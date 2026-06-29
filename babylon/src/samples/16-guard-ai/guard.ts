// Render-independent core for the guard-ai sample (Ch4 #201).
//
// This module holds the entire NPC brain with NO Babylon mesh/camera/engine types:
//   1. the scenario geometry (ground + one wall, plus the scripted player path),
//   2. hand-rolled steering primitives (seek / arrive / avoid) — no crowd library,
//      no steering library, so the steering axis stays controlled across all three
//      engines (Ch4 design §4: hand-rolled FSM + hand-rolled steering),
//   3. a four-state FSM patrol -> detect -> chase -> return that drives the agent.
//
// Pathfinding is NOT reinvented here: chase and return navigate a Recast/Detour
// navmesh through the shared Ch4 foundation (`src/ai/navmesh.ts`) — the same proven
// query path #198 (navmesh-pathfind) uses. The guard reuses that navmesh QUERY plus
// `isInsideFootprintXZ` (for line-of-sight occlusion and steering avoidance) and
// follows the returned waypoints with the hand-rolled steering below. We deliberately
// follow the path with steering rather than #198's fixed-speed `stepFollow` snapper
// because the issue folds sample 15 (steering) into 16: the locomotion model IS the
// seek/arrive/avoid steering, so layering both would be redundant.
//
// Keeping this core free of render types is what lets the headless vitest proof
// (`guard.test.ts`) drive the exact same FSM the visualization renders, under
// NullEngine with no DOM/GPU, asserting robust properties (transition order,
// waypoint-index advance, catch distance) rather than exact float-sensitive paths.

import {
  isInsideFootprintXZ,
  type NavBox,
  type NavSceneSpec,
  type Vec3,
} from "../../ai/navmesh";

// --- Scenario geometry (a 24x24 ground; X and Z each span [-12, +12]). -----------

/** Square ground the guard and player walk on. */
export const GROUND = { width: 24, depth: 24 } as const;

/**
 * One wall that reaches the -Z edge and stops short of +Z, leaving a single gap to
 * thread (the same "wall-with-a-gap, not a free-standing box" trick #198 proved:
 * a wall touching an edge forces a clean detour through one opening, so Detour's
 * straight string-pull never clips a corner). Spans Z in [-12, +8]; gap is Z in
 * (+8, +12). This both carves the navmesh (forcing a chase detour) and occludes
 * line-of-sight, so the guard can lose visual contact behind it.
 */
export const WALL: NavBox = {
  center: { x: 0, y: 1.5, z: -2 },
  size: { x: 2, y: 3, z: 20 },
};

/** The world the guard patrols: open ground carved by the single wall. */
export const GUARD_SPEC: NavSceneSpec = {
  ground: GROUND,
  blockers: [WALL],
};

/** Patrol loop: a back-and-forth on the -X side, clear of the wall footprint. */
export const PATROL_POINTS: readonly Vec3[] = [
  { x: -7, y: 0, z: -6 },
  { x: -7, y: 0, z: 6 },
];

// --- Scripted player path (shared by the headless test and the live demo). --------
//
// A deterministic timeline that exercises every transition: the player lurks far
// away (guard patrols), steps into the guard's view (detect -> chase), gets caught,
// then escapes far behind the wall (guard gives up -> return). Anchored, so the
// headless test can snap the player to exact positions; the visualization lerps
// between anchors for readable motion and loops the whole cycle.

/** Out of detection range — the guard patrols undisturbed. */
export const PLAYER_FAR: Vec3 = { x: 10, y: 0, z: -10 };
/** In front of the guard, open line of sight — triggers detect then chase. */
export const PLAYER_DETECT: Vec3 = { x: -7, y: 0, z: 4 };
/** Across the wall — the guard must detour through the gap to reach it. */
export const PLAYER_CHASE: Vec3 = { x: 8, y: 0, z: 0 };
/** Far behind the wall — beyond lose range, so the guard gives up and returns. */
export const PLAYER_ESCAPE: Vec3 = { x: -11, y: 0, z: -11 };

/** Duration (seconds) of each scripted phase, in order. */
export const PHASE_S = { far: 1.0, detect: 1.0, chase: 6.7, escape: 6.0 } as const;
/** Total length of one scripted cycle, seconds. */
export const SCRIPT_TOTAL_S =
  PHASE_S.far + PHASE_S.detect + PHASE_S.chase + PHASE_S.escape;

/** The scripted player anchor at elapsed time `t` (seconds), no interpolation. */
export function playerAnchorAt(t: number): Vec3 {
  const far = PHASE_S.far;
  const detect = far + PHASE_S.detect;
  const chase = detect + PHASE_S.chase;
  if (t < far) return PLAYER_FAR;
  if (t < detect) return PLAYER_DETECT;
  if (t < chase) return PLAYER_CHASE;
  return PLAYER_ESCAPE;
}

/**
 * Smoothly-interpolated player position for the live demo: lerps between the
 * current and previous anchor over a short blend at each phase boundary so the
 * player glides rather than teleports, and loops every {@link SCRIPT_TOTAL_S}.
 */
export function playerDemoAt(elapsedS: number): Vec3 {
  const t = elapsedS % SCRIPT_TOTAL_S;
  const far = PHASE_S.far;
  const detect = far + PHASE_S.detect;
  const chase = detect + PHASE_S.chase;
  const blend = DEMO_BLEND_S;

  // Lerp from the previous anchor into the current one over `blend` after each edge.
  if (t < far) return lerpXZ(PLAYER_ESCAPE, PLAYER_FAR, clamp01(t / blend));
  if (t < detect) return lerpXZ(PLAYER_FAR, PLAYER_DETECT, clamp01((t - far) / blend));
  if (t < chase) {
    return lerpXZ(PLAYER_DETECT, PLAYER_CHASE, clamp01((t - detect) / blend));
  }
  return lerpXZ(PLAYER_CHASE, PLAYER_ESCAPE, clamp01((t - chase) / blend));
}

/** Blend time (seconds) the demo player takes to glide between anchors. */
const DEMO_BLEND_S = 0.6;

// --- Hand-rolled steering primitives (pure; the controlled "steering" axis). ------

/** Tunable steering + perception knobs for the guard FSM. */
export interface GuardConfig {
  /** Max travel speed, world units / second. */
  speed: number;
  /** Max change in velocity per second (acceleration cap) — gives smooth turns. */
  maxAccel: number;
  /** Distance under which `arrive` starts braking toward a target. */
  arriveRadius: number;
  /** Distance under which a path waypoint is consumed and the next is targeted. */
  waypointRadius: number;
  /** Player must be within this range (and FOV, and unoccluded) to be detected. */
  detectRadius: number;
  /** Half-angle of the guard's view cone, radians. */
  fovHalfRad: number;
  /** Hysteresis: the guard loses an already-acquired player past this range. */
  loseRadius: number;
  /** Continuous sight time (s) required for detect -> chase. */
  detectConfirmS: number;
  /** Time (s) the player must stay beyond `loseRadius` for chase -> return. */
  loseGraceS: number;
  /** Interval (s) between chase re-path queries to the player's position. */
  repathS: number;
  /** Blockers within (footprint + this margin) push the guard away. */
  avoidMargin: number;
  /** Weight of the avoidance push relative to the seek/arrive desire. */
  avoidWeight: number;
  /** Sample spacing (world units) for the line-of-sight occlusion check. */
  losStep: number;
}

const DEG_TO_RAD = Math.PI / 180;

/** Default guard tuning — see field docs; loseRadius > detectRadius is hysteresis. */
export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  speed: 6,
  maxAccel: 30,
  arriveRadius: 1.5,
  waypointRadius: 0.5,
  detectRadius: 10,
  fovHalfRad: 70 * DEG_TO_RAD, // 140-degree cone
  loseRadius: 20,
  detectConfirmS: 0.3,
  loseGraceS: 1.0,
  repathS: 0.25,
  avoidMargin: 0.6,
  avoidWeight: 1.0,
  losStep: 0.25,
};

const EPS = 1e-6;

const subXZ = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: 0, z: a.z - b.z });
const addXZ = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: 0, z: a.z + b.z });
const scaleXZ = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: 0, z: a.z * s });
const lenXZ = (a: Vec3): number => Math.hypot(a.x, a.z);
const dotXZ = (a: Vec3, b: Vec3): number => a.x * b.x + a.z * b.z;
const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Unit vector in the XZ-plane; returns the zero vector for inputs near zero. */
function normalizeXZ(a: Vec3): Vec3 {
  const len = lenXZ(a);
  return len < EPS ? { x: 0, y: 0, z: 0 } : { x: a.x / len, y: 0, z: a.z / len };
}

/** Clamp a vector's XZ length to `max`. */
function clampLenXZ(a: Vec3, max: number): Vec3 {
  const len = lenXZ(a);
  return len > max && len > EPS ? scaleXZ(a, max / len) : { x: a.x, y: 0, z: a.z };
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function lerpXZ(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: 0, z: a.z + (b.z - a.z) * t };
}

/** Seek: desired velocity is full speed straight at the target. */
export function seek(pos: Vec3, target: Vec3, speed: number): Vec3 {
  return scaleXZ(normalizeXZ(subXZ(target, pos)), speed);
}

/**
 * Arrive: like {@link seek} but the desired speed ramps down linearly inside
 * `slowRadius`, so the agent brakes onto the target instead of overshooting.
 */
export function arrive(
  pos: Vec3,
  target: Vec3,
  speed: number,
  slowRadius: number,
): Vec3 {
  const offset = subXZ(target, pos);
  const dist = lenXZ(offset);
  if (dist < EPS) return { x: 0, y: 0, z: 0 };
  const desiredSpeed = dist < slowRadius ? (speed * dist) / slowRadius : speed;
  return scaleXZ(scaleXZ(offset, 1 / dist), desiredSpeed);
}

/**
 * Avoid: sum of outward pushes from every blocker whose (footprint + margin) the
 * agent is currently inside. Zero when the agent is clear of all blockers, so it
 * never fights the navmesh path in open space — it only kicks in near a wall.
 */
export function avoid(
  pos: Vec3,
  blockers: readonly NavBox[],
  speed: number,
  margin: number,
): Vec3 {
  let push: Vec3 = { x: 0, y: 0, z: 0 };
  for (const box of blockers) {
    if (!isInsideFootprintXZ(box, pos, margin)) continue;
    const away = normalizeXZ(subXZ(pos, box.center));
    // Degenerate case: agent exactly on the box center — push along +X arbitrarily.
    push = addXZ(push, lenXZ(away) < EPS ? { x: 1, y: 0, z: 0 } : away);
  }
  return scaleXZ(normalizeXZ(push), speed);
}

// --- The navmesh query the FSM depends on (structurally a `NavQuery`). ------------

/**
 * The slice of the navmesh foundation the guard needs. `NavQuery` from
 * `src/ai/navmesh.ts` (built by `buildHeadlessNav` in tests, or wrapped around a
 * live `RecastJSPlugin` in the sample) satisfies this structurally.
 */
export interface GuardNav {
  /** Snap a world point onto the navmesh. */
  closestPoint(p: Vec3): Vec3;
  /** Corridor path start -> end; empty if unreachable. */
  computePath(start: Vec3, end: Vec3): Vec3[];
  /** Blockers the navmesh was carved with (for LOS + avoidance). */
  readonly blockers: NavBox[];
}

// --- The four-state FSM. ----------------------------------------------------------

export type GuardStateName = "patrol" | "detect" | "chase" | "return";

/** Immutable guard snapshot; `stepGuard` returns a fresh one each tick. */
export interface GuardState {
  readonly name: GuardStateName;
  /** Agent position on the navmesh (XZ; y tracks the path/target y). */
  readonly pos: Vec3;
  /** Unit facing in XZ — drives the FOV cone. */
  readonly heading: Vec3;
  /** Current velocity in XZ. */
  readonly vel: Vec3;
  /** Index of the patrol point currently targeted. */
  readonly patrolIndex: number;
  /** Active navmesh path being followed (chase/return); empty otherwise. */
  readonly path: readonly Vec3[];
  /** Index of the waypoint in `path` currently steered toward. */
  readonly waypointIndex: number;
  /** State-local timer: sight-confirm in detect, lose-grace in chase, seconds. */
  readonly timer: number;
  /** Seconds since the last chase re-path query. */
  readonly repathTimer: number;
  /** Append-only log of states entered, oldest first — proof of transition order. */
  readonly transitions: readonly GuardStateName[];
}

/** Seed a guard at the first patrol point, facing +Z toward the next one. */
export function createGuardState(
  patrol: readonly Vec3[] = PATROL_POINTS,
): GuardState {
  const start = patrol[0] ?? { x: 0, y: 0, z: 0 };
  return {
    name: "patrol",
    pos: { ...start },
    heading: { x: 0, y: 0, z: 1 },
    vel: { x: 0, y: 0, z: 0 },
    patrolIndex: Math.min(1, patrol.length - 1),
    path: [],
    waypointIndex: 0,
    timer: 0,
    repathTimer: 0,
    transitions: ["patrol"],
  };
}

/** True when the player is within range, inside the view cone, and unoccluded. */
export function canSeePlayer(
  state: GuardState,
  player: Vec3,
  nav: GuardNav,
  config: GuardConfig,
): boolean {
  const offset = subXZ(player, state.pos);
  const dist = lenXZ(offset);
  if (dist > config.detectRadius) return false;
  if (dist < EPS) return true;
  const dir = scaleXZ(offset, 1 / dist);
  // Inside the FOV cone if the angle between heading and the player is <= half-FOV.
  if (dotXZ(state.heading, dir) < Math.cos(config.fovHalfRad)) return false;
  return losClear(state.pos, player, nav.blockers, config);
}

/** True when no blocker footprint intersects the segment from `a` to `b`. */
function losClear(
  a: Vec3,
  b: Vec3,
  blockers: readonly NavBox[],
  config: GuardConfig,
): boolean {
  const dist = distXZ(a, b);
  const steps = Math.max(1, Math.ceil(dist / config.losStep));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p: Vec3 = { x: a.x + (b.x - a.x) * t, y: 0, z: a.z + (b.z - a.z) * t };
    for (const box of blockers) {
      if (isInsideFootprintXZ(box, p, 0)) return false;
    }
  }
  return true;
}

/** Integrate one steering step toward `target`, returning new pos/vel/heading. */
function steerToward(
  state: GuardState,
  target: Vec3,
  desired: Vec3,
  nav: GuardNav,
  config: GuardConfig,
  dt: number,
): Pick<GuardState, "pos" | "vel" | "heading"> {
  const avoidance = scaleXZ(
    avoid(state.pos, nav.blockers, config.speed, config.avoidMargin),
    config.avoidWeight,
  );
  const desiredVel = clampLenXZ(addXZ(desired, avoidance), config.speed);
  // Steering = (desired - current) velocity, capped by the per-tick accel budget.
  const steer = clampLenXZ(subXZ(desiredVel, state.vel), config.maxAccel * dt);
  const vel = clampLenXZ(addXZ(state.vel, steer), config.speed);
  const pos: Vec3 = {
    x: state.pos.x + vel.x * dt,
    y: target.y,
    z: state.pos.z + vel.z * dt,
  };
  const heading = lenXZ(vel) > EPS ? normalizeXZ(vel) : state.heading;
  return { pos, vel, heading };
}

/** The current waypoint target along `path`, clamped to the last point. */
function waypointTarget(path: readonly Vec3[], index: number): Vec3 {
  return path[Math.min(index, path.length - 1)];
}

/**
 * Advance one FSM + steering tick. Pure: returns a brand-new {@link GuardState},
 * never mutates the input. `player` is the player's current world position; the
 * caller supplies it (scripted in tests, live in the sample).
 */
export function stepGuard(
  state: GuardState,
  nav: GuardNav,
  player: Vec3,
  dt: number,
  config: GuardConfig = DEFAULT_GUARD_CONFIG,
): GuardState {
  switch (state.name) {
    case "patrol":
      return stepPatrol(state, nav, player, dt, config);
    case "detect":
      return stepDetect(state, nav, player, dt, config);
    case "chase":
      return stepChase(state, nav, player, dt, config);
    case "return":
      return stepReturn(state, nav, player, dt, config);
  }
}

/** Transition helper: switch state name and append it to the log. */
function enter(
  state: GuardState,
  name: GuardStateName,
  patch: Partial<GuardState>,
): GuardState {
  return {
    ...state,
    ...patch,
    name,
    transitions: [...state.transitions, name],
  };
}

function stepPatrol(
  state: GuardState,
  nav: GuardNav,
  player: Vec3,
  dt: number,
  config: GuardConfig,
): GuardState {
  const target = PATROL_POINTS[state.patrolIndex] ?? state.pos;
  const desired = arrive(state.pos, target, config.speed, config.arriveRadius);
  const moved = steerToward(state, target, desired, nav, config, dt);
  let patrolIndex = state.patrolIndex;
  if (distXZ(moved.pos, target) <= config.waypointRadius) {
    patrolIndex = (state.patrolIndex + 1) % PATROL_POINTS.length;
  }
  const next: GuardState = { ...state, ...moved, patrolIndex };
  if (canSeePlayer(next, player, nav, config)) {
    return enter(next, "detect", { timer: 0, vel: { x: 0, y: 0, z: 0 } });
  }
  return next;
}

function stepDetect(
  state: GuardState,
  nav: GuardNav,
  player: Vec3,
  dt: number,
  config: GuardConfig,
): GuardState {
  // Turn to face the player and hold position while confirming the sighting.
  const heading = normalizeXZ(subXZ(player, state.pos));
  const facing: GuardState = {
    ...state,
    heading: lenXZ(heading) > EPS ? heading : state.heading,
    vel: { x: 0, y: 0, z: 0 },
  };
  if (!canSeePlayer(facing, player, nav, config)) {
    // Lost the player during confirmation — stand down to patrol.
    return enter(facing, "patrol", { timer: 0 });
  }
  const timer = state.timer + dt;
  if (timer >= config.detectConfirmS) {
    const path = queryPath(nav, facing.pos, player);
    return enter(facing, "chase", { timer: 0, repathTimer: 0, path, waypointIndex: 1 });
  }
  return { ...facing, timer };
}

function stepChase(
  state: GuardState,
  nav: GuardNav,
  player: Vec3,
  dt: number,
  config: GuardConfig,
): GuardState {
  // Re-path to the player's current position on an interval (alerted tracking).
  let path = state.path;
  let waypointIndex = state.waypointIndex;
  let repathTimer = state.repathTimer + dt;
  if (repathTimer >= config.repathS || path.length < 2) {
    path = queryPath(nav, state.pos, player);
    waypointIndex = 1;
    repathTimer = 0;
  }

  // Follow the navmesh waypoints with arrive steering; fall back to a direct seek
  // at the player if the navmesh returned no usable path.
  const target = path.length >= 2 ? waypointTarget(path, waypointIndex) : player;
  const desired = arrive(state.pos, target, config.speed, config.arriveRadius);
  const moved = steerToward(state, target, desired, nav, config, dt);
  if (
    path.length >= 2 &&
    waypointIndex < path.length - 1 &&
    distXZ(moved.pos, target) <= config.waypointRadius
  ) {
    waypointIndex += 1;
  }

  // Lose grace: the player must stay beyond loseRadius for loseGraceS to break off.
  const beyond = distXZ(moved.pos, player) > config.loseRadius;
  const timer = beyond ? state.timer + dt : 0;
  const next: GuardState = { ...state, ...moved, path, waypointIndex, repathTimer, timer };
  if (timer >= config.loseGraceS) {
    const home = nearestPatrol(next.pos);
    const homePath = queryPath(nav, next.pos, PATROL_POINTS[home]);
    return enter(next, "return", {
      timer: 0,
      repathTimer: 0,
      path: homePath,
      waypointIndex: 1,
      patrolIndex: home,
    });
  }
  return next;
}

function stepReturn(
  state: GuardState,
  nav: GuardNav,
  player: Vec3,
  dt: number,
  config: GuardConfig,
): GuardState {
  // A re-sighting while walking home re-alerts the guard.
  if (canSeePlayer(state, player, nav, config)) {
    return enter(state, "detect", { timer: 0, vel: { x: 0, y: 0, z: 0 } });
  }

  const home = PATROL_POINTS[state.patrolIndex] ?? state.pos;
  const usePath = state.path.length >= 2;
  const target = usePath ? waypointTarget(state.path, state.waypointIndex) : home;
  const desired = arrive(state.pos, target, config.speed, config.arriveRadius);
  const moved = steerToward(state, target, desired, nav, config, dt);

  let waypointIndex = state.waypointIndex;
  if (
    usePath &&
    waypointIndex < state.path.length - 1 &&
    distXZ(moved.pos, target) <= config.waypointRadius
  ) {
    waypointIndex += 1;
  }

  const next: GuardState = { ...state, ...moved, waypointIndex };
  // Home when the final waypoint (or the patrol point itself) is reached.
  const atHome =
    distXZ(moved.pos, home) <= config.arriveRadius ||
    (usePath && waypointIndex >= state.path.length - 1 &&
      distXZ(moved.pos, waypointTarget(state.path, waypointIndex)) <= config.waypointRadius);
  if (atHome) {
    return enter(next, "patrol", { timer: 0, path: [], waypointIndex: 0 });
  }
  return next;
}

/** Query a navmesh corridor from `from` to `to`, snapping both onto the mesh. */
function queryPath(nav: GuardNav, from: Vec3, to: Vec3): Vec3[] {
  return nav.computePath(nav.closestPoint(from), nav.closestPoint(to));
}

/** Index of the patrol point nearest `pos` (the natural place to resume). */
function nearestPatrol(pos: Vec3): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PATROL_POINTS.length; i++) {
    const d = distXZ(pos, PATROL_POINTS[i]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
