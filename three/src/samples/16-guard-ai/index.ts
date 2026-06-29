import {
  CapsuleGeometry,
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
} from "three";
import { Hud } from "../../engine/hud";
import { createGround, createLightPreset } from "../../engine/scene";
import { type Vec3, initNavmesh } from "../../ai/navmesh";
import { createNavmeshDebug, type NavmeshDebug } from "../../ai/navmesh/debugView";
import { DEFAULT_GUARD_CONFIG, GuardSim, type GuardState } from "./guard";
import type { Sample, SampleContext } from "../types";

const SCENE_BACKGROUND = 0x0d1117;

// Fixed overhead camera so the whole 20×20 course + the patrol/chase routing
// reads at a glance (the FSM behaviour is the point of the sample).
const CAMERA_POS: [number, number, number] = [0, 24, 20];
const CAMERA_LOOK: [number, number, number] = [0, 0, 0];

// Fixed-step simulation: accumulate real time and advance the pure FSM in
// constant DT slices so the AI is frame-rate independent (and matches the
// headless test exactly).
const SIM_DT = 1 / 60;
const MAX_FRAME_DT = 0.1; // clamp long frames (tab switch) so nothing teleports
const MAX_STEPS_PER_FRAME = 5; // bound catch-up work after a stall

// --- Guard rig (a capsule recoloured per FSM state). ---
const GUARD_RADIUS = 0.4;
const GUARD_BODY_HEIGHT = 1.0;
const GUARD_CENTER_Y = GUARD_RADIUS + GUARD_BODY_HEIGHT / 2;
const STATE_COLOR: Record<GuardState, number> = {
  patrol: 0x4aa3ff, // blue — calm
  detect: 0xffd166, // yellow — alerted
  chase: 0xff5d5d, // red — pursuing
  return: 0x06d6a0, // green — heading home
};

// --- Player decoy (auto-driven on a loop so all four transitions show). ---
const PLAYER_RADIUS = 0.35;
const PLAYER_Y = PLAYER_RADIUS;
const PLAYER_COLOR = 0xc77dff;
const PLAYER_SPEED = 3.0; // m/s along its loop
const PLAYER_WAYPOINT_EPS = 0.2;
// Far corner → beside the patrol route (trips detect/chase) → opposite side of
// the pillar (chase wraps) → flee far (guard gives up & returns) → loop.
const PLAYER_LOOP: Vec3[] = [
  { x: 8, y: 0, z: 8 },
  { x: -5, y: 0, z: 0 },
  { x: 5, y: 0, z: 0 },
  { x: 8, y: 0, z: -8 },
];

// --- Central pillar (solid visual over the navmesh hole). ---
const PILLAR_COLOR = 0x8a6d3b;
const PILLAR_CENTER: Vec3 = { x: 0, y: 1.5, z: 0 };
const PILLAR_HALF: Vec3 = { x: 2.5, y: 1.5, z: 2.5 };

// --- Patrol / home markers (flat rings on the ground). ---
const MARKER_INNER = 0.35;
const MARKER_OUTER = 0.55;
const MARKER_LIFT = 0.02;
const PATROL_COLOR = 0x3a6ea5;
const HOME_COLOR = 0x06d6a0;

const sample: Sample = {
  id: "16-guard-ai",
  title: "Guard AI (FSM: patrol→detect→chase→return)",
  summary:
    "A hand-rolled FSM guard: it patrols a route, detects a passing player, chases along a navmesh path around the pillar, then returns home when it loses the player. Hand-rolled steering (seek/arrive/avoid); pure AI core is headless-tested.",
  tags: ["ai", "fsm", "steering", "navmesh"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;

    camera.position.set(...CAMERA_POS);
    camera.lookAt(...CAMERA_LOOK);

    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });
    const ground = createGround(scene, { size: 20, y: -0.01 });

    // Solid pillar visual (the navmesh overlay shows the carved hole).
    const pillarGeo = new BoxGeometry(
      PILLAR_HALF.x * 2,
      PILLAR_HALF.y * 2,
      PILLAR_HALF.z * 2,
    );
    const pillarMat = new MeshStandardMaterial({ color: PILLAR_COLOR });
    const pillar = new Mesh(pillarGeo, pillarMat);
    pillar.position.set(PILLAR_CENTER.x, PILLAR_CENTER.y, PILLAR_CENTER.z);
    scene.add(pillar);

    // Guard capsule.
    const guardGeo = new CapsuleGeometry(GUARD_RADIUS, GUARD_BODY_HEIGHT, 8, 16);
    const guardMat = new MeshStandardMaterial({ color: STATE_COLOR.patrol });
    const guardMesh = new Mesh(guardGeo, guardMat);
    scene.add(guardMesh);

    // Player decoy sphere.
    const playerGeo = new SphereGeometry(PLAYER_RADIUS, 16, 12);
    const playerMat = new MeshStandardMaterial({ color: PLAYER_COLOR });
    const playerMesh = new Mesh(playerGeo, playerMat);
    scene.add(playerMesh);

    // Patrol + home markers.
    const markerMeshes: Mesh[] = [];
    const markerGeos: RingGeometry[] = [];
    const markerMats: MeshStandardMaterial[] = [];

    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      title: "Guard AI",
      controls: [
        "Auto: a decoy player loops; watch the guard's state colour change",
        "Blue patrol · Yellow detect · Red chase · Green return",
        "R — reset the run",
      ],
    });

    // Live state overlay (Hud has no dynamic text slot).
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

    // --- Mutable state (populated once the async navmesh is ready). ---
    let guard: GuardSim | null = null;
    let debug: NavmeshDebug | null = null;
    let playerPos: Vec3 = { ...PLAYER_LOOP[0] };
    let playerTarget = 1;
    let accumulator = 0;
    let disposed = false;
    let raf = 0;
    let last = performance.now();

    const setStatus = (text: string): void => {
      statusEl.textContent = text;
    };

    // Advance the auto-driven decoy along its loop.
    const stepPlayer = (dt: number): void => {
      let budget = PLAYER_SPEED * dt;
      while (budget > 0) {
        const target = PLAYER_LOOP[playerTarget];
        const dx = target.x - playerPos.x;
        const dz = target.z - playerPos.z;
        const dist = Math.hypot(dx, dz);
        if (dist <= PLAYER_WAYPOINT_EPS) {
          playerTarget = (playerTarget + 1) % PLAYER_LOOP.length;
          continue;
        }
        const step = Math.min(budget, dist);
        playerPos = {
          x: playerPos.x + (dx / dist) * step,
          y: 0,
          z: playerPos.z + (dz / dist) * step,
        };
        budget -= step;
      }
      playerMesh.position.set(playerPos.x, PLAYER_Y, playerPos.z);
    };

    const reset = (): void => {
      if (disposed) return;
      debug?.dispose();
      guard?.destroy();
      guard = GuardSim.create(DEFAULT_GUARD_CONFIG);
      debug = createNavmeshDebug(scene, guard.navmesh);

      // (Re)build patrol/home markers now that the guard exists.
      for (const m of markerMeshes) scene.remove(m);
      for (const g of markerGeos) g.dispose();
      for (const mt of markerMats) mt.dispose();
      markerMeshes.length = 0;
      markerGeos.length = 0;
      markerMats.length = 0;
      guard.patrolWaypoints.forEach((w) => {
        const isHome =
          w.x === guard?.home.x && w.z === guard.home.z;
        const geo = new RingGeometry(MARKER_INNER, MARKER_OUTER, 24);
        const mat = new MeshStandardMaterial({
          color: isHome ? HOME_COLOR : PATROL_COLOR,
        });
        const mesh = new Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(w.x, MARKER_LIFT, w.z);
        scene.add(mesh);
        markerMeshes.push(mesh);
        markerGeos.push(geo);
        markerMats.push(mat);
      });

      playerPos = { ...PLAYER_LOOP[0] };
      playerTarget = 1;
      playerMesh.position.set(playerPos.x, PLAYER_Y, playerPos.z);
      const start = guard.position;
      guardMesh.position.set(start.x, GUARD_CENTER_Y, start.z);
      accumulator = 0;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code === "KeyR") reset();
    };
    window.addEventListener("keydown", onKeyDown);

    const update = (now: number): void => {
      raf = requestAnimationFrame(update);
      const frameDt = Math.min((now - last) / 1000, MAX_FRAME_DT);
      last = now;
      hud.frame(now);
      if (!guard) {
        setStatus("loading navmesh…");
        return;
      }

      // Fixed-step accumulator: keep the decoy and the FSM in lock-step.
      accumulator += frameDt;
      let steps = 0;
      while (accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
        stepPlayer(SIM_DT);
        guard.tick(SIM_DT, playerPos);
        accumulator -= SIM_DT;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // drop backlog

      const snap = guard.snapshot(playerPos);
      guardMesh.position.set(snap.pos.x, GUARD_CENTER_Y, snap.pos.z);
      guardMat.color.setHex(STATE_COLOR[snap.state]);
      debug?.setPath(guard.activePath);
      setStatus(
        `state: ${snap.state.toUpperCase()}  ·  player ${snap.distanceToPlayer.toFixed(
          1,
        )} m  ·  home ${snap.distanceToHome.toFixed(1)} m`,
      );
    };

    // mount() is sync; kick the WASM navmesh load and wire up once ready.
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
      guard?.destroy();
      for (const m of markerMeshes) scene.remove(m);
      for (const g of markerGeos) g.dispose();
      for (const mt of markerMats) mt.dispose();
      scene.remove(pillar);
      scene.remove(guardMesh);
      scene.remove(playerMesh);
      pillarGeo.dispose();
      pillarMat.dispose();
      guardGeo.dispose();
      guardMat.dispose();
      playerGeo.dispose();
      playerMat.dispose();
      lights.dispose();
      ground.dispose();
    };
  },
};

export default sample;
