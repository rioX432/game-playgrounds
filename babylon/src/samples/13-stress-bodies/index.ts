import { createHud } from "../../engine/hud";
import { createInput } from "../../engine/input";
import { parseMeasureParams } from "../../measure/config";
import { setFrameHook } from "../../measure/frameHook";
import { installRenderSampleSink } from "../../measure/globals";
import { RenderProbe } from "../../measure/probe";
import { createRng } from "../../measure/rng";
import type { Sample, SampleContext } from "../types";
import {
  BATCH_SIZE,
  MAX_BODIES,
  enableStressPhysics,
  setupStressVisuals,
  type StressBodies,
} from "./stressScene";

/**
 * 13 — Stress / load harness (Babylon.js + Havok).
 *
 * The cross-engine performance probe (sibling of `three/` and `bevy/`): spawn
 * batches of dynamic boxes and watch the per-frame cost climb with the body
 * count. Havok auto-steps and auto-syncs each `PhysicsAggregate`'s mesh, so there
 * is no manual stepping/sync here — the least boilerplate of the three.
 *
 * The scene itself (camera, lights, physics world, seeded scatter) lives in the
 * shared ./stressScene module so the WebGPU measure path (#173) builds the SAME
 * scene on a `WebGPUEngine`. This file is the WebGL `Engine` GALLERY path: it adds
 * the interactive HUD/input/stats chrome and, in measure mode, the RenderProbe.
 *
 * NOTE: numbers are read at runtime and intentionally NOT recorded in
 * COMPARISON.md. Matched ms/frame across the three engines must be captured by
 * running each build, not asserted here.
 */

export const sample13: Sample = {
  id: "13-stress-bodies",
  title: "Stress / Load Harness",
  summary:
    "Spawn batches of dynamic boxes and watch ms/frame climb — the cross-engine performance probe.",
  tags: ["physics", "havok", "performance", "stress"],

  mount(ctx: SampleContext): () => void {
    const { scene, canvas } = ctx;
    const { boxMat } = setupStressVisuals(scene, canvas);

    const hud = createHud(ctx, {
      title: "Controls",
      controls: ["Space — add 100 boxes", "R — clear all", `(cap ${MAX_BODIES})`],
    });
    const input = createInput(ctx, { pointerLock: false });

    // Stats readout (body count + smoothed ms/frame).
    const stats = document.createElement("div");
    Object.assign(stats.style, {
      position: "absolute",
      top: "12px",
      left: "12px",
      padding: "8px 10px",
      borderRadius: "8px",
      background: "rgba(11, 14, 19, 0.72)",
      border: "1px solid rgba(74, 163, 255, 0.25)",
      color: "#e6edf3",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "13px",
      whiteSpace: "nowrap",
      pointerEvents: "none",
    } as Partial<CSSStyleDeclaration>);
    (canvas.parentElement ?? document.body).appendChild(stats);

    let disposed = false;
    let msPerFrame = 0;
    let world: StressBodies | null = null;

    // Always seed the scatter (deterministic even outside measure mode) so a given
    // seed reproduces an identical run.
    const params = parseMeasureParams(window.location.search);
    const rng = createRng(params.seed);

    // Havok WASM loads on demand; the shared builder disposes the orphan plugin
    // if we already switched away (disposed) by the time it resolves.
    void enableStressPhysics(scene, boxMat, rng, () => disposed).then((built) => {
      if (!built) return;
      world = built;

      if (params.measure) {
        // Auto-measure: spawn the full body count, then drive a RenderProbe off the
        // engine's real render cadence via the bootstrap frame hook.
        world.spawnBodies(params.bodies);
        const sink = installRenderSampleSink();
        const probe = new RenderProbe({
          warmupMs: params.warmupMs,
          windowMs: params.windowMs,
          maxWindows: params.maxWindows,
          meta: {
            engine: "babylon",
            backend: "webgl",
            host: "browser",
            bodies: params.bodies,
            seed: params.seed,
          },
          onSample: sink,
        });
        probe.markStart(performance.now());
        setFrameHook((now) => {
          probe.recordFrame(now);
          if (probe.isDone()) setFrameHook(null);
        });
      } else {
        world.spawnBodies(BATCH_SIZE); // seed one batch
      }
    });

    // Per-frame: handle input + refresh the stats readout. Havok steps + syncs
    // the aggregates automatically during scene.render (no manual step here).
    const observer = scene.onBeforeRenderObservable.add(() => {
      const dt = scene.getEngine().getDeltaTime(); // ms
      msPerFrame = msPerFrame === 0 ? dt : msPerFrame * 0.9 + dt * 0.1;

      // Ignore manual input during a measurement run so a stray keypress can't
      // corrupt a window (body count is fixed by params.bodies in measure mode).
      if (!params.measure && world) {
        if (input.consumeJustPressed("Space")) world.spawnBodies(BATCH_SIZE);
        if (input.consumeJustPressed("KeyR")) world.clearAll();
      }

      const count = world?.count ?? 0;
      const fps = msPerFrame > 0 ? 1000 / msPerFrame : 0;
      stats.textContent = `bodies: ${count}  |  ${msPerFrame.toFixed(1)} ms/frame  (~${Math.round(fps)} FPS)`;
    });

    return () => {
      disposed = true;
      setFrameHook(null); // detach the measure hook if this sample installed one
      scene.onBeforeRenderObservable.remove(observer);
      input.dispose();
      hud.dispose();
      stats.remove();
      world?.dispose();
      // The scene + its physics engine are torn down by the gallery's scene.dispose.
    };
  },
};
