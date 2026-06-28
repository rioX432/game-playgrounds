import type { PerspectiveCamera, Scene, WebGLRenderer } from "three";
// TYPE-ONLY import (erased at runtime → no second three.webgpu.js instance pulled
// into the classic gallery graph; the runtime-graph-separation rule in PR0 only
// forbids VALUE imports from both `three` and `three/webgpu`).
import type { WebGPURenderer } from "three/webgpu";

/**
 * A renderer the gallery/measure harness can drive. The classic gallery always
 * supplies a `WebGLRenderer` (PR1); the WebGPU measure path (#172) supplies a
 * `WebGPURenderer`. The union keeps `SampleContext` shared without a runtime import.
 */
export type SampleRenderer = WebGLRenderer | WebGPURenderer;

/**
 * Everything a sample needs to render. The harness creates a fresh Scene and
 * PerspectiveCamera per sample and owns the renderer + canvas.
 */
export interface SampleContext {
  renderer: SampleRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
}

/**
 * A self-contained mechanic demo.
 *
 * `mount` is called once when the sample becomes active. It may return an
 * optional dispose function that the harness invokes when switching away
 * (to remove DOM, event listeners, animation hooks, physics worlds, etc.).
 * Geometry/material disposal of objects added to `ctx.scene` is handled by the
 * harness automatically.
 */
export interface Sample {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  mount(ctx: SampleContext): void | (() => void);
}
