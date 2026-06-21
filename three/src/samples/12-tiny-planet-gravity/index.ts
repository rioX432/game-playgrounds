import {
  CapsuleGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import { Hud } from "../../engine/hud";
import { InputController } from "../../engine/input";
import { createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

// --- Tuning constants (no magic numbers in the logic below) ---

// The planet. Its center is the world origin; its surface IS the ground.
const PLANET_RADIUS = 8; // m
const PLANET_COLOR = 0x3b6e4b;
const PLANET_SEGMENTS = 48; // sphere tessellation (smooth horizon)

// Player capsule.
const CAPSULE_RADIUS = 0.35;
const CAPSULE_HEIGHT = 0.8; // cylinder part; total ~1.5m
const PLAYER_COLOR = 0x4aa3ff;
// Half the total capsule height: how far the player's center sits above the
// surface when grounded.
const PLAYER_HALF_HEIGHT = CAPSULE_HEIGHT / 2 + CAPSULE_RADIUS;

// Movement / gravity. Gravity is a positive magnitude pulling along -up
// (toward the planet center).
const MOVE_SPEED = 4; // m/s along the surface
const TURN_SPEED = 2.4; // rad/s heading turn (A/D)
const GRAVITY = 18; // m/s^2 radial pull toward center
const JUMP_VELOCITY = 7; // m/s radial impulse along +up

// Follow camera placement, expressed in the player's local surface frame.
const CAMERA_BACK = 6; // m behind the player (along -forward)
const CAMERA_UP = 3.5; // m above the player (along +up)
const CAMERA_LOOK_AHEAD = 1.0; // m above the player's center to aim at

const SCENE_BACKGROUND = 0x0b1020;

// World axis used only to SEED the initial heading. After the first frame the
// heading is carried on the tangent plane, so this seed never causes pole jank.
const HEADING_SEED = new Vector3(0, 0, 1);

const sample: Sample = {
  id: "12-tiny-planet-gravity",
  title: "Tiny Planet Gravity",
  summary:
    "Spherical gravity + walk-on-sphere. W/S walk, A/D turn, Space jump, up aligns to the surface normal.",
  tags: ["controller", "movement", "camera", "math"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;

    // Lighting only — the planet replaces the flat ground.
    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });

    // The planet. Centered at the origin; the player walks on its surface.
    const planet = new Mesh(
      new SphereGeometry(PLANET_RADIUS, PLANET_SEGMENTS, PLANET_SEGMENTS),
      new MeshStandardMaterial({ color: PLANET_COLOR }),
    );
    scene.add(planet);

    // Player capsule. Built along +Y locally; we re-orient it each frame so its
    // local up matches the surface normal.
    const player = new Mesh(
      new CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HEIGHT, 6, 12),
      new MeshStandardMaterial({ color: PLAYER_COLOR }),
    );
    scene.add(player);

    // Input: keyboard only (no pointer lock). A/D turn the heading, W/S move
    // along it — the most legible control for walk-on-sphere, and it sidesteps
    // pointer-lock + pole-singularity issues that mouse-yaw would introduce.
    const input = new InputController({
      pointerLockTarget: canvas,
      lockOnClick: false,
    });

    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      controls: [
        "W / S — walk forward / back",
        "A / D — turn left / right",
        "Space — jump",
      ],
    });

    // --- Player state ---
    // Start the player at the "north pole" of the planet, grounded.
    const playerPos = new Vector3(0, PLANET_RADIUS + PLAYER_HALF_HEIGHT, 0);
    // Current surface normal (local up). Seeded from the start position.
    const up = playerPos.clone().normalize();
    // Heading forward, kept TANGENT to the sphere and carried across frames so
    // the tangent basis stays continuous (no spin when crossing a pole). Seeded
    // by projecting a world axis onto the start tangent plane.
    const forward = HEADING_SEED.clone()
      .addScaledVector(up, -HEADING_SEED.dot(up))
      .normalize();
    let radialVelocity = 0; // along up; negative = falling toward the planet
    let grounded = false;

    // --- Reusable scratch (avoid per-frame allocation) ---
    const right = new Vector3();
    const moveDir = new Vector3();
    const localForward = new Vector3(); // capsule -Z column for the basis
    const basis = new Matrix4();
    const orient = new Quaternion();

    /**
     * Place + aim the follow camera. Kept as a standalone function so issue #14
     * (12b) can swap in a polished/smoothed camera without touching the
     * controller. The camera's own up is set to the surface normal so the
     * horizon curves and the "tiny planet" reads; without this the view flips
     * as the player rounds the globe.
     */
    function updateCamera(
      cam: PerspectiveCamera,
      pos: Vector3,
      camUp: Vector3,
      camForward: Vector3,
    ): void {
      cam.position
        .copy(pos)
        .addScaledVector(camForward, -CAMERA_BACK)
        .addScaledVector(camUp, CAMERA_UP);
      cam.up.copy(camUp);
      cam.lookAt(
        pos.x + camUp.x * CAMERA_LOOK_AHEAD,
        pos.y + camUp.y * CAMERA_LOOK_AHEAD,
        pos.z + camUp.z * CAMERA_LOOK_AHEAD,
      );
    }

    let raf = 0;
    let last = performance.now();

    const update = (now: number): void => {
      raf = requestAnimationFrame(update);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      hud.frame(now);

      // 1. Surface normal = direction from the planet center (origin) to the
      //    player. Recomputed every frame so up is always exact.
      up.copy(playerPos).normalize();

      // 2. Re-orthogonalize the carried heading against the NEW up. Carrying
      //    forward frame-to-frame (instead of rebuilding from a fixed world
      //    axis) keeps the tangent basis continuous across the poles.
      forward.addScaledVector(up, -forward.dot(up));
      if (forward.lengthSq() < 1e-8) {
        // Degenerate only if forward became parallel to up (shouldn't happen
        // with continuous carry); reseed from a world axis as a safety net.
        forward.copy(HEADING_SEED).addScaledVector(up, -HEADING_SEED.dot(up));
        if (forward.lengthSq() < 1e-8) {
          // HEADING_SEED was itself parallel to up; an orthogonal world axis is
          // guaranteed non-degenerate (up cannot be parallel to both).
          forward.set(1, 0, 0).addScaledVector(up, -up.x);
        }
      }
      forward.normalize();
      // right = forward x up gives a right-handed tangent frame.
      right.copy(forward).cross(up).normalize();

      // 3. Turn the heading about the surface normal (A/D rotate forward in the
      //    tangent plane).
      let turn = 0;
      if (input.isDown("KeyA")) turn += 1;
      if (input.isDown("KeyD")) turn -= 1;
      if (turn !== 0) {
        forward.applyAxisAngle(up, turn * TURN_SPEED * dt).normalize();
        right.copy(forward).cross(up).normalize();
      }

      // 4. Jump: radial impulse along +up (only when grounded).
      if (grounded && input.consumeJustPressed("Space")) {
        radialVelocity = JUMP_VELOCITY;
        grounded = false;
      }

      // 5. Tangential movement: step along the tangent plane (W/S). The
      //    re-projection in step 7 glues the player back onto the sphere.
      moveDir.set(0, 0, 0);
      if (input.isDown("KeyW")) moveDir.add(forward);
      if (input.isDown("KeyS")) moveDir.sub(forward);
      if (moveDir.lengthSq() > 0) {
        moveDir.normalize();
        playerPos.addScaledVector(moveDir, MOVE_SPEED * dt);
      }

      // 6. Gravity: integrate radial velocity along up (gravity pulls down).
      radialVelocity -= GRAVITY * dt;
      playerPos.addScaledVector(up, radialVelocity * dt);

      // 7. Re-project onto the surface. The player should sit exactly at
      //    radius + half-height when grounded; renormalizing the distance from
      //    center is the key trick that keeps the player glued to the sphere
      //    no matter how the tangential step moved it.
      const surfaceDistance = PLANET_RADIUS + PLAYER_HALF_HEIGHT;
      const distance = playerPos.length();
      if (distance <= surfaceDistance) {
        // Grounded: snap to the surface and kill downward radial velocity.
        playerPos.setLength(surfaceDistance);
        if (radialVelocity < 0) radialVelocity = 0;
        grounded = true;
      } else {
        grounded = false;
      }

      // 8. Orient the player so local up = surface normal and it faces forward.
      //    makeBasis takes the local X, Y, Z axes as columns; the capsule's
      //    local +Y is its up and local -Z is "forward", so we pass
      //    (right, up, -forward) to make the capsule face the heading.
      localForward.copy(forward).multiplyScalar(-1);
      basis.makeBasis(right, up, localForward);
      orient.setFromRotationMatrix(basis);
      player.quaternion.copy(orient);
      player.position.copy(playerPos);

      // 9. Follow camera (separable for #14).
      updateCamera(camera, playerPos, up, forward);
    };
    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      input.dispose();
      hud.dispose();
      lights.dispose();
      // Dispose sample-owned geometry/materials (the engine also clears the
      // scene on switch, but owning our resources keeps cleanup leak-free).
      planet.geometry.dispose();
      (planet.material as MeshStandardMaterial).dispose();
      scene.remove(planet);
      player.geometry.dispose();
      (player.material as MeshStandardMaterial).dispose();
      scene.remove(player);
      // Reset camera.up so the next sample starts with a standard Y-up camera.
      camera.up.set(0, 1, 0);
    };
  },
};

export default sample;
