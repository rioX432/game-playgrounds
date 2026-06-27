// Scenario runner (#144). Executes a ScenarioDef in-process against the real
// Colyseus GameRoom (via @colyseus/testing) and returns one MetricsSample per
// stage, optionally appending them to metrics.jsonl.
//
// Room-boot strategy (Codex-reviewed): tickRate and shim are FIXED at onCreate,
// so a fresh room is required whenever they (or clientCount) change. Consecutive
// stages that share those params are grouped into ONE room and the bots are
// live-ramped between them — the faithful "load grows under a steady server"
// shape used by n2-stress-ramp. Sweeps (latency / tick) change params every
// stage, so each is its own fresh room.

import { boot, type ColyseusTestServer } from '@colyseus/testing';
import type { Engine, MetricsSample } from 'net-protocol';
import { appConfig } from '../app.js';
import { ROOM_NAME } from '../config.js';
import { ProbeClient, type ClientRoomLike } from '../client/probeClient.js';
import type { GameRoom, GameRoomOptions } from '../rooms/GameRoom.js';
import type { ShimConfig } from '../transport/shim.js';
import type { ScenarioDef, Stage } from './types.js';

/** Probe input rate, Hz — fixed across stages so input load is a constant. */
const PROBE_INPUT_HZ = 30;

/**
 * Flush cadence high enough that the periodic flusher NEVER fires mid-stage, so
 * the only metrics line per stage is the boundary forceFlushMetrics(). One day.
 */
const NEVER_FLUSH_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Connect attempts before giving up, and the per-retry backoff base, ms. */
const CONNECT_ATTEMPTS = 5;
const CONNECT_BACKOFF_MS = 50;

/**
 * Connect a probe to a room, retrying transient transport resets. Opening a new
 * room right after a previous room's clients left can hand the in-process test
 * client a stale keep-alive HTTP socket, surfacing as a one-shot ECONNRESET on
 * the matchmake request; a retry opens a fresh socket and succeeds.
 */
async function connectWithRetry(
  colyseus: ColyseusTestServer,
  room: Awaited<ReturnType<ColyseusTestServer['createRoom']>>,
): Promise<ClientRoomLike> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    try {
      return (await colyseus.connectTo(room)) as unknown as ClientRoomLike;
    } catch (err) {
      lastErr = err;
      await sleep(CONNECT_BACKOFF_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

const shimKey = (s: ShimConfig): string =>
  `${s.up.delayMs}/${s.up.lossPct}|${s.down.delayMs}/${s.down.lossPct}`;

/** Room-construction identity of a stage: stages sharing it can reuse one room. */
const segmentKey = (s: Stage): string =>
  `${s.tickRate}|${s.clientCount}|${shimKey(s.shim)}`;

/**
 * Group stages into maximal consecutive runs that share room-construction
 * params. Each group becomes one room boot; bots ramp live within it. Pure +
 * exported so the grouping decision is unit-testable without booting Colyseus.
 */
export function planSegments(stages: readonly Stage[]): Stage[][] {
  const segments: Stage[][] = [];
  let current: Stage[] = [];
  let key: string | null = null;
  for (const stage of stages) {
    const k = segmentKey(stage);
    if (key === null || k !== key) {
      if (current.length > 0) segments.push(current);
      current = [];
      key = k;
    }
    current.push(stage);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export interface RunOptions {
  /** RNG seed — reproduces bot motion exactly (loss draws are not reproducible). */
  seed?: number;
  /** Engine label stamped on the samples (render is a dependent variable). */
  engine?: Engine;
  /** If set, every emitted sample is appended to this metrics.jsonl file. */
  metricsPath?: string;
  /** Per-stage callback (live progress / logging). */
  onStage?: (sample: MetricsSample, stage: Stage, index: number) => void;
}

/**
 * Run a scenario end-to-end. Returns the per-stage samples in stage order.
 * The same metrics.jsonl is written when `metricsPath` is provided.
 *
 * ONE Colyseus boot drives the whole scenario; each segment opens a fresh room
 * on it (a new room per tick/shim/clientCount change, since those are fixed at
 * onCreate). A finished room is NOT force-disconnected mid-run — that churns the
 * in-process test client's keep-alive socket (ECONNRESET) — it is instead
 * drained to zero bots and left to idle until the final shutdown, so its
 * residual per-tick cost cannot perturb the next room's server-tick numbers.
 */
export async function runScenario(
  def: ScenarioDef,
  opts: RunOptions = {},
): Promise<MetricsSample[]> {
  const seed = opts.seed ?? 1;
  const engine: Engine = opts.engine ?? 'three';
  const colyseus = await boot(appConfig);
  const samples: MetricsSample[] = [];
  let index = 0;
  try {
    for (const segment of planSegments(def.stages)) {
      await runSegment(colyseus, def, segment, { seed, engine, metricsPath: opts.metricsPath }, (sample, stage) => {
        samples.push(sample);
        opts.onStage?.(sample, stage, index);
        index += 1;
      });
    }
  } finally {
    await colyseus.shutdown();
  }
  return samples;
}

interface SegmentCtx {
  seed: number;
  engine: Engine;
  metricsPath?: string;
}

/** Open one room for a segment, connect probes, run each stage, drain it idle. */
async function runSegment(
  colyseus: ColyseusTestServer,
  def: ScenarioDef,
  segment: Stage[],
  ctx: SegmentCtx,
  emit: (sample: MetricsSample, stage: Stage) => void,
): Promise<void> {
  const first = segment[0];
  const options: GameRoomOptions = {
    scenario: def.id,
    engine: ctx.engine,
    seed: ctx.seed,
    tickRate: first.tickRate,
    botCount: first.botCount,
    metricsPath: ctx.metricsPath,
    flushIntervalMs: NEVER_FLUSH_MS,
    shim: first.shim,
  };
  const room = await colyseus.createRoom(ROOM_NAME, options);
  const gameRoom = room as unknown as GameRoom;

  const probes: ProbeClient[] = [];
  const clientRooms: ClientRoomLike[] = [];
  try {
    for (let c = 0; c < first.clientCount; c++) {
      const cr = await connectWithRetry(colyseus, room);
      // Track the connection BEFORE building the probe, so a probe-construction
      // throw still leaves `cr` to be torn down in the finally.
      clientRooms.push(cr);
      const probe = new ProbeClient(cr, { inputHz: PROBE_INPUT_HZ });
      probe.start();
      probes.push(probe);
    }

    for (const stage of segment) {
      gameRoom.setBotCount(stage.botCount);
      // Settle the new load, THEN discard the warmup window so this stage's
      // sample averages are clean (no previous-stage bots / ramp transients).
      await sleep(stage.warmupMs);
      gameRoom.resetMetricsWindow();
      await sleep(stage.measureMs);
      emit(gameRoom.forceFlushMetrics(), stage);
    }
  } finally {
    for (const probe of probes) probe.stop();
    // Isolate each leave: one rejection must not skip the remaining leaves or the
    // drain below (this is a finally — a throw here would also mask a try error).
    for (const cr of clientRooms) {
      try {
        await cr.leave();
      } catch {
        // best-effort teardown; the final colyseus.shutdown() reclaims the rest
      }
    }
    // Drain to idle instead of disconnecting: a mid-run room.disconnect() resets
    // the shared test-client keep-alive socket. With no clients and no bots the
    // room's tick does near-zero work until the scenario's final shutdown.
    gameRoom.setBotCount(0);
  }
}
