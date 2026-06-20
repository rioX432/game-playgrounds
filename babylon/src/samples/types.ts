import type { Engine } from "@babylonjs/core/Engines/engine";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Everything a sample needs to build its world. The engine is shared and
 * long-lived; the scene is created fresh for each sample and disposed on switch.
 */
export interface SampleContext {
  engine: Engine;
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
