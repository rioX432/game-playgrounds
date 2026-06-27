// A measurement PROBE client. Connected (non-bot) clients are the only RTT /
// snapshot-age probes: they close the round-trip loop the server cannot. Inputs
// carry a monotonic seq + client timestamp; when a snapshot echoes that seq the
// probe derives RTT and reports it back over the telemetry uplink.
//
// Typed structurally (ClientRoomLike) so this file never imports a Colyseus-
// specific client type — keeping the Colyseus coupling isolated.

import {
  MSG,
  type PlayerInput,
  type SnapshotMessage,
  type WelcomeMessage,
} from 'net-protocol';
import { MSG_STAT, type StatMessage } from '../telemetry.js';

/** Minimal surface of a connected Colyseus client room the probe needs. */
export interface ClientRoomLike {
  sessionId: string;
  onMessage<T = unknown>(type: string, cb: (msg: T) => void): void;
  send(type: string, msg?: unknown): void;
  leave(consented?: boolean): Promise<number>;
}

export interface ProbeOptions {
  /** Input send rate, Hz. */
  inputHz: number;
  /** Monotonic clock source (ms); injectable for tests. */
  now?: () => number;
}

export class ProbeClient {
  private seq = 0;
  private readonly sendTimes = new Map<number, number>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private moveX = 1;
  private moveZ = 0;
  private readonly now: () => number;

  welcome: WelcomeMessage | null = null;
  lastSnapshot: SnapshotMessage | null = null;
  snapshotCount = 0;
  lastRttMs = 0;

  constructor(
    private readonly room: ClientRoomLike,
    private readonly opts: ProbeOptions,
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.room.onMessage<WelcomeMessage>(MSG.WELCOME, (m) => {
      this.welcome = m;
    });
    this.room.onMessage<SnapshotMessage>(MSG.SNAPSHOT, (m) =>
      this.onSnapshot(m),
    );
  }

  /** Begin sending inputs at the configured rate. */
  start(): void {
    if (this.interval) return;
    const periodMs = 1000 / this.opts.inputHz;
    this.interval = setInterval(() => this.sendInput(), periodMs);
  }

  /** Stop sending inputs. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Highest input seq this probe has sent (0 if none). */
  get lastSentSeq(): number {
    return this.seq;
  }

  private sendInput(): void {
    this.seq += 1;
    const t = this.now();
    this.sendTimes.set(this.seq, t);
    const input: PlayerInput = {
      seq: this.seq,
      clientTimeMs: t,
      move: [this.moveX, this.moveZ],
      yaw: Math.atan2(this.moveZ, this.moveX),
      buttons: 0,
    };
    this.room.send(MSG.INPUT, input);
  }

  private onSnapshot(snap: SnapshotMessage): void {
    this.lastSnapshot = snap;
    this.snapshotCount += 1;
    const recvMs = this.now();
    const self = snap.players.find((p) => p.id === this.room.sessionId);
    const snapshotAgeMs = Math.max(recvMs - snap.serverTimeMs, 0);

    let rttMs = this.lastRttMs;
    if (self && self.seq > 0) {
      const sentAt = this.sendTimes.get(self.seq);
      if (sentAt !== undefined) {
        rttMs = Math.max(recvMs - sentAt, 0);
        this.lastRttMs = rttMs;
        // Drop acknowledged seqs to bound the map.
        for (const k of this.sendTimes.keys()) {
          if (k <= self.seq) this.sendTimes.delete(k);
        }
      }
    }

    const stat: StatMessage = { rttMs, snapshotAgeMs };
    this.room.send(MSG_STAT, stat);
  }
}
