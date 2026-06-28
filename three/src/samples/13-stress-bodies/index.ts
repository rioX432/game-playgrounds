import RAPIER from "@dimforge/rapier3d-compat";
import { BoxGeometry, Color, Mesh, MeshStandardMaterial } from "three";
import { Hud } from "../../engine/hud";
import { InputController } from "../../engine/input";
import { createGround, createLightPreset } from "../../engine/scene";
import { parseMeasureParams } from "../../measure/config";
import { setFrameHook } from "../../measure/frameHook";
import { installRenderSampleSink } from "../../measure/globals";
import { RenderProbe } from "../../measure/probe";
import { createRng } from "../../measure/rng";
import type { Sample, SampleContext } from "../types";
import { computeSpawnPositions } from "./spawn";

/**
 * 13 — Stress / load harness (Three.js + Rapier).
 *
 * The cross-engine performance probe: spawn batches of dynamic boxes onto a
 * floor and watch the per-frame cost climb as the body count rises. The SAME
 * harness exists in `babylon/` and `bevy/` so the three can be compared under
 * matched load. It renders a live `bodies: N | ms/frame: X` readout.
 *
 * NOTE: the numbers are read at runtime — they are intentionally NOT recorded in
 * COMPARISON.md yet. Capturing matched ms/frame across the three engines (same
 * body count, same machine) is the deliverable that turns COMPARISON §5 from
 * "fine, probably" into measured fact; that capture must be done by running each
 * build, not asserted here.
 *
 * Rendering uses individual meshes sharing one geometry + material (cheap, but
 * not instanced) — so at very high counts the draw cost, not just physics, will
 * show. Instanced rendering is the obvious next optimization if we want to
 * isolate physics cost specifically.
 */

const GRAVITY_Y = -9.81;
const BOX_HALF = 0.3;
const BATCH_SIZE = 100; // boxes added per Space press
const MAX_BODIES = 2000; // safety cap (memory + the gallery stays responsive)
const FLOOR_HALF = 12;
// SPAWN_HEIGHT / SPAWN_SPREAD live in ./spawn (shared with the determinism test).

interface Body {
  mesh: Mesh;
  rb: RAPIER.RigidBody;
}

const sample: Sample = {
  id: "13-stress-bodies",
  title: "Stress / Load Harness",
  summary:
    "Spawn batches of dynamic boxes and watch ms/frame climb — the cross-engine performance probe.",
  tags: ["physics", "rapier", "performance", "stress"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;
    scene.background = new Color(0x0c0f14);
    camera.position.set(0, 10, 20);
    camera.lookAt(0, 2, 0);

    const lights = createLightPreset(scene);
    const ground = createGround(scene, { size: FLOOR_HALF * 2 });

    // Shared geometry + material for every box (one upload, many instances of
    // the handle — not GPU-instanced, but no per-body allocation).
    const boxGeo = new BoxGeometry(BOX_HALF * 2, BOX_HALF * 2, BOX_HALF * 2);
    const boxMat = new MeshStandardMaterial({ color: 0xff8844 });

    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      controls: [
        "Space — add 100 boxes",
        "R — clear all",
        `(cap ${MAX_BODIES})`,
      ],
    });

    // Custom stats readout (body count + smoothed ms/frame).
    const stats = document.createElement("div");
    Object.assign(stats.style, {
      position: "absolute",
      top: "12px",
      left: "12px",
      padding: "8px 10px",
      borderRadius: "8px",
      background: "rgba(11, 14, 19, 0.72)",
      border: "1px solid rgba(74, 163, 255, 0.25)",
      color: "#e6edf3",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "13px",
      whiteSpace: "nowrap",
      pointerEvents: "none",
    } as Partial<CSSStyleDeclaration>);
    (canvas.parentElement ?? document.body).appendChild(stats);

    const input = new InputController({
      pointerLockTarget: canvas,
      lockOnClick: false,
    });

    let disposed = false;
    let raf = 0;
    let world: RAPIER.World | null = null;
    const bodies: Body[] = [];
    let msPerFrame = 0; // exponential moving average of frame time
    let last = performance.now();

    // Always seed the scatter (deterministic even outside measure mode) so a given
    // seed reproduces an identical run.
    const params = parseMeasureParams(window.location.search);
    const rng = createRng(params.seed);

    // Spawn `n` boxes (capped at the safety limit), drawing positions from the
    // seeded rng so the scatter is reproducible.
    const spawnBodies = (n: number): void => {
      if (!world) return;
      const room = MAX_BODIES - bodies.length;
      const count = Math.min(n, room);
      if (count <= 0) return;
      for (const p of computeSpawnPositions(count, rng)) {
        const rb = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z),
        );
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(BOX_HALF, BOX_HALF, BOX_HALF).setRestitution(
            0.1,
          ),
          rb,
        );
        const mesh = new Mesh(boxGeo, boxMat);
        scene.add(mesh);
        bodies.push({ mesh, rb });
      }
    };

    const addBatch = (): void => spawnBodies(BATCH_SIZE);

    const clearAll = (): void => {
      for (const b of bodies) {
        scene.remove(b.mesh);
        world?.removeRigidBody(b.rb);
      }
      bodies.length = 0;
    };

    // Async Rapier init (WASM); guard against unmount during the await.
    void RAPIER.init().then(() => {
      if (disposed) return;
      world = new RAPIER.World(new RAPIER.Vector3(0, GRAVITY_Y, 0));
      // Static floor collider matching the render ground.
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(FLOOR_HALF, 0.1, FLOOR_HALF),
        world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0),
        ),
      );
      if (params.measure) {
        // Auto-measure: spawn the full body count, then drive a RenderProbe off the
        // engine's real render cadence via the bootstrap frame hook.
        spawnBodies(params.bodies);
        const sink = installRenderSampleSink();
        const probe = new RenderProbe({
          warmupMs: params.warmupMs,
          windowMs: params.windowMs,
          maxWindows: params.maxWindows,
          meta: {
            engine: "three",
            backend: "webgl",
            host: "browser",
            bodies: params.bodies,
            seed: params.seed,
          },
          onSample: sink,
        });
        probe.markStart(performance.now());
        setFrameHook((now) => {
          probe.recordFrame(now);
          if (probe.isDone()) setFrameHook(null);
        });
      } else {
        addBatch(); // seed with one batch so something is happening on entry
      }
      raf = requestAnimationFrame(step);
    });

    const step = (now: number): void => {
      raf = requestAnimationFrame(step);
      if (!world) return;

      const dt = now - last;
      last = now;
      // EMA so the readout is stable rather than jittering every frame.
      msPerFrame = msPerFrame === 0 ? dt : msPerFrame * 0.9 + dt * 0.1;

      if (input.consumeJustPressed("Space")) addBatch();
      if (input.consumeJustPressed("KeyR")) clearAll();

      world.step();
      for (const b of bodies) {
        const t = b.rb.translation();
        const r = b.rb.rotation();
        b.mesh.position.set(t.x, t.y, t.z);
        b.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }

      hud.frame(now);
      const fps = msPerFrame > 0 ? 1000 / msPerFrame : 0;
      stats.textContent = `bodies: ${bodies.length}  |  ${msPerFrame.toFixed(1)} ms/frame  (~${Math.round(fps)} FPS)`;
    };

    return () => {
      disposed = true;
      setFrameHook(null); // detach the measure hook if this sample installed one
      cancelAnimationFrame(raf);
      input.dispose();
      hud.dispose();
      stats.remove();
      clearAll();
      world?.free();
      world = null;
      boxGeo.dispose();
      boxMat.dispose();
      lights.dispose();
      ground.dispose();
    };
  },
};

export default sample;
