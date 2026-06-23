import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import "@babylonjs/core/Culling/ray"; // side-effect: Scene.createPickingRay
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder"; // side-effect: CreateCylinder
import "@babylonjs/core/Meshes/Builders/boxBuilder"; // side-effect: CreateBox
import "@babylonjs/core/Meshes/Builders/torusBuilder"; // side-effect: CreateTorus

import { createInput } from "../../engine/input";
import { createHud } from "../../engine/hud";
import { createGround, createBoxGrid, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

/**
 * Top-down twin-stick movement: MOVEMENT (WASD on fixed world axes) and
 * FACING/AIM (toward the mouse cursor) are decoupled, so you can strafe one way
 * while aiming another (kiting). A fixed-orientation follow camera and a ground
 * reticle make the decoupling legible. The cursor stays VISIBLE — we pass
 * `{ pointerLock: false }` to the shared input so it never grabs pointer lock
 * (absolute cursor aim needs the visible cursor, not relative deltas).
 */

// --- Movement (world-axis WASD; not camera/facing-relative). ---
const MOVE_SPEED = 7; // units / s
const GROUND_Y = 0;

// --- Top-down camera (fixed orientation; tracks XZ only, never rotates). ---
const CAM_HEIGHT = 18; // units above the player
const CAM_BACK_OFFSET = 6; // +Z back-offset for a slight tilt (reads better than ortho-top)

// --- Player rig (a disc body + a +Z nose so facing is unambiguous). ---
const BODY_RADIUS = 0.6;
const BODY_HEIGHT = 0.5;
const NOSE_LENGTH = 0.9;
const NOSE_SIZE = 0.3; // box cross-section
// The nose sits on the rig's local +Z (the rig's forward in Babylon's LH frame).
const NOSE_OFFSET_Z = BODY_RADIUS + NOSE_LENGTH / 2;

// --- Aim reticle (a flat ring on the ground at the cursor's world point). ---
const RETICLE_DIAMETER = 1.3;
const RETICLE_THICKNESS = 0.18;
const RETICLE_LIFT = 0.02; // tiny lift to avoid z-fighting with the ground
const AIM_MIN_DIST_SQ = 1e-4; // ignore near-zero aim vectors (cursor on the player)

function sample11Mount(ctx: SampleContext): () => void {
  const { scene } = ctx;
  scene.clearColor.set(0.05, 0.06, 0.07, 1);

  // --- Lighting / ground / obstacles (scene-owned, freed by scene.dispose). ---
  createLightPreset(scene);
  createGround(scene); // floor (render only; aim now uses an infinite plane)
  createBoxGrid(scene, { columns: 4, rows: 4, boxSize: 2, spacing: 6 });

  // --- Player rig: a yaw node carrying the disc body + nose. ---
  const rig = new TransformNode("twinStickRig", scene);
  rig.position.set(0, 0, 0);

  const body = MeshBuilder.CreateCylinder(
    "twinStickBody",
    { diameter: BODY_RADIUS * 2, height: BODY_HEIGHT },
    scene,
  );
  body.parent = rig;
  body.position.set(0, GROUND_Y + BODY_HEIGHT / 2, 0);
  const bodyMat = new StandardMaterial("twinStickBodyMat", scene);
  bodyMat.diffuseColor = new Color3(0.29, 0.64, 1);
  body.material = bodyMat;

  // Nose on local +Z so the rig's Y-rotation aims it horizontally at the cursor.
  const nose = MeshBuilder.CreateBox(
    "twinStickNose",
    { width: NOSE_SIZE, height: NOSE_SIZE, depth: NOSE_LENGTH },
    scene,
  );
  nose.parent = rig;
  nose.position.set(0, GROUND_Y + BODY_HEIGHT / 2, NOSE_OFFSET_Z);
  const noseMat = new StandardMaterial("twinStickNoseMat", scene);
  noseMat.diffuseColor = new Color3(1, 0.82, 0.4);
  nose.material = noseMat;

  // --- Aim reticle: a flat torus laid on the ground at the world aim point. ---
  const reticle = MeshBuilder.CreateTorus(
    "twinStickReticle",
    { diameter: RETICLE_DIAMETER, thickness: RETICLE_THICKNESS, tessellation: 32 },
    scene,
  );
  reticle.position.y = GROUND_Y + RETICLE_LIFT;
  const reticleMat = new StandardMaterial("twinStickReticleMat", scene);
  reticleMat.diffuseColor = new Color3(1, 0.36, 0.36);
  reticleMat.emissiveColor = new Color3(0.5, 0.1, 0.1);
  reticle.material = reticleMat;
  reticle.isPickable = false; // never let the reticle intercept its own aim ray

  // --- Top-down camera: fixed orientation, no attachControl (cursor stays free). ---
  const camera = new UniversalCamera(
    "twinStickCam",
    new Vector3(0, CAM_HEIGHT, CAM_BACK_OFFSET),
    scene,
  );
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;

  // --- HUD (controls overlay). ---
  const hud = createHud(ctx, {
    title: "Controls",
    controls: [
      "WASD — move (world axes)",
      "Mouse — aim / face cursor",
      "Movement and aim are independent",
    ],
  });

  // --- Input: keyboard ONLY. pointerLock:false keeps the cursor visible for aim. ---
  const input = createInput(ctx, { pointerLock: false });

  // Last valid aim yaw, held when the cursor's ray misses the ground.
  let aimYaw = 0;
  const move = new Vector3();
  // The infinite ground plane (y = GROUND_Y) the cursor ray is intersected with.
  const groundPlane = Plane.FromPositionAndNormal(
    new Vector3(0, GROUND_Y, 0),
    new Vector3(0, 1, 0),
  );

  const update = (): void => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    // --- World-axis WASD (decoupled from facing). +Z is "down" on screen for
    // our slightly-tilted top-down camera, so W = -Z, S = +Z, A = -X, D = +X. ---
    move.set(0, 0, 0);
    if (input.isKeyDown("KeyW")) move.z -= 1;
    if (input.isKeyDown("KeyS")) move.z += 1;
    if (input.isKeyDown("KeyA")) move.x -= 1;
    if (input.isKeyDown("KeyD")) move.x += 1;
    if (move.lengthSquared() > 0) {
      move.normalize();
      rig.position.x += move.x * MOVE_SPEED * dt;
      rig.position.z += move.z * MOVE_SPEED * dt;
    }

    // --- Aim: intersect the cursor ray with the INFINITE ground plane (y =
    // GROUND_Y), not the ground mesh — so aiming past the mesh's edge still
    // resolves a world point (matches the Three/Bevy peers). A miss only happens
    // when the ray is parallel to the plane; then we hold the last facing. ---
    const ray = scene.createPickingRay(
      scene.pointerX,
      scene.pointerY,
      Matrix.Identity(),
      camera,
    );
    const distance = ray.intersectsPlane(groundPlane);
    const aim = distance !== null ? ray.origin.add(ray.direction.scale(distance)) : null;
    if (aim) {
      const dx = aim.x - rig.position.x;
      const dz = aim.z - rig.position.z;
      // Skip near-zero direction vectors (cursor on the player) to avoid jitter.
      if (dx * dx + dz * dz > AIM_MIN_DIST_SQ) {
        // +Z local is the nose; atan2(dx, dz) rotates +Z toward (dx, dz) in
        // Babylon's left-handed frame so the nose points at the cursor.
        aimYaw = Math.atan2(dx, dz);
      }
      reticle.position.set(aim.x, GROUND_Y + RETICLE_LIFT, aim.z);
      reticle.setEnabled(true);
    } else {
      reticle.setEnabled(false);
    }
    rig.rotation.y = aimYaw;

    // --- Top-down follow camera: tracks XZ only, fixed orientation. ---
    camera.position.set(rig.position.x, CAM_HEIGHT, rig.position.z + CAM_BACK_OFFSET);
    camera.setTarget(new Vector3(rig.position.x, GROUND_Y, rig.position.z));
  };
  const updateObserver = scene.onBeforeRenderObservable.add(update);

  // --- Dispose: own everything created outside scene.dispose's reach + tidy up
  // the rig/reticle/camera and the render observer. ---
  return () => {
    input.dispose();
    hud.dispose();
    scene.onBeforeRenderObservable.remove(updateObserver);
    reticle.dispose();
    reticleMat.dispose();
    nose.dispose();
    noseMat.dispose();
    body.dispose();
    bodyMat.dispose();
    rig.dispose();
    camera.dispose();
  };
}

export const sample11: Sample = {
  id: "11-top-down-twin-stick",
  title: "Top-Down Twin-Stick Movement",
  summary:
    "Top-down twin-stick: WASD moves on world axes; the player faces the mouse cursor. Movement and aim are decoupled — strafe while aiming elsewhere.",
  tags: ["controller", "input", "camera"],
  mount: sample11Mount,
};

export default sample11;
