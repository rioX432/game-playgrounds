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
import type { RenderBackend } from "../../measure/renderSample";
import { createWebgpuEngine, type WebgpuBackend } from "./engineWebgpu";
import { createStressSceneWebgpu } from "./stressSceneWebgpu";

/** How a non-classic {@link RendererMode} resolves across engine + sample labels. */
interface ResolvedRenderer {
  /** Backend passed to `WebGPURenderer` (`forceWebGL` decided downstream). */
  engineBackend: WebgpuBackend;
  /** Backend recorded in the emitted sample (`webgl` = WebGL2 fallback). */
  sampleBackend: RenderBackend;
}

/** Resolve a non-classic mode to its engine + sample backends. */
function resolveRenderer(mode: Exclude<RendererMode, "classic">): ResolvedRenderer {
  return mode === "webgpu"
    ? { engineBackend: "webgpu", sampleBackend: "webgpu" }
    : { engineBackend: "webgl2", sampleBackend: "webgl" };
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
  const { engineBackend, sampleBackend } = resolveRenderer(params.rendererMode);

  const engine = await createWebgpuEngine(canvas, engineBackend);
  await RAPIER.init();
  const scene = createStressSceneWebgpu(engine.scene, params.seed);
  scene.spawn(params.bodies);

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
        backend: sampleBackend,
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
      return;
    }
    requestAnimationFrame((t) => void frame(t));
  };
  requestAnimationFrame((t) => void frame(t));
}
