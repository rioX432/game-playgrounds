import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import "@babylonjs/core/Meshes/Builders/sphereBuilder"; // side-effect: CreateSphere
import "@babylonjs/core/Meshes/Builders/capsuleBuilder"; // side-effect: CreateCapsule
import "@babylonjs/core/Meshes/Builders/boxBuilder"; // side-effect: CreateBox

import { createInput } from "../../engine/input";
import { createHud } from "../../engine/hud";
import { createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

/**
 * Messenger / Super Mario Galaxy style "tiny planet": gravity points toward the
 * planet center (not world-down), and the character's local up aligns to the
 * surface normal so you can walk all the way around the sphere — over the poles
 * and onto the underside — without ever falling off.
 *
 * Architecture: MANUAL KINEMATICS, no physics body for the player (the same
 * model as the first-person sample 04, generalized from a flat floor to a
 * sphere). Havok's gravity is a single static world vector, so a dynamic body
 * can't get radial gravity without per-frame force fighting the solver; authoring
 * the motion ourselves is both simpler and far less jittery for a character
 * controller. There are no other physics actors in 12a, so Havok isn't loaded at
 * all here — prop collision is a 12b concern.
 *
 * Controls are tank-style (A/D turn, W/S walk) rather than camera-relative WASD.
 * That keeps a single persistent `forward` heading we rotate in the tangent
 * plane, which sidesteps the degenerate "which way is forward?" problem you hit
 * at the poles with camera-relative input.
 */

// --- Planet ---
const PLANET_CENTER = Vector3.Zero();
const PLANET_RADIUS = 10;

// --- Character (capsule aligned along its local Y, per Babylon convention) ---
const CAPSULE_HEIGHT = 1.8;
const CAPSULE_RADIUS = 0.4;
const CAPSULE_HALF_HEIGHT = CAPSULE_HEIGHT / 2;
// Distance from planet center at which the capsule rests on the surface.
const GROUND_DIST = PLANET_RADIUS + CAPSULE_HALF_HEIGHT;

// --- Movement tuning ---
const MOVE_SPEED = 5; // units / s along the surface (arc length)
const TURN_SPEED = 2.4; // radians / s of heading rotation (A/D)
const GRAVITY = -22; // units / s^2 toward the planet center (matches sample 04)
const JUMP_SPEED = 9; // initial outward (away-from-center) velocity
const MAX_DT = 1 / 30; // clamp huge frames (tab refocus) so we never tunnel
// Below this squared length the heading has collapsed onto the up axis; rebuild
// it from an axis not parallel to up to recover a valid tangent forward
// (defensive — tank controls keep forward tangent, but a degenerate frame must
// never emit NaNs into the orientation quaternion).
const MIN_TANGENT_LEN_SQ = 1e-8;

// --- Camera (basic follow; the damped, horizon-curving camera is 12b's job) ---
const CAM_BACK = 7; // how far behind the player, along -forward
const CAM_HEIGHT = 3.5; // how far out along the surface normal (up)
const CAM_LOOK_HEIGHT = 1.2; // look at a point this far up from the player's feet

function sample12aMount(ctx: SampleContext): () => void {
  const { scene } = ctx;
  scene.clearColor.set(0.02, 0.03, 0.05, 1);

  // --- Lighting (scene-owned; freed by scene.dispose). ---
  createLightPreset(scene);

  // --- Planet: a solid sphere centered at the origin. The directional light's
  // shading gradient is the main orientation cue in 12a (props come in 12b). ---
  const planet = MeshBuilder.CreateSphere(
    "planet",
    { diameter: PLANET_RADIUS * 2, segments: 48 },
    scene,
  );
  planet.position.copyFrom(PLANET_CENTER);
  const planetMat = new StandardMaterial("planetMat", scene);
  planetMat.diffuseColor = new Color3(0.18, 0.42, 0.26);
  planetMat.specularColor = new Color3(0.05, 0.05, 0.05);
  planet.material = planetMat;

  // --- Player rig: a capsule body + a +Z nose so heading is unambiguous. The
  // rig's orientation is driven by a quaternion each frame, so it runs in
  // quaternion mode (rotationQuaternion set, Euler `rotation` ignored). ---
  const rig = new TransformNode("playerRig", scene);
  rig.rotationQuaternion = Quaternion.Identity();

  const body = MeshBuilder.CreateCapsule(
    "playerBody",
    { height: CAPSULE_HEIGHT, radius: CAPSULE_RADIUS },
    scene,
  );
  body.parent = rig;
  const bodyMat = new StandardMaterial("playerBodyMat", scene);
  bodyMat.diffuseColor = new Color3(1, 0.55, 0.25);
  body.material = bodyMat;

  // Nose on local +Z (the rig's forward in Babylon's left-handed frame), lifted
  // toward the "head" so the facing direction reads at a glance.
  const nose = MeshBuilder.CreateBox(
    "playerNose",
    { width: 0.18, height: 0.18, depth: 0.5 },
    scene,
  );
  nose.parent = rig;
  nose.position.set(0, CAPSULE_HALF_HEIGHT * 0.5, CAPSULE_RADIUS + 0.25);
  const noseMat = new StandardMaterial("playerNoseMat", scene);
  noseMat.diffuseColor = new Color3(1, 0.9, 0.5);
  noseMat.emissiveColor = new Color3(0.4, 0.32, 0.1);
  nose.material = noseMat;

  // --- Player state. Position starts at the "north pole" of the planet. ---
  const pos = PLANET_CENTER.add(new Vector3(0, GROUND_DIST, 0));
  // Persistent tangent heading. At the start up = +Y, so any horizontal axis is
  // tangent; +Z is a natural initial forward.
  const forward = new Vector3(0, 0, 1);
  let radialVelocity = 0; // along +up (outward); gravity drives it negative
  let grounded = true;
  let jumpWasDown = false; // edge-trigger so holding Space doesn't auto-bounce

  // Scratch values reused each frame to keep the hot loop's allocation low.
  const up = new Vector3();
  const tmp = new Vector3();
  const camTarget = new Vector3();
  const camDir = new Vector3();
  const turnQuat = Quaternion.Identity();

  // --- Camera: follow rig manually; do NOT attachControl (we own the framing).
  // We drive `rotationQuaternion` directly instead of `setTarget`: setTarget
  // builds rotation against world-up and forces roll (rotation.z) to 0, so it
  // can't tilt the view with the surface normal — the camera would stay
  // world-upright while the player walks onto the planet's underside. Driving the
  // quaternion from (lookDir, surfaceNormal) and letting Babylon derive the up
  // vector from it (updateUpVectorFromRotation) gives the correct rolling view. ---
  const camera = new UniversalCamera(
    "planetCam",
    new Vector3(0, GROUND_DIST + CAM_HEIGHT, -CAM_BACK),
    scene,
  );
  camera.minZ = 0.05;
  camera.rotationQuaternion = Quaternion.Identity();
  camera.updateUpVectorFromRotation = true;
  scene.activeCamera = camera;

  // --- HUD ---
  const hud = createHud(ctx, {
    title: "Controls",
    controls: [
      "W / S — walk forward / back",
      "A / D — turn",
      "Space — jump",
      "Walk over the poles — you never fall off",
    ],
  });

  // --- Input: keyboard only. No pointer lock — tank controls don't need mouse
  // look, and a free cursor reads better for a third-person planet view. ---
  const input = createInput(ctx, { pointerLock: false });

  // Re-orthogonalize `forward` so it is a unit tangent perpendicular to `up`.
  // (Removing the radial component keeps the heading on the sphere's surface.)
  // Requires `up` to be a unit vector.
  const reprojectForward = (): void => {
    const dot = Vector3.Dot(forward, up);
    forward.subtractInPlace(up.scale(dot));
    if (forward.lengthSquared() < MIN_TANGENT_LEN_SQ) {
      // Heading collapsed onto up: rebuild from an axis not parallel to up.
      const seed = Math.abs(up.y) < 0.99 ? Vector3.UpReadOnly : Vector3.RightReadOnly;
      Vector3.CrossToRef(seed, up, forward);
    }
    forward.normalize();
  };

  const update = (): void => {
    let dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;
    if (dt > MAX_DT) dt = MAX_DT;

    // Current surface normal (local up) and distance from the planet center.
    pos.subtractToRef(PLANET_CENTER, up);
    const currentRadius = up.length();
    up.scaleInPlace(1 / currentRadius);

    // --- Turn (A/D): rotate the heading about the up axis in the tangent plane. ---
    let turn = 0;
    if (input.isKeyDown("KeyA")) turn -= 1;
    if (input.isKeyDown("KeyD")) turn += 1;
    reprojectForward();
    if (turn !== 0) {
      Quaternion.RotationAxisToRef(up, turn * TURN_SPEED * dt, turnQuat);
      forward.applyRotationQuaternionInPlace(turnQuat);
      reprojectForward();
    }

    // --- Walk (W/S): step along the tangent forward, then re-project to keep the
    // same radius (a straight tangent step would otherwise lift us off the
    // sphere). The current radius is preserved, so jump height survives a walk. ---
    let walk = 0;
    if (input.isKeyDown("KeyW")) walk += 1;
    if (input.isKeyDown("KeyS")) walk -= 1;
    if (walk !== 0) {
      // currentRadius (captured above) is unchanged by the turn, so re-projecting
      // to it preserves any jump height across a walk step.
      forward.scaleToRef(walk * MOVE_SPEED * dt, tmp);
      pos.addInPlace(tmp);
      pos.subtractToRef(PLANET_CENTER, up);
      up.normalize();
      PLANET_CENTER.addToRef(up.scale(currentRadius), pos);
    }

    // --- Gravity + jump along the (recomputed) up axis. ---
    pos.subtractToRef(PLANET_CENTER, up);
    const r = up.length();
    up.scaleInPlace(1 / r);

    const jumpDown = input.isKeyDown("Space");
    if (jumpDown && !jumpWasDown && grounded) {
      radialVelocity = JUMP_SPEED;
      grounded = false;
    }
    jumpWasDown = jumpDown;

    radialVelocity += GRAVITY * dt;
    let newR = r + radialVelocity * dt;
    if (newR <= GROUND_DIST) {
      newR = GROUND_DIST;
      radialVelocity = 0;
      grounded = true;
    }
    PLANET_CENTER.addToRef(up.scale(newR), pos);

    // --- Orient + place the rig: local Y -> up, local Z -> tangent forward. ---
    reprojectForward();
    Quaternion.FromLookDirectionLHToRef(forward, up, rig.rotationQuaternion!);
    rig.position.copyFrom(pos);

    // --- Follow camera: position behind along -forward and out along +up; look
    // at a point slightly above the player's feet. Orientation is set via the
    // quaternion (built from look-dir + surface normal) so the view rolls with
    // the planet — see the camera setup note above for why setTarget won't do. ---
    camera.position.copyFrom(pos);
    camera.position.addInPlace(up.scale(CAM_HEIGHT));
    forward.scaleToRef(CAM_BACK, tmp);
    camera.position.subtractInPlace(tmp);
    camTarget.copyFrom(pos);
    camTarget.addInPlace(up.scale(CAM_LOOK_HEIGHT));
    camTarget.subtractToRef(camera.position, camDir);
    camDir.normalize();
    Quaternion.FromLookDirectionLHToRef(camDir, up, camera.rotationQuaternion!);
  };
  const updateObserver = scene.onBeforeRenderObservable.add(update);

  // --- Dispose: shared modules clean themselves; detach our observer + meshes. ---
  return () => {
    input.dispose();
    hud.dispose();
    scene.onBeforeRenderObservable.remove(updateObserver);
    nose.dispose();
    noseMat.dispose();
    body.dispose();
    bodyMat.dispose();
    rig.dispose();
    planet.dispose();
    planetMat.dispose();
    camera.dispose();
  };
}

export const sample12a: Sample = {
  id: "12a-spherical-gravity",
  title: "Spherical Gravity + Walk-on-Sphere",
  summary:
    "Tiny-planet movement: gravity pulls toward the sphere center and the character's up aligns to the surface normal, so you walk all the way around — even upside-down.",
  tags: ["controller", "gravity", "camera"],
  mount: sample12aMount,
};

export default sample12a;
