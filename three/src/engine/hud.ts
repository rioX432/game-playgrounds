/**
 * Reusable HUD module: a controls/help overlay plus an FPS counter.
 *
 * Samples create a `Hud` in `mount`, call `frame(now)` once per update tick to
 * advance the FPS counter, and call `dispose()` in their cleanup function. The
 * Hud owns every DOM element it creates and removes all of them on `dispose`,
 * so switching samples never leaks nodes.
 */

/** How often (ms) the FPS readout text is refreshed; the average is smoothed. */
const FPS_REFRESH_INTERVAL_MS = 250;

export interface HudOptions {
  /**
   * Element the HUD attaches its absolutely-positioned root to. The parent must
   * establish a positioning context (e.g. `position: relative`); the canvas's
   * containing element is the typical choice. Defaults to `document.body`.
   */
  container?: HTMLElement;
  /** Lines describing the controls, shown in the help overlay (top-left). */
  controls?: string[];
  /** Optional heading above the controls list. */
  title?: string;
  /** Show the FPS counter (top-right). Defaults to true. */
  showFps?: boolean;
}

/**
 * A self-contained HUD overlay. All elements are created on construction and
 * removed on `dispose`.
 */
export class Hud {
  private readonly container: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly fpsEl: HTMLDivElement | null;

  // FPS accumulation state.
  private frames = 0;
  private accumMs = 0;
  private lastFrameTime = 0;

  constructor(options: HudOptions = {}) {
    this.container = options.container ?? document.body;
    const showFps = options.showFps ?? true;

    this.root = document.createElement("div");
    this.root.className = "hud-root";
    // Inline styles keep the module self-contained (no shared CSS dependency).
    Object.assign(this.root.style, {
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
      this.root.appendChild(this.buildControlsPanel(options.title, controls));
    }

    if (showFps) {
      this.fpsEl = this.buildFpsPanel();
      this.root.appendChild(this.fpsEl);
    } else {
      this.fpsEl = null;
    }

    this.container.appendChild(this.root);
  }

  /**
   * Advance the FPS counter by one rendered frame. Call once per update tick,
   * passing a high-resolution timestamp (e.g. `performance.now()`).
   */
  frame(now: number): void {
    if (!this.fpsEl) return;
    if (this.lastFrameTime !== 0) {
      this.accumMs += now - this.lastFrameTime;
      this.frames += 1;
      if (this.accumMs >= FPS_REFRESH_INTERVAL_MS) {
        const fps = (this.frames * 1000) / this.accumMs;
        this.fpsEl.textContent = `${Math.round(fps)} FPS`;
        this.frames = 0;
        this.accumMs = 0;
      }
    }
    this.lastFrameTime = now;
  }

  private buildControlsPanel(
    title: string | undefined,
    controls: string[],
  ): HTMLDivElement {
    const panel = document.createElement("div");
    Object.assign(panel.style, this.panelBaseStyle());
    Object.assign(panel.style, { top: "12px", left: "12px" });

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

  private buildFpsPanel(): HTMLDivElement {
    const el = document.createElement("div");
    Object.assign(el.style, this.panelBaseStyle());
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
  private panelBaseStyle(): Partial<CSSStyleDeclaration> {
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

  /** Remove every element the HUD created from the DOM. */
  dispose(): void {
    this.root.remove();
  }
}
