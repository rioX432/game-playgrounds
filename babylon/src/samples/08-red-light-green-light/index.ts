import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { FollowCamera } from "@babylonjs/core/Cameras/followCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import "@babylonjs/core/Meshes/Builders/capsuleBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import { createInput } from "../../engine/input";
import { createHud } from "../../engine/hud";
import { createGround, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

/**
 * Red Light, Green Light (だるまさんがころんだ / Squid Game round 1).
 *
 * A GREEN(move) / RED(freeze) phase state machine with motion detection. Moving
 * during RED (after a short grace window) eliminates you. Cross the finish line
 * past the doll to WIN.
 *
 * Reuses sample 01's third-person model: FollowCamera + `yawPivot` + the shared
 * pointer-lock look. The movement basis is identical to sample 01 (proven in
 * Babylon's left-handed frame): worldX = strafe·cos + forward·sin,
 * worldZ = forward·cos − strafe·sin. With yaw 0, W moves +Z — so the player
 * starts at -Z and walks toward +Z, where the doll and finish line sit.
 */

// --- Movement tuning. ---
const MOVE_SPEED = 6; // units / s
const LOOK_SENSITIVITY = 0.0025;

// --- Layout. Player starts near (-Z), doll watches from far (+Z). ---
const PLAYER_HEIGHT = 2;
const PLAYER_RADIUS = 0.5;
const START_Z = -18; // near end; walk toward +Z
const FINISH_Z = 6; // crossing this (moving +Z) past the doll = WIN
const DOLL_Z = 10; // doll sits beyond the finish line, watching back toward you

// --- Phase state machine (the core "red-light / green-light" loop). ---
// GREEN:   doll faces away, movement is safe.
// TURNING: brief telegraph — doll rotates to face the player; still safe.
// RED:     doll faces the player; movement above the threshold = CAUGHT.
const GREEN_DURATION = 3; // s the doll stays turned away (safe to move)
const TURNING_DURATION = 0.45; // s the doll spends rotating to face you (telegraph)
const RED_DURATION = 2.5; // s the doll watches; moving here gets you caught
// Grace window at the start of RED: detection is suppressed for a beat so a
// player mid-step has a fair chance to stop. Documented in the README.
const RED_GRACE = 0.18; // s of immunity right after RED begins
// Speed below which the player counts as "still". A small tolerance absorbs
// float jitter from the world-position delta (no false catches when standing).
const MOTION_THRESHOLD = 0.25; // units / s

type Phase = "GREEN" | "TURNING" | "RED" | "CAUGHT" | "WIN";

// --- Doll watcher geometry (body + head + a dark "face" plate). ---
const DOLL_BODY_TOP = 0.5;
const DOLL_BODY_BOTTOM = 0.9;
const DOLL_BODY_HEIGHT = 2.4;
const DOLL_HEAD_RADIUS = 0.7;
const DOLL_HEAD_Y = 2.7;
const DOLL_FACE_SIZE = 0.5;
const DOLL_FACE_DEPTH = 0.2;
const DOLL_FACE_Z = DOLL_HEAD_RADIUS - 0.05; // plate on +Z side of head (its forward)
// The doll's local +Z is where its face points. Under `rotation.y = θ` the local
// +Z axis maps to world (sin θ, 0, cos θ). The player stands at -Z relative to the
// doll, so yaw=0 faces +Z=away from the player and yaw=PI faces -Z=toward them.
const DOLL_FACE_AWAY_YAW = 0; // GREEN: face +Z, away from the player
const DOLL_FACE_PLAYER_YAW = Math.PI; // RED: face -Z, toward the player
// How fast the doll eases its facing toward the target, and how fast the
// background tint eases between phase colors.
const EASE_RATE = 12; // per second

// --- Finish line strip on the ground. ---
const FINISH_WIDTH = 24;
const FINISH_THICKNESS = 0.4;

// --- Phase background tints (mutated IN PLACE on scene.clearColor each frame). ---
const GREEN_BG: readonly [number, number, number] = [0.055, 0.122, 0.078];
const TURNING_BG: readonly [number, number, number] = [0.137, 0.102, 0.047];
const RED_BG: readonly [number, number, number] = [0.165, 0.055, 0.055];

function sample08Mount(ctx: SampleContext): () => void {
  const { scene } = ctx;
  // Start tinted GREEN; we mutate these components in place every frame.
  scene.clearColor.set(GREEN_BG[0], GREEN_BG[1], GREEN_BG[2], 1);

  // --- Lighting / ground via shared scene primitives (scene-owned). ---
  createLightPreset(scene);
  createGround(scene);

  // --- Player capsule on a yaw pivot (same model as sample 01). ---
  const player = MeshBuilder.CreateCapsule(
    "rlgl_player",
    { height: PLAYER_HEIGHT, radius: PLAYER_RADIUS },
    scene,
  );
  const playerMat = new StandardMaterial("rlgl_playerMat", scene);
  playerMat.diffuseColor = new Color3(0.2, 0.45, 0.85);
  player.material = playerMat;

  const yawPivot = new TransformNode("rlgl_yawPivot", scene);
  player.parent = yawPivot;
  player.position.set(0, PLAYER_HEIGHT / 2, 0);
  yawPivot.position.set(0, 0, START_Z);

  // --- Doll watcher (rotate the PARENT, not the child meshes). ---
  const dollPivot = new TransformNode("rlgl_dollPivot", scene);
  dollPivot.position.set(0, 0, DOLL_Z);
  dollPivot.rotation.y = DOLL_FACE_AWAY_YAW;

  const dollBody = MeshBuilder.CreateCylinder(
    "rlgl_dollBody",
    {
      diameterTop: DOLL_BODY_TOP * 2,
      diameterBottom: DOLL_BODY_BOTTOM * 2,
      height: DOLL_BODY_HEIGHT,
      tessellation: 24,
    },
    scene,
  );
  dollBody.parent = dollPivot;
  dollBody.position.y = DOLL_BODY_HEIGHT / 2;
  const dollBodyMat = new StandardMaterial("rlgl_dollBodyMat", scene);
  dollBodyMat.diffuseColor = new Color3(0.85, 0.55, 0.25);
  dollBody.material = dollBodyMat;

  const dollHead = MeshBuilder.CreateSphere(
    "rlgl_dollHead",
    { diameter: DOLL_HEAD_RADIUS * 2, segments: 24 },
    scene,
  );
  dollHead.parent = dollPivot;
  dollHead.position.y = DOLL_HEAD_Y;
  const dollHeadMat = new StandardMaterial("rlgl_dollHeadMat", scene);
  dollHeadMat.diffuseColor = new Color3(0.95, 0.84, 0.7);
  dollHead.material = dollHeadMat;

  // Dark face plate on the head's +Z side marks which way the doll looks.
  const dollFace = MeshBuilder.CreateBox(
    "rlgl_dollFace",
    { width: DOLL_FACE_SIZE, height: DOLL_FACE_SIZE, depth: DOLL_FACE_DEPTH },
    scene,
  );
  dollFace.parent = dollPivot;
  dollFace.position.set(0, DOLL_HEAD_Y, DOLL_FACE_Z);
  const dollFaceMat = new StandardMaterial("rlgl_dollFaceMat", scene);
  dollFaceMat.diffuseColor = new Color3(0.16, 0.05, 0.05);
  dollFace.material = dollFaceMat;

  // --- Finish line strip on the ground. ---
  const finishLine = MeshBuilder.CreateBox(
    "rlgl_finish",
    { width: FINISH_WIDTH, height: FINISH_THICKNESS, depth: FINISH_THICKNESS },
    scene,
  );
  finishLine.position.set(0, FINISH_THICKNESS / 2, FINISH_Z);
  const finishMat = new StandardMaterial("rlgl_finishMat", scene);
  finishMat.diffuseColor = new Color3(0.95, 0.89, 0.29);
  finishMat.emissiveColor = new Color3(0.5, 0.46, 0.1);
  finishLine.material = finishMat;

  // --- Follow camera (trails the player; yaw 0 looks down +Z, toward doll). ---
  const camera = new FollowCamera(
    "rlgl_followCam",
    new Vector3(0, 5, START_Z - 10),
    scene,
    player,
  );
  camera.radius = 9;
  camera.heightOffset = 4;
  camera.rotationOffset = 0; // trail behind on -Z so we SEE the doll's face
  camera.cameraAcceleration = 0.08;
  camera.maxCameraSpeed = 20;

  // --- HUD (shared module: controls overlay + FPS). ---
  const hud = createHud(ctx, {
    title: "Controls",
    controls: [
      "WASD — move (GREEN only!)",
      "Mouse — look (click to lock pointer)",
      "R — reset",
      "GREEN move · RED freeze · reach the line to WIN",
    ],
  });

  // --- Self-owned status readout (top-left, below the gallery card). ---
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
    fontSize: "13px",
    lineHeight: "1.6",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: "10",
  } as Partial<CSSStyleDeclaration>);
  const statusContainer = ctx.canvas.parentElement ?? document.body;
  statusContainer.appendChild(statusEl);

  // --- Input (shared: keyboard state + pointer-lock look). ---
  const input = createInput(ctx);
  let yaw = 0;

  // --- Phase state. ---
  let phase: Phase = "GREEN";
  let phaseTimer = 0; // seconds elapsed in the current timed phase
  let dollFacing = DOLL_FACE_AWAY_YAW; // eased facing yaw of the doll
  let prevR = false; // edge-trigger for reset

  // Per-frame scratch (reused; no per-frame allocation in the loop).
  const prevPos = yawPivot.position.clone();

  /** Reset to a fresh GREEN run at the start position. */
  const reset = (): void => {
    phase = "GREEN";
    phaseTimer = 0;
    yawPivot.position.set(0, 0, START_Z);
    prevPos.copyFrom(yawPivot.position);
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

  const update = (): void => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    // Reset is always available (edge-triggered on R).
    const rDown = input.isKeyDown("KeyR");
    if (rDown && !prevR) reset();
    prevR = rDown;

    // Apply pointer-lock look to the yaw heading (camera orbit; never penalized).
    yaw += input.consumeLookX() * LOOK_SENSITIVITY;
    yawPivot.rotation.y = yaw;

    // Movement is allowed in every non-terminal phase; whether it is SAFE
    // depends on the phase (the whole point of the mechanic).
    const playable =
      phase === "GREEN" || phase === "TURNING" || phase === "RED";

    if (playable) {
      advancePhase(dt);

      // Movement basis identical to sample 01 (proven in Babylon's LH frame).
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

      // Measure actual speed from the WORLD position delta (input-flag
      // independent), so jitter can't fake motion and a held key with no
      // displacement can't hide it.
      const moved = Vector3.Distance(prevPos, yawPivot.position);
      const speed = moved / dt;
      prevPos.copyFrom(yawPivot.position);

      // Detection: during RED, after the grace window, motion above the
      // threshold = CAUGHT. The grace window gives reaction time at the
      // green->red flip so the mechanic is fair, not twitchy.
      if (phase === "RED" && phaseTimer > RED_GRACE && speed > MOTION_THRESHOLD) {
        phase = "CAUGHT";
      }

      // Win: crossing the finish line (past the doll) ends the run.
      if (yawPivot.position.z >= FINISH_Z) {
        phase = "WIN";
      }
    } else {
      // Terminal phases: keep prevPos synced so a later reset is clean.
      prevPos.copyFrom(yawPivot.position);
    }

    // Doll facing: GREEN faces away, TURNING/RED face the player. CAUGHT/WIN
    // hold the last facing. Ease toward the target so the turn reads smoothly.
    const facingTarget =
      phase === "GREEN" ? DOLL_FACE_AWAY_YAW : DOLL_FACE_PLAYER_YAW;
    dollFacing += (facingTarget - dollFacing) * Math.min(1, EASE_RATE * dt);
    dollPivot.rotation.y = dollFacing;

    // Background tint follows the phase. Mutate scene.clearColor IN PLACE (it is
    // a persistent Color4) — easing the r/g/b components toward the target so we
    // never allocate a Color per frame.
    let tr = GREEN_BG[0];
    let tg = GREEN_BG[1];
    let tb = GREEN_BG[2];
    if (phase === "TURNING") {
      tr = TURNING_BG[0];
      tg = TURNING_BG[1];
      tb = TURNING_BG[2];
    } else if (phase === "RED" || phase === "CAUGHT") {
      tr = RED_BG[0];
      tg = RED_BG[1];
      tb = RED_BG[2];
    }
    const k = Math.min(1, EASE_RATE * dt);
    const bg = scene.clearColor;
    bg.r += (tr - bg.r) * k;
    bg.g += (tg - bg.g) * k;
    bg.b += (tb - bg.b) * k;

    // Status readout.
    let label: string = phase;
    let color = "#5fd97a";
    if (phase === "RED" || phase === "CAUGHT") color = "#ff6b61";
    else if (phase === "TURNING") color = "#f2c14a";
    if (phase === "GREEN") label = "GREEN — MOVE";
    else if (phase === "TURNING") label = "TURNING — still safe";
    else if (phase === "RED") label = "RED — FREEZE";
    else if (phase === "CAUGHT") label = "CAUGHT — press R";
    else if (phase === "WIN") label = "WIN! — press R";
    statusEl.innerHTML = `Phase: <span style="color:${color};font-weight:600">${label}</span>`;
  };
  const updateObserver = scene.onBeforeRenderObservable.add(update);

  // --- Dispose: free every mesh/material/TransformNode we new'd, detach the
  // render observer, drop the status DOM node, and tear down shared input/HUD. ---
  return () => {
    input.dispose();
    hud.dispose();
    scene.onBeforeRenderObservable.remove(updateObserver);
    statusEl.remove();

    finishLine.dispose();
    finishMat.dispose();
    dollFace.dispose();
    dollFaceMat.dispose();
    dollHead.dispose();
    dollHeadMat.dispose();
    dollBody.dispose();
    dollBodyMat.dispose();
    dollPivot.dispose();
    player.dispose();
    playerMat.dispose();
    yawPivot.dispose();
    camera.dispose();
  };
}

export const sample08: Sample = {
  id: "08-red-light-green-light",
  title: "Red Light, Green Light",
  summary:
    "Move only when the doll faces away (GREEN). Move while it watches (RED) and you're CAUGHT. Reach the line to WIN.",
  tags: ["mechanic", "controller", "state-machine"],
  mount: sample08Mount,
};

export default sample08;
