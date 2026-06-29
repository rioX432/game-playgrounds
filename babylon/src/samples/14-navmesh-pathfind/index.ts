import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { RecastJSPlugin } from "@babylonjs/core/Navigation/Plugins/recastJSPlugin";
import "@babylonjs/core/Meshes/Builders/groundBuilder"; // side-effect: CreateGround
import "@babylonjs/core/Meshes/Builders/boxBuilder"; // side-effect: CreateBox
import "@babylonjs/core/Meshes/Builders/cylinderBuilder"; // side-effect: CreateCylinder
import "@babylonjs/core/Meshes/Builders/linesBuilder"; // side-effect: CreateLines

import { createLightPreset } from "../../engine/scene";
import { createHud } from "../../engine/hud";
import { loadRecast, type RecastModule } from "../../ai/recast";
import {
  buildSpecMeshes,
  createNavMesh,
  DEFAULT_NAV_PARAMS,
  type Vec3,
} from "../../ai/navmesh";
import { createNavMeshDebug } from "../../ai/navmeshDebug";
import {
  AGENT_SPEED,
  BASE_SPEC,
  createFollowState,
  DYNAMIC_WALL,
  GOAL,
  START,
  stepFollow,
  type FollowState,
} from "./pathfind";
import type { Sample, SampleContext } from "../types";

/**
 * navmesh-pathfind: an agent walks A->B over a Recast/Detour navmesh built through
 * Babylon's engine-integrated `RecastJSPlugin`. Partway along, a wall drops onto
 * the route; the navmesh is rebuilt with the obstacle and the path is recomputed
 * from the agent's current position, so it visibly detours through the one gap.
 * The whole thing loops: reach the goal -> remove the wall -> walk A->B again.
 *
 * The path logic lives in the render-independent `./pathfind` core (and the shared
 * `src/ai` foundation), proven headless in `pathfind.test.ts`; this file is only
 * the visualization — camera, meshes, the navmesh overlay, and the follow tick.
 */

// --- Camera: a near-top-down orbit framing the whole 20x20 ground. ---
const CAM_ALPHA = -Math.PI / 2;
const CAM_BETA = 0.75; // radians from +Y; lower = more top-down
const CAM_RADIUS = 30;

// --- Agent rig (a small capsule-ish cylinder riding on the navmesh). ---
const AGENT_RADIUS = 0.5;
const AGENT_HEIGHT = 1.4;
const AGENT_Y = AGENT_HEIGHT / 2;

// --- Endpoint markers + path line lift (off the ground to avoid z-fighting). ---
const MARKER_DIAMETER = 1.2;
const MARKER_HEIGHT = 0.2;
const PATH_LIFT = 0.15;

// --- Demo pacing. ---
const DROP_DELAY_S = 1.0; // drop the obstacle this long after a run starts
const RESET_DELAY_S = 1.2; // pause on the goal before restarting the loop

type Phase = "following" | "arrived";

function sample14Mount(ctx: SampleContext): () => void {
  const { scene, engine, canvas } = ctx;
  scene.clearColor.set(0.05, 0.06, 0.08, 1);

  createLightPreset(scene);

  const camera = new ArcRotateCamera(
    "navCam",
    CAM_ALPHA,
    CAM_BETA,
    CAM_RADIUS,
    Vector3.Zero(),
    scene,
  );
  camera.attachControl(canvas, true);
  scene.activeCamera = camera;

  // --- Ground (from the shared spec, so the render matches the headless test). ---
  const { ground } = buildSpecMeshes(scene, BASE_SPEC);
  const groundMat = new StandardMaterial("navGroundMat", scene);
  groundMat.diffuseColor = new Color3(0.22, 0.27, 0.22);
  ground.material = groundMat;

  // --- Start / goal markers. ---
  const startMarker = makeMarker(scene, "navStart", START, new Color3(0.3, 0.85, 0.4));
  const goalMarker = makeMarker(scene, "navGoal", GOAL, new Color3(0.95, 0.35, 0.35));

  // --- Agent. ---
  const agent = MeshBuilder.CreateCylinder(
    "navAgent",
    { diameter: AGENT_RADIUS * 2, height: AGENT_HEIGHT },
    scene,
  );
  const agentMat = new StandardMaterial("navAgentMat", scene);
  agentMat.diffuseColor = new Color3(1, 0.82, 0.3);
  agentMat.emissiveColor = new Color3(0.35, 0.28, 0.05);
  agent.material = agentMat;
  agent.position.set(START.x, AGENT_Y, START.z);

  const hud = createHud(ctx, {
    title: "navmesh-pathfind",
    controls: [
      "Agent paths A (green) -> B (red) over the navmesh.",
      "A wall drops mid-route; the path is rebuilt to detour the gap.",
      "Drag to orbit. Loops automatically.",
    ],
  });

  // --- Mutable demo state (assigned once Recast WASM has loaded). ---
  let recast: RecastModule | null = null;
  let plugin: RecastJSPlugin | null = null;
  let debugMesh: Mesh | null = null;
  let pathLine: LinesMesh | null = null;
  let obstacleMesh: Mesh | null = null;
  let path: Vec3[] = [];
  let follow: FollowState = createFollowState([]);
  let phase: Phase = "following";
  let runElapsed = 0; // seconds since the current run started
  let arrivedElapsed = 0; // seconds spent paused on the goal
  let obstacleDropped = false;
  let disposed = false;
  let ready = false;

  /** Rebuild the navmesh from the ground + the currently-active blocker meshes. */
  function rebuildNav(blockers: Mesh[]): void {
    if (!recast) return;
    if (debugMesh) {
      // dispose(_, true): the debug overlay owns a StandardMaterial that Mesh.dispose
      // does not free by default — without this each loop rebuild leaks one material.
      debugMesh.dispose(false, true);
      debugMesh = null;
    }
    if (plugin) {
      plugin.dispose();
      plugin = null;
    }
    plugin = createNavMesh(recast, [ground, ...blockers], DEFAULT_NAV_PARAMS);
    debugMesh = createNavMeshDebug(plugin, scene);
  }

  /** Query A'->B on the current navmesh from `from`, reset the follow + path line. */
  function repathFrom(from: Vec3): void {
    if (!plugin) return;
    const startPt = plugin.getClosestPoint(new Vector3(from.x, from.y, from.z));
    const goalPt = plugin.getClosestPoint(new Vector3(GOAL.x, GOAL.y, GOAL.z));
    const raw = plugin.computePath(startPt, goalPt);
    path = raw.map((v) => ({ x: v.x, y: v.y, z: v.z }));
    follow = createFollowState(path);
    drawPathLine();
  }

  /** Redraw the path polyline (disposed + recreated; only happens on a re-path). */
  function drawPathLine(): void {
    if (pathLine) {
      pathLine.dispose();
      pathLine = null;
    }
    if (path.length < 2) return;
    const points = path.map((p) => new Vector3(p.x, PATH_LIFT, p.z));
    const line = MeshBuilder.CreateLines("navPath", { points }, scene);
    line.color = new Color3(1, 0.95, 0.45);
    line.isPickable = false;
    pathLine = line;
  }

  /** Drop the wall onto the route and rebuild + re-path around it. */
  function dropObstacle(): void {
    obstacleDropped = true;
    obstacleMesh = MeshBuilder.CreateBox(
      "navObstacle",
      {
        width: DYNAMIC_WALL.size.x,
        height: DYNAMIC_WALL.size.y,
        depth: DYNAMIC_WALL.size.z,
      },
      scene,
    );
    obstacleMesh.position.set(
      DYNAMIC_WALL.center.x,
      DYNAMIC_WALL.center.y,
      DYNAMIC_WALL.center.z,
    );
    const obstacleMat = new StandardMaterial("navObstacleMat", scene);
    obstacleMat.diffuseColor = new Color3(0.7, 0.3, 0.3);
    obstacleMesh.material = obstacleMat;
    rebuildNav([obstacleMesh]);
    repathFrom(follow.pos);
  }

  /** Restart the loop: remove the wall, rebuild the open navmesh, walk A->B again. */
  function resetRun(): void {
    if (obstacleMesh) {
      obstacleMesh.material?.dispose();
      obstacleMesh.dispose();
      obstacleMesh = null;
    }
    obstacleDropped = false;
    rebuildNav([]);
    repathFrom(START);
    agent.position.set(START.x, AGENT_Y, START.z);
    phase = "following";
    runElapsed = 0;
    arrivedElapsed = 0;
  }

  const update = (): void => {
    if (!ready) return;
    const dt = engine.getDeltaTime() / 1000;
    if (dt <= 0) return;

    if (phase === "following") {
      runElapsed += dt;
      if (!obstacleDropped && runElapsed >= DROP_DELAY_S) {
        dropObstacle();
      }
      follow = stepFollow(follow, path, AGENT_SPEED, dt);
      agent.position.set(follow.pos.x, AGENT_Y, follow.pos.z);
      if (follow.done) {
        phase = "arrived";
        arrivedElapsed = 0;
      }
    } else {
      arrivedElapsed += dt;
      if (arrivedElapsed >= RESET_DELAY_S) resetRun();
    }
  };
  const updateObserver = scene.onBeforeRenderObservable.add(update);

  // --- Async: load Recast WASM, then build the first navmesh + path. The user may
  // switch away before this resolves, so guard with `disposed`. ---
  loadRecast()
    .then((module) => {
      if (disposed) return;
      recast = module;
      rebuildNav([]);
      repathFrom(START);
      ready = true;
    })
    .catch((err: unknown) => {
      if (!disposed) {
        // reason: surfacing the WASM-load failure in the console is the only
        // sensible action here; the sample simply renders an idle agent.
        console.error("navmesh-pathfind: failed to load Recast", err);
      }
    });

  return () => {
    disposed = true;
    scene.onBeforeRenderObservable.remove(updateObserver);
    hud.dispose();
    if (pathLine) pathLine.dispose();
    if (debugMesh) debugMesh.dispose(false, true);
    if (plugin) plugin.dispose();
    if (obstacleMesh) {
      obstacleMesh.material?.dispose();
      obstacleMesh.dispose();
    }
    agent.dispose();
    agentMat.dispose();
    startMarker.dispose();
    goalMarker.dispose();
    ground.dispose();
    groundMat.dispose();
    camera.dispose();
  };
}

/** A disc marker (mesh + owned material) with an idempotent combined dispose. */
interface Marker {
  dispose(): void;
}

/** Build a flat disc marker on the ground at `at`; the caller owns its dispose. */
function makeMarker(
  scene: SampleContext["scene"],
  name: string,
  at: Vec3,
  color: Color3,
): Marker {
  const disc = MeshBuilder.CreateCylinder(
    name,
    { diameter: MARKER_DIAMETER, height: MARKER_HEIGHT },
    scene,
  );
  disc.position.set(at.x, MARKER_HEIGHT / 2, at.z);
  const mat = new StandardMaterial(`${name}Mat`, scene);
  mat.diffuseColor = color;
  mat.emissiveColor = color.scale(0.4);
  disc.material = mat;
  disc.isPickable = false;

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disc.dispose();
      mat.dispose();
    },
  };
}

export const sample14: Sample = {
  id: "14-navmesh-pathfind",
  title: "Navmesh Pathfind + Dynamic Re-path",
  summary:
    "Agent walks A->B over a Recast/Detour navmesh (via Babylon's RecastJSPlugin); a wall drops mid-route and the path is rebuilt to detour the gap. Loops.",
  tags: ["ai", "navmesh", "pathfinding"],
  mount: sample14Mount,
};

export default sample14;
