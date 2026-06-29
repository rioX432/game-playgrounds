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
  createGuardState,
  GUARD_SPEC,
  playerDemoAt,
  stepGuard,
  type GuardNav,
  type GuardState,
  type GuardStateName,
} from "./guard";
import type { Sample, SampleContext } from "../types";

/**
 * guard-ai: a single NPC runs a hand-rolled FSM — patrol -> detect -> chase ->
 * return — over a Recast/Detour navmesh built through Babylon's `RecastJSPlugin`.
 * A scripted "player" loops through the guard's view: while it lurks far off the
 * guard patrols; step into view and the guard confirms the sighting (detect),
 * navmesh-paths to it and pursues with hand-rolled seek/arrive/avoid steering
 * (chase); escape far behind the wall and the guard gives up and walks home
 * (return), then resumes patrol.
 *
 * All decision + steering logic lives in the render-independent `./guard` core,
 * proven headless in `guard.test.ts`; this file is only the visualization —
 * camera, meshes, the navmesh overlay, the path line, and a per-frame state label.
 * The guard capsule is tinted by its current FSM state.
 */

// --- Camera: a near-top-down orbit framing the whole 24x24 ground. ---
const CAM_ALPHA = -Math.PI / 2;
const CAM_BETA = 0.7; // radians from +Y; lower = more top-down
const CAM_RADIUS = 34;

// --- Agent / player rigs (small capsule-ish cylinders riding the navmesh). ---
const AGENT_RADIUS = 0.5;
const AGENT_HEIGHT = 1.4;
const AGENT_Y = AGENT_HEIGHT / 2;
const PATH_LIFT = 0.15;

// --- Per-state guard tint (diffuse) so the FSM is readable at a glance. ---
const STATE_COLOR: Record<GuardStateName, Color3> = {
  patrol: new Color3(0.35, 0.6, 1), // calm blue
  detect: new Color3(1, 0.85, 0.25), // alert yellow
  chase: new Color3(1, 0.3, 0.25), // aggressive red
  return: new Color3(0.4, 0.85, 0.45), // standing-down green
};

// Pre-scaled emissive tints, so the per-frame update assigns by copyFrom instead
// of allocating two Color3 every render.
const STATE_EMISSIVE: Record<GuardStateName, Color3> = {
  patrol: STATE_COLOR.patrol.scale(0.25),
  detect: STATE_COLOR.detect.scale(0.25),
  chase: STATE_COLOR.chase.scale(0.25),
  return: STATE_COLOR.return.scale(0.25),
};

const STATE_LABEL: Record<GuardStateName, string> = {
  patrol: "PATROL — walking its route",
  detect: "DETECT — confirming a sighting",
  chase: "CHASE — pursuing along the navmesh",
  return: "RETURN — heading back to patrol",
};

function sample16Mount(ctx: SampleContext): () => void {
  const { scene, engine, canvas } = ctx;
  scene.clearColor.set(0.05, 0.06, 0.08, 1);

  createLightPreset(scene);

  const camera = new ArcRotateCamera(
    "guardCam",
    CAM_ALPHA,
    CAM_BETA,
    CAM_RADIUS,
    Vector3.Zero(),
    scene,
  );
  camera.attachControl(canvas, true);
  scene.activeCamera = camera;

  // --- Static world: ground + the one wall, from the shared spec so the render
  // matches the headless test exactly. ---
  const { ground, blockers } = buildSpecMeshes(scene, GUARD_SPEC);
  const groundMat = new StandardMaterial("guardGroundMat", scene);
  groundMat.diffuseColor = new Color3(0.22, 0.27, 0.22);
  ground.material = groundMat;
  const wallMat = new StandardMaterial("guardWallMat", scene);
  wallMat.diffuseColor = new Color3(0.5, 0.42, 0.38);
  for (const b of blockers) b.material = wallMat;

  // --- Guard + player capsules. ---
  const guard = makeCapsule(scene, "guard", STATE_COLOR.patrol);
  const player = makeCapsule(scene, "player", new Color3(0.3, 0.85, 0.85));

  const hud = createHud(ctx, {
    title: "guard-ai",
    controls: [
      "A scripted player loops through the guard's view.",
      "Guard tint = FSM state (see the label, top-center).",
      "Drag to orbit. Auto-loops.",
    ],
  });

  // --- State label (DOM overlay; this module owns it and removes it on dispose). ---
  const label = document.createElement("div");
  Object.assign(label.style, {
    position: "absolute",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "6px 12px",
    borderRadius: "8px",
    background: "rgba(11, 14, 19, 0.72)",
    border: "1px solid rgba(74, 163, 255, 0.25)",
    color: "#e6edf3",
    font: "13px ui-monospace, SFMono-Regular, Menlo, monospace",
    pointerEvents: "none",
    zIndex: "11",
  } as Partial<CSSStyleDeclaration>);
  label.textContent = "loading navmesh…";
  (canvas.parentElement ?? document.body).appendChild(label);

  // --- Mutable demo state (navmesh built once Recast WASM has loaded). ---
  let plugin: RecastJSPlugin | null = null;
  let debugMesh: Mesh | null = null;
  let pathLine: LinesMesh | null = null;
  let lastPath: readonly Vec3[] | null = null;
  let guardState: GuardState = createGuardState();
  let elapsed = 0; // seconds since mount (drives the scripted player loop)
  let disposed = false;
  let ready = false;

  // The navmesh-query slice the FSM needs, wrapping the live plugin. Built lazily.
  let nav: GuardNav | null = null;

  /** Redraw the path polyline only when the followed path actually changed. */
  function syncPathLine(path: readonly Vec3[]): void {
    if (path === lastPath) return;
    lastPath = path;
    if (pathLine) {
      pathLine.dispose();
      pathLine = null;
    }
    if (path.length < 2) return;
    const points = path.map((p) => new Vector3(p.x, PATH_LIFT, p.z));
    const line = MeshBuilder.CreateLines("guardPath", { points }, scene);
    line.color = new Color3(1, 0.5, 0.4);
    line.isPickable = false;
    pathLine = line;
  }

  const update = (): void => {
    const dt = engine.getDeltaTime() / 1000;
    if (dt <= 0) return;
    elapsed += dt;

    // The player loops regardless of readiness, so it is always visible.
    const playerPos = playerDemoAt(elapsed);
    player.position.set(playerPos.x, AGENT_Y, playerPos.z);

    if (!ready || !nav) return;
    guardState = stepGuard(guardState, nav, playerPos, dt);
    guard.position.set(guardState.pos.x, AGENT_Y, guardState.pos.z);
    guard.material.diffuseColor.copyFrom(STATE_COLOR[guardState.name]);
    guard.material.emissiveColor.copyFrom(STATE_EMISSIVE[guardState.name]);
    syncPathLine(guardState.path);
    label.textContent = STATE_LABEL[guardState.name];
  };
  const updateObserver = scene.onBeforeRenderObservable.add(update);

  // --- Async: load Recast WASM, then build the navmesh + debug overlay. The user
  // may switch away before this resolves, so guard with `disposed`. ---
  loadRecast()
    .then((module: RecastModule) => {
      if (disposed) return;
      plugin = createNavMesh(module, [ground, ...blockers], DEFAULT_NAV_PARAMS);
      debugMesh = createNavMeshDebug(plugin, scene);
      const live = plugin;
      nav = {
        closestPoint: (p) => {
          const v = live.getClosestPoint(new Vector3(p.x, p.y, p.z));
          return { x: v.x, y: v.y, z: v.z };
        },
        computePath: (s, e) =>
          live
            .computePath(new Vector3(s.x, s.y, s.z), new Vector3(e.x, e.y, e.z))
            .map((v) => ({ x: v.x, y: v.y, z: v.z })),
        blockers: GUARD_SPEC.blockers,
      };
      ready = true;
    })
    .catch((err: unknown) => {
      if (!disposed) {
        // reason: surfacing the WASM-load failure in the console is the only
        // sensible action here; the sample simply renders an idle guard.
        console.error("guard-ai: failed to load Recast", err);
      }
    });

  return () => {
    disposed = true;
    scene.onBeforeRenderObservable.remove(updateObserver);
    hud.dispose();
    label.remove();
    if (pathLine) pathLine.dispose();
    if (debugMesh) debugMesh.dispose(false, true);
    if (plugin) plugin.dispose();
    guard.dispose();
    player.dispose();
    ground.dispose();
    groundMat.dispose();
    for (const b of blockers) b.dispose();
    wallMat.dispose();
    camera.dispose();
  };
}

/** A capsule-ish cylinder that owns its material; `dispose()` frees both. */
interface Capsule {
  position: Mesh["position"];
  material: StandardMaterial;
  dispose(): void;
}

function makeCapsule(
  scene: SampleContext["scene"],
  name: string,
  color: Color3,
): Capsule {
  const mesh = MeshBuilder.CreateCylinder(
    name,
    { diameter: AGENT_RADIUS * 2, height: AGENT_HEIGHT },
    scene,
  );
  const mat = new StandardMaterial(`${name}Mat`, scene);
  mat.diffuseColor = color.clone();
  mat.emissiveColor = color.scale(0.25);
  mesh.material = mat;
  mesh.position.set(0, AGENT_Y, 0);

  let isDisposed = false;
  return {
    position: mesh.position,
    material: mat,
    dispose(): void {
      if (isDisposed) return;
      isDisposed = true;
      mesh.dispose();
      mat.dispose();
    },
  };
}

export const sample16: Sample = {
  id: "16-guard-ai",
  title: "Guard AI — FSM Patrol/Detect/Chase/Return",
  summary:
    "A single NPC runs a hand-rolled FSM (patrol -> detect -> chase -> return) with hand-rolled seek/arrive/avoid steering, chasing along a Recast/Detour navmesh. A scripted player loops it through every state.",
  tags: ["ai", "fsm", "steering", "navmesh"],
  mount: sample16Mount,
};

export default sample16;
