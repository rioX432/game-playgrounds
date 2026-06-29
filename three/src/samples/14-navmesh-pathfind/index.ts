import {
  CapsuleGeometry,
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  RingGeometry,
  Vector3,
} from "three";
import { Hud } from "../../engine/hud";
import { createGround, createLightPreset } from "../../engine/scene";
import {
  type Navmesh,
  type Vec3,
  initNavmesh,
} from "../../ai/navmesh";
import { createNavmeshDebug, type NavmeshDebug } from "../../ai/navmesh/debugView";
import { PathfindScenario, dynamicObstacleSpec } from "./pathfind";
import type { Sample, SampleContext } from "../types";

const SCENE_BACKGROUND = 0x0d1117;

// --- Camera: a high, tilted overhead so the whole 20x20 course + the detour
// reads at a glance (the path is the point of the sample). Fixed, no follow. ---
const CAMERA_POS: [number, number, number] = [0, 24, 20];
const CAMERA_LOOK: [number, number, number] = [0, 0, 0];

// --- Agent rig: a capsule that walks the path corners at a constant speed. ---
const AGENT_RADIUS = 0.4;
const AGENT_BODY_HEIGHT = 1.0; // cylinder part; total height = body + 2*radius
const AGENT_CENTER_Y = AGENT_RADIUS + AGENT_BODY_HEIGHT / 2;
const AGENT_COLOR = 0x4aa3ff;
const AGENT_SPEED = 4.5; // m/s along the path polyline
const CORNER_REACHED_EPS = 0.15; // m; advance to the next corner within this

// --- Obstacles (solid visuals over the navmesh holes). ---
const PILLAR_COLOR = 0x8a6d3b;
const DYNAMIC_COLOR = 0xff5d5d;
const PILLAR_CENTER: Vec3 = { x: 0, y: 1.5, z: 0 };
const PILLAR_HALF: Vec3 = { x: 2.5, y: 1.5, z: 2.5 };

// --- Start / goal markers (flat rings on the ground). ---
const MARKER_INNER = 0.45;
const MARKER_OUTER = 0.7;
const MARKER_LIFT = 0.02;
const START_COLOR = 0x06d6a0;
const GOAL_COLOR = 0xffd166;

// --- Demo loop timing. ---
const DROP_DELAY_S = 2.2; // auto-drop the obstacle this long after a (re)start
const RESET_DELAY_S = 1.6; // pause on the goal before looping back to the start
const MAX_DT = 0.1; // clamp long frames (tab switch) so the agent never teleports

type DemoPhase = "walking-initial" | "walking-blocked" | "arrived";

const sample: Sample = {
  id: "14-navmesh-pathfind",
  title: "Navmesh Pathfinding (A→B + dynamic re-path)",
  summary:
    "Recast/Detour navmesh: an agent paths A→B around a pillar, then a dynamic obstacle drops onto its corridor — the navmesh re-bakes and the agent re-routes. Pure path core is headless-tested.",
  tags: ["ai", "navmesh", "pathfinding"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;

    camera.position.set(...CAMERA_POS);
    camera.lookAt(...CAMERA_LOOK);

    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });
    // Ground sits a hair below y=0 so it never z-fights the navmesh overlay.
    const ground = createGround(scene, { size: 20, y: -0.01 });

    // Solid obstacle visuals (the navmesh debug overlay shows the carved holes;
    // these opaque boxes make the blockers legible).
    const pillarGeo = new BoxGeometry(
      PILLAR_HALF.x * 2,
      PILLAR_HALF.y * 2,
      PILLAR_HALF.z * 2,
    );
    const pillarMat = new MeshStandardMaterial({ color: PILLAR_COLOR });
    const pillar = new Mesh(pillarGeo, pillarMat);
    pillar.position.set(PILLAR_CENTER.x, PILLAR_CENTER.y, PILLAR_CENTER.z);
    scene.add(pillar);

    const dynGeo = new BoxGeometry(
      dynamicObstacleSpec.half.x * 2,
      dynamicObstacleSpec.half.y * 2,
      dynamicObstacleSpec.half.z * 2,
    );
    const dynMat = new MeshStandardMaterial({ color: DYNAMIC_COLOR });
    const dynBox = new Mesh(dynGeo, dynMat);
    dynBox.position.set(
      dynamicObstacleSpec.center.x,
      dynamicObstacleSpec.center.y,
      dynamicObstacleSpec.center.z,
    );
    dynBox.visible = false; // appears when dropped
    scene.add(dynBox);

    // Agent capsule.
    const agentGeo = new CapsuleGeometry(AGENT_RADIUS, AGENT_BODY_HEIGHT, 8, 16);
    const agentMat = new MeshStandardMaterial({ color: AGENT_COLOR });
    const agent = new Mesh(agentGeo, agentMat);
    scene.add(agent);

    // Start / goal markers.
    const startGeo = new RingGeometry(MARKER_INNER, MARKER_OUTER, 32);
    const startMat = new MeshStandardMaterial({ color: START_COLOR });
    const startMarker = new Mesh(startGeo, startMat);
    startMarker.rotation.x = -Math.PI / 2;
    scene.add(startMarker);

    const goalGeo = new RingGeometry(MARKER_INNER, MARKER_OUTER, 32);
    const goalMat = new MeshStandardMaterial({ color: GOAL_COLOR });
    const goalMarker = new Mesh(goalGeo, goalMat);
    goalMarker.rotation.x = -Math.PI / 2;
    scene.add(goalMarker);

    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      title: "Navmesh pathfind",
      controls: [
        "Space — drop the obstacle now",
        "R — reset the run",
        "Agent auto-re-routes when the navmesh re-bakes",
      ],
    });

    // Live status line (Hud has no dynamic text slot, so own a small overlay).
    const statusEl = document.createElement("div");
    Object.assign(statusEl.style, {
      position: "absolute",
      top: "8px",
      left: "8px",
      padding: "4px 8px",
      background: "rgba(13,17,23,0.7)",
      color: "#e6edf3",
      font: "12px ui-monospace, Menlo, monospace",
      borderRadius: "4px",
      zIndex: "11",
      pointerEvents: "none",
    } as Partial<CSSStyleDeclaration>);
    (canvas.parentElement ?? document.body).appendChild(statusEl);

    // --- Mutable demo state (populated once the async navmesh is ready). ---
    let scenario: PathfindScenario | null = null;
    let debug: NavmeshDebug | null = null;
    let pathPoints: Vec3[] = [];
    let cornerIndex = 0;
    let demoPhase: DemoPhase = "walking-initial";
    let phaseTimer = 0; // seconds since the last (re)start
    let resetTimer = 0; // seconds spent waiting on the goal
    let disposed = false;
    let raf = 0;
    let last = performance.now();

    const agentPos = new Vector3();

    const setStatus = (text: string): void => {
      statusEl.textContent = text;
    };

    // Replace the navmesh debug overlay (the active navmesh changes on re-bake).
    const rebuildDebug = (navmesh: Navmesh): void => {
      debug?.dispose();
      debug = createNavmeshDebug(scene, navmesh);
    };

    const setPath = (points: Vec3[]): void => {
      pathPoints = points;
      cornerIndex = 0;
      debug?.setPath(points);
    };

    // Snap the agent's current XZ onto the active navmesh and re-query to the goal.
    const repathFromAgent = (): void => {
      if (!scenario) return;
      const snapped =
        scenario.closestPoint({ x: agentPos.x, y: 0, z: agentPos.z }) ??
        scenario.course.start;
      const result = scenario.findPath(snapped, scenario.course.goal);
      if (result.success) setPath(result.points);
    };

    const dropObstacleNow = (): void => {
      if (!scenario || scenario.phase === "blocked") return;
      scenario.dropObstacle();
      dynBox.visible = true;
      rebuildDebug(scenario.navmesh); // overlay must reflect the new hole
      repathFromAgent();
      demoPhase = "walking-blocked";
      phaseTimer = 0;
    };

    // Full reset back to the initial (single-pillar) course — fresh navmesh.
    const reset = (): void => {
      if (disposed) return;
      scenario?.destroy();
      scenario = PathfindScenario.create();
      rebuildDebug(scenario.navmesh);
      dynBox.visible = false;
      const { start, goal } = scenario.course;
      startMarker.position.set(start.x, MARKER_LIFT, start.z);
      goalMarker.position.set(goal.x, MARKER_LIFT, goal.z);
      agentPos.set(start.x, AGENT_CENTER_Y, start.z);
      agent.position.copy(agentPos);
      const initial = scenario.findPath(start, goal);
      setPath(initial.success ? initial.points : []);
      demoPhase = "walking-initial";
      phaseTimer = 0;
      resetTimer = 0;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code === "Space") {
        e.preventDefault();
        dropObstacleNow();
      } else if (e.code === "KeyR") {
        reset();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    // Advance the agent toward the next path corner; returns true at the goal.
    const stepAgent = (dt: number): boolean => {
      if (cornerIndex >= pathPoints.length) return true;
      let budget = AGENT_SPEED * dt;
      while (budget > 0 && cornerIndex < pathPoints.length) {
        const target = pathPoints[cornerIndex];
        const dx = target.x - agentPos.x;
        const dz = target.z - agentPos.z;
        const dist = Math.hypot(dx, dz);
        if (dist <= CORNER_REACHED_EPS || dist === 0) {
          cornerIndex++;
          continue;
        }
        const step = Math.min(budget, dist);
        agentPos.x += (dx / dist) * step;
        agentPos.z += (dz / dist) * step;
        budget -= step;
        if (step >= dist) cornerIndex++;
      }
      agent.position.set(agentPos.x, AGENT_CENTER_Y, agentPos.z);
      return cornerIndex >= pathPoints.length;
    };

    const update = (now: number): void => {
      raf = requestAnimationFrame(update);
      const dt = Math.min((now - last) / 1000, MAX_DT);
      last = now;
      hud.frame(now);
      if (!scenario) {
        setStatus("loading navmesh…");
        return;
      }

      phaseTimer += dt;
      if (demoPhase === "walking-initial") {
        setStatus(
          `phase: initial route — obstacle drops in ${Math.max(
            0,
            DROP_DELAY_S - phaseTimer,
          ).toFixed(1)}s (Space)`,
        );
        if (phaseTimer >= DROP_DELAY_S) dropObstacleNow();
        else if (stepAgent(dt)) demoPhase = "arrived";
      } else if (demoPhase === "walking-blocked") {
        setStatus("phase: re-routed around the dropped obstacle");
        if (stepAgent(dt)) demoPhase = "arrived";
      } else {
        setStatus("phase: arrived — looping (R to reset now)");
        resetTimer += dt;
        if (resetTimer >= RESET_DELAY_S) reset();
      }
    };

    // Async navmesh init: mount() is sync, so kick the WASM load off here and
    // wire everything up once ready (guarding against dispose mid-flight).
    void initNavmesh()
      .then(() => {
        if (disposed) return;
        reset();
      })
      .catch((err: unknown) => {
        if (!disposed) setStatus(`navmesh init failed: ${String(err)}`);
      });

    raf = requestAnimationFrame(update);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      hud.dispose();
      statusEl.remove();
      debug?.dispose();
      scenario?.destroy();
      scene.remove(pillar);
      scene.remove(dynBox);
      scene.remove(agent);
      scene.remove(startMarker);
      scene.remove(goalMarker);
      pillarGeo.dispose();
      pillarMat.dispose();
      dynGeo.dispose();
      dynMat.dispose();
      agentGeo.dispose();
      agentMat.dispose();
      startGeo.dispose();
      startMat.dispose();
      goalGeo.dispose();
      goalMat.dispose();
      lights.dispose();
      ground.dispose();
    };
  },
};

export default sample;
