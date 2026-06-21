import { Euler, Vector3 } from "three";
import { Hud } from "../../engine/hud";
import { InputController } from "../../engine/input";
import {
  createBoxGrid,
  createGround,
  createLightPreset,
} from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

// Tuning constants (no magic numbers in the logic below).
const MOVE_SPEED = 6; // m/s
const GRAVITY = -22; // m/s^2
const JUMP_VELOCITY = 9; // m/s
const EYE_HEIGHT = 1.7; // camera height above the floor (standing eye level)
const GROUND_Y = 0;
const INITIAL_PITCH = 0; // look straight ahead at the horizon
// Clamp pitch just shy of straight up/down to avoid gimbal flip at the poles.
const PITCH_CLAMP: [number, number] = [-Math.PI / 2 + 0.01, Math.PI / 2 - 0.01];
const SCENE_BACKGROUND = 0x101418;
// Box grid laid out as spatial reference; spacing leaves room to walk between.
const GRID_COUNT = 4;
const GRID_SPACING = 5;
// Start the player off-center so the grid is in front, not on top of them.
const START_X = 0;
const START_Z = 12;
const START_YAW = 0; // yaw 0 looks down -Z, toward the grid at the origin

const sample: Sample = {
  id: "04-first-person-controller",
  title: "First-Person Controller",
  summary:
    "First-person FPS movement. WASD move, mouse look (pointer lock), Space to jump, gravity.",
  tags: ["controller", "input", "camera"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;

    // Shared scene primitives (F3): light preset + ground + box grid. Each
    // returns a PrimitiveSet that owns its GPU resources and is disposed below.
    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });
    const ground = createGround(scene);
    const boxGrid = createBoxGrid(scene, {
      count: GRID_COUNT,
      spacing: GRID_SPACING,
    });

    // Shared input module: keyboard state + pointer-lock mouse look. Wider
    // pitch clamp than the third-person sample because a first-person camera
    // should be able to look nearly straight up/down.
    const input = new InputController({
      pointerLockTarget: canvas,
      initialYaw: START_YAW,
      initialPitch: INITIAL_PITCH,
      pitchClamp: PITCH_CLAMP,
    });

    // Shared HUD module: controls overlay + FPS counter.
    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      controls: [
        "Click canvas — lock mouse",
        "WASD — move",
        "Mouse — look",
        "Space — jump",
        "Esc — release mouse",
      ],
    });

    // Player state. The camera IS the player: there is no visible avatar, so we
    // track the eye position directly. `position.y` is the eye height; the floor
    // for collision is GROUND_Y + EYE_HEIGHT.
    camera.position.set(START_X, GROUND_Y + EYE_HEIGHT, START_Z);
    let velocityY = 0;
    let grounded = true;

    // Reusable scratch vectors / orientation to avoid per-frame allocation.
    let raf = 0;
    let last = performance.now();
    const forward = new Vector3();
    const right = new Vector3();
    const move = new Vector3();
    // Apply look as YXZ Euler: yaw about world Y first, then pitch about local X.
    // This is the canonical FPS camera order and avoids roll.
    const look = new Euler(0, 0, 0, "YXZ");

    const update = (now: number) => {
      raf = requestAnimationFrame(update);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      hud.frame(now);

      const yaw = input.yaw;
      const pitch = input.pitch;

      // Drive the camera orientation directly from look angles (first-person).
      look.set(pitch, yaw, 0);
      camera.quaternion.setFromEuler(look);

      // Jump is edge-triggered: only fires the frame Space is first pressed.
      if (grounded && input.consumeJustPressed("Space")) {
        velocityY = JUMP_VELOCITY;
        grounded = false;
      }

      // Movement basis from yaw on the horizontal plane (pitch ignored, so
      // looking up/down never lifts or sinks the walk — classic FPS feel).
      // Forward must match the camera's view direction: a YXZ-Euler camera at
      // this yaw looks down (-sin yaw, 0, -cos yaw); `right` is derived from it
      // so W/S and A/D all move relative to where the player is facing.
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
      right.set(forward.z, 0, -forward.x);

      move.set(0, 0, 0);
      if (input.isDown("KeyW")) move.add(forward);
      if (input.isDown("KeyS")) move.sub(forward);
      if (input.isDown("KeyA")) move.add(right);
      if (input.isDown("KeyD")) move.sub(right);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(MOVE_SPEED * dt);
        camera.position.x += move.x;
        camera.position.z += move.z;
      }

      // Gravity + ground collision against the eye-height floor.
      velocityY += GRAVITY * dt;
      camera.position.y += velocityY * dt;
      const floor = GROUND_Y + EYE_HEIGHT;
      if (camera.position.y <= floor) {
        camera.position.y = floor;
        velocityY = 0;
        grounded = true;
      }
    };
    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      input.dispose();
      hud.dispose();
      // Tear down shared primitives (frees their geometries/materials and
      // removes their groups).
      lights.dispose();
      ground.dispose();
      boxGrid.dispose();
    };
  },
};

export default sample;
