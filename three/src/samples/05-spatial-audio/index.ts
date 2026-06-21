import {
  AudioListener,
  Color,
  Euler,
  Mesh,
  MeshStandardMaterial,
  PositionalAudio,
  SphereGeometry,
  Vector3,
} from "three";
import { Hud } from "../../engine/hud";
import { InputController } from "../../engine/input";
import { createGround, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

// --- Movement tuning (mirrors 04-first-person-controller so the player can
// freely walk around the emitters; no gravity/jump here — flat exploration). ---
const MOVE_SPEED = 6; // m/s
const EYE_HEIGHT = 1.7; // camera height above the floor (standing eye level)
const GROUND_Y = 0;
const INITIAL_PITCH = 0; // look at the horizon
// Clamp pitch just shy of straight up/down to avoid gimbal flip at the poles.
const PITCH_CLAMP: [number, number] = [-Math.PI / 2 + 0.01, Math.PI / 2 - 0.01];
const SCENE_BACKGROUND = 0x0d1117;
const START_X = 0;
const START_Z = 14;
const START_YAW = 0; // yaw 0 looks down -Z, toward the emitters

// --- Distance-attenuation tuning (the mechanic under test). ---
// "linear" model gives an intuitive, fully-audible-then-silent falloff that is
// easy to judge by ear: full volume within REF_DISTANCE, fading linearly to
// zero at MAX_DISTANCE. (The "inverse" model never reaches true silence, which
// makes the proximity boundary harder to feel — see README.)
const DISTANCE_MODEL = "linear" as const;
const REF_DISTANCE = 2; // meters of full volume before attenuation begins
const MAX_DISTANCE = 16; // meters at which the emitter fades to silence
const ROLLOFF_FACTOR = 1; // how aggressively volume drops between ref and max

// --- Emitter visuals / audio. ---
const EMITTER_RADIUS = 0.5;
const EMITTER_Y = 1.2; // raise emitters to roughly ear height
const EMITTER_VOLUME = 0.25; // per-beacon level (pre-distance-attenuation)
const EMITTER_EMISSIVE = 0.4; // self-lit glow so beacons read as light sources
const SPHERE_WIDTH_SEGMENTS = 24;
const SPHERE_HEIGHT_SEGMENTS = 16;

/** A procedural sound beacon: fixed world position, distinct pitch + color. */
interface EmitterSpec {
  readonly label: string;
  readonly position: readonly [number, number, number];
  /** Oscillator frequency in Hz — distinct pitch so each beacon is identifiable. */
  readonly frequency: number;
  readonly waveform: OscillatorType;
  readonly color: number;
}

// Three beacons spread across the field at distinct pitches (low/mid/high) so
// proximity is audible: walking toward one swells its tone, away mutes it.
const EMITTERS: readonly EmitterSpec[] = [
  { label: "low", position: [-7, EMITTER_Y, -2], frequency: 196, waveform: "sine", color: 0x4aa3ff },
  { label: "mid", position: [0, EMITTER_Y, -8], frequency: 330, waveform: "triangle", color: 0x57d977 },
  { label: "high", position: [7, EMITTER_Y, -2], frequency: 523, waveform: "sine", color: 0xffb454 },
];

/** Live audio + visual resources for one emitter, tracked for disposal. */
interface LiveEmitter {
  readonly mesh: Mesh;
  readonly audio: PositionalAudio;
  readonly oscillator: OscillatorNode;
  readonly worldPos: Vector3;
  readonly label: string;
}

const sample: Sample = {
  id: "05-spatial-audio",
  title: "Spatial Audio — Proximity Falloff",
  summary:
    "Positional audio with distance attenuation. Walk toward procedural beacons; volume swells/fades with distance (REPO / Content Warning proximity-voice feel).",
  tags: ["audio", "spatial", "camera"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;

    // Shared stage: lights + ground only (the emitters ARE the reference geometry).
    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });
    const ground = createGround(scene);

    // Shared first-person input (pointer-lock look + WASD). The pointer-lock
    // click doubles as the user gesture that unlocks the AudioContext (below).
    const input = new InputController({
      pointerLockTarget: canvas,
      initialYaw: START_YAW,
      initialPitch: INITIAL_PITCH,
      pitchClamp: PITCH_CLAMP,
    });

    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      title: "Spatial Audio",
      controls: [
        "Click canvas — lock mouse + enable audio",
        "WASD — move",
        "Mouse — look",
        "Esc — release mouse",
        "Walk toward a beacon: its tone swells",
      ],
    });

    // Small self-owned readout showing audio state + nearest-beacon distance, so
    // the falloff is measurable by eye too. Bottom-right corner: avoids the
    // gallery card (top-left), the FPS counter (top-right), and the HUD controls
    // panel (bottom-left).
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
    (canvas.parentElement ?? document.body).appendChild(readout);

    // Audio listener tracks the camera transform automatically once attached.
    const listener = new AudioListener();
    camera.add(listener);
    const audioCtx = listener.context;

    // Shared geometry for all beacon meshes (cheap; disposed once below).
    const sphereGeometry = new SphereGeometry(
      EMITTER_RADIUS,
      SPHERE_WIDTH_SEGMENTS,
      SPHERE_HEIGHT_SEGMENTS,
    );

    // Build each beacon: a mesh in the scene graph + a PositionalAudio child fed
    // by a procedural oscillator. The PositionalAudio auto-tracks the mesh world
    // position, so the panner's distance attenuation "just works" each frame.
    const emitters: LiveEmitter[] = EMITTERS.map((spec) => {
      const material = new MeshStandardMaterial({
        color: spec.color,
        emissive: new Color(spec.color),
        emissiveIntensity: EMITTER_EMISSIVE,
      });
      const mesh = new Mesh(sphereGeometry, material);
      mesh.position.set(...spec.position);
      scene.add(mesh);

      const audio = new PositionalAudio(listener);
      audio.setDistanceModel(DISTANCE_MODEL);
      audio.setRefDistance(REF_DISTANCE);
      audio.setMaxDistance(MAX_DISTANCE);
      audio.setRolloffFactor(ROLLOFF_FACTOR);
      audio.setVolume(EMITTER_VOLUME); // per-beacon base level (pre-attenuation)
      mesh.add(audio); // attach so the audio follows the mesh world position

      // Procedural tone: oscillator → PositionalAudio (panner → gain) → listener.
      // No asset files (the playground forbids bespoke art assets). setNodeSource
      // routes the oscillator through the spatial panner. setVolume above sets the
      // PositionalAudio's own gain, so no separate GainNode is needed.
      const oscillator = audioCtx.createOscillator();
      oscillator.type = spec.waveform;
      oscillator.frequency.value = spec.frequency;
      audio.setNodeSource(oscillator);

      return {
        mesh,
        audio,
        oscillator,
        worldPos: new Vector3(),
        label: spec.label,
      };
    });

    // Oscillators must be started exactly once, and only after the AudioContext
    // resumes (browsers start it `suspended` until a user gesture). We start
    // them on the first successful resume so they ramp in as soon as audio is on.
    let oscillatorsStarted = false;
    const startOscillators = (): void => {
      if (oscillatorsStarted) return;
      oscillatorsStarted = true;
      for (const e of emitters) e.oscillator.start();
    };

    // Resume on the same click that requests pointer lock (a valid user gesture).
    // Calling resume() outside a gesture is a no-op the browser ignores.
    let audioEnabled = false;
    let disposed = false;
    const onEnableAudio = (): void => {
      if (audioEnabled) return;
      void audioCtx.resume().then(() => {
        // The resume may settle after the sample was switched away; do not start
        // (now-disconnected) oscillators in that case.
        if (disposed) return;
        audioEnabled = true;
        startOscillators();
      });
    };
    canvas.addEventListener("click", onEnableAudio);

    // Player state — camera IS the player (no avatar). Flat walk, no gravity.
    camera.position.set(START_X, GROUND_Y + EYE_HEIGHT, START_Z);

    // Per-frame scratch to avoid allocation.
    let raf = 0;
    let last = performance.now();
    const forward = new Vector3();
    const right = new Vector3();
    const move = new Vector3();
    const look = new Euler(0, 0, 0, "YXZ");
    const camWorld = new Vector3();

    const update = (now: number): void => {
      raf = requestAnimationFrame(update);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      hud.frame(now);

      const yaw = input.yaw;
      const pitch = input.pitch;
      look.set(pitch, yaw, 0);
      camera.quaternion.setFromEuler(look);

      // Horizontal movement basis from yaw (looking up/down never lifts you).
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
      right.set(forward.z, 0, -forward.x);
      move.set(0, 0, 0);
      if (input.isDown("KeyW")) move.add(forward);
      if (input.isDown("KeyS")) move.sub(forward);
      if (input.isDown("KeyA")) move.add(right);
      if (input.isDown("KeyD")) move.sub(right);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(MOVE_SPEED * dt);
        camera.position.x += move.x;
        camera.position.z += move.z;
      }

      // Distance to the nearest beacon, so the falloff is measurable by eye as
      // well as ear. Uses each emitter's world position vs the camera.
      camera.getWorldPosition(camWorld);
      let nearestLabel = "";
      let nearestDist = Infinity;
      for (const e of emitters) {
        e.mesh.getWorldPosition(e.worldPos);
        const d = camWorld.distanceTo(e.worldPos);
        if (d < nearestDist) {
          nearestDist = d;
          nearestLabel = e.label;
        }
      }
      const audioState = audioEnabled ? "on" : "click to enable";
      readout.textContent = `audio: ${audioState}  |  nearest: ${nearestLabel} @ ${nearestDist.toFixed(1)} m`;
    };
    raf = requestAnimationFrame(update);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("click", onEnableAudio);
      input.dispose();
      hud.dispose();
      readout.remove();

      // --- Audio teardown (critical: no leaked oscillators / running graph). ---
      for (const e of emitters) {
        // Stop the oscillator if it was started; stopping an unstarted node
        // throws, so guard on the same flag used to start them.
        if (oscillatorsStarted) {
          try {
            e.oscillator.stop();
          } catch {
            // Already stopped — ignore.
          }
        }
        // Tear down the whole graph via Audio.disconnect(): it disconnects the
        // oscillator from the panner AND the panner from the listener gain. We
        // must NOT also call oscillator.disconnect() first — that would remove
        // the oscillator->panner edge, so Audio.disconnect()'s internal
        // oscillator.disconnect(panner) would then throw InvalidAccessError.
        e.audio.disconnect();
        e.mesh.remove(e.audio);
        scene.remove(e.mesh);
        (e.mesh.material as MeshStandardMaterial).dispose();
      }
      sphereGeometry.dispose();

      // Remove the listener from the camera so it stops tracking. We SUSPEND
      // (not close) the AudioContext: Three caches it as a module-level
      // singleton (see three/src/audio/AudioContext.js), so closing it would
      // break the next audio sample that reuses the same cached, dead context.
      camera.remove(listener);
      void audioCtx.suspend();

      lights.dispose();
      ground.dispose();
    };
  },
};

export default sample;
