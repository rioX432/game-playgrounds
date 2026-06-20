import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { FollowCamera } from "@babylonjs/core/Cameras/followCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/capsuleBuilder";

import type { Sample, SampleContext } from "../types";

/**
 * Manually-integrated third-person controller. We deliberately avoid Babylon's
 * built-in PhysicsCharacterController here so this sample has zero physics-engine
 * dependency and the "feel" is fully in our hands (see README).
 */
const GRAVITY = -22; // units / s^2, tuned for a snappy arcade jump
const MOVE_SPEED = 6; // units / s
const JUMP_SPEED = 9; // initial upward velocity
const LOOK_SENSITIVITY = 0.0025;

function sample01Mount(ctx: SampleContext): () => void {
  const { scene, canvas } = ctx;
  scene.clearColor.set(0.6, 0.75, 0.9, 1);

  // --- Lighting ---
  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.7;
  const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.5), scene);
  sun.intensity = 0.6;

  // --- Ground ---
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: 60, height: 60 },
    scene,
  );
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.35, 0.5, 0.35);
  ground.material = groundMat;

  // --- Scattered obstacle boxes ---
  const boxMat = new StandardMaterial("boxMat", scene);
  boxMat.diffuseColor = new Color3(0.8, 0.55, 0.3);
  const boxes: AbstractMesh[] = [];
  for (let i = 0; i < 6; i++) {
    const box = MeshBuilder.CreateBox("box" + i, { size: 2 }, scene);
    box.position.set((i - 3) * 5 + 2, 1, ((i % 3) - 1) * 8);
    box.material = boxMat;
    boxes.push(box);
  }

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

  // --- Input state ---
  const keys: Record<string, boolean> = {};
  let yaw = 0;
  let verticalVelocity = 0;
  let grounded = true;
  const groundY = capsuleHeight / 2;

  const onKeyDown = (e: KeyboardEvent): void => {
    keys[e.code] = true;
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys[e.code] = false;
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // --- Pointer-lock mouse look ---
  const onCanvasClick = (): void => {
    void canvas.requestPointerLock?.();
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (document.pointerLockElement !== canvas) return;
    yaw += e.movementX * LOOK_SENSITIVITY;
  };
  canvas.addEventListener("click", onCanvasClick);
  document.addEventListener("mousemove", onMouseMove);

  // --- Per-frame update ---
  const update = (): void => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    yawPivot.rotation.y = yaw;

    // Build a movement vector in the player's local frame, then rotate by yaw.
    let forward = 0;
    let strafe = 0;
    if (keys["KeyW"]) forward += 1;
    if (keys["KeyS"]) forward -= 1;
    if (keys["KeyD"]) strafe += 1;
    if (keys["KeyA"]) strafe -= 1;

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

    // Jump + gravity.
    if (keys["Space"] && grounded) {
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
  scene.onBeforeRenderObservable.add(update);

  // --- Dispose ---
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("click", onCanvasClick);
    document.removeEventListener("mousemove", onMouseMove);
    if (document.pointerLockElement === canvas) {
      document.exitPointerLock?.();
    }
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
