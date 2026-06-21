import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import { Hud } from "../../engine/hud";
import { InputController } from "../../engine/input";
import { createGround, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

// --- Movement tuning (third-person follow so the player SEES the doll's face). ---
const MOVE_SPEED = 5; // m/s
const GROUND_Y = 0;
const INITIAL_PITCH = 0.28;
const PITCH_CLAMP: [number, number] = [-0.2, 1.2];
const CAMERA_DISTANCE = 8;
const CAMERA_HEIGHT = 4;
const CAMERA_LOOK_HEIGHT = 1; // aim slightly above the player's base
const SCENE_BACKGROUND = 0x0d1117;
const START_X = 0;
const START_Z = 18; // player starts at the near end; doll is far down -Z
const START_YAW = 0; // yaw 0 looks down -Z, toward the doll + finish line

// --- Phase state machine (the core "red-light / green-light" loop). ---
// GREEN: doll faces away, movement is safe.
// TURNING: brief telegraph — doll rotates to face the player; still safe.
// RED: doll faces the player; any movement above the threshold = CAUGHT.
const GREEN_DURATION = 3; // s the doll stays turned away (safe to move)
const TURNING_DURATION = 0.45; // s the doll spends rotating to face you (telegraph)
const RED_DURATION = 2.5; // s the doll watches; moving here gets you caught
// Grace window at the start of RED: detection is suppressed for a beat so a
// player mid-step has a fair chance to stop. Documented in the README feel
// notes — it makes the mechanic forgiving rather than twitchy.
const RED_GRACE = 0.18; // s of immunity right after RED begins
// Speed below which the player counts as "still". A small tolerance absorbs
// float jitter from position deltas (no false catches when standing still).
const MOTION_THRESHOLD = 0.25; // m/s

// --- Win condition: reach the finish line past the doll. ---
const FINISH_Z = -6; // crossing this (moving -Z) past the doll = WIN
const DOLL_Z = -10; // doll sits beyond the finish line, watching back toward you

// Phase tints applied to the scene background, so the state is legible even
// peripherally (the classic "the lighting goes red" tell).
const GREEN_BG = 0x0e1f14;
const RED_BG = 0x2a0e0e;
const TURNING_BG = 0x231a0c;

type Phase = "GREEN" | "TURNING" | "RED" | "CAUGHT" | "WIN";

// --- Doll geometry tuning (a simple watcher: body + head + a "face" marker). ---
const DOLL_BODY_RADIUS_TOP = 0.5;
const DOLL_BODY_RADIUS_BOTTOM = 0.9;
const DOLL_BODY_HEIGHT = 2.4;
const DOLL_BODY_SEGMENTS = 24;
const DOLL_HEAD_RADIUS = 0.7;
const DOLL_HEAD_SEGMENTS = 24;
const DOLL_HEAD_Y = 2.7;
const DOLL_FACE_SIZE = 0.5;
const DOLL_FACE_DEPTH_RATIO = 0.4;
const DOLL_FACE_Z = DOLL_HEAD_RADIUS - 0.05; // face marker on +Z side of head
const DOLL_BODY_COLOR = 0xd98c3f;
const DOLL_HEAD_COLOR = 0xf2d6b3;
const DOLL_FACE_COLOR = 0x2a0e0e;
// The doll's local +Z is where its face points. yaw=PI faces toward the player
// (down +Z, since the player is at +Z); yaw=0 faces away. We ease between them.
const DOLL_FACE_AWAY_YAW = 0;
const DOLL_FACE_PLAYER_YAW = Math.PI;
// How fast the doll snaps its facing toward the target, and how fast the
// background tint eases between phase colors.
const EASE_RATE = 12; // per second

// --- Player marker. ---
const PLAYER_RADIUS = 0.5;
const PLAYER_HEIGHT = 1.6;
const PLAYER_SEGMENTS = 20;
const PLAYER_COLOR = 0x4aa3ff;

// --- Finish line strip on the ground. ---
const FINISH_WIDTH = 24;
const FINISH_DEPTH = 0.4;
const FINISH_COLOR = 0xf2e34a;

const sample: Sample = {
  id: "08-red-light-green-light",
  title: "Red Light, Green Light",
  summary:
    "Move only when the doll faces away (GREEN). Move while it watches (RED) and you're CAUGHT. Reach the line to WIN.",
  tags: ["mechanic", "controller", "state-machine"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;

    // Shared stage primitives (own + dispose their own GPU resources).
    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });
    const ground = createGround(scene);

    // --- Doll watcher (a group we rotate to face away / toward the player). ---
    const dollGroup = new Group();
    const dollBodyGeo = new CylinderGeometry(
      DOLL_BODY_RADIUS_TOP,
      DOLL_BODY_RADIUS_BOTTOM,
      DOLL_BODY_HEIGHT,
      DOLL_BODY_SEGMENTS,
    );
    const dollBodyMat = new MeshStandardMaterial({ color: DOLL_BODY_COLOR });
    const dollBody = new Mesh(dollBodyGeo, dollBodyMat);
    dollBody.position.y = DOLL_BODY_HEIGHT / 2;
    dollGroup.add(dollBody);

    const dollHeadGeo = new SphereGeometry(
      DOLL_HEAD_RADIUS,
      DOLL_HEAD_SEGMENTS,
      DOLL_HEAD_SEGMENTS,
    );
    const dollHeadMat = new MeshStandardMaterial({ color: DOLL_HEAD_COLOR });
    const dollHead = new Mesh(dollHeadGeo, dollHeadMat);
    dollHead.position.y = DOLL_HEAD_Y;
    dollGroup.add(dollHead);

    // A dark "face" plate on the head's +Z side marks which way the doll looks.
    const dollFaceGeo = new BoxGeometry(
      DOLL_FACE_SIZE,
      DOLL_FACE_SIZE,
      DOLL_FACE_SIZE * DOLL_FACE_DEPTH_RATIO,
    );
    const dollFaceMat = new MeshStandardMaterial({ color: DOLL_FACE_COLOR });
    const dollFace = new Mesh(dollFaceGeo, dollFaceMat);
    dollFace.position.set(0, DOLL_HEAD_Y, DOLL_FACE_Z);
    dollGroup.add(dollFace);

    dollGroup.position.set(0, GROUND_Y, DOLL_Z);
    dollGroup.rotation.y = DOLL_FACE_AWAY_YAW;
    scene.add(dollGroup);

    // --- Finish line strip on the ground. ---
    const finishGeo = new BoxGeometry(FINISH_WIDTH, FINISH_DEPTH, FINISH_DEPTH);
    const finishMat = new MeshStandardMaterial({ color: FINISH_COLOR });
    const finishLine = new Mesh(finishGeo, finishMat);
    finishLine.position.set(0, GROUND_Y + FINISH_DEPTH / 2, FINISH_Z);
    scene.add(finishLine);

    // --- Player marker. ---
    const playerGeo = new CylinderGeometry(
      PLAYER_RADIUS,
      PLAYER_RADIUS,
      PLAYER_HEIGHT,
      PLAYER_SEGMENTS,
    );
    const playerMat = new MeshStandardMaterial({ color: PLAYER_COLOR });
    const player = new Mesh(playerGeo, playerMat);
    player.position.set(START_X, GROUND_Y + PLAYER_HEIGHT / 2, START_Z);
    scene.add(player);

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
        "WASD — move (GREEN only!)",
        "Mouse — orbit camera",
        "R — reset",
        "GREEN move · RED freeze · reach the line to WIN",
      ],
    });

    // Status panel (top-left, below the gallery card): phase + outcome.
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
      fontSize: "13px",
      lineHeight: "1.6",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      zIndex: "10",
    } as Partial<CSSStyleDeclaration>);
    (canvas.parentElement ?? document.body).appendChild(status);

    // --- Phase state. ---
    let phase: Phase = "GREEN";
    let phaseTimer = 0; // seconds elapsed in the current timed phase
    let dollFacing = DOLL_FACE_AWAY_YAW; // eased facing yaw of the doll

    // Per-frame scratch.
    let raf = 0;
    let last = performance.now();
    const forward = new Vector3();
    const right = new Vector3();
    const move = new Vector3();
    const prevPos = new Vector3().copy(player.position);
    const camOffset = new Vector3();
    const bgColor = new Color(SCENE_BACKGROUND);
    const greenBg = new Color(GREEN_BG);
    const redBg = new Color(RED_BG);
    const turningBg = new Color(TURNING_BG);

    /** Reset to a fresh GREEN run at the start position. */
    const reset = (): void => {
      phase = "GREEN";
      phaseTimer = 0;
      player.position.set(START_X, GROUND_Y + PLAYER_HEIGHT / 2, START_Z);
      player.rotation.y = 0;
      prevPos.copy(player.position);
    };

    /** Advance the GREEN -> TURNING -> RED -> GREEN cycle by dt. */
    const advancePhase = (dt: number): void => {
      phaseTimer += dt;
      if (phase === "GREEN" && phaseTimer >= GREEN_DURATION) {
        phase = "TURNING";
        phaseTimer = 0;
      } else if (phase === "TURNING" && phaseTimer >= TURNING_DURATION) {
        phase = "RED";
        phaseTimer = 0;
      } else if (phase === "RED" && phaseTimer >= RED_DURATION) {
        phase = "GREEN";
        phaseTimer = 0;
      }
    };

    const update = (now: number): void => {
      raf = requestAnimationFrame(update);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      hud.frame(now);

      // Reset is always available (edge-triggered).
      if (input.consumeJustPressed("KeyR")) reset();

      // Movement is allowed in every non-terminal phase; whether it is SAFE
      // depends on the phase (the whole point of the mechanic).
      const playable =
        phase === "GREEN" || phase === "TURNING" || phase === "RED";

      if (playable) {
        advancePhase(dt);

        const yaw = input.yaw;
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
          player.rotation.y = Math.atan2(move.x, move.z);
        }

        // Measure actual speed this frame (distance / dt), independent of the
        // input flags so float jitter can't fake motion and a held key with no
        // displacement can't hide it.
        const speed = dt > 0 ? prevPos.distanceTo(player.position) / dt : 0;
        prevPos.copy(player.position);

        // Detection: during RED (after the grace window) any motion above the
        // threshold = CAUGHT. The grace window gives reaction time at the
        // green->red flip so the mechanic is fair, not twitchy.
        if (
          phase === "RED" &&
          phaseTimer > RED_GRACE &&
          speed > MOTION_THRESHOLD
        ) {
          phase = "CAUGHT";
        }

        // Win: crossing the finish line (past the doll) ends the run.
        if (player.position.z <= FINISH_Z) {
          phase = "WIN";
        }
      } else {
        // Terminal phases: keep prevPos synced so a later reset is clean.
        prevPos.copy(player.position);
      }

      // Doll facing: GREEN faces away, TURNING/RED face the player. CAUGHT/WIN
      // hold the last facing. Ease toward the target so the turn reads smoothly.
      const facingTarget =
        phase === "GREEN" ? DOLL_FACE_AWAY_YAW : DOLL_FACE_PLAYER_YAW;
      dollFacing += (facingTarget - dollFacing) * Math.min(1, EASE_RATE * dt);
      dollGroup.rotation.y = dollFacing;

      // Background tint follows the phase so the state is legible peripherally.
      let bgTarget = greenBg;
      if (phase === "TURNING") bgTarget = turningBg;
      else if (phase === "RED" || phase === "CAUGHT") bgTarget = redBg;
      bgColor.lerp(bgTarget, Math.min(1, EASE_RATE * dt));
      (scene.background as Color).copy(bgColor);

      // Follow camera (spherical offset behind the player).
      const yaw = input.yaw;
      const pitch = input.pitch;
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
      let label: string = phase;
      let color = "#5fd97a";
      if (phase === "RED" || phase === "CAUGHT") color = "#ff6b61";
      else if (phase === "TURNING") color = "#f2c14a";
      if (phase === "CAUGHT") label = "CAUGHT — press R";
      else if (phase === "WIN") label = "WIN! — press R";
      status.innerHTML = `Phase: <span style="color:${color};font-weight:600">${label}</span>`;
    };
    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      input.dispose();
      hud.dispose();
      status.remove();

      // Free every geometry + material this sample created.
      dollBodyGeo.dispose();
      dollBodyMat.dispose();
      dollHeadGeo.dispose();
      dollHeadMat.dispose();
      dollFaceGeo.dispose();
      dollFaceMat.dispose();
      finishGeo.dispose();
      finishMat.dispose();
      playerGeo.dispose();
      playerMat.dispose();
      scene.remove(dollGroup);
      scene.remove(finishLine);
      scene.remove(player);

      // Stage primitives free their own GPU resources.
      lights.dispose();
      ground.dispose();
    };
  },
};

export default sample;
