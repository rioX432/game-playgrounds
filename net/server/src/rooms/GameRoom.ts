// Server-authoritative Colyseus room.
//
// Piggyback policy (net/CLAUDE.md): we use Colyseus for room lifecycle,
// transport and message routing ONLY. We do NOT use @colyseus/schema auto-sync;
// instead the room broadcasts our own thin PlayerSnapshot frames each tick. This
// (a) keeps the pattern identical to what bevy_replicon will do, (b) makes
// application bytes directly measurable, and (c) avoids coupling measurement to
// Colyseus's opaque delta encoding. (Codex-verified, #141.)

import { ClientState, Room } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import {
  type Engine,
  MSG,
  type PlayerInput,
  type WelcomeMessage,
} from 'net-protocol';
import {
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_TICK_RATE,
  MAX_CLIENTS,
  MAX_TICK_RATE,
  MIN_TICK_RATE,
} from '../config.js';
import { BotDriver } from '../bots/botDriver.js';
import { MetricsCollector, type SampleContext } from '../metrics/collector.js';
import { MetricsWriter } from '../metrics/writer.js';
import { createRng } from '../sim/rng.js';
import { World } from '../sim/world.js';
import { TransportShim, type ShimConfig } from '../transport/shim.js';
import { MSG_STAT, type StatMessage } from '../telemetry.js';

const MS_PER_SEC = 1000;
const DEFAULT_SEED = 1;
// Derive the shim's loss-RNG stream from the same seed but a distinct offset, so
// bot motion (consumed synchronously in tick()) stays fully reproducible
// regardless of when async up-link loss draws happen. (golden-ratio constant)
const SHIM_SEED_OFFSET = 0x9e3779b9;

const ZERO_SHIM: ShimConfig = {
  up: { delayMs: 0, lossPct: 0 },
  down: { delayMs: 0, lossPct: 0 },
};

/** onCreate options. Plain JSON (crosses the matchmaker), so no live objects. */
export interface GameRoomOptions {
  /** Scenario id stamped on every emitted MetricsSample. */
  scenario?: string;
  /** Engine label for the sample (the render engine the probe represents). */
  engine?: Engine;
  /** RNG seed — reproduces bot motion + loss draws. */
  seed?: number;
  /** Server tick rate, Hz (clamped to the 10–30 band). */
  tickRate?: number;
  /** Server-side simulated player count. */
  botCount?: number;
  /** If set, MetricsSample lines are appended here. */
  metricsPath?: string;
  /** Flush cadence, ms. */
  flushIntervalMs?: number;
  /** Bidirectional impairment knobs. */
  shim?: ShimConfig;
}

const clampTick = (hz: number): number =>
  Math.min(Math.max(hz, MIN_TICK_RATE), MAX_TICK_RATE);

export class GameRoom extends Room {
  private world!: World;
  private bots!: BotDriver;
  private shim!: TransportShim;
  private collector!: MetricsCollector;
  private writer: MetricsWriter | null = null;

  private tickRate = DEFAULT_TICK_RATE;
  private dtSec = 1 / DEFAULT_TICK_RATE;
  private tickCount = 0;
  private lastFlushMs = 0;
  private flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
  private shimConfig: ShimConfig = ZERO_SHIM;
  private sampleBase!: Omit<
    SampleContext,
    'clientCount' | 'botCount'
  >;

  onCreate(options: GameRoomOptions = {}): void {
    this.maxClients = MAX_CLIENTS;
    // The room is driven by the scenario/test lifecycle, not by emptiness.
    this.autoDispose = false;

    this.tickRate = clampTick(options.tickRate ?? DEFAULT_TICK_RATE);
    this.dtSec = 1 / this.tickRate;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.shimConfig = options.shim ?? ZERO_SHIM;

    const seed = options.seed ?? DEFAULT_SEED;
    // Independent RNG streams: bot motion vs transport loss draws. Sharing one
    // stream would make bot trajectories depend on async input-arrival timing
    // (up-link loss draws happen in the message handler), breaking seed repro.
    const botRng = createRng(seed);
    const lossRng = createRng((seed ^ SHIM_SEED_OFFSET) >>> 0);
    this.world = new World();
    this.bots = new BotDriver(this.world, botRng);
    this.shim = new TransportShim(this.shimConfig, lossRng);
    this.collector = new MetricsCollector();
    this.bots.setCount(options.botCount ?? 0);

    if (options.metricsPath) {
      this.writer = new MetricsWriter(options.metricsPath);
    }

    this.sampleBase = {
      scenario: options.scenario ?? 'adhoc',
      engine: options.engine ?? 'three',
      seed,
      tickRate: this.tickRate,
      injectedDelayCtoSMs: this.shimConfig.up.delayMs,
      injectedDelayStoCMs: this.shimConfig.down.delayMs,
      lossPct: this.shimConfig.up.lossPct,
    };

    // client -> server: authoritative input, through the up-link shim.
    this.onMessage<PlayerInput>(MSG.INPUT, (client, input) => {
      this.collector.recordUp(byteLen(input));
      this.shim.up(() => this.world.applyInput(client.sessionId, input));
    });

    // client -> server: probe telemetry (RTT / snapshot age).
    this.onMessage<StatMessage>(MSG_STAT, (_client, stat) => {
      // rttMs < 0 is the probe's "no fresh measurement" sentinel — skip it so
      // pre-echo snapshots and repeated echoes do not pollute the percentiles.
      if (Number.isFinite(stat.rttMs) && stat.rttMs >= 0) {
        this.collector.recordRtt(stat.rttMs);
      }
      if (Number.isFinite(stat.snapshotAgeMs)) {
        this.collector.recordSnapshotAge(stat.snapshotAgeMs);
      }
    });

    this.lastFlushMs = performance.now();
    this.setSimulationInterval(
      () => this.tick(),
      MS_PER_SEC / this.tickRate,
    );
  }

  onJoin(client: Client): void {
    this.world.add(client.sessionId, false);
    const welcome: WelcomeMessage = {
      playerId: client.sessionId,
      tickRate: this.tickRate,
      serverTimeMs: performance.now(),
    };
    client.send(MSG.WELCOME, welcome);
  }

  onLeave(client: Client): void {
    this.world.remove(client.sessionId);
  }

  onDispose(): void {
    this.shim.dispose();
  }

  /** Connected (non-bot) player count. */
  get connectedCount(): number {
    return this.world.count('player');
  }

  /** Server-side bot count. */
  get activeBotCount(): number {
    return this.bots.count;
  }

  /** Live-ramp the bot population (scenario stress control). */
  setBotCount(n: number): void {
    this.bots.setCount(n);
  }

  /** Force a metrics flush now (deterministic tests / scenario boundaries). */
  forceFlushMetrics(): void {
    this.flush();
  }

  private tick(): void {
    const simStart = performance.now();
    this.bots.tick();
    this.world.step(this.dtSec);
    const simMs = performance.now() - simStart;

    const serializeStart = performance.now();
    const snapshot = this.world.buildSnapshot(this.tickCount, serializeStart);
    const payloadBytes = byteLen(snapshot);
    const serializeMs = performance.now() - serializeStart;

    const sendStart = performance.now();
    for (const client of this.clients) {
      this.collector.recordDown(payloadBytes);
      // The deliver closure may run LATER (down-link delay), by which time the
      // client could have left. Guard on JOINED so a delayed send never targets
      // a disconnected client (which can throw on a closed connection).
      this.shim.down(() => {
        if (client.state === ClientState.JOINED) {
          client.send(MSG.SNAPSHOT, snapshot);
        }
      });
    }
    const sendMs = performance.now() - sendStart;

    this.collector.recordTick(simMs, serializeMs, sendMs);
    this.tickCount += 1;

    const now = performance.now();
    if (this.writer && now - this.lastFlushMs >= this.flushIntervalMs) {
      this.flush();
      this.lastFlushMs = now;
    }
  }

  private flush(): void {
    if (!this.writer) return;
    const sample = this.collector.sample({
      ...this.sampleBase,
      clientCount: this.connectedCount,
      botCount: this.activeBotCount,
    });
    this.writer.write(sample);
  }
}

/** UTF-8 byte length of a value's JSON form — the application payload size. */
function byteLen(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}
