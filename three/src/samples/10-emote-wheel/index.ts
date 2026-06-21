import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import { Hud } from "../../engine/hud";
import { InputController } from "../../engine/input";
import {
  createBoxGrid,
  createGround,
  createLightPreset,
} from "../../engine/scene";
import type { Sample, SampleContext } from "../types";
import { WheelOverlay } from "./wheel-overlay";

// --- Movement tuning (third-person follow so the player's POSE is visible). ---
const MOVE_SPEED = 5; // m/s
const GROUND_Y = 0;
const INITIAL_PITCH = 0.3;
const PITCH_CLAMP: [number, number] = [-0.2, 1.2];
const CAMERA_DISTANCE = 7;
const CAMERA_HEIGHT = 3.2;
const CAMERA_LOOK_HEIGHT = 1.0; // aim slightly above the player's base
const SCENE_BACKGROUND = 0x0d1117;
const START_X = 0;
const START_Z = 8;
const START_YAW = 0; // yaw 0 looks down -Z, toward the reference grid
const GRID_COUNT = 4;
const GRID_SPACING = 5;

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

const BODY_COLOR = 0x4aa3ff;
const HEAD_COLOR = 0xffd9a8;
const ARM_COLOR = 0x357ad0;

// --- Wheel / selection tuning. ---
const WHEEL_KEY = "KeyF"; // hold to open the emote wheel
// Mouse delta (px) accumulated into the selection vector is scaled so a small
// flick reaches the outer ring. Works WITH pointer lock: no cursor needed.
const SELECTION_SENSITIVITY = 1.0;
// Clamp the accumulated selection so it can't run off to infinity while held.
const SELECTION_MAX_PX = 200;

// --- Pose system. Each emote drives a procedural transform on the rig parts. ---
// Poses play for a fixed duration via a time accumulator, then return to idle.
const POSE_DURATION_DEFAULT = 1.4; // seconds a one-shot pose plays
const POSE_DURATION_LONG = 2.4; // for sustained poses (sit / crouch read longer)
const WAVE_FREQUENCY = 9; // rad/s of the wave oscillation
const WAVE_AMPLITUDE = 1.1; // radians the waving arm swings
const JUMP_HEIGHT = 1.1; // meters at the apex of a hop
const SPIN_TURNS = 2; // full turns during a spin
const CROUCH_SCALE_Y = 0.55; // body Y-scale while crouched
const SIT_DROP = 0.5; // meters the rig lowers when sitting
const SIT_TILT = -0.25; // radians the body leans back when sitting
const POINT_ARM_PITCH = -1.3; // radians the arm raises to point forward
const CLAP_FREQUENCY = 11; // rad/s of the clap oscillation
const CLAP_REACH = 0.55; // radians arms swing inward when clapping
const NOD_FREQUENCY = 6; // rad/s of the head nod
const NOD_AMPLITUDE = 0.4; // radians the head nods
const CHEER_FREQUENCY = 8; // rad/s of the cheering arm pump

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

/** Grouped primitive meshes that make up the visible player. */
interface PlayerRig {
  readonly root: Group;
  readonly body: Mesh;
  readonly head: Mesh;
  readonly leftArm: Group; // arm pivots are Groups so rotation is at the shoulder
  readonly rightArm: Group;
}

// Ease helper for hops: a single sine arch over the pose progress.
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
      rig.root.position.y = GROUND_Y + arch(progress) * JUMP_HEIGHT;
      rig.leftArm.rotation.z = 0.4 * arch(progress);
      rig.rightArm.rotation.z = -0.4 * arch(progress);
    },
  },
  {
    label: "Spin",
    duration: POSE_DURATION_DEFAULT,
    // Spin writes spinYaw; the sample composes it with the facing yaw after the
    // pose is applied, so the character whirls about its own up axis.
    apply: (rig, _t, progress) => {
      rig.spinYaw = progress * SPIN_TURNS * Math.PI * 2;
    },
  },
  {
    label: "Crouch",
    duration: POSE_DURATION_LONG,
    apply: (rig) => {
      rig.body.scale.y = CROUCH_SCALE_Y;
      rig.body.position.y = HIP_HEIGHT * CROUCH_SCALE_Y;
      rig.head.position.y = BODY_HEIGHT * CROUCH_SCALE_Y + HEAD_RADIUS * 0.6;
    },
  },
  {
    label: "Sit",
    duration: POSE_DURATION_LONG,
    apply: (rig) => {
      rig.root.position.y = GROUND_Y - SIT_DROP;
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

// Extend PlayerRig with a mutable spinYaw the Spin emote writes (applied to the
// rig root after pose application so it composes with the facing yaw).
interface PlayerRig {
  spinYaw: number;
}

/**
 * Build the multi-part player rig: body + head + two arms (arms parented to
 * pivot Groups so they rotate at the shoulder). All geometries/materials are
 * created here and freed by `disposeRig`.
 */
function createRig(): { rig: PlayerRig; dispose: () => void } {
  const bodyGeo = new BoxGeometry(BODY_WIDTH, BODY_HEIGHT, BODY_DEPTH);
  const bodyMat = new MeshStandardMaterial({ color: BODY_COLOR });
  const headGeo = new SphereGeometry(HEAD_RADIUS, 20, 16);
  const headMat = new MeshStandardMaterial({ color: HEAD_COLOR });
  const armGeo = new BoxGeometry(ARM_WIDTH, ARM_HEIGHT, ARM_DEPTH);
  const armMat = new MeshStandardMaterial({ color: ARM_COLOR });

  const root = new Group();

  const body = new Mesh(bodyGeo, bodyMat);
  body.position.y = HIP_HEIGHT;
  root.add(body);

  const head = new Mesh(headGeo, headMat);
  head.position.y = HEAD_CENTER_Y;
  root.add(head);

  // Arm pivots sit at shoulder height; the arm mesh hangs below the pivot so
  // rotating the pivot swings the whole arm about the shoulder.
  const makeArm = (side: -1 | 1): Group => {
    const pivot = new Group();
    pivot.position.set(side * ARM_REST_X, ARM_PIVOT_Y, 0);
    const arm = new Mesh(armGeo, armMat);
    arm.position.y = -ARM_HEIGHT / 2;
    pivot.add(arm);
    root.add(pivot);
    return pivot;
  };
  const leftArm = makeArm(-1);
  const rightArm = makeArm(1);

  const rig: PlayerRig = {
    root,
    body,
    head,
    leftArm,
    rightArm,
    spinYaw: 0,
  };

  const dispose = (): void => {
    bodyGeo.dispose();
    bodyMat.dispose();
    headGeo.dispose();
    headMat.dispose();
    armGeo.dispose();
    armMat.dispose();
  };

  return { rig, dispose };
}

/** Reset every rig transform a pose might touch back to its idle value. */
function resetRig(rig: PlayerRig): void {
  rig.root.position.y = GROUND_Y;
  rig.spinYaw = 0;
  rig.body.position.y = HIP_HEIGHT;
  rig.body.scale.set(1, 1, 1);
  rig.body.rotation.set(0, 0, 0);
  rig.head.position.y = HEAD_CENTER_Y;
  rig.head.rotation.set(0, 0, 0);
  rig.leftArm.rotation.set(0, 0, 0);
  rig.rightArm.rotation.set(0, 0, 0);
}

const sample: Sample = {
  id: "10-emote-wheel",
  title: "Emote / Pose Radial Wheel",
  summary:
    "Hold F to open a radial emote wheel; aim with the mouse to pick a sector; release to play the pose on the character.",
  tags: ["ui", "input", "mechanic"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;
    const container = canvas.parentElement ?? document.body;

    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });
    const ground = createGround(scene);
    const boxGrid = createBoxGrid(scene, {
      count: GRID_COUNT,
      spacing: GRID_SPACING,
    });

    const { rig, dispose: disposeRig } = createRig();
    rig.root.position.set(START_X, GROUND_Y, START_Z);
    scene.add(rig.root);

    const input = new InputController({
      pointerLockTarget: canvas,
      initialYaw: START_YAW,
      initialPitch: INITIAL_PITCH,
      pitchClamp: PITCH_CLAMP,
    });

    const wheel = new WheelOverlay({
      container,
      labels: EMOTES.map((e) => e.label),
    });

    const hud = new Hud({
      container,
      controls: [
        "Click canvas — lock mouse",
        "WASD — move",
        "Mouse — orbit camera",
        "Hold F — open emote wheel · move mouse to aim",
        "Release F — play selected emote (center = cancel)",
      ],
    });

    // Status readout: current emote.
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
    container.appendChild(status);

    // --- Wheel selection state (approach (a): accumulate mouse delta). ---
    // While F is held we read raw mouse deltas into (selX, selY); the wheel
    // owns the dead-zone + sector snap. We add our OWN mousemove listener (not
    // InputController's) so the camera look does NOT move while the wheel is
    // open — the same delta would otherwise spin the camera behind the wheel.
    let wheelOpen = false;
    let selX = 0;
    let selY = 0;
    // Single capture-phase listener: while the wheel is open it accumulates the
    // mouse delta into the selection vector AND stops the event before it
    // reaches InputController's bubble-phase listener, so the camera does not
    // also spin behind the wheel. When closed it is inert (camera look as usual).
    const onWheelMouseMove = (e: MouseEvent): void => {
      if (!wheelOpen || !input.isPointerLocked) return;
      selX = Math.max(
        -SELECTION_MAX_PX,
        Math.min(SELECTION_MAX_PX, selX + e.movementX * SELECTION_SENSITIVITY),
      );
      selY = Math.max(
        -SELECTION_MAX_PX,
        Math.min(SELECTION_MAX_PX, selY + e.movementY * SELECTION_SENSITIVITY),
      );
      e.stopImmediatePropagation();
    };
    window.addEventListener("mousemove", onWheelMouseMove, { capture: true });

    // --- Active emote playback state. ---
    let activeEmote: Emote | null = null;
    let emoteElapsed = 0;
    let currentLabel = "(idle)";

    // Per-frame state.
    let raf = 0;
    let last = performance.now();
    const forward = new Vector3();
    const right = new Vector3();
    const move = new Vector3();
    const camOffset = new Vector3();
    let facingYaw = START_YAW;

    const update = (now: number): void => {
      raf = requestAnimationFrame(update);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      hud.frame(now);

      // --- Open/close the wheel on F press/release (edge-triggered open). ---
      const fDown = input.isDown(WHEEL_KEY);
      if (fDown && !wheelOpen) {
        // Open: reset the selection to the dead-zone center.
        wheelOpen = true;
        selX = 0;
        selY = 0;
      } else if (!fDown && wheelOpen) {
        // Close: snap to the nearest sector and apply (null = cancel).
        wheelOpen = false;
        const sector = wheel.sectorFor(selX, selY);
        if (sector !== null) {
          activeEmote = EMOTES[sector];
          emoteElapsed = 0;
          currentLabel = activeEmote.label;
        }
      }

      // Draw the wheel (and read the live highlighted sector).
      const highlighted = wheel.render(selX, selY, wheelOpen);

      const yaw = input.yaw;
      const pitch = input.pitch;

      // Movement basis from yaw. Camera-relative forward: a YXZ camera at this
      // yaw looks down (-sin yaw, 0, -cos yaw). Movement is suspended while the
      // wheel is open so aiming the wheel doesn't also walk the character.
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
      right.set(forward.z, 0, -forward.x);
      move.set(0, 0, 0);
      if (!wheelOpen) {
        if (input.isDown("KeyW")) move.add(forward);
        if (input.isDown("KeyS")) move.sub(forward);
        if (input.isDown("KeyA")) move.add(right);
        if (input.isDown("KeyD")) move.sub(right);
      }
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(MOVE_SPEED * dt);
        rig.root.position.x += move.x;
        rig.root.position.z += move.z;
        facingYaw = Math.atan2(move.x, move.z);
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
      // Compose facing yaw with any spin the active emote requested.
      rig.root.rotation.y = facingYaw + rig.spinYaw;

      // --- Follow camera (spherical offset behind the player). ---
      camOffset
        .set(
          Math.sin(yaw) * Math.cos(pitch),
          Math.sin(pitch),
          Math.cos(yaw) * Math.cos(pitch),
        )
        .multiplyScalar(CAMERA_DISTANCE);
      camera.position.copy(rig.root.position).add(camOffset);
      camera.position.y += CAMERA_HEIGHT * Math.cos(pitch);
      camera.lookAt(
        rig.root.position.x,
        rig.root.position.y + CAMERA_LOOK_HEIGHT,
        rig.root.position.z,
      );

      // --- Status readout. ---
      const aiming =
        wheelOpen && highlighted !== null
          ? ` · aiming: ${EMOTES[highlighted].label}`
          : wheelOpen
            ? " · aiming: (cancel)"
            : "";
      status.textContent = `Emote: ${currentLabel}${aiming}`;
    };
    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onWheelMouseMove, {
        capture: true,
      });
      input.dispose();
      hud.dispose();
      wheel.dispose();
      status.remove();
      scene.remove(rig.root);
      disposeRig();
      lights.dispose();
      ground.dispose();
      boxGrid.dispose();
    };
  },
};

export default sample;
