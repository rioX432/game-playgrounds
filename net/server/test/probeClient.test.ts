import { afterEach, describe, expect, it, vi } from 'vitest';
import { MSG, type SnapshotMessage } from 'net-protocol';
import { ProbeClient, type ClientRoomLike } from '../src/client/probeClient.js';
import { MSG_STAT, type StatMessage } from '../src/telemetry.js';

interface Sent {
  type: string;
  msg: unknown;
}

function makeRoom(): {
  room: ClientRoomLike;
  sent: Sent[];
  emitSnapshot: (snap: SnapshotMessage) => void;
} {
  const sent: Sent[] = [];
  let snapshotCb: ((m: SnapshotMessage) => void) | null = null;
  const room: ClientRoomLike = {
    sessionId: 'me',
    onMessage: <T>(type: string, cb: (msg: T) => void): void => {
      if (type === MSG.SNAPSHOT) {
        snapshotCb = cb as (m: SnapshotMessage) => void;
      }
    },
    send: (type, msg) => sent.push({ type, msg }),
    leave: async () => 0,
  };
  return {
    room,
    sent,
    emitSnapshot: (snap) => snapshotCb?.(snap),
  };
}

const snap = (selfSeq: number, serverTimeMs: number): SnapshotMessage => ({
  tick: 1,
  serverTimeMs,
  players: [{ id: 'me', pos: [0, 0, 0], yaw: 0, flags: 1, seq: selfSeq }],
});

const stats = (sent: Sent[]): StatMessage[] =>
  sent.filter((s) => s.type === MSG_STAT).map((s) => s.msg as StatMessage);

describe('ProbeClient RTT measurement', () => {
  afterEach(() => vi.useRealTimers());

  it('reports the -1 sentinel before any input is echoed (no spurious 0ms)', () => {
    const { room, sent, emitSnapshot } = makeRoom();
    let t = 100;
    new ProbeClient(room, { inputHz: 10, now: () => t });

    // snapshot arrives before our first input round-trips (self.seq === 0)
    emitSnapshot(snap(0, 90));

    const s = stats(sent);
    expect(s).toHaveLength(1);
    expect(s[0].rttMs).toBe(-1); // NOT 0 — would pollute the percentiles
    expect(s[0].snapshotAgeMs).toBe(10);
  });

  it('measures a fresh echo once, then sentinels repeats of the same seq', () => {
    vi.useFakeTimers();
    const { room, sent, emitSnapshot } = makeRoom();
    let t = 0;
    const probe = new ProbeClient(room, { inputHz: 10, now: () => t });

    probe.start();
    vi.advanceTimersByTime(100); // one input sent at t=0, seq=1
    probe.stop();

    t = 20; // snapshot echoes seq 1 -> fresh RTT = 20ms
    emitSnapshot(snap(1, 10));
    // same seq echoed again -> no fresh measurement -> sentinel
    emitSnapshot(snap(1, 15));

    const s = stats(sent);
    expect(s).toHaveLength(2);
    expect(s[0].rttMs).toBe(20);
    expect(s[1].rttMs).toBe(-1); // not re-counted
  });
});
