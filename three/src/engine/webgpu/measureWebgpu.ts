// WebGPU measure-path orchestrator (#172).
//
// This module is the ONLY entry into the `three/webgpu` runtime graph. main.ts reaches
// it via a dynamic `import()` solely on the `?renderer=webgl|webgpu` path, so the
// classic gallery never co-loads the `three/webgpu` bundle. It owns the render loop and
// plays the role the classic bootstrap plays for the gallery: it calls `runFrameHook`
// once per frame right before the draw, while the `RenderProbe` is installed via
// `setFrameHook` exactly as the classic sample installs it — so the probe works
// identically across both paths.
//
// It value-imports Three ONLY transitively through engineWebgpu/stressSceneWebgpu
// (which import from `three/webgpu`). The measure primitives below are renderer-agnostic.

import RAPIER from "@dimforge/rapier3d-compat";
import type { MeasureParams, RendererMode } from "../../measure/config";
import { setFrameHook, runFrameHook } from "../../measure/frameHook";
import { installRenderSampleSink } from "../../measure/globals";
import { RenderProbe } from "../../measure/probe";
import { createWebgpuEngine, type WebgpuBackend } from "./engineWebgpu";
import { createStressSceneWebgpu } from "./stressSceneWebgpu";

/** Resolve a non-classic mode to the backend requested of `WebGPURenderer`. */
function resolveEngineBackend(mode: Exclude<RendererMode, "classic">): WebgpuBackend {
  return mode === "webgpu" ? "webgpu" : "webgl2";
}

/**
 * Drive the WebGPU stress scene under measurement. Precondition: `params.rendererMode`
 * is a webgpu mode (main.ts routes `"classic"` to the untouched gallery path).
 */
export async function runWebgpuMeasure(
  canvas: HTMLCanvasElement,
  params: MeasureParams,
): Promise<void> {
  if (params.rendererMode === "classic") {
    throw new Error("runWebgpuMeasure called with the classic renderer mode");
  }
  const engineBackend = resolveEngineBackend(params.rendererMode);

  const engine = await createWebgpuEngine(canvas, engineBackend);
  // Once the WebGPU engine holds a live GPU device, any setup failure below must free it
  // before surfacing — otherwise a failed measure run (e.g. RAPIER.init rejecting) leaks
  // the renderer/device. main.ts still sees the rethrown error.
  let scene: ReturnType<typeof createStressSceneWebgpu>;
  try {
    await RAPIER.init();
    scene = createStressSceneWebgpu(engine.scene, params.seed);
    scene.spawn(params.bodies);
  } catch (err) {
    engine.dispose();
    throw err;
  }

  let probe: RenderProbe | null = null;
  if (params.measure) {
    const sink = installRenderSampleSink();
    probe = new RenderProbe({
      warmupMs: params.warmupMs,
      windowMs: params.windowMs,
      maxWindows: params.maxWindows,
      meta: {
        engine: "three",
        renderer: "three-webgpu",
        // Stamped from the backend the renderer ACTUALLY initialized on, so a WebGPU
        // request that silently fell back to WebGL2 is recorded honestly as "webgl".
        backend: engine.actualBackend,
        host: "browser",
        bodies: params.bodies,
        seed: params.seed,
      },
      onSample: (s) => sink(s),
    });
    probe.markStart(performance.now());
    // Install the probe the same way the classic sample does — the loop below is the
    // call site that fires it via runFrameHook(now).
    setFrameHook((now) => {
      probe?.recordFrame(now);
    });
  }

  let running = true;
  const frame = async (now: number): Promise<void> => {
    if (!running) return;
    scene.step();
    runFrameHook(now); // mirror of the classic bootstrap's pre-draw hook call site
    await engine.renderFrame();
    if (probe?.isDone()) {
      running = false;
      setFrameHook(null);
      // Free the physics world + GPU resources once the measurement windows are done.
      scene.dispose();
      engine.dispose();
      return;
    }
    requestAnimationFrame((t) => void frame(t));
  };
  requestAnimationFrame((t) => void frame(t));
}
