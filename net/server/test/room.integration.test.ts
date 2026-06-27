import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boot, type ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConfig } from '../src/app.js';
import { ROOM_NAME } from '../src/config.js';
import { GameRoom, type GameRoomOptions } from '../src/rooms/GameRoom.js';
import { ProbeClient, type ClientRoomLike } from '../src/client/probeClient.js';
import { assertMetricsSample } from '../src/metrics/validate.js';

const BOT_COUNT = 4;
const TICK_RATE = 20;

const waitFor = async (
  cond: () => boolean,
  timeoutMs = 6000,
  stepMs = 20,
): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

describe('GameRoom (in-process integration)', () => {
  let colyseus: ColyseusTestServer;

  beforeAll(async () => {
    colyseus = await boot(appConfig);
  });

  afterAll(async () => {
    await colyseus.shutdown();
  });

  it('drives join -> input -> snapshot -> leave and emits a #140-conformant metrics line', async () => {
    // Arrange
    const metricsPath = join(tmpdir(), `net-${randomUUID()}.metrics.jsonl`);
    const options: GameRoomOptions = {
      scenario: 'n1-integration',
      engine: 'three',
      seed: 42,
      tickRate: TICK_RATE,
      botCount: BOT_COUNT,
      metricsPath,
      flushIntervalMs: 100,
      shim: {
        up: { delayMs: 0, lossPct: 0 },
        down: { delayMs: 0, lossPct: 0 },
      },
    };
    const room = await colyseus.createRoom(ROOM_NAME, options);
    const gameRoom = room as unknown as GameRoom;

    const clientRoom = (await colyseus.connectTo(room)) as unknown as ClientRoomLike;
    const probe = new ProbeClient(clientRoom, { inputHz: 30 });
    probe.start();

    // Act: let join + several snapshot round-trips happen.
    await waitFor(() => probe.welcome !== null && probe.snapshotCount >= 5);

    // Assert: welcome handshake
    expect(probe.welcome?.playerId).toBe(clientRoom.sessionId);
    expect(probe.welcome?.tickRate).toBe(TICK_RATE);

    // Assert: snapshot is authoritative, thin, and echoes our input seq
    const snap = probe.lastSnapshot;
    expect(snap).not.toBeNull();
    const self = snap?.players.find((p) => p.id === clientRoom.sessionId);
    expect(self).toBeDefined();
    expect(self?.seq).toBeGreaterThan(0); // an input was processed + echoed
    // 1 connected client + BOT_COUNT server bots are all replicated
    expect(snap?.players.length).toBe(1 + BOT_COUNT);
    expect(gameRoom.connectedCount).toBe(1);
    expect(gameRoom.activeBotCount).toBe(BOT_COUNT);

    // Snapshot DTO is exactly the thin shape { id, pos, yaw, flags, seq }
    expect(Object.keys(self ?? {}).sort()).toEqual(
      ['flags', 'id', 'pos', 'seq', 'yaw'].sort(),
    );

    // Act: flush metrics and disconnect
    gameRoom.forceFlushMetrics();
    probe.stop();
    await clientRoom.leave();
    await waitFor(() => gameRoom.connectedCount === 0);

    // Assert: leave removed the player from authoritative state
    expect(gameRoom.connectedCount).toBe(0);

    // Assert: metrics.jsonl — one line, satisfies the #140 schema
    const lines = readFileSync(metricsPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const first = assertMetricsSample(JSON.parse(lines[0]));
    expect(first.scenario).toBe('n1-integration');
    expect(first.engine).toBe('three');
    expect(first.tickRate).toBe(TICK_RATE);
    expect(first.botCount).toBe(BOT_COUNT);
    expect(first.clientCount).toBe(1);
    // RTT was measured from an echoed seq (probe reported it back)
    expect(first.rttP50Ms).toBeGreaterThanOrEqual(0);
  });

  it('records lossPct as max(up, down) so asymmetric loss is never under-reported', async () => {
    // Arrange: loss only on the DOWN link — the schema has a single lossPct.
    const metricsPath = join(tmpdir(), `net-${randomUUID()}.metrics.jsonl`);
    const options: GameRoomOptions = {
      scenario: 'n1-asym-loss',
      engine: 'three',
      seed: 7,
      tickRate: TICK_RATE,
      botCount: 2,
      metricsPath,
      flushIntervalMs: 100,
      shim: {
        up: { delayMs: 0, lossPct: 0 },
        down: { delayMs: 0, lossPct: 20 },
      },
    };
    const room = await colyseus.createRoom(ROOM_NAME, options);
    const gameRoom = room as unknown as GameRoom;

    // Act: let a few ticks run, then flush (no client needed — config-derived).
    await new Promise((r) => setTimeout(r, 200));
    gameRoom.forceFlushMetrics();

    // Assert: lossPct == max(0, 20) == 20, NOT the up-link's 0.
    const lines = readFileSync(metricsPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const sample = assertMetricsSample(JSON.parse(lines[0]));
    expect(sample.lossPct).toBe(20);
    expect(sample.injectedDelayCtoSMs).toBe(0);
    expect(sample.injectedDelayStoCMs).toBe(0);

    await room.disconnect();
  });
});
