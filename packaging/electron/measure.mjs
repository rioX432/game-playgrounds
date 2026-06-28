// Electron host-overhead measurement runner for the web-on-steam chapter (#174, Layer 2).
//
// For each body count it launches the Electron shell (real GPU, bundled Chromium) on the
// 13-stress auto-measure URL, harvests window.__renderSamples over CDP, and records the
// distribution-overhead metrics this layer is about:
//   * ramRssKbProcessTree — summed RSS of the WHOLE Electron process tree (main + renderer
//     + GPU + helpers); a single-PID reading under-counts (issue #174).
//   * timeToFirstSampleMs  — wall-clock from process spawn to the first completed measure
//     window (host cold-start incl. page load + engine init + warmup + one window). Measured
//     IDENTICALLY across hosts so browser/Electron/Tauri are comparable.
//
// HONEST LABELLING: the in-page probe stamps host:"browser" (it can't know its shell); the
// runner KNOWS it launched Electron, so it overrides host:"electron" on each harvested line.
//
// Env: WEB_DIST (required, e.g. ../../three/dist built with --base=./), ENGINE (three|babylon),
//   BACKEND (webgl|webgpu), BODIES (comma list, e.g. 100,500,1000,1500,2000), SEED=12345,
//   WARMUP_MS=1000, WINDOW_MS=1500, MAX_WINDOWS=3, OUT (jsonl path), PORT=9333,
//   ELECTRON_BIN (default ./node_modules/.bin/electron).
import { spawn, execSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const env = process.env;
const WEB_DIST = env.WEB_DIST ? resolve(env.WEB_DIST) : null;
const ENGINE = env.ENGINE ?? "three";
const BACKEND = env.BACKEND ?? "webgpu";
const BODIES = (env.BODIES ?? "100,500,1000,1500,2000").split(",").map((s) => Number(s.trim()));
const SEED = Number(env.SEED ?? 12345);
const WARMUP_MS = Number(env.WARMUP_MS ?? 1000);
const WINDOW_MS = Number(env.WINDOW_MS ?? 1500);
const MAX_WINDOWS = Number(env.MAX_WINDOWS ?? 3);
const OUT = env.OUT ?? "electron-render.jsonl";
const BASE_PORT = Number(env.PORT ?? 9333);
const ELECTRON_BIN = env.ELECTRON_BIN ?? resolve("./node_modules/.bin/electron");

if (!WEB_DIST) { console.error("WEB_DIST is required"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** All descendant PIDs of `root` (inclusive) via repeated pgrep -P. */
function processTree(root) {
  const all = new Set([root]);
  let frontier = [root];
  while (frontier.length) {
    const next = [];
    for (const pid of frontier) {
      let kids = [];
      try { kids = execSync(`pgrep -P ${pid}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString().trim().split("\n").filter(Boolean).map(Number); } catch { /* no children */ }
      for (const k of kids) if (!all.has(k)) { all.add(k); next.push(k); }
    }
    frontier = next;
  }
  return [...all];
}

/** Summed RSS (KB) of a process tree. */
function treeRssKb(root) {
  const pids = processTree(root);
  let rss = 0;
  for (const pid of pids) {
    try { rss += Number(execSync(`ps -o rss= -p ${pid}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim() || 0); } catch { /* process gone */ }
  }
  return { rssKb: rss, processCount: pids.length };
}

function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  return (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
}

async function rendererWsUrl(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await fetch(`http://localhost:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === "page" && (t.url.startsWith("file://") || t.url.includes("index.html")));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("no Electron renderer CDP target");
}

async function runOne(bodies, port) {
  const MEASURE_QUERY =
    `?sample=13-stress-bodies&measure=1&renderer=${BACKEND}&bodies=${bodies}` +
    `&seed=${SEED}&warmupMs=${WARMUP_MS}&windowMs=${WINDOW_MS}&maxWindows=${MAX_WINDOWS}`;
  const child = spawn(ELECTRON_BIN, [".", `--remote-debugging-port=${port}`], {
    env: { ...env, WEB_DIST, MEASURE_QUERY },
    stdio: "ignore",
  });
  const tSpawn = Date.now();
  let result = { samples: [], rssKb: 0, processCount: 0, timeToFirstSampleMs: null, versions: null };
  try {
    const ws = new WebSocket(await rendererWsUrl(port));
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    const send = cdp(ws);
    await send("Runtime.enable");
    let samples = [];
    for (let i = 0; i < 120; i++) { // up to ~60s
      const r = await send("Runtime.evaluate", { expression: "JSON.stringify(window.__renderSamples || [])", returnByValue: true });
      try { samples = JSON.parse(r.result?.result?.value ?? "[]"); } catch { samples = []; }
      if (samples.length >= 1 && result.timeToFirstSampleMs === null) {
        result.timeToFirstSampleMs = Date.now() - tSpawn;
        // Steady-state RAM: sample the tree once measurement is under way.
        const tree = treeRssKb(child.pid);
        result.rssKb = tree.rssKb; result.processCount = tree.processCount;
        const v = await send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
        result.versions = v.result?.result?.value ?? null;
      }
      if (samples.length >= MAX_WINDOWS) break;
      await sleep(500);
    }
    result.samples = samples;
    ws.close();
  } finally {
    child.kill("SIGTERM");
    await sleep(400);
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
  return result;
}

async function main() {
  const outPath = resolve(OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, ""); // fresh file per runner invocation (one engine+backend)
  for (let bi = 0; bi < BODIES.length; bi++) {
    const bodies = BODIES[bi];
    const port = BASE_PORT + bi;
    const r = await runOne(bodies, port);
    // Render lines: override host -> "electron" (the runner is the host source of truth).
    for (const s of r.samples) {
      appendFileSync(outPath, JSON.stringify({ ...s, host: "electron" }) + "\n");
    }
    // One overhead line per body count.
    appendFileSync(outPath, JSON.stringify({
      kind: "overhead", host: "electron", engine: ENGINE, backend: BACKEND, bodies, seed: SEED,
      ramRssKbProcessTree: r.rssKb, processCount: r.processCount,
      timeToFirstSampleMs: r.timeToFirstSampleMs, windowsCaptured: r.samples.length, ua: r.versions,
    }) + "\n");
    console.log(`[electron] ${ENGINE}/${BACKEND} bodies=${bodies}: windows=${r.samples.length} ` +
      `ramRssMb=${(r.rssKb / 1024).toFixed(0)} procs=${r.processCount} firstSampleMs=${r.timeToFirstSampleMs}`);
  }
  console.log(`wrote -> ${outPath}`);
}

main().catch((e) => { console.error("RUNNER_ERROR", e); process.exit(1); });
