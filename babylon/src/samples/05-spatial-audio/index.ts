import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Sound } from "@babylonjs/core/Audio/sound";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/Builders/sphereBuilder"; // side-effect: CreateSphere
// Side-effect: wires the scene's audio engine + the per-frame listener that
// tracks scene.activeCamera. Without it, spatial sounds never pan/attenuate.
import "@babylonjs/core/Audio/audioSceneComponent";

import { createInput } from "../../engine/input";
import { createHud } from "../../engine/hud";
import { createGround, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

/**
 * Spatial audio with distance attenuation — a proximity-voice stand-in in the
 * spirit of REPO / Content Warning. You walk in first person around three fixed
 * sound beacons (low/mid/high tones); each beacon swells as you approach and
 * fades to silence past a max range. HRTF panning lets you locate a beacon by
 * ear before you see it.
 *
 * Mirrors the Three.js sample 05 behaviorally: linear distance model, full
 * volume within ~2m, silent by ~16m, three procedural sine beacons at distinct
 * pitches. Reuses the first-person base from sample 04 (manual UniversalCamera
 * + shared pointer-lock look/WASD input); no gravity/jump — flat exploration.
 *
 * Babylon specifics (verified against @babylonjs/core 7.54.3 type defs):
 * - The stable `Sound` class with `spatialSound: true` does the panner math.
 *   Its listener auto-tracks `scene.activeCamera.globalPosition` + orientation
 *   each frame via `audioSceneComponent` (the side-effect import above).
 * - Tones are built procedurally (no asset files): a one-period sine `AudioBuffer`
 *   is filled by hand and handed to the `Sound` constructor, which accepts an
 *   AudioBuffer directly (synchronous, no async load race).
 */

// --- Movement tuning (mirrors sample 04 / Three sample 05; flat, no gravity). ---
const MOVE_SPEED = 6; // units / s
const LOOK_SENSITIVITY = 0.0025; // radians per pixel of mouse movement
const EYE_HEIGHT = 1.7; // camera height above the floor (standing eye level)
const GROUND_Y = 0;
// Clamp pitch just shy of vertical to avoid the view snapping at the poles.
const PITCH_MIN = -Math.PI / 2 + 0.01;
const PITCH_MAX = Math.PI / 2 - 0.01;
const START_X = 0;
const START_Z = 14;
const START_YAW = Math.PI; // face -Z, toward the beacons near the origin

// --- Distance-attenuation tuning (the mechanic under test). ---
// "linear" gives an intuitive fully-audible-then-silent falloff that is easy to
// judge by ear: full volume within refDistance, fading linearly to zero at
// maxDistance. ("inverse" never reaches true silence — see README.)
const DISTANCE_MODEL = "linear";
const REF_DISTANCE = 2; // units of full volume before attenuation begins
const MAX_DISTANCE = 16; // units at which the beacon fades to silence
const ROLLOFF_FACTOR = 1; // how aggressively volume drops between ref and max

// --- Beacon visuals / audio. ---
const BEACON_RADIUS = 0.5;
const BEACON_Y = 1.2; // raise beacons to roughly ear height
const BEACON_VOLUME = 0.25; // per-beacon level (pre-distance-attenuation)
const BEACON_EMISSIVE = 0.6; // self-lit glow so beacons read as light sources
const SPHERE_SEGMENTS = 24;

// --- Procedural tone buffer. ---
const TONE_SAMPLE_RATE_FALLBACK = 44100; // only used if the context lacks one
const TONE_LOOP_PERIODS = 1; // a single sine period loops seamlessly

/** A procedural sound beacon: fixed world position, distinct pitch + color. */
interface BeaconSpec {
  readonly label: string;
  readonly position: readonly [number, number, number];
  /** Sine frequency in Hz — distinct pitch so each beacon is identifiable. */
  readonly frequency: number;
  readonly color: Color3;
}

// Three beacons spread across the field at distinct pitches (low/mid/high),
// roughly G3 / E4 / C5, so proximity + direction are both audible.
const BEACONS: readonly BeaconSpec[] = [
  { label: "low", position: [-7, BEACON_Y, -2], frequency: 196, color: new Color3(0.29, 0.64, 1) },
  { label: "mid", position: [0, BEACON_Y, -8], frequency: 330, color: new Color3(0.34, 0.85, 0.47) },
  { label: "high", position: [7, BEACON_Y, -2], frequency: 523, color: new Color3(1, 0.71, 0.33) },
];

/** Live audio + visual resources for one beacon, tracked for disposal. */
interface LiveBeacon {
  readonly mesh: Mesh;
  readonly sound: Sound;
  readonly label: string;
}

/**
 * Build a seamlessly-loopable mono sine `AudioBuffer` of the given frequency.
 * One full period loops without a click at the seam.
 */
function createSineBuffer(
  audioContext: AudioContext,
  frequency: number,
): AudioBuffer {
  const sampleRate = audioContext.sampleRate || TONE_SAMPLE_RATE_FALLBACK;
  const frameCount = Math.max(
    1,
    Math.round((sampleRate / frequency) * TONE_LOOP_PERIODS),
  );
  const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < frameCount; i++) {
    channel[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return buffer;
}

function sample05Mount(ctx: SampleContext): () => void {
  const { scene } = ctx;
  scene.clearColor.set(0.05, 0.07, 0.09, 1);

  // --- Shared stage: lights + ground only (the beacons ARE the reference geometry). ---
  createLightPreset(scene);
  createGround(scene);

  // --- Camera as the player's eye (manual look; do NOT attachControl). ---
  const camera = new UniversalCamera(
    "spatialAudioCam",
    new Vector3(START_X, GROUND_Y + EYE_HEIGHT, START_Z),
    scene,
  );
  camera.minZ = 0.1;
  scene.activeCamera = camera;

  // --- HUD (shared module). ---
  const hud = createHud(ctx, {
    title: "Spatial Audio",
    controls: [
      "Click — lock mouse + enable audio",
      "WASD — move",
      "Mouse — look",
      "Esc — release mouse",
      "Walk toward a beacon: its tone swells",
    ],
  });

  // --- Input (shared module: keyboard + pointer-lock look). The pointer-lock
  // click also serves as the gesture that unlocks Babylon's audio engine. ---
  const input = createInput(ctx);

  // --- Self-owned readout (audio state + nearest-beacon distance). Bottom-right
  // corner: clear of the gallery card (top-left), FPS (top-right), and the HUD
  // controls panel (bottom-left). Removed in dispose. ---
  const readout = document.createElement("div");
  Object.assign(readout.style, {
    position: "absolute",
    bottom: "12px",
    right: "12px",
    padding: "8px 10px",
    borderRadius: "8px",
    background: "rgba(11, 14, 19, 0.72)",
    border: "1px solid rgba(74, 163, 255, 0.25)",
    color: "#e6edf3",
    font: "12px ui-monospace, SFMono-Regular, Menlo, monospace",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: "10",
  } as Partial<CSSStyleDeclaration>);
  readout.textContent = "audio: click to enable";
  const readoutContainer = ctx.canvas.parentElement ?? document.body;
  readoutContainer.appendChild(readout);

  // --- Audio engine + context. The audio engine is a process-wide singleton on
  // AbstractEngine, created (with audioContext suspended until a user gesture)
  // by the audioSceneComponent side-effect import. Accessing `.audioContext`
  // lazily initializes it. If Web Audio is unavailable, skip audio gracefully. ---
  const audioEngine = AbstractEngine.audioEngine;
  const audioContext = audioEngine?.audioContext ?? null;

  const beacons: LiveBeacon[] = [];
  if (audioContext) {
    for (const spec of BEACONS) {
      const material = new StandardMaterial(`beacon_${spec.label}Mat`, scene);
      material.diffuseColor = spec.color.clone();
      material.emissiveColor = spec.color.scale(BEACON_EMISSIVE);
      const mesh = MeshBuilder.CreateSphere(
        `beacon_${spec.label}`,
        { diameter: BEACON_RADIUS * 2, segments: SPHERE_SEGMENTS },
        scene,
      );
      mesh.position.set(...spec.position);
      mesh.material = material;

      // Procedural looping sine tone — no asset files. The Sound constructor
      // accepts an AudioBuffer directly (synchronous; sets up autoplay).
      const buffer = createSineBuffer(audioContext, spec.frequency);
      const sound = new Sound(`beaconSound_${spec.label}`, buffer, scene, null, {
        loop: true,
        autoplay: true,
        spatialSound: true,
        volume: BEACON_VOLUME,
        distanceModel: DISTANCE_MODEL,
        maxDistance: MAX_DISTANCE,
        rolloffFactor: ROLLOFF_FACTOR,
        refDistance: REF_DISTANCE,
      });
      // HRTF panning so direction (left/right + front/back) is audible, not just
      // distance. Falls back to equalpower internally if HRTF is unsupported.
      sound.switchPanningModelToHRTF();
      // Attach so the panner tracks the mesh's world position each frame.
      sound.attachToMesh(mesh);

      beacons.push({ mesh, sound, label: spec.label });
    }
  }

  // --- Audio unlock on the pointer-lock click (a valid user gesture). Babylon's
  // audio engine resumes the suspended context on user interaction; we also call
  // unlock() explicitly so autoplay starts promptly. ---
  let audioEnabled = audioEngine?.unlocked ?? false;
  const onEnableAudio = (): void => {
    if (audioEnabled || !audioEngine) return;
    audioEngine.unlock();
  };
  const unlockedObserver = audioEngine
    ? audioEngine.onAudioUnlockedObservable.add(() => {
        audioEnabled = true;
      })
    : null;
  ctx.canvas.addEventListener("pointerdown", onEnableAudio);

  // --- Player look/move state. ---
  let yaw = START_YAW;
  let pitch = 0;
  const floorY = GROUND_Y + EYE_HEIGHT;

  // --- Per-frame update. ---
  const update = (): void => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    yaw += input.consumeLookX() * LOOK_SENSITIVITY;
    pitch += input.consumeLookY() * LOOK_SENSITIVITY;
    if (pitch < PITCH_MIN) pitch = PITCH_MIN;
    if (pitch > PITCH_MAX) pitch = PITCH_MAX;
    camera.rotation.set(pitch, yaw, 0);

    // Horizontal movement basis from yaw only (looking up/down never lifts you).
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
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
      camera.position.x += (forward * sin + strafe * cos) * MOVE_SPEED * dt;
      camera.position.z += (forward * cos - strafe * sin) * MOVE_SPEED * dt;
    }
    camera.position.y = floorY; // keep eye height pinned (flat walk).

    // Distance to the nearest beacon, so the falloff is measurable by eye too.
    let nearestLabel = "-";
    let nearestDist = Infinity;
    for (const b of beacons) {
      const d = Vector3.Distance(camera.position, b.mesh.position);
      if (d < nearestDist) {
        nearestDist = d;
        nearestLabel = b.label;
      }
    }
    const audioState = beacons.length === 0
      ? "unavailable"
      : audioEnabled
        ? "on"
        : "click to enable";
    const nearest = beacons.length === 0
      ? ""
      : `  |  nearest: ${nearestLabel} @ ${nearestDist.toFixed(1)} m`;
    readout.textContent = `audio: ${audioState}${nearest}`;
  };
  const updateObserver = scene.onBeforeRenderObservable.add(update);

  // --- Dispose. ---
  // scene.dispose() frees meshes/materials/lights and the listener observer, but
  // NOT the Sound objects (their WebAudio nodes live on the shared, process-wide
  // audio engine), so we dispose each Sound explicitly. DOM readout, shared HUD
  // and input, the pointer-down listener and the unlocked observer are removed
  // here too. We do NOT close/suspend the shared audio context — it is reused by
  // the next audio sample (mirrors the Three.js cleanup decision).
  return () => {
    ctx.canvas.removeEventListener("pointerdown", onEnableAudio);
    if (unlockedObserver && audioEngine) {
      audioEngine.onAudioUnlockedObservable.remove(unlockedObserver);
    }
    for (const b of beacons) {
      b.sound.stop();
      b.sound.dispose(); // stops + disconnects source/panner/gain from the graph
    }
    input.dispose();
    hud.dispose();
    readout.remove();
    scene.onBeforeRenderObservable.remove(updateObserver);
  };
}

export const sample05: Sample = {
  id: "05-spatial-audio",
  title: "Spatial Audio — Proximity Falloff",
  summary:
    "Positional audio with distance attenuation. Walk toward procedural beacons; volume swells/fades with distance (REPO / Content Warning proximity-voice feel).",
  tags: ["audio", "spatial", "camera"],
  mount: sample05Mount,
};

export default sample05;
