// Bidirectional transport impairment shim.
//
// Injects latency, JITTER, and loss SEPARATELY for client->server (up) and
// server->client (down), layered on top of Colyseus's reliable channel. This is
// APPLICATION-LEVEL impairment (Codex caveat, baked in): dropping a message
// models a missing snapshot/input, NOT UDP retransmit pressure, congestion, or
// TCP head-of-line blocking. It is isolated behind our own type so the
// Bevy/replicon side can mirror the exact same knobs.
//
// Jitter (#159): each direction adds a per-delivery offset from the SHARED
// `JitterSampler` (net-protocol) so a seed reproduces the same jitter stream on
// both stacks. Reordering EMERGES from jitter — a later message can draw a smaller
// effective delay and overtake an earlier one. NOTE this is only an APPROXIMATION
// of real web reorder: Colyseus is a reliable ordered channel, so real web
// transport would suppress out-of-order delivery via HOL blocking (documented gap,
// COMPARISON §8). The world's stale-`seq` guard absorbs any residual reorder.

import { JitterSampler, NO_JITTER, type JitterConfig } from 'net-protocol';
import type { Rng } from '../sim/rng.js';

/** One direction's impairment knobs. */
export interface LinkConfig {
  /** One-way base delay added before delivery, ms. */
  delayMs: number;
  /** Drop probability, percent in [0, 100]. */
  lossPct: number;
  /** Optional per-delivery delay jitter. Absent ⇒ no jitter (fast path preserved). */
  jitter?: JitterConfig;
}

export interface ShimConfig {
  /** client -> server link. */
  up: LinkConfig;
  /** server -> client link. */
  down: LinkConfig;
}

type Deliver = () => void;

/**
 * Applies per-direction delay/jitter/loss to message delivery. `deliver` is the
 * actual transport send/apply; the shim decides whether and when to call it.
 *
 * Ordering note: a positive effective delay schedules delivery via setTimeout. With
 * NO jitter and equal base delays, FIFO order is preserved per direction. WITH
 * jitter, effective delays vary, so deliveries may reorder (the emergent-reorder
 * model). The world already rejects stale seqs, so any reorder cannot corrupt state.
 */
export class TransportShim {
  private disposed = false;
  /** Outstanding timers so they can be cancelled on dispose (no leaks/tests hang). */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly upJitter: JitterSampler;
  private readonly downJitter: JitterSampler;

  /**
   * @param rng loss-draw stream (per-direction loss).
   * @param jitterRngUp / jitterRngDown dedicated jitter streams. Default to `rng`;
   *   pass distinct streams (see GameRoom) so a no-jitter run is unaffected but a
   *   jitter run's draws don't interleave with loss / the other direction. With a
   *   no-jitter config the sampler is a no-op and consumes nothing regardless.
   */
  constructor(
    private readonly config: ShimConfig,
    private readonly rng: Rng,
    jitterRngUp: Rng = rng,
    jitterRngDown: Rng = rng,
  ) {
    this.upJitter = new JitterSampler(config.up.jitter ?? NO_JITTER, jitterRngUp);
    this.downJitter = new JitterSampler(config.down.jitter ?? NO_JITTER, jitterRngDown);
  }

  /** Send over the client->server link. Returns false if dropped (loss). */
  up(deliver: Deliver): boolean {
    return this.send(this.config.up, this.upJitter, deliver);
  }

  /** Send over the server->client link. Returns false if dropped (loss). */
  down(deliver: Deliver): boolean {
    return this.send(this.config.down, this.downJitter, deliver);
  }

  /** Cancel all pending deliveries. Call on room dispose. */
  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private send(link: LinkConfig, jitter: JitterSampler, deliver: Deliver): boolean {
    if (this.disposed) return false;
    if (link.lossPct > 0 && this.rng.next() * 100 < link.lossPct) {
      return false; // dropped in transit
    }
    // Effective delay = base + jitter, floored at 0 (no delivery before "now"). A
    // no-op jitter sampler draws nothing, so a clean link keeps the exact
    // synchronous, deterministic fast path it had before #159.
    const effDelayMs = jitter.isNoop()
      ? link.delayMs
      : Math.max(0, link.delayMs + jitter.next());
    if (effDelayMs <= 0) {
      deliver(); // no-impairment fast path: synchronous, deterministic
      return true;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed) return;
      deliver();
    }, effDelayMs);
    this.timers.add(timer);
    return true;
  }
}
