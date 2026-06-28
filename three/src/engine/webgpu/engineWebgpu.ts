// WebGPU-capable render engine for the measure path (#172).
//
// RUNTIME-GRAPH RULE (PR0 §three/webgpu import policy): every Three symbol in this
// file and its sibling stress scene is VALUE-imported EXCLUSIVELY from `three/webgpu`
// — NEVER from bare `three`. `three/webgpu` is a self-contained bundle that re-bundles
// every core class; mixing it with bare-`three` core symbols in one runtime graph
// creates duplicate class instances ("Multiple instances of Three.js"). This whole
// `engine/webgpu/` subtree is reached ONLY via a dynamic `import()` on the
// `?renderer=webgl|webgpu` path, so the classic gallery graph never co-loads it.
//
// `WebGPURenderer` (verified r0.169) requires `await renderer.init()` before the first
// frame and renders asynchronously via `renderAsync`. It is therefore built by an
// async factory (no top-level await). Source-verified against:
//   node_modules/@types/three/src/renderers/webgpu/WebGPURenderer.d.ts
//     -> `WebGPURendererParameters { forceWebGL?: boolean }`, `constructor(parameters?)`
//   node_modules/@types/three/src/renderers/common/Renderer.d.ts
//     -> `init(): Promise<void>`, `renderAsync(scene, camera): Promise<void>`

import {
  Color,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
} from "three/webgpu";

/** Which backend `WebGPURenderer` runs on. `webgl2` is the `forceWebGL` fallback. */
export type WebgpuBackend = "webgpu" | "webgl2";

/** Background color — matched to the classic 13-stress scene for visual parity. */
const SCENE_BACKGROUND = 0x0c0f14;
/** Camera framing — identical to the classic 13-stress sample for comparability. */
const CAMERA_FOV = 60;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 1000;
const CAMERA_POSITION: readonly [number, number, number] = [0, 10, 20];
const CAMERA_LOOK_AT: readonly [number, number, number] = [0, 2, 0];
/** Cap device pixel ratio so high-DPI screens don't skew the frame-time numbers. */
const MAX_PIXEL_RATIO = 2;

/** A live WebGPU engine: renderer + fresh scene/camera + a single render step. */
export interface WebgpuEngine {
  readonly renderer: WebGPURenderer;
  /**
   * The backend `WebGPURenderer` ACTUALLY initialized on — read from the live backend
   * after `init()`, NOT from the requested mode. `WebGPURenderer` silently falls back to
   * WebGL2 when WebGPU is unavailable, so the requested mode can lie; this cannot.
   */
  readonly actualBackend: "webgpu" | "webgl";
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Draw one frame. Async because `WebGPURenderer` renders via `renderAsync`. */
  renderFrame(): Promise<void>;
  /** Tear down the resize listener and free the renderer's GPU resources. */
  dispose(): void;
}

/**
 * Build a {@link WebgpuEngine} on `canvas`. `backend === "webgl2"` forces the WebGL2
 * fallback backend (`forceWebGL: true`); `"webgpu"` uses the WebGPU backend with the
 * renderer's own automatic WebGL2 fallback if WebGPU is unavailable.
 *
 * Mirrors the classic bootstrap's scene/camera setup so the existing `RenderProbe`
 * measures a comparable scene. The caller owns the loop and calls `runFrameHook(now)`
 * before each `renderFrame()` — the same frame-hook call site the classic loop uses.
 */
export async function createWebgpuEngine(
  canvas: HTMLCanvasElement,
  backend: WebgpuBackend,
): Promise<WebgpuEngine> {
  const renderer = new WebGPURenderer({
    canvas,
    // Match the classic bootstrap (antialias: true) so classic-vs-WebGPU frame-time
    // numbers aren't confounded by an MSAA on/off difference.
    antialias: true,
    forceWebGL: backend === "webgl2",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));

  // MUST complete before the first frame — the WebGPU device/pipeline is set up here.
  await renderer.init();

  // Read the backend the renderer ACTUALLY ended up on (WebGPU vs the WebGL2 fallback):
  // WebGPURenderer silently falls back to WebGL2 when WebGPU is unavailable. WebGPUBackend
  // carries `isWebGPUBackend: true`; WebGLBackend does not.
  const actualBackend: "webgpu" | "webgl" =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
      ? "webgpu"
      : "webgl";

  const scene = new Scene();
  scene.background = new Color(SCENE_BACKGROUND);

  const camera = new PerspectiveCamera(
    CAMERA_FOV,
    1,
    CAMERA_NEAR,
    CAMERA_FAR,
  );
  camera.position.set(...CAMERA_POSITION);
  camera.lookAt(...CAMERA_LOOK_AT);

  const resize = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  return {
    renderer,
    actualBackend,
    scene,
    camera,
    renderFrame(): Promise<void> {
      return renderer.renderAsync(scene, camera);
    },
    dispose(): void {
      window.removeEventListener("resize", resize);
      renderer.dispose();
    },
  };
}
