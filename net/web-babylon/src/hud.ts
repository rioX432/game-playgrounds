// Minimal on-screen telemetry. Shows the chapter's headline client-side numbers
// for real-machine confirmation; the reproducible measurement data is the
// server's metrics.jsonl, NOT this overlay (net/CLAUDE.md).

import type { ConnectionStatus } from "./net/netClient";

export interface HudState {
  status: ConnectionStatus;
  errorMessage: string;
  syncedCount: number;
  rttMs: number;
  snapshotAgeMs: number;
  fps: number;
}

export class Hud {
  private readonly statusEl: HTMLElement;
  private readonly bodyEl: HTMLElement;

  constructor(el: HTMLElement) {
    // Build a fixed structure once; per-frame we only set textContent (no
    // innerHTML), so an external error string can never inject markup.
    this.statusEl = document.createElement("span");
    this.bodyEl = document.createElement("span");
    el.replaceChildren(this.statusEl, document.createTextNode("\n"), this.bodyEl);
  }

  update(s: HudState): void {
    this.statusEl.className =
      s.status === "connected"
        ? "status-connected"
        : s.status === "error" || s.status === "disconnected"
          ? "status-error"
          : "";

    const statusLine =
      s.status === "error" || s.status === "disconnected"
        ? `${s.status}: ${s.errorMessage || "(no detail)"}`
        : s.status;
    this.statusEl.textContent = `net N1 · ${statusLine}`;

    this.bodyEl.textContent =
      `players synced : ${s.syncedCount}\n` +
      `RTT            : ${fmt(s.rttMs)} ms\n` +
      `snapshot age   : ${fmt(s.snapshotAgeMs)} ms\n` +
      `fps            : ${Math.round(s.fps)}\n` +
      `move WASD/arrows · fire SPACE`;
  }
}

const fmt = (ms: number): string => (ms > 0 ? ms.toFixed(1) : "—");
