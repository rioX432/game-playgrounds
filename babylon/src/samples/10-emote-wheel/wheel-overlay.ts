/**
 * Radial emote-wheel overlay: a self-contained 2D <canvas> drawn over the
 * gallery canvas. It owns its DOM node and removes it on `dispose`.
 *
 * The overlay is purely a renderer + hit-tester for sector selection. It holds
 * NO game state: the sample feeds it the current selection vector each frame and
 * reads back the highlighted sector index (or `null` inside the dead zone). This
 * keeps the pointer-lock interaction (delta accumulation) entirely in the
 * sample and the overlay free of input concerns. This mirrors the Three.js
 * sibling sample so the two engines stay apples-to-apples.
 */

// --- Wheel geometry / styling (no magic numbers in the logic below). ---
const WHEEL_DIAMETER_PX = 320; // overlay canvas size (square)
const WHEEL_OUTER_RADIUS_PX = 150; // outer edge of the sector ring
const WHEEL_INNER_RADIUS_PX = 56; // inner edge; also the dead-zone radius
const LABEL_RADIUS_PX = 103; // where sector labels sit (between inner/outer)
const SECTOR_GAP_RAD = 0.04; // small gap between sectors for legibility
const POINTER_DOT_RADIUS_PX = 7; // the live selection cursor dot
const BACKPLATE_MARGIN_PX = 6; // backplate extends past the outer ring
const DEADZONE_INSET_PX = 4; // dead-zone disc sits slightly inside inner ring

const COLOR_BG = "rgba(11, 14, 19, 0.62)";
const COLOR_SECTOR = "rgba(40, 52, 68, 0.85)";
const COLOR_SECTOR_HILITE = "rgba(74, 163, 255, 0.92)";
const COLOR_DEADZONE = "rgba(20, 26, 34, 0.9)";
const COLOR_DEADZONE_RING = "rgba(255, 90, 90, 0.55)";
const COLOR_LABEL = "#e6edf3";
const COLOR_LABEL_HILITE = "#0b0e13";
const COLOR_POINTER = "#ffd24a";
const LABEL_FONT = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";

export interface WheelOverlayOptions {
  /** Parent the overlay attaches to (a positioned element over the canvas). */
  container: HTMLElement;
  /** Sector labels, in order. Sector 0 starts at the top and goes clockwise. */
  labels: string[];
}

/**
 * The radial wheel overlay. Draw it each frame with `render(selX, selY, visible)`
 * where the selection vector is in screen space (x right, y down) relative to
 * wheel center. Returns the snapped sector or null (dead zone).
 */
export class WheelOverlay {
  private readonly container: HTMLElement;
  private readonly labels: string[];
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sectorCount: number;
  private readonly dpr: number;
  private disposed = false;

  constructor(options: WheelOverlayOptions) {
    this.container = options.container;
    this.labels = options.labels;
    this.sectorCount = options.labels.length;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas = document.createElement("canvas");
    this.canvas.width = WHEEL_DIAMETER_PX * this.dpr;
    this.canvas.height = WHEEL_DIAMETER_PX * this.dpr;
    Object.assign(this.canvas.style, {
      position: "absolute",
      top: "50%",
      left: "50%",
      width: `${WHEEL_DIAMETER_PX}px`,
      height: `${WHEEL_DIAMETER_PX}px`,
      transform: "translate(-50%, -50%)",
      pointerEvents: "none",
      zIndex: "20",
      display: "none",
    } as Partial<CSSStyleDeclaration>);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("WheelOverlay: 2D canvas context unavailable");
    this.ctx = ctx;
    this.ctx.scale(this.dpr, this.dpr);

    this.container.appendChild(this.canvas);
  }

  /** The number of selectable sectors. */
  get count(): number {
    return this.sectorCount;
  }

  /** Radius (screen px) inside which selection counts as the dead zone. */
  get deadZoneRadius(): number {
    return WHEEL_INNER_RADIUS_PX;
  }

  /** Radius (screen px) at which the selection vector should be clamped (rim). */
  get rimRadius(): number {
    return WHEEL_OUTER_RADIUS_PX;
  }

  /**
   * Map a selection vector (px, relative to center, y-down) to a sector index,
   * or null if inside the dead zone. Sector 0 is centered at the top (-Y) and
   * sectors advance clockwise. This is the single source of truth for snapping
   * so both the highlight and the applied emote agree.
   */
  sectorFor(selX: number, selY: number): number | null {
    const dist = Math.hypot(selX, selY);
    if (dist < WHEEL_INNER_RADIUS_PX) return null;
    // atan2(x, -y): 0 at top, increasing clockwise. Add half a sector so the
    // top sector is centered on straight-up rather than starting there.
    const sectorArc = (Math.PI * 2) / this.sectorCount;
    let angle = Math.atan2(selX, -selY) + sectorArc / 2;
    angle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return Math.floor(angle / sectorArc) % this.sectorCount;
  }

  /**
   * Show/draw the wheel for the given selection vector and return the snapped
   * sector (null = dead zone). When `visible` is false the overlay is hidden and
   * nothing is drawn.
   */
  render(selX: number, selY: number, visible: boolean): number | null {
    if (!visible) {
      this.canvas.style.display = "none";
      return null;
    }
    this.canvas.style.display = "block";

    const selected = this.sectorFor(selX, selY);
    const cx = WHEEL_DIAMETER_PX / 2;
    const cy = WHEEL_DIAMETER_PX / 2;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WHEEL_DIAMETER_PX, WHEEL_DIAMETER_PX);

    // Backplate.
    ctx.fillStyle = COLOR_BG;
    ctx.beginPath();
    ctx.arc(cx, cy, WHEEL_OUTER_RADIUS_PX + BACKPLATE_MARGIN_PX, 0, Math.PI * 2);
    ctx.fill();

    const sectorArc = (Math.PI * 2) / this.sectorCount;
    for (let i = 0; i < this.sectorCount; i++) {
      // Sector i spans [start, end] in canvas angles. atan2(x,-y) convention:
      // canvas angle 0 is +X (right), so rotate by -PI/2 to put sector 0 at top.
      const mid = i * sectorArc - Math.PI / 2;
      const start = mid - sectorArc / 2 + SECTOR_GAP_RAD;
      const end = mid + sectorArc / 2 - SECTOR_GAP_RAD;

      ctx.beginPath();
      ctx.arc(cx, cy, WHEEL_OUTER_RADIUS_PX, start, end);
      ctx.arc(cx, cy, WHEEL_INNER_RADIUS_PX, end, start, true);
      ctx.closePath();
      ctx.fillStyle = i === selected ? COLOR_SECTOR_HILITE : COLOR_SECTOR;
      ctx.fill();

      // Label, placed at the sector's mid-angle.
      const lx = cx + Math.cos(mid) * LABEL_RADIUS_PX;
      const ly = cy + Math.sin(mid) * LABEL_RADIUS_PX;
      ctx.fillStyle = i === selected ? COLOR_LABEL_HILITE : COLOR_LABEL;
      ctx.font = LABEL_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.labels[i], lx, ly);
    }

    // Dead-zone disc in the center: a highlighted ring + "cancel" when no sector
    // is chosen (releasing now cancels), neutral otherwise.
    ctx.beginPath();
    ctx.arc(cx, cy, WHEEL_INNER_RADIUS_PX - DEADZONE_INSET_PX, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_DEADZONE;
    ctx.fill();
    if (selected === null) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLOR_DEADZONE_RING;
      ctx.stroke();
      ctx.fillStyle = COLOR_LABEL;
      ctx.font = LABEL_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("cancel", cx, cy);
    }

    // Live selection cursor dot (clamped to the ring so it stays on-wheel).
    const dist = Math.hypot(selX, selY);
    if (dist > 0) {
      const clamped = Math.min(dist, WHEEL_OUTER_RADIUS_PX);
      const px = cx + (selX / dist) * clamped;
      const py = cy + (selY / dist) * clamped;
      ctx.beginPath();
      ctx.arc(px, py, POINTER_DOT_RADIUS_PX, 0, Math.PI * 2);
      ctx.fillStyle = COLOR_POINTER;
      ctx.fill();
    }

    return selected;
  }

  /** Remove the overlay canvas from the DOM. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.remove();
  }
}
