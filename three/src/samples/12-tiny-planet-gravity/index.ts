import {
  CapsuleGeometry,
  ConeGeometry,
  DodecahedronGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import type { BufferGeometry } from "three";
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

// Camera smoothing. The camera position and its up vector are damped toward
// their targets so rounding the globe feels fluid instead of stiff. Rates are
// in 1/s; the per-frame blend is `1 - exp(-rate*dt)` (frame-rate-independent).
const CAMERA_POS_DAMP = 12; // higher = snappier position follow
const CAMERA_UP_DAMP = 8; // lower = gentler horizon re-leveling
// If the damped up nears antiparallel to its target (the player crossed far
// enough that a lerp would pass through zero), snap instead of interpolating to
// avoid a degenerate near-zero up that flips the view.
const CAMERA_UP_FLIP_DOT = -0.99;

// Environment props scattered on the planet surface. Each prop's local +Y is
// aligned to the surface normal at its location so it sticks out radially.
const PROP_COLOR_ROCK = 0x6b6f76;
const PROP_COLOR_TREE_TRUNK = 0x6e4a2b;
const PROP_COLOR_TREE_LEAF = 0x2f7d4f;
const ROCK_RADIUS = 0.55; // dodecahedron circumradius
const TREE_TRUNK_RADIUS = 0.16;
const TREE_TRUNK_HEIGHT = 1.0;
const TREE_LEAF_RADIUS = 0.7;
const TREE_LEAF_HEIGHT = 1.6;
const PROP_GEOMETRY_DETAIL = 0; // dodecahedron subdivision (0 = faceted rock)
const CONE_RADIAL_SEGMENTS = 10;

// Prop placements as (latitude, longitude) in radians + a kind. Spread across
// the equator, both poles, and the underside so we can verify radial
// orientation everywhere on the sphere. Latitude: +pi/2 = north pole, 0 =
// equator, -pi/2 = south pole (underside relative to the start).
type PropKind = "rock" | "tree";
interface PropPlacement {
  kind: PropKind;
  lat: number; // radians, [-pi/2, pi/2]
  lon: number; // radians
}
const HALF_PI = Math.PI / 2;
const PROP_PLACEMENTS: readonly PropPlacement[] = [
  { kind: "tree", lat: 0, lon: 0 }, // equator, facing the start heading
  { kind: "rock", lat: 0, lon: HALF_PI }, // equator, quarter around
  { kind: "tree", lat: 0, lon: Math.PI }, // equator, far side
  { kind: "rock", lat: 0.6, lon: -0.8 }, // mid-northern
  { kind: "tree", lat: -0.6, lon: 2.2 }, // mid-southern
  { kind: "rock", lat: HALF_PI - 0.25, lon: 1.0 }, // near north pole
  { kind: "tree", lat: -HALF_PI + 0.25, lon: -2.0 }, // near south pole (underside)
  { kind: "rock", lat: -1.1, lon: 0.4 }, // underside
];

const SCENE_BACKGROUND = 0x0b1020;

// World axis used only to SEED the initial heading. After the first frame the
// heading is carried on the tangent plane, so this seed never causes pole jank.
const HEADING_SEED = new Vector3(0, 0, 1);

/** +Y in local space — the axis we align to each prop's surface normal. */
const LOCAL_UP = new Vector3(0, 1, 0);

/**
 * Tracks every prop geometry/material so the sample's dispose path frees them
 * exactly once. Materials are shared across props of the same kind (cheap, and
 * disposed once), so we dedupe before recording. Returns a single `Group` to
 * add to the scene plus a `dispose()` that removes it and frees all owned GPU
 * resources — mirroring the engine's PrimitiveSet ownership contract.
 */
interface PropSet {
  readonly root: Group;
  dispose(): void;
}

function createProps(radius: number): PropSet {
  const root = new Group();
  root.name = "tiny-planet-props";

  // Shared materials (one per color, reused across props).
  const rockMaterial = new MeshStandardMaterial({ color: PROP_COLOR_ROCK });
  const trunkMaterial = new MeshStandardMaterial({
    color: PROP_COLOR_TREE_TRUNK,
  });
  const leafMaterial = new MeshStandardMaterial({ color: PROP_COLOR_TREE_LEAF });

  // Shared geometries (one per prop part).
  const rockGeometry = new DodecahedronGeometry(
    ROCK_RADIUS,
    PROP_GEOMETRY_DETAIL,
  );
  const trunkGeometry = new ConeGeometry(
    TREE_TRUNK_RADIUS,
    TREE_TRUNK_HEIGHT,
    CONE_RADIAL_SEGMENTS,
  );
  const leafGeometry = new ConeGeometry(
    TREE_LEAF_RADIUS,
    TREE_LEAF_HEIGHT,
    CONE_RADIAL_SEGMENTS,
  );

  const geometries: BufferGeometry[] = [
    rockGeometry,
    trunkGeometry,
    leafGeometry,
  ];
  const materials: MeshStandardMaterial[] = [
    rockMaterial,
    trunkMaterial,
    leafMaterial,
  ];

  // Scratch reused across placements (no per-prop allocation churn).
  const surfacePos = new Vector3();
  const normal = new Vector3();
  const orient = new Quaternion();

  for (const placement of PROP_PLACEMENTS) {
    // Spherical (lat, lon) -> Cartesian point ON the sphere surface.
    const cosLat = Math.cos(placement.lat);
    surfacePos.set(
      radius * cosLat * Math.sin(placement.lon),
      radius * Math.sin(placement.lat),
      radius * cosLat * Math.cos(placement.lon),
    );
    // Surface normal = direction from the planet center (origin) outward.
    normal.copy(surfacePos).normalize();
    // Align local +Y to the normal so the prop stands radially out of the
    // surface, not toward world up. Stable for any normal (setFromUnitVectors
    // handles the antiparallel case internally).
    orient.setFromUnitVectors(LOCAL_UP, normal);

    if (placement.kind === "rock") {
      const rock = new Mesh(rockGeometry, rockMaterial);
      // Sink the rock slightly so its flat-ish base meets the surface.
      rock.position.copy(surfacePos).addScaledVector(normal, ROCK_RADIUS * 0.4);
      rock.quaternion.copy(orient);
      root.add(rock);
    } else {
      // A "tree": a trunk cone topped by a wider leaf cone, both built along
      // +Y and parented under one group that we orient as a whole. Cones are
      // centered on their height, so each part is pushed out by half its height
      // (plus the previous part) along the normal.
      const tree = new Group();
      const trunk = new Mesh(trunkGeometry, trunkMaterial);
      trunk.position.set(0, TREE_TRUNK_HEIGHT / 2, 0);
      const leaf = new Mesh(leafGeometry, leafMaterial);
      leaf.position.set(0, TREE_TRUNK_HEIGHT + TREE_LEAF_HEIGHT / 2, 0);
      tree.add(trunk, leaf);
      tree.position.copy(surfacePos);
      tree.quaternion.copy(orient);
      root.add(tree);
    }
  }

  let disposed = false;
  return {
    root,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      root.clear();
    },
  };
}

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

    // Environment props scattered on the surface, each oriented so its local
    // +Y points along the surface normal (radially out). Static scenery; the
    // PropSet owns its geometries/materials and frees them on dispose.
    const props = createProps(PLANET_RADIUS);
    scene.add(props.root);

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

    // --- Smoothed camera state (persists across frames) ---
    // The camera's actual position and up are damped toward their targets so
    // the view glides as the player rounds the globe. Seeded on the first frame
    // (cameraReady = false) so there's no startup lerp from the world origin.
    const cameraPos = new Vector3();
    const cameraUp = up.clone();
    const desiredCameraPos = new Vector3();
    let cameraReady = false;

    /**
     * Place + aim the polished follow camera (12b). Kept as a standalone
     * function so the controller never has to know about camera feel.
     *
     * Both the camera position and the camera's own up are damped toward their
     * targets with a frame-rate-independent blend `t = 1 - exp(-rate*dt)` so the
     * view glides instead of snapping as the player rounds the globe — turning
     * around the sphere feels far less stiff than hard-setting every frame.
     *
     * The camera up tracks the surface normal so the horizon curves and the
     * "tiny planet" reads. If the smoothed up would cross near-antiparallel to
     * its target (a degenerate lerp that passes through zero and flips the
     * view), we snap the up instead. On the first frame everything is seeded
     * directly so there's no startup swoop from the origin.
     */
    function updateCamera(
      cam: PerspectiveCamera,
      pos: Vector3,
      targetUp: Vector3,
      camForward: Vector3,
      dt: number,
    ): void {
      // Desired camera position in the player's current surface frame.
      desiredCameraPos
        .copy(pos)
        .addScaledVector(camForward, -CAMERA_BACK)
        .addScaledVector(targetUp, CAMERA_UP);

      if (!cameraReady) {
        cameraReady = true;
        cameraPos.copy(desiredCameraPos);
        cameraUp.copy(targetUp);
      } else {
        // Frame-rate-independent damping blend factors.
        const posT = 1 - Math.exp(-CAMERA_POS_DAMP * dt);
        const upT = 1 - Math.exp(-CAMERA_UP_DAMP * dt);
        cameraPos.lerp(desiredCameraPos, posT);
        // Guard the up lerp against a degenerate near-antiparallel blend.
        if (cameraUp.dot(targetUp) < CAMERA_UP_FLIP_DOT) {
          cameraUp.copy(targetUp);
        } else {
          cameraUp.lerp(targetUp, upT).normalize();
        }
      }

      cam.position.copy(cameraPos);
      cam.up.copy(cameraUp);
      cam.lookAt(
        pos.x + targetUp.x * CAMERA_LOOK_AHEAD,
        pos.y + targetUp.y * CAMERA_LOOK_AHEAD,
        pos.z + targetUp.z * CAMERA_LOOK_AHEAD,
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

      // 9. Polished follow camera (separable; smoothing handled inside).
      updateCamera(camera, playerPos, up, forward, dt);
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
      // Props own their (shared) geometries/materials; free them once.
      props.dispose();
      scene.remove(props.root);
      player.geometry.dispose();
      (player.material as MeshStandardMaterial).dispose();
      scene.remove(player);
      // Reset camera.up so the next sample starts with a standard Y-up camera.
      camera.up.set(0, 1, 0);
    };
  },
};

export default sample;
