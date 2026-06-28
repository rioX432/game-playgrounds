// Playwright smoke for the client-render probe (#166).
//
// Loads the BUILT three.js client against an ALREADY-RUNNING loaded bot room and
// a static preview server, lets the in-page probe collect its windows, then
// harvests `window.__clientRenderSamples` and writes them to `client-render.jsonl`
// from the Node side. This is auto-measurement, explicitly allowed by #166.
//
// HONEST CAVEAT: headless Chromium renders WebGL through SwiftShader (software),
// NOT the real GPU. The SHAPE and the pipeline (raw rAF dt → shared sampler →
// sidecar JSONL with matching join keys) are faithful, but the absolute fps/
// frame-time numbers are software-rendered and are NOT a real-GPU result. For
// real-GPU numbers, follow the MANUAL procedure in README.md instead.
//
// Playwright is intentionally NOT a dependency of this package (keeps
// `npm install && npm run build && npm test` green and browser-free). Install it
// once to run this smoke:  npm i -D playwright   (browsers are cached globally).
//
// Prereqs (two terminals), then run this:
//   cd net/server   && BOT_COUNT=24 SEED=12345 TICK=20 SCENARIO=n2-stress-ramp \
//                      PORT=2567 npm run dev:server:loaded
//   cd net/web-three && npm run build && npx vite preview --port 4173
//   cd net/web-three && PREVIEW_URL=http://localhost:4173 \
//                      PROBE_QUERY='?probe=1&scenario=n2-stress-ramp&seed=12345&tickRate=20&botCount=24&clientCount=1&delayCtoSMs=0&delayStoCMs=0&lossPct=0&warmupMs=2000&windowDurationMs=4000&maxWindows=3' \
//                      RENDER_OUT=../measurements/n2/web-three-client-render.jsonl \
//                      node smoke/renderProbe.smoke.mjs
//
// Env:
//   PREVIEW_URL   base URL of the built client (default http://localhost:4173)
//   PROBE_QUERY   query string with ?probe=1 + join keys (matches the loaded room)
//   RENDER_OUT    output JSONL path (default ./client-render.jsonl). Named distinctly
//                 from the server's OUT (server metrics) so a globally-exported OUT
//                 never sends MetricsSample lines into the client-render sidecar.
//   TARGET        kept-window target before harvesting (default 3)
//   TIMEOUT_MS    overall wait budget (default 60000)

import { chromium } from "playwright";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const PREVIEW_URL = process.env.PREVIEW_URL ?? "http://localhost:4173";
const PROBE_QUERY =
  process.env.PROBE_QUERY ??
  "?probe=1&scenario=n2-stress-ramp&seed=12345&tickRate=20&botCount=24&clientCount=1&delayCtoSMs=0&delayStoCMs=0&lossPct=0&warmupMs=2000&windowDurationMs=4000&maxWindows=3";
const OUT = process.env.RENDER_OUT ?? "client-render.jsonl";
const TARGET = Number(process.env.TARGET ?? 3);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 60_000);
const POLL_MS = 500;

async function main() {
  const browser = await chromium.launch({
    // Enable a software-WebGL context in headless Chromium.
    args: [
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (msg) => {
    const t = msg.text();
    if (t.startsWith("[client-render]")) console.log(t);
  });

  const url = `${PREVIEW_URL}/${PROBE_QUERY}`;
  console.log(`navigating ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + TIMEOUT_MS;
  let samples = [];
  while (Date.now() < deadline) {
    samples = await page.evaluate(() => window.__clientRenderSamples ?? []);
    if (samples.length >= TARGET) break;
    await page.waitForTimeout(POLL_MS);
  }

  await browser.close();

  if (samples.length === 0) {
    console.error("no samples harvested (connection / WebGL / timeout?)");
    process.exitCode = 1;
    return;
  }

  const outPath = isAbsolute(OUT) ? OUT : resolve(process.cwd(), OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, "");
  for (const s of samples) appendFileSync(outPath, `${JSON.stringify(s)}\n`);
  console.log(`wrote ${samples.length} sample(s) -> ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
