// WebGPU measure-path orchestrator (#173).
//
// Reached ONLY from main.ts on the `?renderer=webgpu` branch; the classic gallery
// path (param absent / `webgl`) never touches this module. It plays the role the
// gallery's `Playground` plays for the WebGL path: it owns ONE engine + render
// loop and calls `runFrameHook(now)` once per rendered frame right before the
// draw, while the `RenderProbe` is installed via `setFrameHook` exactly as the
// PR1 babylon sample installs it — so the probe behaves identically on both paths.
//
// Unlike three (#172), there is NO dual-module-graph hazard: `Engine` and
// `WebGPUEngine` both come from `@babylonjs/core`, so this is a plain async branch.
// Importing the `WebGPUEngine` class side-effect-loads all its WebGPU subsystems
// (engine.alpha/renderTarget/query/…). `StandardMaterial` lazily `import()`s its
// WGSL shaders on first compile, so no explicit shader side-effect import is needed.

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import type { MeasureParams } from "../measure/config";
import { runFrameHook, setFrameHook } from "../measure/frameHook";
import { installRenderSampleSink } from "../measure/globals";
import { RenderProbe } from "../measure/probe";
import { createRng } from "../measure/rng";
import {
  enableStressPhysics,
  setupStressVisuals,
} from "../samples/13-stress-bodies/stressScene";

/** Matches the gallery `Engine` options so AA/stencil don't confound the numbers. */
const ENGINE_OPTIONS = { antialias: true, stencil: true } as const;

/**
 * Drive the shared 13-stress scene under measurement on a `WebGPUEngine`.
 * Precondition: `params.rendererMode === "webgpu"` (main.ts routes `"webgl"` to
 * the untouched gallery path).
 *
 * HONEST GATING (no silent fallback): if `WebGPUEngine.IsSupportedAsync` is false
 * we surface the failure (console + visible overlay) and render NOTHING — we never
 * quietly fall back to the WebGL `Engine`, which would mislabel the sample.
 * `WebGPUEngine` itself does not auto-fall-back, so once support is confirmed the
 * `backend:"webgpu"` stamp is honest by construction.
 */
export async function runWebgpuMeasure(
  canvas: HTMLCanvasElement,
  params: MeasureParams,
  overlay: HTMLElement,
): Promise<void> {
  if (params.rendererMode !== "webgpu") {
    throw new Error("runWebgpuMeasure called with a non-webgpu renderer mode");
  }

  if (!(await WebGPUEngine.IsSupportedAsync)) {
    const message =
      "WebGPU is not supported in this browser — refusing to silently render on WebGL " +
      "(that would mislabel the sample as backend:webgpu). Use ?renderer=webgl for the WebGL path.";
    console.error(`[measure] ${message}`);
    overlay.textContent = message;
    return;
  }

  const engine = await WebGPUEngine.CreateAsync(canvas, ENGINE_OPTIONS);
  const scene = new Scene(engine);

  const { boxMat } = setupStressVisuals(scene, canvas);
  const rng = createRng(params.seed);
  // Dedicated measure page: nothing tears this down mid-load, so never aborted.
  const world = await enableStressPhysics(scene, boxMat, rng, () => false);
  if (!world) {
    // Defensive: enableStressPhysics only returns null when aborted, which cannot
    // happen here. Surface it rather than spin an empty loop.
    const message = "WebGPU measure: physics world failed to build.";
    console.error(`[measure] ${message}`);
    overlay.textContent = message;
    engine.dispose();
    return;
  }
  world.spawnBodies(params.bodies);

  const resize = (): void => engine.resize();
  window.addEventListener("resize", resize);

  let probe: RenderProbe | null = null;
  if (params.measure) {
    const sink = installRenderSampleSink();
    probe = new RenderProbe({
      warmupMs: params.warmupMs,
      windowMs: params.windowMs,
      maxWindows: params.maxWindows,
      meta: {
        engine: "babylon",
        // Honest: stamped only after IsSupportedAsync passed and WebGPUEngine
        // (which never auto-falls-back) initialized.
        backend: "webgpu",
        host: "browser",
        bodies: params.bodies,
        seed: params.seed,
      },
      onSample: sink,
    });
    probe.markStart(performance.now());
    // Install the probe the same way the classic sample does; the loop below is
    // the call site that fires it via runFrameHook(now).
    setFrameHook((now) => probe?.recordFrame(now));
  }

  const teardown = (): void => {
    setFrameHook(null);
    window.removeEventListener("resize", resize);
    engine.stopRenderLoop();
    // scene.dispose() tears down the physics world + meshes; engine.dispose()
    // frees the GPU device. world.dispose() is therefore not called here (it
    // would double-dispose scene-owned bodies).
    scene.dispose();
    engine.dispose();
  };

  engine.runRenderLoop(() => {
    // Mirror of the gallery bootstrap's pre-draw hook call site.
    runFrameHook(performance.now());
    scene.render();
    if (probe?.isDone()) teardown();
  });
}
