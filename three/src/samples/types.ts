import type { PerspectiveCamera, Scene, WebGLRenderer } from "three";

/**
 * Everything a sample needs to render. The harness creates a fresh Scene and
 * PerspectiveCamera per sample and owns the renderer + canvas.
 */
export interface SampleContext {
  renderer: WebGLRenderer;
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
