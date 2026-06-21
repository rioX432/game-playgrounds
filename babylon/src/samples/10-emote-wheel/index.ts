import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { FollowCamera } from "@babylonjs/core/Cameras/followCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/Builders/boxBuilder"; // side-effect: CreateBox
import "@babylonjs/core/Meshes/Builders/sphereBuilder"; // side-effect: CreateSphere

import { createInput } from "../../engine/input";
import { createHud } from "../../engine/hud";
import { createGround, createBoxGrid, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";
import { WheelOverlay } from "./wheel-overlay";

/**
 * Hold F to open a radial emote wheel; aim a sector with the mouse; release to
 * play a procedural pose on a third-person primitive character.
 *
 * Babylon-specific design note (the clean fix for the pointer-lock double-use):
 * the shared `createInput` already routes mouse-look ONLY through
 * `consumeLookX/Y()` — nothing reads the raw event. So while the wheel is open
 * we simply feed that consumed delta into the 2D selection vector instead of the
 * camera yaw, and suspend WASD. No capture-phase `mousemove` swallow is needed
 * (which is what the Three.js sibling had to do). The trade-off is honest: the
 * camera/heading freezes the instant the wheel opens (documented in README).
 */

// --- Movement tuning (third-person follow so the player's POSE is visible). ---
const MOVE_SPEED = 6; // units / s
const LOOK_SENSITIVITY = 0.0025; // yaw radians per look pixel (matches sample 01)
const SCENE_CLEAR = new Color3(0.6, 0.75, 0.9);

// --- Player rig dimensions (a simple multi-part body so poses read clearly). ---
const BODY_WIDTH = 0.7;
const BODY_HEIGHT = 1.0;
const BODY_DEPTH = 0.4;
const HEAD_RADIUS = 0.28;
const ARM_WIDTH = 0.16;
const ARM_HEIGHT = 0.62;
const ARM_DEPTH = 0.16;
const ARM_GAP = 0.06; // gap between body side and arm
const HIP_HEIGHT = BODY_HEIGHT / 2; // body center above the rig origin (feet)
const HEAD_CENTER_Y = BODY_HEIGHT + HEAD_RADIUS * 0.6;
const ARM_PIVOT_Y = BODY_HEIGHT - ARM_HEIGHT * 0.1; // shoulder height
const ARM_REST_X = BODY_WIDTH / 2 + ARM_GAP + ARM_WIDTH / 2;

const BODY_COLOR = new Color3(0.29, 0.64, 1.0);
const HEAD_COLOR = new Color3(1.0, 0.85, 0.66);
const ARM_COLOR = new Color3(0.21, 0.48, 0.82);

// --- Camera framing. ---
const CAMERA_RADIUS = 9;
const CAMERA_HEIGHT = 4;

// --- Wheel / selection tuning. ---
const WHEEL_KEY = "KeyF"; // hold to open the emote wheel
// Look delta (px) accumulated into the selection vector is scaled so a small
// flick reaches the outer ring. Works WITH pointer lock: no cursor needed.
const SELECTION_SENSITIVITY = 1.0;

// --- Pose system. Each emote drives a procedural transform on the rig parts. ---
// Poses play for a fixed duration via a time accumulator, then return to idle.
const POSE_DURATION_DEFAULT = 1.4; // seconds a one-shot pose plays
const POSE_DURATION_LONG = 2.4; // for sustained poses (sit / crouch read longer)
const WAVE_FREQUENCY = 9; // rad/s of the wave oscillation
const WAVE_AMPLITUDE = 1.1; // radians the waving arm swings
const JUMP_HEIGHT = 1.1; // units at the apex of a hop
const SPIN_TURNS = 2; // full turns during a spin
const CROUCH_SCALE_Y = 0.55; // body Y-scale while crouched
const SIT_DROP = 0.5; // units the rig lowers when sitting
const SIT_TILT = -0.25; // radians the body leans back when sitting
const POINT_ARM_PITCH = -1.3; // radians the arm raises to point forward
const CLAP_FREQUENCY = 11; // rad/s of the clap oscillation
const CLAP_REACH = 0.55; // radians arms swing inward when clapping
const NOD_FREQUENCY = 6; // rad/s of the head nod
const NOD_AMPLITUDE = 0.4; // radians the head nods
const CHEER_FREQUENCY = 8; // rad/s of the cheering arm pump

/** Grouped primitive nodes that make up the visible player. */
interface PlayerRig {
  /** Root under the yaw pivot; holds the whole body. Spin rotates this. */
  readonly root: TransformNode;
  readonly body: Mesh;
  readonly head: Mesh;
  /** Arm pivots are TransformNodes so rotation happens at the shoulder. */
  readonly leftArm: TransformNode;
  readonly rightArm: TransformNode;
  /** Whole-body spin yaw the Spin emote writes; composed onto root each frame. */
  spinYaw: number;
}

/** A named emote with a duration and a per-frame pose application. */
interface Emote {
  readonly label: string;
  readonly duration: number;
  /**
   * Apply this emote to the rig. `t` is elapsed seconds since the emote started;
   * `progress` is `t / duration` clamped to [0, 1]. The rig is reset to idle
   * before each call, so each emote only sets the transforms it cares about.
   */
  readonly apply: (rig: PlayerRig, t: number, progress: number) => void;
}

// Ease helper for hops/bows: a single sine arch over the pose progress.
const arch = (progress: number): number => Math.sin(progress * Math.PI);

// The 10-emote catalog. Sector 0 = top, clockwise.
const EMOTES: Emote[] = [
  {
    label: "Wave",
    duration: POSE_DURATION_DEFAULT,
    apply: (rig, t) => {
      rig.rightArm.rotation.z =
        -1.4 + Math.sin(t * WAVE_FREQUENCY) * (WAVE_AMPLITUDE * 0.4) - 0.2;
      rig.rightArm.rotation.x = Math.sin(t * WAVE_FREQUENCY) * WAVE_AMPLITUDE;
    },
  },
  {
    label: "Jump",
    duration: POSE_DURATION_DEFAULT,
    apply: (rig, _t, progress) => {
      rig.root.position.y = arch(progress) * JUMP_HEIGHT;
      rig.leftArm.rotation.z = 0.4 * arch(progress);
      rig.rightArm.rotation.z = -0.4 * arch(progress);
    },
  },
  {
    label: "Spin",
    duration: POSE_DURATION_DEFAULT,
    // Spin writes spinYaw; it is composed onto root.rotation.y after the pose is
    // applied, so the character whirls about its own up axis.
    apply: (rig, _t, progress) => {
      rig.spinYaw = progress * SPIN_TURNS * Math.PI * 2;
    },
  },
  {
    label: "Crouch",
    duration: POSE_DURATION_LONG,
    apply: (rig) => {
      rig.body.scaling.y = CROUCH_SCALE_Y;
      rig.body.position.y = HIP_HEIGHT * CROUCH_SCALE_Y;
      rig.head.position.y = BODY_HEIGHT * CROUCH_SCALE_Y + HEAD_RADIUS * 0.6;
    },
  },
  {
    label: "Sit",
    duration: POSE_DURATION_LONG,
    apply: (rig) => {
      rig.root.position.y = -SIT_DROP;
      rig.body.rotation.x = SIT_TILT;
    },
  },
  {
    label: "Point",
    duration: POSE_DURATION_DEFAULT,
    apply: (rig) => {
      rig.rightArm.rotation.x = POINT_ARM_PITCH;
    },
  },
  {
    label: "Clap",
    duration: POSE_DURATION_DEFAULT,
    apply: (rig, t) => {
      const swing = (Math.sin(t * CLAP_FREQUENCY) * 0.5 + 0.5) * CLAP_REACH;
      rig.leftArm.rotation.x = -1.0;
      rig.rightArm.rotation.x = -1.0;
      rig.leftArm.rotation.z = -swing;
      rig.rightArm.rotation.z = swing;
    },
  },
  {
    label: "Nod",
    duration: POSE_DURATION_DEFAULT,
    apply: (rig, t) => {
      rig.head.rotation.x = Math.sin(t * NOD_FREQUENCY) * NOD_AMPLITUDE - 0.1;
    },
  },
  {
    label: "Cheer",
    duration: POSE_DURATION_DEFAULT,
    apply: (rig, t) => {
      const pump = Math.sin(t * CHEER_FREQUENCY) * 0.3;
      rig.leftArm.rotation.z = 2.4 + pump;
      rig.rightArm.rotation.z = -2.4 - pump;
    },
  },
  {
    label: "Bow",
    duration: POSE_DURATION_DEFAULT,
    apply: (rig, _t, progress) => {
      rig.body.rotation.x = arch(progress) * 1.0;
      rig.head.rotation.x = arch(progress) * 0.3;
    },
  },
];

/**
 * Build the multi-part player rig parented under `parent` (the yaw pivot):
 * body + head + two arms (arms parented to pivot TransformNodes so they rotate
 * at the shoulder). Meshes/materials are created here and freed by `disposeRig`.
 */
function createRig(
  scene: Scene,
  parent: TransformNode,
): { rig: PlayerRig; dispose: () => void } {
  const bodyMat = new StandardMaterial("emoteBodyMat", scene);
  bodyMat.diffuseColor = BODY_COLOR.clone();
  const headMat = new StandardMaterial("emoteHeadMat", scene);
  headMat.diffuseColor = HEAD_COLOR.clone();
  const armMat = new StandardMaterial("emoteArmMat", scene);
  armMat.diffuseColor = ARM_COLOR.clone();

  const root = new TransformNode("emoteRigRoot", scene);
  root.parent = parent;

  const body = MeshBuilder.CreateBox(
    "emoteBody",
    { width: BODY_WIDTH, height: BODY_HEIGHT, depth: BODY_DEPTH },
    scene,
  );
  body.material = bodyMat;
  body.parent = root;
  body.position.y = HIP_HEIGHT;

  const head = MeshBuilder.CreateSphere(
    "emoteHead",
    { diameter: HEAD_RADIUS * 2, segments: 16 },
    scene,
  );
  head.material = headMat;
  head.parent = root;
  head.position.y = HEAD_CENTER_Y;

  // Arm pivots sit at shoulder height; the arm mesh hangs below the pivot so
  // rotating the pivot swings the whole arm about the shoulder.
  const armMeshes: Mesh[] = [];
  const makeArm = (side: -1 | 1, name: string): TransformNode => {
    const pivot = new TransformNode(name, scene);
    pivot.parent = root;
    pivot.position.set(side * ARM_REST_X, ARM_PIVOT_Y, 0);
    const arm = MeshBuilder.CreateBox(
      `${name}Mesh`,
      { width: ARM_WIDTH, height: ARM_HEIGHT, depth: ARM_DEPTH },
      scene,
    );
    arm.material = armMat;
    arm.parent = pivot;
    arm.position.y = -ARM_HEIGHT / 2;
    armMeshes.push(arm);
    return pivot;
  };
  const leftArm = makeArm(-1, "emoteLeftArm");
  const rightArm = makeArm(1, "emoteRightArm");

  const rig: PlayerRig = {
    root,
    body,
    head,
    leftArm,
    rightArm,
    spinYaw: 0,
  };

  const dispose = (): void => {
    // Dispose meshes and pivots explicitly; the shared armMat is disposed once
    // below (mesh.dispose() does not free a material still referenced elsewhere).
    body.dispose();
    head.dispose();
    for (const arm of armMeshes) arm.dispose();
    leftArm.dispose();
    rightArm.dispose();
    root.dispose();
    bodyMat.dispose();
    headMat.dispose();
    armMat.dispose();
  };

  return { rig, dispose };
}

/** Reset every rig transform a pose might touch back to its idle value. */
function resetRig(rig: PlayerRig): void {
  rig.root.position.y = 0;
  rig.spinYaw = 0;
  rig.body.position.y = HIP_HEIGHT;
  rig.body.scaling.set(1, 1, 1);
  rig.body.rotation.set(0, 0, 0);
  rig.head.position.y = HEAD_CENTER_Y;
  rig.head.rotation.set(0, 0, 0);
  rig.leftArm.rotation.set(0, 0, 0);
  rig.rightArm.rotation.set(0, 0, 0);
}

function sample10Mount(ctx: SampleContext): () => void {
  const { scene, canvas } = ctx;
  scene.clearColor.set(SCENE_CLEAR.r, SCENE_CLEAR.g, SCENE_CLEAR.b, 1);
  const container = canvas.parentElement ?? document.body;

  // --- Lighting / ground / obstacles via shared scene primitives ---
  // Owned by the scene, freed by scene.dispose() on switch.
  createLightPreset(scene);
  createGround(scene);
  createBoxGrid(scene, { columns: 4, rows: 4, boxSize: 2, spacing: 8 });

  // --- Player rig parented to the yaw pivot (heading) ---
  const yawPivot = new TransformNode("yawPivot", scene);
  const { rig, dispose: disposeRig } = createRig(scene, yawPivot);

  // --- Follow camera tracks the body so the pose stays framed ---
  const camera = new FollowCamera(
    "followCam",
    new Vector3(0, CAMERA_HEIGHT, -CAMERA_RADIUS),
    scene,
    rig.body,
  );
  camera.radius = CAMERA_RADIUS;
  camera.heightOffset = CAMERA_HEIGHT;
  camera.rotationOffset = 180;
  camera.cameraAcceleration = 0.08;
  camera.maxCameraSpeed = 20;

  // --- HUD (shared module: controls overlay bottom-left + FPS top-right) ---
  const hud = createHud(ctx, {
    title: "Controls",
    controls: [
      "Click — lock pointer",
      "WASD — move (suspended while wheel open)",
      "Hold F — open emote wheel · move mouse to aim",
      "Release F — play emote (center = cancel)",
      "Esc — release pointer",
    ],
  });

  // --- Wheel overlay (self-owned 2D canvas, removed in dispose) ---
  const wheel = new WheelOverlay({
    container,
    labels: EMOTES.map((e) => e.label),
  });

  // --- Status readout: current emote + live aim. ---
  const status = document.createElement("div");
  Object.assign(status.style, {
    position: "absolute",
    bottom: "12px",
    right: "12px",
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
  container.appendChild(status);

  // --- Input (shared module: keyboard state + pointer-lock look) ---
  const input = createInput(ctx);
  let yaw = 0;

  // --- Wheel selection state. While F is held we route the consumed look delta
  // into (selX, selY) instead of yaw, and suspend WASD. This is the clean fix
  // for the pointer-lock double-use: the look delta only ever reaches the
  // selection vector here, so the camera/heading does not also spin. ---
  let wheelOpen = false;
  let selX = 0;
  let selY = 0;

  // --- Active emote playback state. ---
  let activeEmote: Emote | null = null;
  let emoteElapsed = 0;
  let currentLabel = "(idle)";

  const update = (): void => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    // Always consume the look delta so it never accumulates stale; route it to
    // either the selection vector (wheel open) or the heading yaw (wheel closed).
    const lookX = input.consumeLookX();
    const lookY = input.consumeLookY();

    // --- Open/close the wheel on F press/release (edge-triggered open). ---
    const fDown = input.isKeyDown(WHEEL_KEY);
    if (fDown && !wheelOpen) {
      // Open: reset the selection to the dead-zone center.
      wheelOpen = true;
      selX = 0;
      selY = 0;
    } else if (!fDown && wheelOpen) {
      // Close: snap to the highlighted sector and apply (null = cancel).
      wheelOpen = false;
      const sector = wheel.sectorFor(selX, selY);
      if (sector !== null) {
        activeEmote = EMOTES[sector];
        emoteElapsed = 0;
        currentLabel = activeEmote.label;
      }
    }

    if (wheelOpen) {
      // Integrate the look delta into the selection vector, clamp to the rim.
      selX += lookX * SELECTION_SENSITIVITY;
      selY += lookY * SELECTION_SENSITIVITY;
      const dist = Math.hypot(selX, selY);
      const rim = wheel.rimRadius;
      if (dist > rim) {
        selX = (selX / dist) * rim;
        selY = (selY / dist) * rim;
      }
    } else {
      // Normal look: the delta drives the heading yaw.
      yaw += lookX * LOOK_SENSITIVITY;
    }
    yawPivot.rotation.y = yaw;

    // Draw the wheel (and read the live highlighted sector).
    const highlighted = wheel.render(selX, selY, wheelOpen);

    // --- Movement (suspended while the wheel is open so aiming doesn't walk). ---
    let forward = 0;
    let strafe = 0;
    if (!wheelOpen) {
      if (input.isKeyDown("KeyW")) forward += 1;
      if (input.isKeyDown("KeyS")) forward -= 1;
      if (input.isKeyDown("KeyD")) strafe += 1;
      if (input.isKeyDown("KeyA")) strafe -= 1;
    }
    if (forward !== 0 || strafe !== 0) {
      const len = Math.hypot(forward, strafe);
      forward /= len;
      strafe /= len;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      yawPivot.position.x += (strafe * cos + forward * sin) * MOVE_SPEED * dt;
      yawPivot.position.z += (forward * cos - strafe * sin) * MOVE_SPEED * dt;
    }

    // --- Pose application. Reset to idle, then apply the active emote. ---
    resetRig(rig);
    if (activeEmote) {
      emoteElapsed += dt;
      const progress = Math.min(1, emoteElapsed / activeEmote.duration);
      activeEmote.apply(rig, emoteElapsed, progress);
      if (emoteElapsed >= activeEmote.duration) {
        activeEmote = null;
        currentLabel = "(idle)";
      }
    }
    // Compose any spin onto the rig root (heading stays on the yaw pivot).
    rig.root.rotation.y = rig.spinYaw;

    // --- Status readout. ---
    const aiming =
      wheelOpen && highlighted !== null
        ? ` · aiming: ${EMOTES[highlighted].label}`
        : wheelOpen
          ? " · aiming: (cancel)"
          : "";
    status.textContent = `Emote: ${currentLabel}${aiming}`;
  };
  const updateObserver = scene.onBeforeRenderObservable.add(update);

  // --- Dispose ---
  // input.dispose() removes its observers + pointer-lock listener and releases
  // the lock if owned. hud.dispose() removes its DOM + FPS observer. The wheel
  // overlay and status div are our own DOM and must be removed here. The rig
  // meshes/materials + arm pivot TransformNodes are freed by disposeRig. The
  // render observer is scene-owned but detached here for tidy teardown.
  return () => {
    scene.onBeforeRenderObservable.remove(updateObserver);
    input.dispose();
    hud.dispose();
    wheel.dispose();
    status.remove();
    disposeRig();
    yawPivot.dispose();
  };
}

export const sample10: Sample = {
  id: "10-emote-wheel",
  title: "Emote / Pose Radial Wheel",
  summary:
    "Hold F to open a radial emote wheel; aim with the mouse to pick a sector; release to play the pose on a third-person character.",
  tags: ["ui", "input", "mechanic"],
  mount: sample10Mount,
};

export default sample10;
