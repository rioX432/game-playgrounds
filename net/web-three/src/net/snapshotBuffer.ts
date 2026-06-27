// Pure, render-agnostic snapshot interpolation buffer.
//
// This is the heart of the client side of the chapter's
// server-authoritative + client-interpolation pattern (net/CLAUDE.md). It holds
// the most recent authoritative SnapshotMessage frames and, given a target
// SERVER time, produces interpolated entity poses between the two bracketing
// snapshots. It owns NO Three.js / Colyseus types, so it is headless-testable
// and mirrors the same interpolation a Bevy client would do.

import type { PlayerSnapshot, SnapshotMessage } from "net-protocol";

const TAU = Math.PI * 2;

/** One entity's interpolated render pose at a queried time. */
export interface InterpolatedPlayer {
  id: string;
  /** Interpolated world position [x, y, z]. */
  pos: [number, number, number];
  /** Interpolated facing yaw, radians (shortest-arc). */
  yaw: number;
  /** Boolean state bitfield (taken from the newer authoritative frame). */
  flags: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shortest-arc angular interpolation, radians. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/** Copy a snapshot's players verbatim (clamp case — no interpolation). */
function snapshotPlayers(snap: SnapshotMessage): InterpolatedPlayer[] {
  return snap.players.map((p: PlayerSnapshot) => ({
    id: p.id,
    pos: [p.pos[0], p.pos[1], p.pos[2]],
    yaw: p.yaw,
    flags: p.flags,
  }));
}

/** Interpolate every entity present in BOTH frames; snap newcomers to `b`. */
function interpolate(
  a: SnapshotMessage,
  b: SnapshotMessage,
  serverTimeMs: number,
): InterpolatedPlayer[] {
  const span = b.serverTimeMs - a.serverTimeMs;
  const alpha = span > 0 ? (serverTimeMs - a.serverTimeMs) / span : 0;
  const aById = new Map(a.players.map((p) => [p.id, p]));

  const out: InterpolatedPlayer[] = [];
  // Iterate the NEWER frame: entities that left (in `a`, not `b`) are dropped.
  for (const pb of b.players) {
    const pa = aById.get(pb.id);
    if (!pa) {
      // Appeared between the two frames: no pair to blend, render at `b`.
      out.push({
        id: pb.id,
        pos: [pb.pos[0], pb.pos[1], pb.pos[2]],
        yaw: pb.yaw,
        flags: pb.flags,
      });
      continue;
    }
    out.push({
      id: pb.id,
      pos: [
        lerp(pa.pos[0], pb.pos[0], alpha),
        lerp(pa.pos[1], pb.pos[1], alpha),
        lerp(pa.pos[2], pb.pos[2], alpha),
      ],
      yaw: lerpAngle(pa.yaw, pb.yaw, alpha),
      // Boolean entity state is not interpolated — take the newer frame's value.
      flags: pb.flags,
    });
  }
  return out;
}

/**
 * Holds recent authoritative frames (sorted ascending by `serverTimeMs`) and
 * samples interpolated poses at a target server time. Stale/out-of-order frames
 * (<= newest held) are dropped so interpolation only ever advances forward.
 */
export class SnapshotBuffer {
  private readonly snaps: SnapshotMessage[] = [];

  constructor(private readonly maxSnapshots = 60) {}

  /** Ingest a frame. No-op for an out-of-order or duplicate frame. */
  push(snap: SnapshotMessage): void {
    const newest = this.snaps[this.snaps.length - 1];
    if (newest && snap.serverTimeMs <= newest.serverTimeMs) return;
    this.snaps.push(snap);
    while (this.snaps.length > this.maxSnapshots) this.snaps.shift();
  }

  /** Number of buffered frames. */
  get size(): number {
    return this.snaps.length;
  }

  /** Server time of the freshest buffered frame, or null if empty. */
  latestServerTimeMs(): number | null {
    const n = this.snaps.length;
    return n === 0 ? null : this.snaps[n - 1].serverTimeMs;
  }

  /** Entity count in the freshest frame (no interpolation / allocation). */
  latestPlayerCount(): number {
    const n = this.snaps.length;
    return n === 0 ? 0 : this.snaps[n - 1].players.length;
  }

  /**
   * Interpolated entity poses at `serverTimeMs`.
   * - empty buffer → `[]`
   * - before the oldest frame → clamp to the oldest (no backward extrapolation)
   * - after the newest frame → hold the newest (no forward extrapolation)
   * - otherwise → blend the two bracketing frames.
   */
  sampleAt(serverTimeMs: number): InterpolatedPlayer[] {
    const n = this.snaps.length;
    if (n === 0) return [];
    if (n === 1) return snapshotPlayers(this.snaps[0]);

    const first = this.snaps[0];
    const last = this.snaps[n - 1];
    if (serverTimeMs <= first.serverTimeMs) return snapshotPlayers(first);
    if (serverTimeMs >= last.serverTimeMs) return snapshotPlayers(last);

    for (let i = 0; i < n - 1; i++) {
      const a = this.snaps[i];
      const b = this.snaps[i + 1];
      if (serverTimeMs >= a.serverTimeMs && serverTimeMs < b.serverTimeMs) {
        return interpolate(a, b, serverTimeMs);
      }
    }
    // Unreachable given the clamp guards above; hold newest defensively.
    return snapshotPlayers(last);
  }
}
