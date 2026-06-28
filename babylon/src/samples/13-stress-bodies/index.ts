import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Physics/physicsEngineComponent";

import { createHavokPlugin } from "../../engine/havok";
import { createHud } from "../../engine/hud";
import { createInput } from "../../engine/input";
import { parseMeasureParams } from "../../measure/config";
import { setFrameHook } from "../../measure/frameHook";
import { installRenderSampleSink } from "../../measure/globals";
import { RenderProbe } from "../../measure/probe";
import { createRng } from "../../measure/rng";
import type { Sample, SampleContext } from "../types";
import { computeSpawnPositions } from "./spawn";

/**
 * 13 — Stress / load harness (Babylon.js + Havok).
 *
 * The cross-engine performance probe (sibling of `three/` and `bevy/`): spawn
 * batches of dynamic boxes and watch the per-frame cost climb with the body
 * count. Havok auto-steps and auto-syncs each `PhysicsAggregate`'s mesh, so there
 * is no manual stepping/sync here — the least boilerplate of the three.
 *
 * NOTE: numbers are read at runtime and intentionally NOT recorded in
 * COMPARISON.md. Matched ms/frame across the three engines must be captured by
 * running each build, not asserted here.
 */

const GRAVITY_Y = -9.81;
const BOX_HALF = 0.3;
const BATCH_SIZE = 100;
const MAX_BODIES = 2000;
const FLOOR_SIZE = 24;
// SPAWN_HEIGHT / SPAWN_SPREAD live in ./spawn (shared with the determinism test).

export const sample13: Sample = {
  id: "13-stress-bodies",
  title: "Stress / Load Harness",
  summary:
    "Spawn batches of dynamic boxes and watch ms/frame climb — the cross-engine performance probe.",
  tags: ["physics", "havok", "performance", "stress"],

  mount(ctx: SampleContext): () => void {
    const { scene, canvas } = ctx;
    scene.clearColor.set(0.05, 0.06, 0.08, 1);

    const camera = new ArcRotateCamera(
      "stressCam",
      -Math.PI / 2,
      Math.PI / 3,
      32,
      new Vector3(0, 2, 0),
      scene,
    );
    camera.attachControl(canvas, true);

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, -0.3), scene);
    sun.intensity = 0.8;

    const boxMat = new StandardMaterial("stressBoxMat", scene);
    boxMat.diffuseColor = new Color3(1, 0.53, 0.27);

    const hud = createHud(ctx, {
      title: "Controls",
      controls: ["Space — add 100 boxes", "R — clear all", `(cap ${MAX_BODIES})`],
    });
    const input = createInput(ctx, { pointerLock: false });

    // Stats readout (body count + smoothed ms/frame).
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

    let disposed = false;
    let msPerFrame = 0;
    const bodies: { mesh: Mesh; aggregate: PhysicsAggregate }[] = [];
    // A hidden template box; clones share its geometry + material (cheap spawn).
    let template: Mesh | null = null;

    // Always seed the scatter (deterministic even outside measure mode) so a given
    // seed reproduces an identical run.
    const params = parseMeasureParams(window.location.search);
    const rng = createRng(params.seed);

    // Spawn `n` boxes (capped at the safety limit), drawing positions from the
    // seeded rng so the scatter is reproducible.
    const spawnBodies = (n: number): void => {
      if (!template) return;
      const room = MAX_BODIES - bodies.length;
      const count = Math.min(n, room);
      if (count <= 0) return;
      for (const p of computeSpawnPositions(count, rng)) {
        const box = template.clone(`box${bodies.length}`, null) as Mesh;
        box.setEnabled(true);
        box.position.set(p.x, p.y, p.z);
        const aggregate = new PhysicsAggregate(
          box,
          PhysicsShapeType.BOX,
          { mass: 1, restitution: 0.1 },
          scene,
        );
        bodies.push({ mesh: box, aggregate });
      }
    };

    const addBatch = (): void => spawnBodies(BATCH_SIZE);

    const clearAll = (): void => {
      for (const b of bodies) {
        b.aggregate.dispose();
        b.mesh.dispose();
      }
      bodies.length = 0;
    };

    // Havok WASM loads on demand; guard against unmount during the await.
    void createHavokPlugin().then((plugin) => {
      // Switched away mid-load: dispose the orphan plugin so it doesn't leak its
      // native world (it was never handed to a scene that would dispose it).
      if (disposed) {
        plugin.dispose();
        return;
      }
      scene.enablePhysics(new Vector3(0, GRAVITY_Y, 0), plugin);

      const floor = MeshBuilder.CreateGround(
        "floor",
        { width: FLOOR_SIZE, height: FLOOR_SIZE },
        scene,
      );
      const floorMat = new StandardMaterial("stressFloorMat", scene);
      floorMat.diffuseColor = new Color3(0.22, 0.22, 0.26);
      floor.material = floorMat;
      new PhysicsAggregate(floor, PhysicsShapeType.BOX, { mass: 0 }, scene);

      // Hidden template the batch clones from (so we build geometry once).
      template = MeshBuilder.CreateBox("boxTemplate", { size: BOX_HALF * 2 }, scene);
      template.material = boxMat;
      template.setEnabled(false);

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
            engine: "babylon",
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
        addBatch(); // seed one batch
      }
    });

    // Per-frame: handle input + refresh the stats readout. Havok steps + syncs
    // the aggregates automatically during scene.render (no manual step here).
    const observer = scene.onBeforeRenderObservable.add(() => {
      const dt = scene.getEngine().getDeltaTime(); // ms
      msPerFrame = msPerFrame === 0 ? dt : msPerFrame * 0.9 + dt * 0.1;

      if (input.consumeJustPressed("Space")) addBatch();
      if (input.consumeJustPressed("KeyR")) clearAll();

      const fps = msPerFrame > 0 ? 1000 / msPerFrame : 0;
      stats.textContent = `bodies: ${bodies.length}  |  ${msPerFrame.toFixed(1)} ms/frame  (~${Math.round(fps)} FPS)`;
    });

    return () => {
      disposed = true;
      setFrameHook(null); // detach the measure hook if this sample installed one
      scene.onBeforeRenderObservable.remove(observer);
      input.dispose();
      hud.dispose();
      stats.remove();
      clearAll();
      template?.dispose();
      // The scene + its physics engine are torn down by the gallery's scene.dispose.
    };
  },
};
