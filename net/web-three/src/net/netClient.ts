// Colyseus connection wrapper — the ONLY place that touches the network.
//
// Responsibilities (and nothing more, by chapter design):
//   - join the shared authoritative room;
//   - feed received SnapshotMessage frames into the interpolation buffer;
//   - send thin PlayerInput frames (seq + client monotonic timestamp);
//   - derive RTT from the echoed input seq, exactly as the server-side probe
//     does (net/server/src/client/probeClient.ts);
//   - expose interpolated render poses + HUD telemetry.
//
// Authoritative state lives on the server; this client keeps only the minimal
// state required to render and to interpolate (net/CLAUDE.md).

import { Client } from "colyseus.js";
import type { Room } from "colyseus.js";
import {
  MSG,
  type PlayerInput,
  type SnapshotMessage,
  type WelcomeMessage,
} from "net-protocol";
import {
  DEFAULT_INTERP_DELAY_MS,
  INTERP_TICKS,
  MAX_SNAPSHOTS,
  ROOM_NAME,
  SERVER_ENDPOINT,
} from "../config";
import { SnapshotBuffer, type InterpolatedPlayer } from "./snapshotBuffer";

const MS_PER_SEC = 1000;
// Cap on un-acknowledged input timestamps. A snapshot normally drains these by
// echoing the seq; the cap bounds memory if echoes stall (server never returns
// this client's id, or it disconnects mid-flight).
const MAX_PENDING_INPUTS = 256;

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "error"
  | "disconnected";

/** A monotonic clock source; injectable for tests. */
type Now = () => number;

export class NetClient {
  private readonly client: Client;
  private room: Room | null = null;
  private readonly buffer = new SnapshotBuffer(MAX_SNAPSHOTS);
  private readonly now: Now;

  // Maps client monotonic clock → server clock: server's monotonic origin is
  // arbitrary, so we anchor it to the WelcomeMessage. This folds the welcome's
  // one-way latency into the baseline (honest caveat — see README).
  private offsetMs = 0;
  private hasOffset = false;
  private interpDelayMs = DEFAULT_INTERP_DELAY_MS;

  private seq = 0;
  private readonly sendTimes = new Map<number, number>();

  status: ConnectionStatus = "connecting";
  errorMessage = "";
  selfId = "";
  tickRate = 0;
  rttMs = 0;
  private lastSnapshotServerTimeMs: number | null = null;

  constructor(now: Now = () => performance.now()) {
    this.client = new Client(SERVER_ENDPOINT);
    this.now = now;
  }

  /** Join the room. Failures surface via `status`/`errorMessage`, not throws. */
  async connect(): Promise<void> {
    try {
      const room = await this.client.joinOrCreate(ROOM_NAME);
      this.room = room;
      this.selfId = room.sessionId;
      room.onMessage<WelcomeMessage>(MSG.WELCOME, (w) => this.onWelcome(w));
      room.onMessage<SnapshotMessage>(MSG.SNAPSHOT, (s) => this.onSnapshot(s));
      room.onError((code, message) => {
        this.status = "error";
        this.errorMessage = `${code} ${message ?? ""}`.trim();
      });
      room.onLeave(() => {
        this.status = "disconnected";
      });
      this.status = "connected";
    } catch (err) {
      this.status = "error";
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  private onWelcome(w: WelcomeMessage): void {
    this.tickRate = w.tickRate;
    this.interpDelayMs =
      w.tickRate > 0
        ? (INTERP_TICKS * MS_PER_SEC) / w.tickRate
        : DEFAULT_INTERP_DELAY_MS;
    this.offsetMs = this.now() - w.serverTimeMs;
    this.hasOffset = true;
    if (!this.selfId) this.selfId = w.playerId;
  }

  private onSnapshot(snap: SnapshotMessage): void {
    // Guard the one place that ingests untrusted wire data: a malformed frame
    // must not throw here OR later in the render loop. Top-level shape first,
    // then every player's render-critical fields (a missing pos/yaw/etc. would
    // otherwise throw inside interpolate()/snapshotPlayers during frame()).
    if (!snap || !Array.isArray(snap.players) || typeof snap.serverTimeMs !== "number") {
      return;
    }
    for (const p of snap.players) {
      if (
        !p ||
        typeof p.id !== "string" ||
        typeof p.seq !== "number" ||
        typeof p.yaw !== "number" ||
        typeof p.flags !== "number" ||
        !Array.isArray(p.pos) ||
        p.pos.length < 3 ||
        typeof p.pos[0] !== "number" ||
        typeof p.pos[1] !== "number" ||
        typeof p.pos[2] !== "number"
      ) {
        return;
      }
    }
    this.buffer.push(snap);
    this.lastSnapshotServerTimeMs = snap.serverTimeMs;

    // RTT from the echoed input seq — no cross-machine wall-clock subtraction.
    const self = snap.players.find((p) => p.id === this.selfId);
    if (self && self.seq > 0) {
      const sentAt = this.sendTimes.get(self.seq);
      if (sentAt !== undefined) {
        this.rttMs = Math.max(this.now() - sentAt, 0);
        // Drop acknowledged seqs (also prevents re-measuring the same echo).
        for (const k of this.sendTimes.keys()) {
          if (k <= self.seq) this.sendTimes.delete(k);
        }
      }
    }
  }

  /** Send one input frame. No-op until connected. */
  sendInput(move: readonly [number, number], yaw: number, buttons: number): void {
    if (!this.room || this.status !== "connected") return;
    this.seq += 1;
    const t = this.now();
    this.sendTimes.set(this.seq, t);
    // Bound memory if echoes stall: drop the oldest pending input (Map keeps
    // insertion order, so the first key is the oldest seq).
    if (this.sendTimes.size > MAX_PENDING_INPUTS) {
      const oldest = this.sendTimes.keys().next().value;
      if (oldest !== undefined) this.sendTimes.delete(oldest);
    }
    const input: PlayerInput = {
      seq: this.seq,
      clientTimeMs: t,
      move: [move[0], move[1]],
      yaw,
      buttons,
    };
    this.room.send(MSG.INPUT, input);
  }

  /** Estimate of "now" expressed on the server's monotonic clock. */
  private estServerNow(): number {
    return this.now() - this.offsetMs;
  }

  /** Interpolated poses to render this frame (render delayed by INTERP_TICKS). */
  sample(): InterpolatedPlayer[] {
    if (!this.hasOffset) {
      // No clock baseline yet — render the freshest frame verbatim.
      const t = this.buffer.latestServerTimeMs();
      return t === null ? [] : this.buffer.sampleAt(t);
    }
    return this.buffer.sampleAt(this.estServerNow() - this.interpDelayMs);
  }

  /** Number of entities currently synced (connected clients + server bots). */
  get syncedCount(): number {
    return this.buffer.latestPlayerCount();
  }

  /** Staleness of the freshest received snapshot, ms (honest down-path age). */
  get snapshotAgeMs(): number {
    if (!this.hasOffset || this.lastSnapshotServerTimeMs === null) return 0;
    return Math.max(this.estServerNow() - this.lastSnapshotServerTimeMs, 0);
  }

  /** Leave the room and release tracking state. */
  dispose(): void {
    this.sendTimes.clear();
    void this.room?.leave();
    this.room = null;
  }
}
