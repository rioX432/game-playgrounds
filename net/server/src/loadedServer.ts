// Loaded standalone server harness for the client-render probe (#166).
//
// The plain `dev:server` (src/index.ts) boots an EMPTY room (botCount 0): a
// browser that joins sees only itself, so there is no render load to measure.
// This thin wrapper boots the SAME Colyseus app, then PRE-CREATES one labelled
// `game` room loaded with bots (and optional impairment) from env — reusing the
// #144 knobs and the existing `GameRoomOptions`. A real three/babylon client's
// UNCHANGED `joinOrCreate("game")` then lands in this loaded room and renders
// `botCount + 1` synced entities under net load.
//
// It deliberately adds NO new room/netcode surface: it only seeds a room via the
// standard matchmaker, exactly as the in-process scenario runner does with
// `createRoom(ROOM_NAME, options)`. Measurement of render perf happens on the
// CLIENT (the probe); this harness just provides the load + the join keys.

import { listen } from '@colyseus/tools';
import { matchMaker } from 'colyseus';
import { ENGINES, type Engine } from 'net-protocol';
import { appConfig } from './app.js';
import { ROOM_NAME } from './config.js';
import type { GameRoomOptions } from './rooms/GameRoom.js';

const DEFAULT_PORT = 2567;
const DEFAULT_SCENARIO = 'n2-stress-ramp';
const DEFAULT_SEED = 12345;
const DEFAULT_TICK_RATE = 20;
const DEFAULT_BOT_COUNT = 24;

/** Parse a finite numeric env knob, falling back when unset/blank/invalid. */
const numEnv = (key: string, fallback: number): number => {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const parseEngine = (v: string | undefined): Engine =>
  v !== undefined && (ENGINES as readonly string[]).includes(v)
    ? (v as Engine)
    : 'three';

async function main(): Promise<void> {
  const port = numEnv('PORT', DEFAULT_PORT);

  const scenario = process.env.SCENARIO ?? DEFAULT_SCENARIO;
  const engine = parseEngine(process.env.ENGINE);
  const seed = numEnv('SEED', DEFAULT_SEED);
  const tickRate = numEnv('TICK', DEFAULT_TICK_RATE);
  // BOT_COUNT is the loaded stage; the browser renders this many bots + itself.
  const botCount = numEnv('BOT_COUNT', DEFAULT_BOT_COUNT);
  const delayUpMs = numEnv('DELAY_UP_MS', 0);
  const delayDownMs = numEnv('DELAY_DOWN_MS', 0);
  const lossUpPct = numEnv('LOSS_UP_PCT', 0);
  const lossDownPct = numEnv('LOSS_DOWN_PCT', 0);

  const options: GameRoomOptions = {
    scenario,
    engine,
    seed,
    tickRate,
    botCount,
    shim: {
      up: { delayMs: delayUpMs, lossPct: lossUpPct },
      down: { delayMs: delayDownMs, lossPct: lossDownPct },
    },
    // Optionally mirror server metrics for the SAME live room (pairs 1:1 with the
    // client-render.jsonl). Off by default — the canonical metrics.jsonl is the
    // scenario runner's; this harness primarily provides load + join keys.
    ...(process.env.OUT ? { metricsPath: process.env.OUT } : {}),
  };

  await listen(appConfig, port);
  await matchMaker.createRoom(ROOM_NAME, options);

  // The single `lossPct` join key is max(up, down) — same rule as MetricsSample.
  const lossPct = Math.max(lossUpPct, lossDownPct);
  // Emit the exact probe URL query the browser must use so the emitted
  // ClientRenderSample join keys line up with this loaded room (and a matching
  // metrics.jsonl stage). clientCount=1 assumes a single real renderer.
  const query =
    `?probe=1&scenario=${encodeURIComponent(scenario)}&seed=${seed}` +
    `&tickRate=${tickRate}&botCount=${botCount}&clientCount=1` +
    `&delayCtoSMs=${delayUpMs}&delayStoCMs=${delayDownMs}&lossPct=${lossPct}`;

  // eslint-disable-next-line no-console
  console.log(
    `loaded room "${ROOM_NAME}" on :${port} — scenario=${scenario} seed=${seed} ` +
      `tick=${tickRate}Hz bots=${botCount} engine=${engine} ` +
      `delay(up/down)=${delayUpMs}/${delayDownMs}ms loss(up/down)=${lossUpPct}/${lossDownPct}%`,
  );
  // eslint-disable-next-line no-console
  console.log(`probe URL query: ${query}`);
}

void main();
