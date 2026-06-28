import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Everything a sample needs to build its world. The engine is shared and
 * long-lived; the scene is created fresh for each sample and disposed on switch.
 *
 * Typed as {@link AbstractEngine} (the shared base of WebGL `Engine` and
 * `WebGPUEngine`, #173) so a sample is engine-backend-agnostic. The gallery's
 * Playground supplies a concrete WebGL `Engine`; the WebGPU measure path supplies
 * a `WebGPUEngine`. A sample needing concrete-`Engine`-only methods (e.g. the
 * pointer-lock helpers in `engine/input.ts`) narrows explicitly.
 */
export interface SampleContext {
  engine: AbstractEngine;
  scene: Scene;
  canvas: HTMLCanvasElement;
}

/**
 * The single contract every playground sample implements. `/dev-all` adds new
 * samples by implementing this interface and registering them in registry.ts.
 *
 * `mount` may return a dispose function; it is called when the user switches
 * away, *before* the scene itself is disposed, so samples can detach DOM
 * listeners, pointer-lock handlers, observers, etc.
 */
export interface Sample {
  /** Stable kebab-case id, also used as the deep-link hash (`#/<id>`). */
  id: string;
  /** Human-readable name shown in the sidebar. */
  title: string;
  /** One-line description shown in the overlay. */
  summary: string;
  /** Searchable/filterable tags shown in the sidebar. */
  tags: string[];
  /** Build the sample into ctx.scene. Optionally return a dispose callback. */
  mount(ctx: SampleContext): void | (() => void);
}
