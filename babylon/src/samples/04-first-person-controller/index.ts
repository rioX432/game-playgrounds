import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";

import { createInput } from "../../engine/input";
import { createHud } from "../../engine/hud";
import { createGround, createBoxGrid, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

/**
 * First-person controller. Unlike the third-person sample 01 (a follow camera
 * behind a visible capsule), here the camera IS the player: there is no avatar
 * mesh, just an eye positioned at standing height. We drive the camera yaw/pitch
 * ourselves from the shared pointer-lock input and never call
 * `camera.attachControl` for look — mixing Babylon's built-in camera input with
 * our manual look would make the two input models fight (see CLAUDE.md → Think
 * Twice / pointer-lock conflicts).
 *
 * Movement is manual kinematics on the XZ plane relative to yaw only (pitch is
 * ignored for walking, the classic FPS convention), plus gravity + Space jump
 * with a ground clamp at eye height. Tuning constants mirror the Three.js
 * sample 04 so the two engines feel the same.
 */
const GRAVITY = -22; // units / s^2, snappy arcade jump
const MOVE_SPEED = 6; // units / s
const JUMP_SPEED = 9; // initial upward velocity
const LOOK_SENSITIVITY = 0.0025; // radians per pixel of mouse movement
const EYE_HEIGHT = 1.7; // camera height above the floor (standing eye level)
const GROUND_Y = 0;
// Clamp pitch just shy of straight up/down to avoid the view snapping at vertical.
const PITCH_MIN = -Math.PI / 2 + 0.01;
const PITCH_MAX = Math.PI / 2 - 0.01;
// Start the player off-center so the box grid sits in front of them as a
// motion-reference, not on top of them.
const START_X = 0;
const START_Z = 12;
const START_YAW = Math.PI; // face -Z (toward the grid at the origin)

function sample04Mount(ctx: SampleContext): () => void {
  const { scene } = ctx;
  scene.clearColor.set(0.06, 0.08, 0.1, 1);

  // --- Lighting / ground / obstacles via shared scene primitives ---
  // Owned by the scene and freed by scene.dispose() on switch.
  createLightPreset(scene);
  createGround(scene);
  createBoxGrid(scene, { columns: 4, rows: 4, boxSize: 2, spacing: 8 });

  // --- Camera as the player's eye ---
  // UniversalCamera at rotation (pitch, yaw, roll) = (0, 0, 0) looks down +Z.
  // We set rotation manually each frame; do NOT attachControl (would fight the
  // shared pointer-lock look input).
  const camera = new UniversalCamera(
    "fpsCam",
    new Vector3(START_X, GROUND_Y + EYE_HEIGHT, START_Z),
    scene,
  );
  camera.minZ = 0.1;
  scene.activeCamera = camera;

  // --- HUD (shared module) ---
  const hud = createHud(ctx, {
    title: "Controls",
    controls: [
      "Click — lock pointer",
      "WASD — move",
      "Mouse — look",
      "Space — jump",
      "Esc — release pointer",
    ],
  });

  // --- Input (shared module: keyboard + pointer-lock look) ---
  const input = createInput(ctx);
  let yaw = START_YAW;
  let pitch = 0;
  let verticalVelocity = 0;
  let grounded = true;
  const floorY = GROUND_Y + EYE_HEIGHT;

  // --- Per-frame update ---
  const update = (): void => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    // Apply accumulated pointer-lock look to yaw/pitch, then drive the camera.
    yaw += input.consumeLookX() * LOOK_SENSITIVITY;
    pitch += input.consumeLookY() * LOOK_SENSITIVITY;
    if (pitch < PITCH_MIN) pitch = PITCH_MIN;
    if (pitch > PITCH_MAX) pitch = PITCH_MAX;
    // Babylon UniversalCamera.rotation is (x=pitch, y=yaw, z=roll).
    camera.rotation.set(pitch, yaw, 0);

    // Movement basis from yaw only (pitch ignored, so looking up/down never
    // lifts or sinks the walk). A UniversalCamera at this yaw looks along
    // (sin yaw, *, cos yaw) on the XZ plane; right is that vector rotated -90°.
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    let forward = 0;
    let strafe = 0;
    if (input.isKeyDown("KeyW")) forward += 1;
    if (input.isKeyDown("KeyS")) forward -= 1;
    if (input.isKeyDown("KeyD")) strafe += 1;
    if (input.isKeyDown("KeyA")) strafe -= 1;

    if (forward !== 0 || strafe !== 0) {
      const len = Math.hypot(forward, strafe);
      forward /= len;
      strafe /= len;
      // forwardDir = (sin, cos); rightDir = (cos, -sin).
      const worldX = (forward * sin + strafe * cos) * MOVE_SPEED * dt;
      const worldZ = (forward * cos - strafe * sin) * MOVE_SPEED * dt;
      camera.position.x += worldX;
      camera.position.z += worldZ;
    }

    // Jump (edge-triggered via the shared input) + gravity + ground clamp at
    // eye height. consumeJustPressed fires only on the down-edge, so holding
    // Space can't auto-bounce.
    if (grounded && input.consumeJustPressed("Space")) {
      verticalVelocity = JUMP_SPEED;
      grounded = false;
    }

    verticalVelocity += GRAVITY * dt;
    camera.position.y += verticalVelocity * dt;
    if (camera.position.y <= floorY) {
      camera.position.y = floorY;
      verticalVelocity = 0;
      grounded = true;
    }
  };
  const updateObserver = scene.onBeforeRenderObservable.add(update);

  // --- Dispose ---
  // Shared modules clean themselves up (input removes its observers + pointer
  // lock; hud removes its overlay DOM + FPS observer). The render observer is
  // scene-owned but we detach it too for tidy teardown.
  return () => {
    input.dispose();
    hud.dispose();
    scene.onBeforeRenderObservable.remove(updateObserver);
  };
}

export const sample04: Sample = {
  id: "04-first-person-controller",
  title: "First-Person Controller",
  summary:
    "First-person FPS movement: WASD relative to look yaw, pointer-lock mouse look, Space jump, gravity.",
  tags: ["controller", "input", "camera"],
  mount: sample04Mount,
};

export default sample04;
