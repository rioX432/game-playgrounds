import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { FollowCamera } from "@babylonjs/core/Cameras/followCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import "@babylonjs/core/Meshes/Builders/capsuleBuilder";

import { createInput } from "../../engine/input";
import { createHud } from "../../engine/hud";
import { createGround, createBoxGrid, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

/**
 * Manually-integrated third-person controller. We deliberately avoid Babylon's
 * built-in PhysicsCharacterController here so this sample has zero physics-engine
 * dependency and the "feel" is fully in our hands (see README).
 *
 * Input is delegated to the shared `engine/input` module (keyboard state +
 * pointer-lock look) so every sample shares one leak-safe input model.
 */
const GRAVITY = -22; // units / s^2, tuned for a snappy arcade jump
const MOVE_SPEED = 6; // units / s
const JUMP_SPEED = 9; // initial upward velocity
const LOOK_SENSITIVITY = 0.0025;

function sample01Mount(ctx: SampleContext): () => void {
  const { scene } = ctx;
  scene.clearColor.set(0.6, 0.75, 0.9, 1);

  // --- Lighting / ground / obstacles via shared scene primitives ---
  // These are owned by the scene and freed by scene.dispose() on switch, so the
  // sample does not need to dispose them manually (see engine/scene.ts).
  createLightPreset(scene);
  createGround(scene);
  createBoxGrid(scene, { columns: 4, rows: 4, boxSize: 2, spacing: 8 });

  // --- Player capsule ---
  const capsuleHeight = 2;
  const player = MeshBuilder.CreateCapsule(
    "player",
    { height: capsuleHeight, radius: 0.5 },
    scene,
  );
  player.position.set(0, capsuleHeight / 2, 0);
  const playerMat = new StandardMaterial("playerMat", scene);
  playerMat.diffuseColor = new Color3(0.2, 0.45, 0.85);
  player.material = playerMat;

  // Yaw pivot drives both movement direction and the look heading.
  const yawPivot = new TransformNode("yawPivot", scene);
  player.parent = yawPivot;
  player.position.set(0, capsuleHeight / 2, 0);
  yawPivot.position.set(0, 0, 0);

  // --- Follow camera ---
  const camera = new FollowCamera(
    "followCam",
    new Vector3(0, 5, -10),
    scene,
    player,
  );
  camera.radius = 9;
  camera.heightOffset = 4;
  camera.rotationOffset = 180;
  camera.cameraAcceleration = 0.08;
  camera.maxCameraSpeed = 20;

  // --- HUD (shared module: controls overlay bottom-left + FPS top-right) ---
  const hud = createHud(ctx, {
    title: "Controls",
    controls: [
      "WASD — move",
      "Mouse — look (click to lock pointer)",
      "Space — jump",
      "Esc — release pointer",
    ],
  });

  // --- Input (shared module: keyboard state + pointer-lock look) ---
  const input = createInput(ctx);
  let yaw = 0;
  let verticalVelocity = 0;
  let grounded = true;
  const groundY = capsuleHeight / 2;

  // --- Per-frame update ---
  const update = (): void => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    // Apply accumulated pointer-lock look to the yaw heading.
    yaw += input.consumeLookX() * LOOK_SENSITIVITY;
    yawPivot.rotation.y = yaw;

    // Build a movement vector in the player's local frame, then rotate by yaw.
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
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const worldX = (strafe * cos + forward * sin) * MOVE_SPEED * dt;
      const worldZ = (forward * cos - strafe * sin) * MOVE_SPEED * dt;
      yawPivot.position.x += worldX;
      yawPivot.position.z += worldZ;
    }

    // Jump + gravity. Edge-triggered: only fires on the frame Space is first
    // pressed, so holding Space does NOT auto-bounce.
    if (grounded && input.consumeJustPressed("Space")) {
      verticalVelocity = JUMP_SPEED;
      grounded = false;
    }
    verticalVelocity += GRAVITY * dt;
    yawPivot.position.y += verticalVelocity * dt;
    if (yawPivot.position.y <= 0) {
      yawPivot.position.y = 0;
      verticalVelocity = 0;
      grounded = true;
    }
    void groundY;
  };
  const updateObserver = scene.onBeforeRenderObservable.add(update);

  // --- Dispose ---
  // The shared input controller removes its own observers + DOM listener and
  // releases pointer lock if owned. The HUD removes its overlay DOM nodes + FPS
  // observer. The render observer is scene-owned (cleared by scene.dispose), but
  // we detach it here too for tidy, leak-free teardown.
  return () => {
    input.dispose();
    hud.dispose();
    scene.onBeforeRenderObservable.remove(updateObserver);
  };
}

export const sample01: Sample = {
  id: "01-character-controller",
  title: "Third-Person Character Controller",
  summary:
    "Capsule controller: WASD move, pointer-lock mouse look, Space to jump, gravity, follow camera.",
  tags: ["controller", "input", "camera", "kinematic"],
  mount: sample01Mount,
};

export default sample01;
