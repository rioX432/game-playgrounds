// Headless N2 load-probe CLI (#144). Selects a named scenario, runs it
// in-process against the real Colyseus room, and appends one MetricsSample line
// per stage to metrics.jsonl. No rendering.
//
// Env (all optional):
//   SCENARIO  one of: n2-stress-ramp | n2-latency-sweep | n2-tickrate-sweep | adhoc
//             (default n2-stress-ramp)
//   ENGINE    sample label: three | babylon | bevy (default three; render is a
//             dependent variable, so this only labels the line)
//   SEED      RNG seed for reproducible bot motion (default 1)
//   OUT       metrics.jsonl path (default metrics.jsonl)
//   WARMUP_MS / MEASURE_MS   per-stage settle / measured window (ms)
//   CLIENTS   probe-client count (RTT/snapshot-age sources)
//   TICK      tick rate, Hz (ramp / latency / adhoc; ignored by tickrate-sweep)
//   BOTS      bot ramp for n2-stress-ramp / adhoc, e.g. BOTS="2,24,100"
//   BOT_COUNT fixed bot count for the sweep scenarios
//   DELAY_UP_MS / DELAY_DOWN_MS / LOSS_UP_PCT / LOSS_DOWN_PCT   adhoc shim
//   TICKS     tick sweep, e.g. TICKS="10,20,30" (n2-tickrate-sweep)

import { ENGINES, type Engine } from 'net-protocol';
import { SCENARIOS, scenarioIds, type ScenarioOpts } from './scenarios/defs.js';
import { runScenario } from './scenarios/runner.js';

// Parse a numeric env knob. An empty/whitespace value (`Number('')` is 0) or a
// value below `min` is treated as UNSET so it falls back to the scenario default
// — a silently-accepted 0 ms measure window or negative count would emit a
// plausible-looking but wrong metrics line (Core Value #1: honest measurement).
const numEnv = (key: string, min = -Infinity): number | undefined => {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : undefined;
};

// Parse a comma-separated positive-number ramp (bot/tick counts must be > 0).
const listEnv = (key: string): number[] | undefined => {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const xs = v
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return xs.length > 0 ? xs : undefined;
};

const parseEngine = (v: string | undefined): Engine =>
  v !== undefined && (ENGINES as readonly string[]).includes(v)
    ? (v as Engine)
    : 'three';

async function main(): Promise<void> {
  const id = process.env.SCENARIO ?? 'n2-stress-ramp';
  const builder = SCENARIOS[id];
  if (!builder) {
    // eslint-disable-next-line no-console
    console.error(`unknown SCENARIO "${id}". Known: ${scenarioIds().join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const opts: ScenarioOpts = {
    clientCount: numEnv('CLIENTS', 1),
    tickRate: numEnv('TICK', 1),
    botCount: numEnv('BOT_COUNT', 0),
    botStages: listEnv('BOTS'),
    ticks: listEnv('TICKS'),
    warmupMs: numEnv('WARMUP_MS', 0),
    measureMs: numEnv('MEASURE_MS', 1),
    shim: {
      up: { delayMs: numEnv('DELAY_UP_MS', 0) ?? 0, lossPct: numEnv('LOSS_UP_PCT', 0) ?? 0 },
      down: { delayMs: numEnv('DELAY_DOWN_MS', 0) ?? 0, lossPct: numEnv('LOSS_DOWN_PCT', 0) ?? 0 },
    },
  };

  const def = builder(opts);
  const seed = numEnv('SEED') ?? 1;
  const engine = parseEngine(process.env.ENGINE);
  const metricsPath = process.env.OUT ?? 'metrics.jsonl';

  // eslint-disable-next-line no-console
  console.log(`scenario "${def.id}" — ${def.stages.length} stage(s), seed ${seed}, engine ${engine}`);
  // eslint-disable-next-line no-console
  console.log(`note: ${def.notes}`);

  await runScenario(def, {
    seed,
    engine,
    metricsPath,
    onStage: (sample, _stage, i) => {
      // eslint-disable-next-line no-console
      console.log(
        `stage ${i}: bots=${sample.botCount} clients=${sample.clientCount} ` +
          `tick=${sample.tickRate} down=${sample.bytesDownPerSec.toFixed(0)}B/s ` +
          `rttP50=${sample.rttP50Ms.toFixed(1)}ms snapAge=${sample.snapshotAgeMs.toFixed(1)}ms ` +
          `sim=${sample.serverTickSimMs.toFixed(2)}ms ser=${sample.serverTickSerializeMs.toFixed(2)}ms ` +
          `send=${sample.serverTickSendMs.toFixed(2)}ms loss=${sample.lossPct}%`,
      );
    },
  });

  // eslint-disable-next-line no-console
  console.log(`scenario complete -> ${metricsPath}`);
}

void main();
