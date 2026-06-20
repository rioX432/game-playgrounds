import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from "three";
import { Hud } from "../../engine/hud";
import { InputController } from "../../engine/input";
import type { Sample, SampleContext } from "../types";

// Tuning constants (no magic numbers in the logic below).
const MOVE_SPEED = 6; // m/s
const GRAVITY = -22; // m/s^2
const JUMP_VELOCITY = 9; // m/s
const CAPSULE_RADIUS = 0.4;
const CAPSULE_HEIGHT = 1.0; // cylinder part; total ~1.8m
const GROUND_Y = 0;
const INITIAL_PITCH = 0.2;
const PITCH_CLAMP: [number, number] = [-0.4, 1.2];
const CAMERA_DISTANCE = 6;
const CAMERA_HEIGHT = 3;

const sample: Sample = {
  id: "01-character-controller",
  title: "Character Controller",
  summary:
    "Third-person capsule. WASD move, mouse look (pointer lock), Space to jump, gravity, follow camera.",
  tags: ["controller", "input", "camera"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;
    scene.background = new Color(0x101418);

    // Lights.
    const hemi = new HemisphereLight(0xbfd4ff, 0x202020, 0.9);
    scene.add(hemi);
    const dir = new DirectionalLight(0xffffff, 1.4);
    dir.position.set(5, 10, 4);
    scene.add(dir);

    // Ground.
    const ground = new Mesh(
      new PlaneGeometry(60, 60),
      new MeshStandardMaterial({ color: 0x2a3b2f }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // A few static boxes for spatial reference.
    const boxMat = new MeshStandardMaterial({ color: 0x8a6d3b });
    for (let i = 0; i < 6; i++) {
      const box = new Mesh(new BoxGeometry(1.5, 1.5, 1.5), boxMat);
      const angle = (i / 6) * Math.PI * 2;
      box.position.set(Math.cos(angle) * 8, 0.75, Math.sin(angle) * 8);
      scene.add(box);
    }

    // Player capsule.
    const player = new Mesh(
      new CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HEIGHT, 6, 12),
      new MeshStandardMaterial({ color: 0x4aa3ff }),
    );
    const halfHeight = CAPSULE_HEIGHT / 2 + CAPSULE_RADIUS;
    player.position.set(0, GROUND_Y + halfHeight, 0);
    scene.add(player);

    // Shared input module: keyboard state + pointer-lock mouse look.
    const input = new InputController({
      pointerLockTarget: canvas,
      initialPitch: INITIAL_PITCH,
      pitchClamp: PITCH_CLAMP,
    });

    // Shared HUD module: controls overlay + FPS counter. Attaches over the
    // canvas (its parent is the positioned #stage) and is removed on dispose.
    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      title: "Character Controller",
      controls: [
        "Click canvas — lock mouse",
        "WASD — move",
        "Mouse — look",
        "Space — jump",
        "Esc — release mouse",
      ],
    });

    // Movement / physics state owned by the sample.
    let velocityY = 0;
    let grounded = true;

    // Per-frame update (state only; the engine handles rendering).
    let raf = 0;
    let last = performance.now();
    const forward = new Vector3();
    const right = new Vector3();
    const move = new Vector3();

    const update = (now: number) => {
      raf = requestAnimationFrame(update);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      hud.frame(now);

      const yaw = input.yaw;
      const pitch = input.pitch;

      // Jump is edge-triggered: only fires the frame Space is first pressed.
      if (grounded && input.consumeJustPressed("Space")) {
        velocityY = JUMP_VELOCITY;
        grounded = false;
      }

      // Movement basis from yaw (horizontal plane).
      forward.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
      right.set(forward.z, 0, -forward.x);

      move.set(0, 0, 0);
      if (input.isDown("KeyW")) move.add(forward);
      if (input.isDown("KeyS")) move.sub(forward);
      if (input.isDown("KeyA")) move.add(right);
      if (input.isDown("KeyD")) move.sub(right);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(MOVE_SPEED * dt);
        player.position.x += move.x;
        player.position.z += move.z;
      }

      // Gravity + ground collision.
      velocityY += GRAVITY * dt;
      player.position.y += velocityY * dt;
      const floor = GROUND_Y + halfHeight;
      if (player.position.y <= floor) {
        player.position.y = floor;
        velocityY = 0;
        grounded = true;
      }

      // Face movement direction (yaw only).
      player.rotation.y = yaw;

      // Follow camera (spherical offset behind the player).
      const offset = new Vector3(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      ).multiplyScalar(-CAMERA_DISTANCE);
      camera.position.copy(player.position).add(offset);
      camera.position.y += CAMERA_HEIGHT * Math.cos(pitch);
      camera.lookAt(
        player.position.x,
        player.position.y + 0.5,
        player.position.z,
      );
    };
    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      input.dispose();
      hud.dispose();
    };
  },
};

export default sample;
