// Headless proof for guard-ai (Ch4 #201). Runs under vitest's `node` environment
// with no DOM/GPU: the shared foundation's `buildHeadlessNav` spins up a private
// NullEngine, Babylon's `RecastJSPlugin` builds the navmesh, and the pure FSM core
// (`guard.ts`) drives an agent against a SCRIPTED player position sequence.
//
// Per the Ch4 design, navmesh paths are float-sensitive, so these asserts test
// ROBUST properties — the FSM transitions fire in the expected ORDER, a chase path
// waypoint index ADVANCES, and the guard CLOSES to within a catch distance — and
// deliberately NOT monotonic distance decrease nor exact path point-sequence
// equality. Every check is guarded against a vacuous pass (non-empty chase path
// before asserting on it; transitions actually observed, not an empty log).

import { describe, expect, it } from "vitest";
import { buildHeadlessNav, type Vec3 } from "../../ai/navmesh";
import {
  arrive,
  avoid,
  canSeePlayer,
  createGuardState,
  DEFAULT_GUARD_CONFIG,
  GUARD_SPEC,
  PHASE_S,
  PLAYER_DETECT,
  PLAYER_FAR,
  playerAnchorAt,
  seek,
  stepGuard,
  WALL,
  type GuardState,
  type GuardStateName,
} from "./guard";

const FOLLOW_DT = 1 / 60;
/** Within this distance the guard is deemed to have caught the player. */
const CATCH_THRESHOLD = 2.0;

const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** True if `seq` appears as an ordered (not necessarily contiguous) subsequence. */
function isOrderedSubsequence(
  log: readonly GuardStateName[],
  seq: readonly GuardStateName[],
): boolean {
  let i = 0;
  for (const name of log) {
    if (name === seq[i]) i++;
    if (i === seq.length) return true;
  }
  return i === seq.length;
}

interface SimResult {
  final: GuardState;
  /** Min guard->player distance observed while in the chase state. */
  minChaseDist: number;
  /** Smallest waypoint index observed during chase (non-vacuous baseline). */
  minChaseWaypoint: number;
  /** Largest waypoint index observed during chase. */
  maxChaseWaypoint: number;
  /** Longest chase path length observed (>= 2 proves a real path existed). */
  maxChasePathLen: number;
}

/** Run the scripted scenario to completion and collect robust observations. */
async function runScriptedSim(): Promise<SimResult> {
  const nav = await buildHeadlessNav(GUARD_SPEC);
  try {
    let state = createGuardState();
    const total = PHASE_S.far + PHASE_S.detect + PHASE_S.chase + PHASE_S.escape;
    const steps = Math.ceil(total / FOLLOW_DT);

    let minChaseDist = Infinity;
    let minChaseWaypoint = Infinity;
    let maxChaseWaypoint = -Infinity;
    let maxChasePathLen = 0;

    for (let i = 0; i < steps; i++) {
      const t = i * FOLLOW_DT;
      const player = playerAnchorAt(t);
      state = stepGuard(state, nav, player, FOLLOW_DT);
      if (state.name === "chase") {
        minChaseDist = Math.min(minChaseDist, distXZ(state.pos, player));
        minChaseWaypoint = Math.min(minChaseWaypoint, state.waypointIndex);
        maxChaseWaypoint = Math.max(maxChaseWaypoint, state.waypointIndex);
        maxChasePathLen = Math.max(maxChasePathLen, state.path.length);
      }
    }
    return {
      final: state,
      minChaseDist,
      minChaseWaypoint,
      maxChaseWaypoint,
      maxChasePathLen,
    };
  } finally {
    nav.dispose();
  }
}

describe("guard-ai steering primitives", () => {
  it("seek points a full-speed velocity straight at the target", () => {
    const v = seek({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 }, 10);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(10, 6);
    // Direction matches the unit target direction (3,4)/5.
    expect(v.x).toBeCloseTo(6, 6);
    expect(v.z).toBeCloseTo(8, 6);
  });

  it("arrive brakes inside the slow radius and is zero on the target", () => {
    const speed = 10;
    const slow = 4;
    const far = arrive({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, speed, slow);
    expect(Math.hypot(far.x, far.z)).toBeCloseTo(speed, 6); // full speed when far
    const near = arrive({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, speed, slow);
    expect(Math.hypot(near.x, near.z)).toBeCloseTo((speed * 2) / slow, 6); // ramped
    const on = arrive({ x: 5, y: 0, z: 5 }, { x: 5, y: 0, z: 5 }, speed, slow);
    expect(Math.hypot(on.x, on.z)).toBe(0); // no desire on the target
  });

  it("avoid pushes away from an overlapped blocker and is zero when clear", () => {
    // Standing left of the wall center, inside footprint+margin -> pushed -X.
    const inside = avoid({ x: -0.5, y: 0, z: 0 }, [WALL], 10, 0.6);
    expect(inside.x).toBeLessThan(0);
    expect(Math.hypot(inside.x, inside.z)).toBeCloseTo(10, 6);
    // Far from the wall -> no push at all.
    const clear = avoid({ x: -8, y: 0, z: 0 }, [WALL], 10, 0.6);
    expect(Math.hypot(clear.x, clear.z)).toBe(0);
  });
});

describe("guard-ai FSM", () => {
  it("does not see the player when out of range", async () => {
    const nav = await buildHeadlessNav(GUARD_SPEC);
    try {
      const state = createGuardState();
      expect(canSeePlayer(state, PLAYER_FAR, nav, DEFAULT_GUARD_CONFIG)).toBe(false);
      // ...but does see a player straight ahead, in range, with open LOS.
      expect(canSeePlayer(state, PLAYER_DETECT, nav, DEFAULT_GUARD_CONFIG)).toBe(true);
    } finally {
      nav.dispose();
    }
  });

  it("fires patrol -> detect -> chase -> return in order under the scripted player", async () => {
    const sim = await runScriptedSim();
    const log = sim.final.transitions;

    // Non-vacuous: the guard actually changed state several times.
    expect(log.length).toBeGreaterThanOrEqual(4);
    expect(log[0]).toBe("patrol");
    expect(
      isOrderedSubsequence(log, ["patrol", "detect", "chase", "return"]),
    ).toBe(true);
  });

  it("advances a real navmesh waypoint index while chasing", async () => {
    const sim = await runScriptedSim();
    // Non-vacuous: a real (>=2 point) chase path existed...
    expect(sim.maxChasePathLen).toBeGreaterThanOrEqual(2);
    // ...and the followed waypoint index strictly advanced during the chase.
    expect(sim.maxChaseWaypoint).toBeGreaterThan(sim.minChaseWaypoint);
    expect(sim.maxChaseWaypoint).toBeGreaterThanOrEqual(2);
  });

  it("closes to within the catch distance of the player during chase", async () => {
    const sim = await runScriptedSim();
    // Robust property (NOT monotonic decrease): at some chase tick the guard got
    // close to the player.
    expect(sim.minChaseDist).toBeLessThan(CATCH_THRESHOLD);
  });
});
