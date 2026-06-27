// Bidirectional transport impairment shim.
//
// Injects latency and loss SEPARATELY for client->server (up) and
// server->client (down), layered on top of Colyseus's reliable channel. This is
// APPLICATION-LEVEL impairment (Codex caveat, baked in): dropping a message
// models a missing snapshot/input, NOT UDP retransmit pressure, congestion, or
// TCP head-of-line blocking. It is isolated behind our own type so the
// Bevy/replicon side can mirror the exact same knobs.

import type { Rng } from '../sim/rng.js';

/** One direction's impairment knobs. */
export interface LinkConfig {
  /** One-way delay added before delivery, ms. */
  delayMs: number;
  /** Drop probability, percent in [0, 100]. */
  lossPct: number;
}

export interface ShimConfig {
  /** client -> server link. */
  up: LinkConfig;
  /** server -> client link. */
  down: LinkConfig;
}

type Deliver = () => void;

/**
 * Applies per-direction delay/loss to message delivery. `deliver` is the actual
 * transport send/apply; the shim decides whether and when to call it.
 *
 * Ordering note: a positive delay schedules delivery via setTimeout, so with
 * jitter-free equal delays FIFO order is preserved per direction. The world
 * already rejects stale seqs, so any residual reorder cannot corrupt state.
 */
export class TransportShim {
  private disposed = false;
  /** Outstanding timers so they can be cancelled on dispose (no leaks/tests hang). */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly config: ShimConfig,
    private readonly rng: Rng,
  ) {}

  /** Send over the client->server link. Returns false if dropped (loss). */
  up(deliver: Deliver): boolean {
    return this.send(this.config.up, deliver);
  }

  /** Send over the server->client link. Returns false if dropped (loss). */
  down(deliver: Deliver): boolean {
    return this.send(this.config.down, deliver);
  }

  /** Cancel all pending deliveries. Call on room dispose. */
  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private send(link: LinkConfig, deliver: Deliver): boolean {
    if (this.disposed) return false;
    if (link.lossPct > 0 && this.rng.next() * 100 < link.lossPct) {
      return false; // dropped in transit
    }
    if (link.delayMs <= 0) {
      deliver(); // no-impairment fast path: synchronous, deterministic
      return true;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed) return;
      deliver();
    }, link.delayMs);
    this.timers.add(timer);
    return true;
  }
}
