// Headless measurement scenario runner. Boots the room IN-PROCESS, connects N
// probe clients + M server bots under configurable impairment, runs for a fixed
// duration, and appends MetricsSample lines to metrics.jsonl. No rendering.
//
// Config via env vars (all optional):
//   SCENARIO ENGINE SEED TICK BOTS CLIENTS INPUT_HZ DURATION_MS FLUSH_MS OUT
//   DELAY_UP_MS DELAY_DOWN_MS LOSS_UP_PCT LOSS_DOWN_PCT
//
//   BOTS supports a ramp, e.g. BOTS="2,24,100" — each stage runs DURATION_MS.

import { boot } from '@colyseus/testing';
import { ENGINES, type Engine } from 'net-protocol';
import { appConfig } from './app.js';
import { ROOM_NAME } from './config.js';
import { ProbeClient, type ClientRoomLike } from './client/probeClient.js';
import { GameRoom, type GameRoomOptions } from './rooms/GameRoom.js';

const num = (key: string, def: number): number => {
  const v = process.env[key];
  return v === undefined ? def : Number(v);
};

const parseEngine = (v: string | undefined): Engine =>
  v !== undefined && (ENGINES as readonly string[]).includes(v)
    ? (v as Engine)
    : 'three';

const parseRamp = (v: string | undefined, def: number): number[] =>
  v === undefined
    ? [def]
    : v
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const clientCount = num('CLIENTS', 2);
  const tickRate = num('TICK', 20);
  const durationMs = num('DURATION_MS', 3000);
  const inputHz = num('INPUT_HZ', 30);
  const seed = num('SEED', 1);
  const metricsPath = process.env.OUT ?? 'metrics.jsonl';
  const botStages = parseRamp(process.env.BOTS, 8);

  const options: GameRoomOptions = {
    scenario: process.env.SCENARIO ?? 'adhoc',
    engine: parseEngine(process.env.ENGINE),
    seed,
    tickRate,
    botCount: botStages[0],
    metricsPath,
    flushIntervalMs: num('FLUSH_MS', 1000),
    shim: {
      up: { delayMs: num('DELAY_UP_MS', 0), lossPct: num('LOSS_UP_PCT', 0) },
      down: { delayMs: num('DELAY_DOWN_MS', 0), lossPct: num('LOSS_DOWN_PCT', 0) },
    },
  };

  const colyseus = await boot(appConfig);
  const room = await colyseus.createRoom(ROOM_NAME, options);
  const gameRoom = room as unknown as GameRoom;

  const probes: ProbeClient[] = [];
  const clientRooms: ClientRoomLike[] = [];
  for (let i = 0; i < clientCount; i++) {
    const cr = (await colyseus.connectTo(room)) as unknown as ClientRoomLike;
    const probe = new ProbeClient(cr, { inputHz });
    probe.start();
    probes.push(probe);
    clientRooms.push(cr);
  }

  for (const bots of botStages) {
    gameRoom.setBotCount(bots);
    // eslint-disable-next-line no-console
    console.log(`stage: ${bots} bots, ${clientCount} clients @ ${tickRate}Hz`);
    await sleep(durationMs);
  }

  // Flush the final window WHILE clients are still connected so clientCount and
  // the windowed byte counters describe the same moment.
  gameRoom.forceFlushMetrics();
  for (const probe of probes) probe.stop();
  for (const cr of clientRooms) await cr.leave();
  await colyseus.shutdown();
  // eslint-disable-next-line no-console
  console.log(`scenario complete -> ${metricsPath}`);
}

void main();
