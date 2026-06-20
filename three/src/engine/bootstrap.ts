import {
  Material,
  Mesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import type { Object3D } from "three";
import type { Sample, SampleContext } from "../samples/types";

/**
 * Owns the renderer, the render loop, and resize handling. Mounts one sample
 * at a time with a fresh Scene + PerspectiveCamera, and fully disposes the
 * previous sample (its scene's GPU resources + its dispose fn) before the next.
 */
export class Engine {
  private readonly renderer: WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;

  private scene: Scene;
  private camera: PerspectiveCamera;

  private activeDispose: (() => void) | null = null;
  private rafId = 0;
  private lastTime = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(60, 1, 0.1, 1000);

    this.resize();
    window.addEventListener("resize", this.resize);

    this.loop(0);
  }

  /** Switch to a new sample, disposing the previous one entirely. */
  mount(sample: Sample): void {
    this.unmountActive();

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(60, this.aspect(), 0.1, 1000);
    this.camera.position.set(0, 3, 8);

    const ctx: SampleContext = {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      canvas: this.canvas,
    };

    const dispose = sample.mount(ctx);
    this.activeDispose = typeof dispose === "function" ? dispose : null;
  }

  private unmountActive(): void {
    if (this.activeDispose) {
      this.activeDispose();
      this.activeDispose = null;
    }
    disposeScene(this.scene);
  }

  private loop = (time: number): void => {
    this.rafId = requestAnimationFrame(this.loop);
    // delta seconds, clamped to avoid huge jumps after tab-switch.
    const dt = Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;
    // Samples drive their own animation via requestAnimationFrame or by
    // patching renderer state; the engine only guarantees a render call.
    void dt;
    this.renderer.render(this.scene, this.camera);
  };

  private aspect(): number {
    return this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
  }

  private resize = (): void => {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  };

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.resize);
    this.unmountActive();
    this.renderer.dispose();
  }
}

/** Recursively dispose geometries and materials of every Mesh in a scene. */
function disposeScene(scene: Scene): void {
  scene.traverse((obj: Object3D) => {
    if (obj instanceof Mesh) {
      obj.geometry?.dispose();
      const mat = obj.material;
      if (Array.isArray(mat)) {
        mat.forEach((m: Material) => m.dispose());
      } else if (mat) {
        (mat as Material).dispose();
      }
    }
  });
  scene.clear();
}
