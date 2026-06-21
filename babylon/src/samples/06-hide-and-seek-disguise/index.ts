import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { FollowCamera } from "@babylonjs/core/Cameras/followCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/Builders/boxBuilder"; // side-effect: CreateBox
import "@babylonjs/core/Meshes/Builders/cylinderBuilder"; // side-effect: CreateCylinder (barrel + cone)
import "@babylonjs/core/Meshes/Builders/sphereBuilder"; // side-effect: CreateSphere

import { createInput } from "../../engine/input";
import { createHud } from "../../engine/hud";
import { createGround, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

/**
 * Prop-hunt stealth. The player swaps their visible mesh to one of a small
 * catalog of prop shapes (crate / barrel / cone / sphere) to blend into
 * immovable decoys of the same shapes. The disguise only reads as hidden while
 * STANDING STILL; moving above a small speed threshold = EXPOSED (the active
 * prop tints red and wobbles). Third-person follow camera so you SEE your own
 * disguise. See README for the honest feel notes.
 */

// --- Movement tuning (reused from sample 01's third-person approach). ---
const MOVE_SPEED = 5; // units / s
const LOOK_SENSITIVITY = 0.0025;
const SCENE_BACKGROUND = new Color3(0.05, 0.07, 0.09);

// --- Disguise "tell" tuning (the honest core of prop-hunt). ---
// The disguise only reads as scenery while STILL. Any movement above this speed
// flips the player to EXPOSED: tinted red and wobbling so the tell is legible.
const EXPOSED_SPEED_THRESHOLD = 0.2; // units/s below which the player is hidden
const WOBBLE_FREQUENCY = 14; // rad/s — how fast the exposed prop jitters
const WOBBLE_AMPLITUDE = 0.12; // radians of tilt at full exposure
const WOBBLE_PITCH_RATIO = 0.5; // secondary-axis tilt relative to the main wobble
const TINT_LERP_RATE = 12; // how fast the tint/wobble eases in/out (per second)
const EXPOSED_TINT = new Color3(1, 0.23, 0.19); // red overlay applied while moving

// --- Prop catalog dimensions (hoisted so decoys match the player exactly). ---
const CRATE_SIZE = 1.4;
const BARREL_DIAMETER = 1.4;
const BARREL_HEIGHT = 1.5;
const CONE_DIAMETER = 1.7;
const CONE_HEIGHT = 1.7;
const SPHERE_DIAMETER = 1.6;
const CYLINDER_TESSELLATION = 20;
const CONE_TESSELLATION = 22;
const SPHERE_SEGMENTS = 24;

const CRATE_COLOR = new Color3(0.61, 0.42, 0.25);
const BARREL_COLOR = new Color3(0.29, 0.47, 0.66);
const CONE_COLOR = new Color3(0.37, 0.68, 0.37);
const SPHERE_COLOR = new Color3(0.69, 0.37, 0.68);

/** A prop shape: how to build its mesh, its base color, and its rest height. */
interface PropSpec {
  readonly label: string;
  /** Build a fresh mesh of this shape (player disguise or scattered decoy). */
  create(name: string, scene: Scene): Mesh;
  readonly baseColor: Color3;
  /** Y offset so the prop rests on the ground (half-height, or radius for sphere). */
  readonly restY: number;
}

const PROP_SPECS: readonly PropSpec[] = [
  {
    label: "Crate",
    create: (name, scene) =>
      MeshBuilder.CreateBox(name, { size: CRATE_SIZE }, scene),
    baseColor: CRATE_COLOR,
    restY: CRATE_SIZE / 2,
  },
  {
    label: "Barrel",
    create: (name, scene) =>
      MeshBuilder.CreateCylinder(
        name,
        {
          diameter: BARREL_DIAMETER,
          height: BARREL_HEIGHT,
          tessellation: CYLINDER_TESSELLATION,
        },
        scene,
      ),
    baseColor: BARREL_COLOR,
    restY: BARREL_HEIGHT / 2,
  },
  {
    label: "Cone",
    // A cone is a cylinder with a zero-diameter top.
    create: (name, scene) =>
      MeshBuilder.CreateCylinder(
        name,
        {
          diameterTop: 0,
          diameterBottom: CONE_DIAMETER,
          height: CONE_HEIGHT,
          tessellation: CONE_TESSELLATION,
        },
        scene,
      ),
    baseColor: CONE_COLOR,
    restY: CONE_HEIGHT / 2,
  },
  {
    label: "Sphere",
    create: (name, scene) =>
      MeshBuilder.CreateSphere(
        name,
        { diameter: SPHERE_DIAMETER, segments: SPHERE_SEGMENTS },
        scene,
      ),
    baseColor: SPHERE_COLOR,
    // Sphere rests on its radius, NOT half a height — forgetting this sinks it.
    restY: SPHERE_DIAMETER / 2,
  },
];

// Scattered immovable decoys so a still, correctly-disguised player blends into
// the crowd. Each entry cycles through the prop specs (index = position order).
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

function sample06Mount(ctx: SampleContext): () => void {
  const { scene } = ctx;
  scene.clearColor.set(
    SCENE_BACKGROUND.r,
    SCENE_BACKGROUND.g,
    SCENE_BACKGROUND.b,
    1,
  );

  // --- Stage: lights + ground are scene-owned (freed by scene.dispose). ---
  createLightPreset(scene);
  createGround(scene);

  // --- Shared decoy materials: ONE per prop shape, reused by every decoy of
  // that shape. These are immovable scenery; they are NEVER tinted, so tinting
  // the player's disguise cannot bleed into them. We own + dispose them. ---
  const decoyMaterials: StandardMaterial[] = PROP_SPECS.map((spec, i) => {
    const mat = new StandardMaterial(`decoyMat_${i}`, scene);
    mat.diffuseColor = spec.baseColor.clone();
    return mat;
  });

  const decoys: Mesh[] = DECOY_POSITIONS.map(([x, z], i) => {
    const specIndex = i % PROP_SPECS.length;
    const spec = PROP_SPECS[specIndex];
    const decoy = spec.create(`decoy_${i}`, scene);
    decoy.position.set(x, spec.restY, z);
    decoy.material = decoyMaterials[specIndex];
    return decoy;
  });

  // --- Player: a yaw pivot drives movement + heading (same as sample 01). The
  // disguise is a CATALOG of one mesh per prop shape, all parented to the pivot.
  // Exactly one is enabled at a time; Q/E cycle the enabled index. This swaps
  // shape with zero per-cycle allocation. Each disguise mesh owns its OWN
  // tintable material instance so the red EXPOSED tint never touches decoys. ---
  const yawPivot = new TransformNode("yawPivot", scene);
  yawPivot.position.set(0, 0, 10);

  const disguiseMeshes: Mesh[] = [];
  const disguiseMaterials: StandardMaterial[] = [];
  PROP_SPECS.forEach((spec, i) => {
    const mesh = spec.create(`disguise_${i}`, scene);
    mesh.parent = yawPivot;
    mesh.position.set(0, spec.restY, 0);
    const mat = new StandardMaterial(`disguiseMat_${i}`, scene);
    mat.diffuseColor = spec.baseColor.clone();
    mesh.material = mat;
    mesh.setEnabled(false);
    disguiseMeshes.push(mesh);
    disguiseMaterials.push(mat);
  });

  let disguiseIndex = 0;
  disguiseMeshes[disguiseIndex].setEnabled(true);

  /** Enable one disguise mesh (visual swap), disabling the rest. */
  const applyDisguise = (index: number): void => {
    disguiseMeshes[disguiseIndex].setEnabled(false);
    // Reset the previous disguise's tilt + tint so a re-show starts clean.
    disguiseMeshes[disguiseIndex].rotation.set(0, 0, 0);
    disguiseMaterials[disguiseIndex].diffuseColor.copyFrom(
      PROP_SPECS[disguiseIndex].baseColor,
    );

    disguiseIndex =
      ((index % PROP_SPECS.length) + PROP_SPECS.length) % PROP_SPECS.length;
    disguiseMeshes[disguiseIndex].setEnabled(true);
  };

  // --- Follow camera (third-person: you must SEE your disguise). Targets the
  // pivot so the camera tracks the player regardless of which mesh is shown. ---
  const camera = new FollowCamera(
    "followCam",
    new Vector3(0, 5, 0),
    scene,
    // reason: FollowCamera's lockedTarget is typed AbstractMesh, but a
    // TransformNode tracks fine (it only reads .position); the catalog meshes
    // are parented to this pivot so targeting the pivot follows whichever is shown.
    yawPivot as unknown as Mesh,
  );
  camera.radius = 7;
  camera.heightOffset = 3.5;
  camera.rotationOffset = 180;
  camera.cameraAcceleration = 0.08;
  camera.maxCameraSpeed = 20;

  // --- HUD: shared controls overlay + FPS. ---
  const hud = createHud(ctx, {
    title: "Controls",
    controls: [
      "WASD — move",
      "Mouse — look (click to lock pointer)",
      "Q / E — cycle disguise",
      "Stand still — HIDDEN · move — EXPOSED",
      "Esc — release pointer",
    ],
  });

  // --- Status panel (top-left, below the gallery card): disguise + state. ---
  const statusEl = document.createElement("div");
  Object.assign(statusEl.style, {
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
  const statusContainer = ctx.canvas.parentElement ?? document.body;
  statusContainer.appendChild(statusEl);

  // --- Input (shared: keyboard state + pointer-lock look). ---
  const input = createInput(ctx);
  let yaw = 0;
  let exposure = 0; // 0 = fully hidden, 1 = fully exposed (eased)
  let prevQ = false;
  let prevE = false;
  const prevPos = yawPivot.position.clone();

  const update = (): void => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    // Edge-triggered disguise cycling (Q back, E forward).
    const eDown = input.isKeyDown("KeyE");
    const qDown = input.isKeyDown("KeyQ");
    if (eDown && !prevE) applyDisguise(disguiseIndex + 1);
    if (qDown && !prevQ) applyDisguise(disguiseIndex - 1);
    prevE = eDown;
    prevQ = qDown;

    // Apply pointer-lock look to the yaw heading.
    yaw += input.consumeLookX() * LOOK_SENSITIVITY;
    yawPivot.rotation.y = yaw;

    // Movement vector in local frame, rotated by yaw (same basis as sample 01).
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
      yawPivot.position.x += (strafe * cos + forward * sin) * MOVE_SPEED * dt;
      yawPivot.position.z += (forward * cos - strafe * sin) * MOVE_SPEED * dt;
    }

    // The "tell": measure actual horizontal speed this frame.
    const dx = yawPivot.position.x - prevPos.x;
    const dz = yawPivot.position.z - prevPos.z;
    const speed = Math.hypot(dx, dz) / dt;
    prevPos.copyFrom(yawPivot.position);

    // Ease exposure so the red tint + wobble fade in/out smoothly (not a hard cut).
    const exposedNow = speed > EXPOSED_SPEED_THRESHOLD;
    const target = exposedNow ? 1 : 0;
    exposure += (target - exposure) * Math.min(1, TINT_LERP_RATE * dt);

    // Tint: lerp ONLY the active disguise material toward red by `exposure`.
    const activeMesh = disguiseMeshes[disguiseIndex];
    const activeMat = disguiseMaterials[disguiseIndex];
    Color3.LerpToRef(
      PROP_SPECS[disguiseIndex].baseColor,
      EXPOSED_TINT,
      exposure,
      activeMat.diffuseColor,
    );

    // Wobble: tilt the active prop while exposed so motion is unmistakable.
    const t = performance.now() * 0.001;
    const wobble = Math.sin(t * WOBBLE_FREQUENCY) * WOBBLE_AMPLITUDE * exposure;
    activeMesh.rotation.z = wobble;
    activeMesh.rotation.x = wobble * WOBBLE_PITCH_RATIO;

    // Status readout.
    const stateText = exposedNow ? "EXPOSED" : "HIDDEN";
    const stateColor = exposedNow ? "#ff6b61" : "#5fd97a";
    statusEl.innerHTML =
      `Disguise: ${PROP_SPECS[disguiseIndex].label}<br>` +
      `State: <span style="color:${stateColor};font-weight:600">${stateText}</span>`;
  };
  const updateObserver = scene.onBeforeRenderObservable.add(update);

  // --- Dispose: own-what-you-create. scene.dispose() would free scene meshes,
  // but we are explicit. We dispose the disguise meshes + their tintable
  // materials, the decoy meshes + their shared materials, the pivot, the status
  // DOM, shared input/HUD, and the render observer. Nothing is allocated per
  // disguise cycle, so cycling can't leak. ---
  return () => {
    input.dispose();
    hud.dispose();
    statusEl.remove();
    scene.onBeforeRenderObservable.remove(updateObserver);
    for (const mesh of disguiseMeshes) mesh.dispose();
    for (const mat of disguiseMaterials) mat.dispose();
    for (const decoy of decoys) decoy.dispose();
    for (const mat of decoyMaterials) mat.dispose();
    yawPivot.dispose();
  };
}

export const sample06: Sample = {
  id: "06-hide-and-seek-disguise",
  title: "Hide & Seek — Prop Disguise",
  summary:
    "Prop-hunt disguise: cycle your shape to blend into nearby props; stand still to stay HIDDEN, move and you go EXPOSED.",
  tags: ["stealth", "controller", "mechanic"],
  mount: sample06Mount,
};

export default sample06;
