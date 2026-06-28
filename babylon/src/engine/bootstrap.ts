import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { runFrameHook } from "../measure/frameHook";
import type { Sample, SampleContext } from "../samples/types";

/**
 * Owns the single Babylon Engine + render loop for the whole gallery.
 * Samples come and go; the engine and canvas persist. Each sample gets a
 * freshly created Scene that is disposed when the user switches away.
 */
export class Playground {
  readonly engine: Engine;
  readonly canvas: HTMLCanvasElement;

  private currentScene: Scene | null = null;
  private currentDispose: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // antialias on, stencil enabled for selection/outline effects in samples.
    this.engine = new Engine(canvas, true, {
      stencil: true,
      preserveDrawingBuffer: true,
    });

    this.engine.runRenderLoop(() => {
      // Auto-measure frame hook (no-op unless measure mode installed one). Fired on
      // the REAL render cadence, just before the scene draws.
      runFrameHook(performance.now());
      this.currentScene?.render();
    });

    window.addEventListener("resize", this.handleResize);
  }

  private handleResize = (): void => {
    this.engine.resize();
  };

  /** Tear down the active sample + its scene, if any. */
  private teardownCurrent(): void {
    if (this.currentDispose) {
      try {
        this.currentDispose();
      } catch (err) {
        console.error("[playground] sample dispose threw:", err);
      }
      this.currentDispose = null;
    }
    if (this.currentScene) {
      this.currentScene.dispose();
      this.currentScene = null;
    }
  }

  /**
   * Switch to the given sample: dispose the previous one (which removes any
   * overlay UI it added), run the optional `beforeMount` hook (used by the
   * gallery to reset the overlay), build a fresh scene, and mount the sample.
   *
   * Ordering is load-bearing: teardown -> beforeMount -> mount, so a sample's
   * own overlay UI is never wiped by the gallery's overlay reset.
   */
  load(sample: Sample, beforeMount?: () => void): void {
    this.teardownCurrent();
    beforeMount?.();

    const scene = new Scene(this.engine);
    this.currentScene = scene;

    const ctx: SampleContext = {
      engine: this.engine,
      scene,
      canvas: this.canvas,
    };

    const dispose = sample.mount(ctx);
    if (typeof dispose === "function") {
      this.currentDispose = dispose;
    }
  }

  /** Fully release the playground (used rarely; the gallery is long-lived). */
  dispose(): void {
    window.removeEventListener("resize", this.handleResize);
    this.teardownCurrent();
    this.engine.dispose();
  }
}
