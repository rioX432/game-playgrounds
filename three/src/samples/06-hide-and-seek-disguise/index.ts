import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import type { BufferGeometry } from "three";
import { Hud } from "../../engine/hud";
import { InputController } from "../../engine/input";
import { createGround, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

// --- Movement tuning (third-person follow so the player SEES their disguise). ---
const MOVE_SPEED = 5; // m/s
const GROUND_Y = 0;
const INITIAL_PITCH = 0.25;
const PITCH_CLAMP: [number, number] = [-0.3, 1.2];
const CAMERA_DISTANCE = 7;
const CAMERA_HEIGHT = 3.5;
const CAMERA_LOOK_HEIGHT = 0.6; // aim the camera slightly above the prop's base
const SCENE_BACKGROUND = 0x0d1117;
const START_X = 0;
const START_Z = 10;
const START_YAW = 0; // yaw 0 looks down -Z, toward the scattered props

// --- Disguise "tell" tuning (the honest core of prop-hunt). ---
// The disguise only reads as scenery while STILL. Any movement above this speed
// flips the player to "EXPOSED": tinted red and wobbling so the tell is legible.
const EXPOSED_SPEED_THRESHOLD = 0.2; // m/s below which the player counts as hidden
const WOBBLE_FREQUENCY = 14; // rad/s — how fast the exposed prop jitters
const WOBBLE_AMPLITUDE = 0.12; // radians of tilt at full exposure
const EXPOSED_TINT = 0xff3b30; // red overlay applied while moving
const TINT_LERP_RATE = 12; // how fast the tint eases in/out (per second)
const WOBBLE_PITCH_RATIO = 0.5; // secondary axis tilt relative to the main wobble

// --- Prop catalog (created ONCE, disposed ONCE — no per-swap allocation). ---
// Each entry is a distinct {geometry, material} pair. Swapping a disguise only
// re-points the player mesh at one of these; it never creates or frees GPU
// resources mid-run, so cycling disguises can't leak.
interface PropType {
  readonly label: string;
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardMaterial;
  /** Base color, restored when the player is hidden (tint eases back to this). */
  readonly baseColor: Color;
  /** Y offset so the prop rests on the ground (half-height of its shape). */
  readonly restY: number;
}

// Shape dimensions, hoisted so the scattered decoys match the player exactly.
const CRATE_SIZE = 1.4;
const BARREL_RADIUS = 0.7;
const BARREL_HEIGHT = 1.5;
const CONE_RADIUS = 0.85;
const CONE_HEIGHT = 1.7;
const SPHERE_RADIUS = 0.8;
const BARREL_RADIAL_SEGMENTS = 20;
const CONE_RADIAL_SEGMENTS = 22;
const SPHERE_SEGMENTS = 24;

const CRATE_COLOR = 0x9c6b3f;
const BARREL_COLOR = 0x4a78a8;
const CONE_COLOR = 0x5fae5f;
const SPHERE_COLOR = 0xb05fae;

/**
 * Build the fixed catalog of disguise prop types. All geometries/materials live
 * for the whole sample lifetime; `disposeCatalog` frees every one of them.
 */
function createCatalog(): PropType[] {
  const make = (
    label: string,
    geometry: BufferGeometry,
    color: number,
    restY: number,
  ): PropType => ({
    label,
    geometry,
    material: new MeshStandardMaterial({ color }),
    baseColor: new Color(color),
    restY,
  });

  return [
    make(
      "Crate",
      new BoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE),
      CRATE_COLOR,
      CRATE_SIZE / 2,
    ),
    make(
      "Barrel",
      new CylinderGeometry(
        BARREL_RADIUS,
        BARREL_RADIUS,
        BARREL_HEIGHT,
        BARREL_RADIAL_SEGMENTS,
      ),
      BARREL_COLOR,
      BARREL_HEIGHT / 2,
    ),
    make(
      "Cone",
      new ConeGeometry(CONE_RADIUS, CONE_HEIGHT, CONE_RADIAL_SEGMENTS),
      CONE_COLOR,
      CONE_HEIGHT / 2,
    ),
    make(
      "Sphere",
      new SphereGeometry(SPHERE_RADIUS, SPHERE_SEGMENTS, SPHERE_SEGMENTS),
      SPHERE_COLOR,
      SPHERE_RADIUS,
    ),
  ];
}

/** Free every geometry + material in the catalog exactly once. */
function disposeCatalog(catalog: PropType[]): void {
  for (const prop of catalog) {
    prop.geometry.dispose();
    prop.material.dispose();
  }
}

// --- Scattered environment decoys: immovable copies of each prop type so a
// still, correctly-disguised player blends into the crowd. ---
const DECOY_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [-6, -2],
  [-3, -8],
  [3, -6],
  [7, -1],
  [-8, -7],
  [5, -10],
  [0, -4],
  [-4, -12],
];

const sample: Sample = {
  id: "06-hide-and-seek-disguise",
  title: "Hide & Seek — Prop Disguise",
  summary:
    "Prop-hunt disguise. Cycle your form to blend into nearby props; move and the disguise breaks (EXPOSED).",
  tags: ["stealth", "controller", "mechanic"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;

    // Shared stage primitives (own + dispose their own GPU resources).
    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });
    const ground = createGround(scene);

    // Fixed prop catalog: created once, disposed once.
    const catalog = createCatalog();

    // Scatter immovable decoys (one per position, cycling through prop types)
    // so the player has scenery to blend into. They share the catalog's
    // geometry/material — no extra GPU resources, nothing extra to dispose.
    const decoys: Mesh[] = [];
    DECOY_POSITIONS.forEach(([x, z], i) => {
      const prop = catalog[i % catalog.length];
      const decoy = new Mesh(prop.geometry, prop.material);
      decoy.position.set(x, GROUND_Y + prop.restY, z);
      scene.add(decoy);
      decoys.push(decoy);
    });

    // The player: a single mesh whose geometry is swapped to the selected
    // catalog entry. It owns its OWN material instance so we can tint it red
    // (the "tell") without affecting the shared decoys.
    let disguiseIndex = 0;
    const playerMaterial = new MeshStandardMaterial();
    const player = new Mesh(catalog[disguiseIndex].geometry, playerMaterial);
    player.position.set(START_X, GROUND_Y, START_Z);
    scene.add(player);

    /** Point the player mesh at a catalog entry (visual swap, no allocation). */
    const applyDisguise = (index: number): void => {
      disguiseIndex =
        ((index % catalog.length) + catalog.length) % catalog.length;
      const prop = catalog[disguiseIndex];
      player.geometry = prop.geometry;
      player.position.y = GROUND_Y + prop.restY;
    };
    applyDisguise(disguiseIndex);

    const input = new InputController({
      pointerLockTarget: canvas,
      initialYaw: START_YAW,
      initialPitch: INITIAL_PITCH,
      pitchClamp: PITCH_CLAMP,
    });

    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      controls: [
        "Click canvas — lock mouse",
        "WASD — move",
        "Mouse — orbit camera",
        "Q / E — cycle disguise",
        "Stand still — HIDDEN · move — EXPOSED",
      ],
    });

    // Status panel (top-left, below the gallery card): disguise + hidden state.
    const status = document.createElement("div");
    Object.assign(status.style, {
      position: "absolute",
      top: "64px",
      left: "12px",
      padding: "8px 10px",
      borderRadius: "8px",
      background: "rgba(11, 14, 19, 0.72)",
      border: "1px solid rgba(74, 163, 255, 0.25)",
      color: "#e6edf3",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "12px",
      lineHeight: "1.5",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      zIndex: "10",
    } as Partial<CSSStyleDeclaration>);
    (canvas.parentElement ?? document.body).appendChild(status);

    // Per-frame state.
    let raf = 0;
    let last = performance.now();
    let exposure = 0; // 0 = fully hidden, 1 = fully exposed (eased)
    const forward = new Vector3();
    const right = new Vector3();
    const move = new Vector3();
    const prevPos = new Vector3().copy(player.position);
    const camOffset = new Vector3();
    const tintColor = new Color(EXPOSED_TINT);
    const litColor = new Color();

    const update = (now: number): void => {
      raf = requestAnimationFrame(update);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      hud.frame(now);

      // Edge-triggered disguise cycling (Q back, E forward).
      if (input.consumeJustPressed("KeyE")) applyDisguise(disguiseIndex + 1);
      if (input.consumeJustPressed("KeyQ")) applyDisguise(disguiseIndex - 1);

      const yaw = input.yaw;
      const pitch = input.pitch;

      // Movement basis from yaw. Camera-consistent forward (yaw 0 looks -Z).
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
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
        // Face movement direction so the disguise turns with you.
        player.rotation.y = Math.atan2(move.x, move.z);
      }

      // The "tell": measure actual speed this frame, decide hidden/exposed.
      const speed = dt > 0 ? prevPos.distanceTo(player.position) / dt : 0;
      prevPos.copy(player.position);
      const exposedNow = speed > EXPOSED_SPEED_THRESHOLD;
      const target = exposedNow ? 1 : 0;
      // Ease exposure so the red tint and wobble fade in/out smoothly.
      exposure += (target - exposure) * Math.min(1, TINT_LERP_RATE * dt);

      // Tint: lerp the player's base color toward red by the exposure amount.
      const base = catalog[disguiseIndex].baseColor;
      litColor.copy(base).lerp(tintColor, exposure);
      playerMaterial.color.copy(litColor);

      // Wobble: tilt the prop while exposed so motion is unmistakable.
      const wobble =
        Math.sin(now * 0.001 * WOBBLE_FREQUENCY) * WOBBLE_AMPLITUDE * exposure;
      player.rotation.z = wobble;
      player.rotation.x = wobble * WOBBLE_PITCH_RATIO;

      // Follow camera (spherical offset behind the player).
      camOffset
        .set(
          Math.sin(yaw) * Math.cos(pitch),
          Math.sin(pitch),
          Math.cos(yaw) * Math.cos(pitch),
        )
        .multiplyScalar(CAMERA_DISTANCE);
      camera.position.copy(player.position).add(camOffset);
      camera.position.y += CAMERA_HEIGHT * Math.cos(pitch);
      camera.lookAt(
        player.position.x,
        player.position.y + CAMERA_LOOK_HEIGHT,
        player.position.z,
      );

      // Status readout.
      const stateText = exposedNow ? "EXPOSED" : "HIDDEN";
      const stateColor = exposedNow ? "#ff6b61" : "#5fd97a";
      status.innerHTML =
        `Disguise: ${catalog[disguiseIndex].label}<br>` +
        `State: <span style="color:${stateColor};font-weight:600">${stateText}</span>`;
    };
    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      input.dispose();
      hud.dispose();
      status.remove();
      // Player owns its own material (the tintable one); dispose it explicitly.
      playerMaterial.dispose();
      scene.remove(player);
      // Decoys share catalog geometry/material; just detach them.
      for (const decoy of decoys) scene.remove(decoy);
      // Free EVERY catalog geometry + material (not just the active disguise).
      disposeCatalog(catalog);
      // Stage primitives free their own GPU resources.
      lights.dispose();
      ground.dispose();
    };
  },
};

export default sample;
