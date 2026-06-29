// net/ real-GPU client-render runner — automate §8.7 web (three/babylon) magnitudes (#191).
//
// The committed `*-client-render.jsonl` sidecars under net/measurements/n2 are
// HEADLESS software-WebGL (SwiftShader) smokes (smoke/renderProbe.smoke.mjs): the
// pipeline + sample SHAPE are faithful but the fps/frame-time MAGNITUDES are software,
// not the real GPU. This runner is the OTHER layer: it drives the SAME probe on a
// REAL GPU by launching a HEADED Chrome (headless:false, no SwiftShader forced) and
// harvesting `window.__clientRenderSamples` over the Chrome DevTools Protocol — the
// same CDP-harvest pattern as packaging/electron/measure.mjs (§5.1's real-GPU source),
// adapted to net's 2-process topology (loaded server + vite preview web client).
//
// IMPORTANT — this is an ATTENDED run, not a CI/headless job. A trustworthy real-GPU
// number needs a real display, a FOREGROUND window (rAF is throttled when occluded),
// and thermal cooldown between runs. Headless = SwiftShader = not real GPU, so this
// runner is deliberately NOT wired into any build/test gate. See net/tools/README.md
// and net/measurements/n2/README.md ("real-GPU attended run").
//
// Topology (all spawned here; ALL killed on exit — no process leaks):
//   [this runner] --spawn--> loaded net server   (net/server: npm run dev:server:loaded)
//                 --spawn--> vite preview client  (net/web-<engine>: vite preview)
//                 --launch-> headed Chrome        (--remote-debugging-port, REAL GPU)
//   Chrome --navigate--> preview ?probe=1 + join keys (the server prints the exact query)
//   runner --CDP Runtime.evaluate--> window.__clientRenderSamples --> <out>.jsonl
//   runner --CDP--> WEBGL_debug_renderer_info (UNMASKED_RENDERER_WEBGL) --> <out>.meta.json
//
// Honesty guard: the runner reads UNMASKED_RENDERER_WEBGL and ABORTS (no file written)
// if it looks like SwiftShader/llvmpipe/software — a real-GPU file is never produced
// from a software context. The renderer string is recorded in the companion meta.json
// so "non-SwiftShader" is independently verifiable for any committed real-GPU sidecar.
//
// Env knobs:
//   ENGINE        three | babylon                              (default three)
//   BOT_COUNT     loaded bot stage / botCount join key          (default 24)
//   SEED          RNG seed join key                             (default 12345)
//   TICK          server tick Hz join key                       (default 20)
//   SCENARIO      scenario join key                             (default n2-stress-ramp)
//   DELAY_UP_MS DELAY_DOWN_MS LOSS_UP_PCT LOSS_DOWN_PCT  impairment knobs (default 0)
//   WARMUP_MS     settling window excluded before measuring     (default 2000)
//   WINDOW_MS     measurement window length (windowDurationMs)  (default 4000)
//   MAX_WINDOWS   stop after this many KEPT windows             (default 3)
//   RENDER_OUT    output JSONL path  (default net/measurements/n2/web-<engine>-client-render.realgpu.jsonl)
//   SERVER_PORT   Colyseus port                                 (default 2567)
//   PREVIEW_PORT  vite preview port                             (default 4173)
//   CDP_PORT      Chrome remote-debugging port                  (default 9444)
//   CHROME_BIN    Chrome/Chromium executable (default: macOS Google Chrome)
//   SKIP_BUILD    "1" to reuse an existing client dist          (default build first)
//   TIMEOUT_MS    overall harvest budget                        (default 120000)

import { spawn, execSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Paths: resolve net/ root from this file so the runner is cwd-independent. ---
const HERE = dirname(fileURLToPath(import.meta.url));
const NET_ROOT = resolve(HERE, "..");

// --- Config -------------------------------------------------------------------
const ENGINE = (env.ENGINE ?? "three").toLowerCase();
if (ENGINE !== "three" && ENGINE !== "babylon") {
  console.error(`ENGINE must be three|babylon (got "${ENGINE}")`);
  process.exit(2);
}
const CLIENT_DIR = resolve(NET_ROOT, ENGINE === "babylon" ? "web-babylon" : "web-three");
const SERVER_DIR = resolve(NET_ROOT, "server");

const BOT_COUNT = num(env.BOT_COUNT, 24);
const SEED = num(env.SEED, 12345);
const TICK = num(env.TICK, 20);
const SCENARIO = env.SCENARIO ?? "n2-stress-ramp";
const DELAY_UP_MS = num(env.DELAY_UP_MS, 0);
const DELAY_DOWN_MS = num(env.DELAY_DOWN_MS, 0);
const LOSS_UP_PCT = num(env.LOSS_UP_PCT, 0);
const LOSS_DOWN_PCT = num(env.LOSS_DOWN_PCT, 0);
const WARMUP_MS = num(env.WARMUP_MS, 2000);
const WINDOW_MS = num(env.WINDOW_MS, 4000);
const MAX_WINDOWS = num(env.MAX_WINDOWS, 3);
const SERVER_PORT = num(env.SERVER_PORT, 2567);
const PREVIEW_PORT = num(env.PREVIEW_PORT, 4173);
const CDP_PORT = num(env.CDP_PORT, 9444);
const TIMEOUT_MS = num(env.TIMEOUT_MS, 120_000);
const SKIP_BUILD = env.SKIP_BUILD === "1";

const DEFAULT_OUT = resolve(
  NET_ROOT,
  `measurements/n2/web-${ENGINE}-client-render.realgpu.jsonl`,
);
const OUT = env.RENDER_OUT ? resolve(env.RENDER_OUT) : DEFAULT_OUT;
const META_OUT = OUT.replace(/\.jsonl$/, "") + ".meta.json";

const CHROME_BIN =
  env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Renderer strings that mean "software rasteriser", NOT a real GPU. A real-GPU file
// is never written if the live context matches one of these (the whole point of #191).
const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|software|microsoft basic render/i;

// --- Process bookkeeping: kill EVERY spawned tree on any exit path. -----------
/** @type {{name: string, child: import('node:child_process').ChildProcess}[]} */
const spawned = [];
let userDataDir = null;
let cleanedUp = false;

/** All descendant PIDs of `root` (inclusive) via repeated pgrep -P. */
function processTree(root) {
  const all = new Set([root]);
  let frontier = [root];
  while (frontier.length) {
    const next = [];
    for (const pid of frontier) {
      let kids = [];
      try {
        kids = execSync(`pgrep -P ${pid}`, {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(Number);
      } catch {
        /* no children */
      }
      for (const k of kids)
        if (!all.has(k)) {
          all.add(k);
          next.push(k);
        }
    }
    frontier = next;
  }
  return [...all];
}

function killTree(pid, signal) {
  for (const p of processTree(pid)) {
    try {
      process.kill(p, signal);
    } catch {
      /* already gone */
    }
  }
}

function dropProfileDir() {
  if (userDataDir) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    userDataDir = null;
  }
}

/** Synchronous SIGTERM to every spawned tree — safe to call from a signal handler
 *  (we kill each PID directly, not relying on shell/npm signal propagation). */
function killAllTerm() {
  for (const { child } of spawned) {
    if (child.pid) killTree(child.pid, "SIGTERM");
  }
}

/** Full async teardown for the normal exit paths: SIGTERM, settle, SIGKILL any
 *  survivor, then drop the temp Chrome profile. Idempotent. */
async function teardown() {
  if (cleanedUp) return;
  cleanedUp = true;
  killAllTerm();
  await sleep(500);
  for (const { child } of spawned) {
    if (child.pid) killTree(child.pid, "SIGKILL");
  }
  dropProfileDir();
}

const onSignal = (exitCode) => () => {
  killAllTerm();
  dropProfileDir();
  process.exit(exitCode);
};
process.on("SIGINT", onSignal(130));
process.on("SIGTERM", onSignal(143));

// --- Minimal CDP-over-WebSocket client (same shape as measure.mjs). -----------
function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  return (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
}

async function chromeWsUrl(port, host) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await fetch(`http://localhost:${port}/json/list`).then((r) =>
        r.json(),
      );
      const page = list.find(
        (t) => t.type === "page" && t.url.includes(host),
      );
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("no Chrome page CDP target for the preview URL");
}

// --- Spawn helpers ------------------------------------------------------------
/** Spawn a child, record it for cleanup, and resolve once `readyLine` is seen on
 *  stdout (or reject on early exit / timeout). */
function spawnUntilReady(name, cmd, args, opts, readyRe, readyTimeoutMs) {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  spawned.push({ name, child });
  let stdoutBuf = "";
  return new Promise((res, rej) => {
    const timer = setTimeout(
      () => rej(new Error(`${name} not ready within ${readyTimeoutMs}ms`)),
      readyTimeoutMs,
    );
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdoutBuf += s;
      process.stdout.write(`[${name}] ${s}`);
      const m = stdoutBuf.match(readyRe);
      if (m) {
        clearTimeout(timer);
        res({ child, match: m, stdout: () => stdoutBuf });
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      rej(new Error(`${name} exited early (code ${code})`));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return; // server is answering
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`preview URL not reachable: ${url}`);
}

// --- The run ------------------------------------------------------------------
async function main() {
  console.log(
    `real-GPU runner — engine=${ENGINE} bots=${BOT_COUNT} seed=${SEED} tick=${TICK} ` +
      `scenario=${SCENARIO} warmup=${WARMUP_MS}ms window=${WINDOW_MS}ms maxWindows=${MAX_WINDOWS}`,
  );

  // 1. Loaded authoritative server. It prints the EXACT `?probe=1...` join-key query
  //    once the room is created — we reuse that so the join keys cannot drift.
  const server = await spawnUntilReady(
    "server",
    "npm",
    ["run", "dev:server:loaded"],
    {
      cwd: SERVER_DIR,
      env: {
        ...env,
        PORT: String(SERVER_PORT),
        BOT_COUNT: String(BOT_COUNT),
        SEED: String(SEED),
        TICK: String(TICK),
        SCENARIO,
        ENGINE,
        DELAY_UP_MS: String(DELAY_UP_MS),
        DELAY_DOWN_MS: String(DELAY_DOWN_MS),
        LOSS_UP_PCT: String(LOSS_UP_PCT),
        LOSS_DOWN_PCT: String(LOSS_DOWN_PCT),
      },
    },
    /probe URL query:\s*(\?\S+)/,
    60_000,
  );
  const serverQuery = server.match[1];
  console.log(`server join-key query: ${serverQuery}`);

  // 2. Build (unless reusing dist) + vite preview the web client.
  if (!SKIP_BUILD) {
    console.log(`building ${ENGINE} client…`);
    execSync("npm run build", { cwd: CLIENT_DIR, stdio: "inherit" });
  }
  await spawnUntilReady(
    "preview",
    "npx",
    ["vite", "preview", "--port", String(PREVIEW_PORT), "--strictPort"],
    { cwd: CLIENT_DIR, env: { ...env } },
    /Local:\s+http/,
    30_000,
  );
  const previewBase = `http://localhost:${PREVIEW_PORT}`;
  await waitForHttp(previewBase, 30_000);

  // 3. Final probe URL = server's join-key query + the client-only window knobs.
  const probeQuery =
    `${serverQuery}&warmupMs=${WARMUP_MS}` +
    `&windowDurationMs=${WINDOW_MS}&maxWindows=${MAX_WINDOWS}`;
  const pageUrl = `${previewBase}/${probeQuery}`;
  console.log(`navigating headed Chrome to ${pageUrl}`);

  // 4. Launch HEADED Chrome (headless:false ⇒ real GPU). A dedicated --user-data-dir
  //    forces a fresh, debuggable instance instead of attaching to a running Chrome.
  userDataDir = mkdtempSync(join(tmpdir(), "net-realgpu-chrome-"));
  const chrome = spawn(
    CHROME_BIN,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      pageUrl,
    ],
    { stdio: "ignore" },
  );
  spawned.push({ name: "chrome", child: chrome });

  // 5. Connect CDP, verify it is a REAL GPU, then harvest the probe samples.
  const ws = new WebSocket(await chromeWsUrl(CDP_PORT, `localhost:${PREVIEW_PORT}`));
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const send = cdp(ws);
  await send("Runtime.enable");

  // 5a. GPU evidence — read UNMASKED_RENDERER_WEBGL via a throwaway context.
  const gpuExpr = `(() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { error: 'no-webgl' };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        version: gl.getParameter(gl.VERSION),
      };
    } catch (e) { return { error: String(e) }; }
  })()`;
  const gpuRes = await send("Runtime.evaluate", {
    expression: gpuExpr,
    returnByValue: true,
  });
  const gpu = gpuRes.result?.result?.value ?? { error: "evaluate-failed" };
  const uaRes = await send("Runtime.evaluate", {
    expression: "navigator.userAgent",
    returnByValue: true,
  });
  const ua = uaRes.result?.result?.value ?? null;
  console.log(
    `GPU renderer: ${gpu.renderer ?? gpu.error ?? "unknown"} (vendor: ${gpu.vendor ?? "?"})`,
  );

  const softwareDetected =
    !gpu.renderer || SOFTWARE_RENDERER_RE.test(String(gpu.renderer));
  if (softwareDetected) {
    ws.close();
    throw new Error(
      `refusing to write a "real-gpu" sidecar — renderer looks software ` +
        `(${gpu.renderer ?? gpu.error}). Run ATTENDED on a real display; do not ` +
        `force SwiftShader. Headless Chrome cannot produce a trustworthy real-GPU number.`,
    );
  }

  // 5b. Poll until the in-page probe has kept MAX_WINDOWS samples (or timeout).
  const tStart = Date.now();
  let samples = [];
  while (Date.now() - tStart < TIMEOUT_MS) {
    const r = await send("Runtime.evaluate", {
      expression: "JSON.stringify(window.__clientRenderSamples || [])",
      returnByValue: true,
    });
    try {
      samples = JSON.parse(r.result?.result?.value ?? "[]");
    } catch {
      samples = [];
    }
    if (samples.length >= MAX_WINDOWS) break;
    await sleep(500);
  }
  ws.close();

  if (samples.length === 0) {
    throw new Error(
      "no samples harvested (connection / WebGL / foreground-window / timeout?). " +
        "The Chrome window MUST stay foreground+visible — rAF throttles when occluded.",
    );
  }

  // 6. Write the schema-pure ClientRenderSample sidecar + the provenance meta.json.
  //    The .jsonl stays pure ClientRenderSample lines so it LEFT JOINs and schema-
  //    validates exactly like the software smoke output; the GPU evidence + the
  //    backend=real-gpu tag live in the companion meta.json (the sidecar's "meta").
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, "");
  for (const s of samples) appendFileSync(OUT, `${JSON.stringify(s)}\n`);

  const meta = {
    backend: "real-gpu",
    engine: ENGINE,
    measurementBasis: "web-raf-dt",
    swiftShaderDetected: false,
    gpuRenderer: gpu.renderer,
    gpuVendor: gpu.vendor,
    glVersion: gpu.version ?? null,
    userAgent: ua,
    capturedAtIso: new Date().toISOString(),
    host: "headed-chrome",
    joinKeys: {
      scenario: SCENARIO,
      seed: SEED,
      tickRate: TICK,
      botCount: BOT_COUNT,
      clientCount: 1,
      injectedDelayCtoSMs: DELAY_UP_MS,
      injectedDelayStoCMs: DELAY_DOWN_MS,
      lossPct: Math.max(LOSS_UP_PCT, LOSS_DOWN_PCT),
    },
    window: {
      warmupMs: WARMUP_MS,
      windowDurationMs: WINDOW_MS,
      maxWindows: MAX_WINDOWS,
    },
    windowsCaptured: samples.length,
    // basename only — this meta.json is meant to be committed; never leak an
    // absolute operator path into the repo.
    sidecar: basename(OUT),
  };
  writeFileSync(META_OUT, `${JSON.stringify(meta, null, 2)}\n`);

  console.log(
    `wrote ${samples.length} real-GPU sample(s) -> ${OUT}\n` +
      `wrote provenance -> ${META_OUT}`,
  );
}

main()
  .then(async () => {
    await teardown();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("REALGPU_RUNNER_ERROR", e.message ?? e);
    await teardown();
    process.exit(1);
  });
