// N1 Three.js networking client — entry point.
//
// Wires the pieces and owns the render loop + the fixed-rate input pump:
//   net  : NetClient   — join, snapshots in, inputs out, RTT/age telemetry
//   in   : KeyboardInput — WASD/arrows → move axis, Space → fire
//   out  : PlayerViews — interpolated poses → meshes
//   ui   : Hud         — synced count / RTT / snapshot age / fps
//
// The client is render + input + interpolation only; the world is authoritative
// on the server (net/CLAUDE.md).

import { WebGLRenderer } from "three";
import "./style.css";
import { INPUT_HZ } from "./config";
import { Hud } from "./hud";
import { KeyboardInput } from "./net/input";
import { NetClient } from "./net/netClient";
import { createScene } from "./render/scene";
import { PlayerViews } from "./render/players";

const MS_PER_SEC = 1000;
const FPS_SMOOTHING = 0.1;

const canvas = document.getElementById("app");
const hudEl = document.getElementById("hud");
if (!(canvas instanceof HTMLCanvasElement) || !hudEl) {
  throw new Error("net/web-three: index.html must provide #app canvas and #hud");
}

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const { scene, camera, dispose: disposeScene } = createScene(aspect());
const players = new PlayerViews(scene);
const hud = new Hud(hudEl);

const net = new NetClient();
void net.connect();

const input = new KeyboardInput();
input.attach(window);

// Fixed-rate input pump, decoupled from render and from the server tick.
const inputTimer = window.setInterval(() => {
  const s = input.sample();
  net.sendInput(s.move, s.yaw, s.buttons);
}, MS_PER_SEC / INPUT_HZ);

let fps = 0;
let lastTime = performance.now();
let rafId = 0;

function frame(now: number): void {
  rafId = requestAnimationFrame(frame);

  const dtMs = now - lastTime;
  lastTime = now;
  if (dtMs > 0) {
    const instantaneous = MS_PER_SEC / dtMs;
    fps = fps === 0 ? instantaneous : fps + (instantaneous - fps) * FPS_SMOOTHING;
  }

  players.sync(net.sample(), net.selfId);

  hud.update({
    status: net.status,
    errorMessage: net.errorMessage,
    syncedCount: net.syncedCount,
    rttMs: net.rttMs,
    snapshotAgeMs: net.snapshotAgeMs,
    fps,
  });

  renderer.render(scene, camera);
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}

function aspect(): number {
  return window.innerWidth / Math.max(1, window.innerHeight);
}

resize();
window.addEventListener("resize", resize);
rafId = requestAnimationFrame(frame);

function dispose(): void {
  cancelAnimationFrame(rafId);
  window.clearInterval(inputTimer);
  window.removeEventListener("resize", resize);
  input.dispose();
  net.dispose();
  players.dispose();
  disposeScene();
  renderer.dispose();
}

window.addEventListener("beforeunload", dispose);
// Clean teardown across Vite hot reloads (no leaked sockets/listeners/GPU).
if (import.meta.hot) {
  import.meta.hot.dispose(dispose);
}
