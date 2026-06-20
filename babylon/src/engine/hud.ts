import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import type { SampleContext } from "../samples/types";

/**
 * Reusable HUD for the Babylon playground: a controls/help overlay (text lines)
 * plus an FPS counter.
 *
 * The HUD is a **DOM overlay**, which lives entirely outside Babylon's scene
 * graph. `scene.dispose()` does NOT touch DOM, so this module owns every node it
 * creates and removes all of them in `dispose()`. The FPS readout is refreshed
 * from `scene.onBeforeRenderObservable` (scene-owned, cleared on scene disposal),
 * but the observer is still removed in `dispose()` because a sample's dispose fn
 * runs *before* `scene.dispose()` and to stay correct if a future caller reuses a
 * scene. The readout reads `engine.getFps()` rather than hand-rolling timing.
 *
 * Layout: the gallery always renders the sample title/summary card at TOP-LEFT,
 * so the controls overlay is placed BOTTOM-LEFT (clear of that card, and never
 * duplicating the sample title) and the FPS counter TOP-RIGHT. The root attaches
 * to a caller-provided container that establishes a positioning context — by
 * default the canvas's parent element (the gallery's `#stage`).
 */

/** How often (ms) the FPS readout text is refreshed. */
const FPS_REFRESH_INTERVAL_MS = 250;

export interface HudOptions {
  /**
   * Element the HUD attaches its absolutely-positioned root to. The container
   * must establish a positioning context (e.g. `position: relative`). Defaults
   * to the canvas's parent element, falling back to `document.body`.
   */
  container?: HTMLElement;
  /** Lines describing the controls, shown in the help overlay (bottom-left). */
  controls?: string[];
  /** Optional heading above the controls list. Do NOT pass the sample title. */
  title?: string;
  /** Show the FPS counter (top-right). Defaults to true. */
  showFps?: boolean;
}

/** A self-contained HUD overlay bound to a sample's scene/engine. */
export interface Hud {
  /** Remove every DOM node + the FPS observer. Idempotent. */
  dispose(): void;
}

/**
 * Create a {@link Hud} for a sample. Call the returned `dispose()` from the
 * sample's dispose fn so the overlay and its observer are torn down on switch.
 */
export function createHud(ctx: SampleContext, options: HudOptions = {}): Hud {
  const { scene, engine, canvas } = ctx;
  const container =
    options.container ?? canvas.parentElement ?? document.body;
  const showFps = options.showFps ?? true;
  let disposed = false;

  const root = document.createElement("div");
  root.className = "hud-root";
  // Inline styles keep the module self-contained (no shared CSS dependency).
  Object.assign(root.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "12px",
    lineHeight: "1.5",
    zIndex: "10",
  } as Partial<CSSStyleDeclaration>);

  const controls = options.controls ?? [];
  if (controls.length > 0 || options.title) {
    root.appendChild(buildControlsPanel(options.title, controls));
  }

  let fpsEl: HTMLDivElement | null = null;
  let fpsObserver: Observer<Scene> | null = null;
  let accumMs = 0;
  if (showFps) {
    fpsEl = buildFpsPanel();
    root.appendChild(fpsEl);
    // Refresh from engine.getFps() on the scene's per-frame observable. Throttle
    // the text writes so the readout is legible (not jittering every frame).
    fpsObserver = scene.onBeforeRenderObservable.add(() => {
      accumMs += engine.getDeltaTime();
      if (accumMs >= FPS_REFRESH_INTERVAL_MS) {
        accumMs = 0;
        if (fpsEl) fpsEl.textContent = `${Math.round(engine.getFps())} FPS`;
      }
    });
  }

  container.appendChild(root);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (fpsObserver) {
        scene.onBeforeRenderObservable.remove(fpsObserver);
        fpsObserver = null;
      }
      root.remove();
      fpsEl = null;
    },
  };
}

function buildControlsPanel(
  title: string | undefined,
  controls: string[],
): HTMLDivElement {
  const panel = document.createElement("div");
  Object.assign(panel.style, panelBaseStyle());
  // Bottom-left so it never collides with the gallery's top-left overlay card.
  Object.assign(panel.style, { bottom: "12px", left: "12px" });

  if (title) {
    const heading = document.createElement("div");
    heading.textContent = title;
    Object.assign(heading.style, {
      fontWeight: "600",
      marginBottom: "6px",
      opacity: "0.95",
    } as Partial<CSSStyleDeclaration>);
    panel.appendChild(heading);
  }

  for (const line of controls) {
    const row = document.createElement("div");
    row.textContent = line;
    row.style.opacity = "0.85";
    panel.appendChild(row);
  }
  return panel;
}

function buildFpsPanel(): HTMLDivElement {
  const el = document.createElement("div");
  Object.assign(el.style, panelBaseStyle());
  Object.assign(el.style, {
    top: "12px",
    right: "12px",
    minWidth: "60px",
    textAlign: "right",
  } as Partial<CSSStyleDeclaration>);
  el.textContent = "-- FPS";
  return el;
}

/** Shared visual style for HUD panels. */
function panelBaseStyle(): Partial<CSSStyleDeclaration> {
  return {
    position: "absolute",
    padding: "8px 10px",
    borderRadius: "8px",
    background: "rgba(11, 14, 19, 0.72)",
    border: "1px solid rgba(74, 163, 255, 0.25)",
    color: "#e6edf3",
    whiteSpace: "nowrap",
  };
}
