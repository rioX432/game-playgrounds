import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import "@babylonjs/core/Meshes/Builders/sphereBuilder"; // side-effect: CreateSphere
import "@babylonjs/core/Meshes/Builders/capsuleBuilder"; // side-effect: CreateCapsule
import "@babylonjs/core/Meshes/Builders/boxBuilder"; // side-effect: CreateBox
import "@babylonjs/core/Meshes/Builders/polyhedronBuilder"; // side-effect: CreatePolyhedron
import "@babylonjs/core/Meshes/Builders/cylinderBuilder"; // side-effect: CreateCylinder

import { createInput } from "../../engine/input";
import { createHud } from "../../engine/hud";
import { createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

/**
 * Tiny-planet POLISH layer. Sample 12a proved the core mechanic (radial gravity +
 * walk-on-sphere via manual kinematics); 12b keeps that controller and adds the
 * two things that make a tiny planet actually feel good to move around:
 *
 *  1. **Environment props** scattered across the whole globe (rock dodecahedra +
 *     stacked-cone trees), each radially oriented so its local +Y points along the
 *     surface normal. They double as motion landmarks — without them, slow walking
 *     on a smooth-lit sphere can read as standing still (12a's honest weak point).
 *  2. **A damped follow camera.** 12a snapped the camera rigidly to −forward every
 *     frame, so turns whipped the whole view and the horizon re-levelled in one
 *     frame (borderline nauseating). Here the camera position is damped toward its
 *     target, and the camera's up-vector is damped toward the surface normal, so
 *     the horizon *curves* smoothly as you orbit instead of snapping.
 *
 * Both the prop orientation and the controller orientation use
 * `Quaternion.FromLookDirectionLH(tangent, normal)` rather than Euler angles, so
 * nothing gimbal-flips at the poles or on the underside.
 */

// --- Planet ---
const PLANET_CENTER = Vector3.Zero();
const PLANET_RADIUS = 10;

// --- Character (capsule aligned along its local Y, per Babylon convention) ---
const CAPSULE_HEIGHT = 1.8;
const CAPSULE_RADIUS = 0.4;
const CAPSULE_HALF_HEIGHT = CAPSULE_HEIGHT / 2;
const GROUND_DIST = PLANET_RADIUS + CAPSULE_HALF_HEIGHT;

// --- Movement tuning (carried from 12a so the feel is identical) ---
const MOVE_SPEED = 5; // units / s along the surface (arc length)
const TURN_SPEED = 2.4; // radians / s of heading rotation (A/D)
const GRAVITY = -22; // units / s^2 toward the planet center
const JUMP_SPEED = 9; // initial outward (away-from-center) velocity
const MAX_DT = 1 / 30; // clamp huge frames (tab refocus) so we never tunnel
const MIN_TANGENT_LEN_SQ = 1e-8; // below this the heading collapsed onto up

// --- Camera framing ---
const CAM_BACK = 7; // how far behind the player, along -forward
const CAM_HEIGHT = 3.5; // how far out along the surface normal (up)
const CAM_LOOK_HEIGHT = 1.2; // look at a point this far up from the player's feet
// Exponential damping rates (1/s). Higher = stiffer / catches up faster. The
// per-frame blend is `1 - exp(-rate*dt)`, which is frame-rate independent.
const CAM_POS_RATE = 6; // position follow stiffness
const CAM_UP_RATE = 4; // horizon-roll stiffness (slower → the curve reads)
// If the smoothed up and the target up are nearly opposite, a lerp would drag
// the view through the degenerate point; snap instead.
const CAM_UP_ANTIPARALLEL_DOT = -0.99;

// --- Props ---
const PROP_COUNT = 30;
// Golden-angle increment for an even Fibonacci-sphere scatter (deterministic, no
// RNG — same layout every mount).
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const ROCK_SIZE = 0.55;
const TREE_TRUNK_HEIGHT = 0.9;
const TREE_TRUNK_RADIUS = 0.12;
const TREE_FOLIAGE_HEIGHT = 1.5;
const TREE_FOLIAGE_RADIUS = 0.7;
// Every Nth prop is a tree; the rest are rocks.
const TREE_EVERY = 3;

/**
 * Build a unit surface normal for the i-th of `count` Fibonacci-distributed
 * points on a sphere, writing it into `out`. Even, deterministic coverage of the
 * whole globe (including the underside) so props are never clustered.
 */
function fibonacciNormalToRef(i: number, count: number, out: Vector3): void {
  const y = 1 - (i / (count - 1)) * 2; // y from +1 (north) to -1 (south)
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = i * GOLDEN_ANGLE;
  out.set(Math.cos(theta) * r, y, Math.sin(theta) * r);
  out.normalize();
}

/**
 * A tangent unit vector perpendicular to `normal`, used as the prop's local +Z
 * heading. Uses the same non-parallel-seed trick as the controller so it stays
 * well-defined at the poles. `spin` rotates it about the normal for variety.
 */
function tangentForRef(normal: Vector3, spin: number, out: Vector3): void {
  const seed =
    Math.abs(normal.y) < 0.99 ? Vector3.UpReadOnly : Vector3.RightReadOnly;
  Vector3.CrossToRef(seed, normal, out);
  out.normalize();
  if (spin !== 0) {
    const q = Quaternion.RotationAxis(normal, spin);
    out.applyRotationQuaternionInPlace(q);
    out.normalize();
  }
}

function sample12bMount(ctx: SampleContext): () => void {
  const { scene } = ctx;
  scene.clearColor.set(0.02, 0.03, 0.05, 1);

  // --- Lighting (scene-owned; freed by scene.dispose). ---
  createLightPreset(scene);

  // --- Planet ---
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

  // --- Props: scattered over the whole globe, each oriented to its surface
  // normal. Parented under one root so dispose is a single recursive call;
  // shared materials are disposed explicitly alongside it. ---
  const propsRoot = new TransformNode("props", scene);
  const rockMat = new StandardMaterial("rockMat", scene);
  rockMat.diffuseColor = new Color3(0.5, 0.5, 0.55);
  rockMat.specularColor = new Color3(0.1, 0.1, 0.1);
  const trunkMat = new StandardMaterial("trunkMat", scene);
  trunkMat.diffuseColor = new Color3(0.4, 0.26, 0.15);
  const leafMat = new StandardMaterial("leafMat", scene);
  leafMat.diffuseColor = new Color3(0.16, 0.5, 0.22);

  const propNormal = new Vector3();
  const propTangent = new Vector3();
  for (let i = 0; i < PROP_COUNT; i++) {
    fibonacciNormalToRef(i, PROP_COUNT, propNormal);
    tangentForRef(propNormal, i * 0.7, propTangent);

    const node = new TransformNode(`prop_${i}`, scene);
    node.parent = propsRoot;
    // Sit the prop's base on the surface; local +Y is "up" out of the ground.
    PLANET_CENTER.addToRef(propNormal.scale(PLANET_RADIUS), node.position);
    node.rotationQuaternion = Quaternion.FromLookDirectionLH(
      propTangent,
      propNormal,
    );

    if (i % TREE_EVERY === 0) {
      // Tree: trunk + two stacked cones, all along local +Y.
      const trunk = MeshBuilder.CreateCylinder(
        `prop_${i}_trunk`,
        {
          height: TREE_TRUNK_HEIGHT,
          diameter: TREE_TRUNK_RADIUS * 2,
          tessellation: 8,
        },
        scene,
      );
      trunk.parent = node;
      trunk.position.set(0, TREE_TRUNK_HEIGHT / 2, 0);
      trunk.material = trunkMat;

      const lowerY = TREE_TRUNK_HEIGHT + TREE_FOLIAGE_HEIGHT * 0.4;
      const cone1 = MeshBuilder.CreateCylinder(
        `prop_${i}_cone1`,
        {
          height: TREE_FOLIAGE_HEIGHT,
          diameterTop: 0,
          diameterBottom: TREE_FOLIAGE_RADIUS * 2,
          tessellation: 8,
        },
        scene,
      );
      cone1.parent = node;
      cone1.position.set(0, lowerY, 0);
      cone1.material = leafMat;

      const cone2 = MeshBuilder.CreateCylinder(
        `prop_${i}_cone2`,
        {
          height: TREE_FOLIAGE_HEIGHT * 0.7,
          diameterTop: 0,
          diameterBottom: TREE_FOLIAGE_RADIUS * 1.3,
          tessellation: 8,
        },
        scene,
      );
      cone2.parent = node;
      cone2.position.set(0, lowerY + TREE_FOLIAGE_HEIGHT * 0.45, 0);
      cone2.material = leafMat;
    } else {
      // Rock: a single dodecahedron (polyhedron type 2) resting on the surface.
      const rock = MeshBuilder.CreatePolyhedron(
        `prop_${i}_rock`,
        { type: 2, size: ROCK_SIZE },
        scene,
      );
      rock.parent = node;
      rock.position.set(0, ROCK_SIZE * 0.6, 0);
      rock.material = rockMat;
    }
  }

  // --- Player rig (identical controller to 12a). ---
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
  const forward = new Vector3(0, 0, 1);
  let radialVelocity = 0;
  let grounded = true;
  let jumpWasDown = false;

  // Scratch values reused each frame to keep the hot loop's allocation low.
  const up = new Vector3();
  const tmp = new Vector3();
  const camTarget = new Vector3();
  const camDesired = new Vector3();
  const camDir = new Vector3();
  const turnQuat = Quaternion.Identity();
  // Smoothed camera up-vector (the horizon basis). Starts on the initial normal.
  const camUp = new Vector3(0, 1, 0);

  // --- Camera: manual follow; drive rotationQuaternion (not setTarget, which
  // forces roll=0 and can't tilt with the surface normal). See 12a for the full
  // rationale; 12b additionally *damps* both the position and the up-vector. ---
  const camera = new UniversalCamera(
    "planetCam",
    new Vector3(0, GROUND_DIST + CAM_HEIGHT, -CAM_BACK),
    scene,
  );
  camera.minZ = 0.05;
  camera.rotationQuaternion = Quaternion.Identity();
  camera.updateUpVectorFromRotation = true;
  scene.activeCamera = camera;

  // Seed the camera at its exact target so it does not lerp in from the origin
  // on the first frame.
  camDesired.copyFrom(pos);
  camDesired.addInPlace(Vector3.UpReadOnly.scale(CAM_HEIGHT));
  camDesired.subtractInPlace(forward.scale(CAM_BACK));
  camera.position.copyFrom(camDesired);

  // --- HUD ---
  const hud = createHud(ctx, {
    title: "Controls",
    controls: [
      "W / S — walk forward / back",
      "A / D — turn",
      "Space — jump",
      "Walk over the poles — the camera horizon curves with you",
    ],
  });

  // --- Input: keyboard only (tank controls, free cursor). ---
  const input = createInput(ctx, { pointerLock: false });

  // Re-orthogonalize `forward` to a unit tangent perpendicular to `up`.
  const reprojectForward = (): void => {
    const dot = Vector3.Dot(forward, up);
    forward.subtractInPlace(up.scale(dot));
    if (forward.lengthSquared() < MIN_TANGENT_LEN_SQ) {
      const seed =
        Math.abs(up.y) < 0.99 ? Vector3.UpReadOnly : Vector3.RightReadOnly;
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

    // --- Walk (W/S): step along the tangent forward, then re-project to the same
    // radius so a straight tangent step becomes a great-circle step. ---
    let walk = 0;
    if (input.isKeyDown("KeyW")) walk += 1;
    if (input.isKeyDown("KeyS")) walk -= 1;
    if (walk !== 0) {
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

    // --- Damped follow camera. The target sits behind along -forward and out
    // along +up; the camera position eases toward it (frame-rate-independent
    // blend), so a turn swings the view around instead of snapping. ---
    camDesired.copyFrom(pos);
    camDesired.addInPlace(up.scale(CAM_HEIGHT));
    forward.scaleToRef(CAM_BACK, tmp);
    camDesired.subtractInPlace(tmp);
    const posBlend = 1 - Math.exp(-CAM_POS_RATE * dt);
    Vector3.LerpToRef(camera.position, camDesired, posBlend, camera.position);

    // --- Damp the camera up-vector toward the surface normal so the horizon
    // curves smoothly. Snap (don't lerp) through the antiparallel singularity. ---
    if (Vector3.Dot(camUp, up) < CAM_UP_ANTIPARALLEL_DOT) {
      camUp.copyFrom(up);
    } else {
      const upBlend = 1 - Math.exp(-CAM_UP_RATE * dt);
      Vector3.LerpToRef(camUp, up, upBlend, camUp);
      camUp.normalize();
    }

    // --- Look at a point slightly above the player's feet, rolled by camUp. ---
    camTarget.copyFrom(pos);
    camTarget.addInPlace(up.scale(CAM_LOOK_HEIGHT));
    camTarget.subtractToRef(camera.position, camDir);
    camDir.normalize();
    Quaternion.FromLookDirectionLHToRef(camDir, camUp, camera.rotationQuaternion!);
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
    // Recursively dispose every prop mesh, then the shared prop materials.
    propsRoot.dispose();
    rockMat.dispose();
    trunkMat.dispose();
    leafMat.dispose();
    planet.dispose();
    planetMat.dispose();
    camera.dispose();
  };
}

export const sample12b: Sample = {
  id: "12b-tiny-planet",
  title: "Tiny Planet — Environment + Camera",
  summary:
    "The polished tiny planet: scattered props and a damped follow camera whose horizon curves smoothly as you walk around the globe.",
  tags: ["controller", "gravity", "camera"],
  mount: sample12bMount,
};

export default sample12b;
