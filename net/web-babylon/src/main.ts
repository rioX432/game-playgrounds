// N1 Babylon.js networking client — entry point.
//
// Wires the pieces and owns the render loop + the fixed-rate input pump:
//   net  : NetClient     — join, snapshots in, inputs out, RTT/age telemetry
//   in   : KeyboardInput — WASD/arrows -> move axis, Space -> fire
//   out  : PlayerViews   — interpolated poses -> Babylon meshes
//   ui   : Hud           — synced count / RTT / snapshot age / fps
//
// The client is render + input + interpolation only; the world is authoritative
// on the server (net/CLAUDE.md). NetClient/SnapshotBuffer/KeyboardInput/Hud are
// byte-for-byte the same modules web-three uses — only this file and render/*
// differ, which is the whole point of the comparison.

import { Engine } from "@babylonjs/core/Engines/engine";
import "./style.css";
import { INPUT_HZ } from "./config";
import { Hud } from "./hud";
import { KeyboardInput } from "./net/input";
import { NetClient } from "./net/netClient";
import { installProbeGlobals } from "./render/probeGlobals";
import { RenderProbe } from "./render/renderProbe";
import { parseRenderProbeParams } from "./render/renderProbeConfig";
import { createScene } from "./render/scene";
import { PlayerViews } from "./render/players";

const MS_PER_SEC = 1000;

const canvas = document.getElementById("app");
const hudEl = document.getElementById("hud");
if (!(canvas instanceof HTMLCanvasElement) || !hudEl) {
  throw new Error("net/web-babylon: index.html must provide #app canvas and #hud");
}

const engine = new Engine(canvas, true);

const { scene, dispose: disposeScene } = createScene(engine);
const players = new PlayerViews(scene);
const hud = new Hud(hudEl);

const net = new NetClient();
void net.connect();

const input = new KeyboardInput();
input.attach(window);

// Client-render probe (#167) — OFF unless `?probe=1`. When on, it collects RAW
// per-frame deltas (NOT Babylon's `engine.getFps()` EMA) into fixed wall-clock
// windows and emits one `ClientRenderSample` per kept window via the #165 shared
// sampler. Its join keys come from URL params so they line up with a server
// bot-ramp metrics.jsonl. Mirrors the three probe (#166); engine = babylon.
const probeParams = parseRenderProbeParams(window.location.search);
const renderProbe = probeParams.enabled
  ? new RenderProbe({
      keys: probeParams.keys,
      sink: installProbeGlobals(window),
      warmupMs: probeParams.warmupMs,
      windowDurationMs: probeParams.windowDurationMs,
      maxWindows: probeParams.maxWindows,
    })
  : null;

// Fixed-rate input pump, decoupled from render and from the server tick.
const inputTimer = window.setInterval(() => {
  const s = input.sample();
  net.sendInput(s.move, s.yaw, s.buttons);
}, MS_PER_SEC / INPUT_HZ);

engine.runRenderLoop(() => {
  // Babylon's render loop is rAF-driven but its callback gets no timestamp, so we
  // read `performance.now()` once per frame as the RAW frame timestamp — the
  // babylon analogue of three's rAF `now`. The probe derives its own raw delta
  // from it; `engine.getFps()` below is a smoothed EMA for DISPLAY only and must
  // never reach the sampler (#165 contract). Mark ready once connected AND a
  // first snapshot has arrived (warmup starts from there).
  if (renderProbe) {
    const now = performance.now();
    if (net.status === "connected" && net.syncedCount > 0) {
      renderProbe.markReady(now);
    }
    renderProbe.recordFrame(now);
  }

  players.sync(net.sample(), net.selfId);

  hud.update({
    status: net.status,
    errorMessage: net.errorMessage,
    syncedCount: net.syncedCount,
    rttMs: net.rttMs,
    snapshotAgeMs: net.snapshotAgeMs,
    // Babylon's built-in smoothed frame-rate estimate (display only).
    fps: engine.getFps(),
  });

  scene.render();
});

function resize(): void {
  engine.resize();
}
window.addEventListener("resize", resize);

function dispose(): void {
  engine.stopRenderLoop();
  window.clearInterval(inputTimer);
  window.removeEventListener("resize", resize);
  input.dispose();
  net.dispose();
  players.dispose();
  disposeScene();
  scene.dispose();
  engine.dispose();
}

window.addEventListener("beforeunload", dispose);
// Clean teardown across Vite hot reloads (no leaked sockets/listeners/GPU).
if (import.meta.hot) {
  import.meta.hot.dispose(dispose);
}
