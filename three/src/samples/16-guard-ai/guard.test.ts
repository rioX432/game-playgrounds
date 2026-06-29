// Headless proof for sample 16 (guard-ai). Runs in the `node` vitest
// environment with NO GPU and NO window. It drives the pure guard FSM with a
// SCRIPTED player position sequence at a fixed timestep and asserts ROBUST
// properties only (design-ch4 §3 guard-ai row):
//
//   1. State transitions fire in the expected ORDER: patrol → detect → chase →
//      return (… → patrol). Vacuity guard: chase must be observed for several
//      ticks and the active chase path must be non-empty.
//   2. The chase path WAYPOINT INDEX advances (the guard makes corridor progress
//      around the pillar). We assert the monotonic corner counter increased
//      during chase — NOT a monotonic distance decrease (broken by the detour),
//      and NOT an exact path point sequence (drifts with Recast).
//   3. The return phase actually brings the guard HOME: the final distance to
//      home when it resumes patrol is below the arrive threshold.

import { beforeAll, describe, expect, it } from "vitest";
import { initNavmesh, type Vec3 } from "../../ai/navmesh";
import { DEFAULT_GUARD_CONFIG, GuardSim, type GuardState } from "./guard";

const DT = 1 / 60; // fixed simulation step (s)
const MAX_TICKS = 1500; // hard cap (~25 s) so a stuck run can never hang
const FINAL_HOME_DISTANCE = 1.0; // m; > arriveRadius (0.6) for voxel-quantization slack
const MIN_CHASE_TICKS = 10; // vacuity guard: chase must really happen

// Scripted player path (XZ). The phases are timed to walk the guard through the
// full FSM cycle deterministically:
//   • [0, 60)    far corner            → guard keeps patrolling
//   • [60, 120)  beside the patrol route → seen → detect → chase
//   • [120, 360) opposite side of pillar → chase routes AROUND the pillar
//   • [360, …)   far away               → lost → return home → patrol
function scriptedPlayer(tick: number): Vec3 {
  if (tick < 60) return { x: 8, y: 0, z: 8 };
  if (tick < 120) return { x: -4, y: 0, z: 0 };
  if (tick < 360) return { x: 4, y: 0, z: 0 };
  return { x: 12, y: 0, z: 12 };
}

interface RunResult {
  /** Distinct consecutive states in the order they first occurred. */
  stateRuns: GuardState[];
  /** Per-tick state log. */
  states: GuardState[];
  chaseTicks: number;
  /** cornersAdvanced delta accumulated while in the chase state. */
  chaseCornerAdvance: number;
  /** Max active-path length seen during chase (vacuity guard). */
  maxChasePathLength: number;
  /** True once a return → patrol transition was observed. */
  returnedHome: boolean;
  /** distanceToHome captured at the return → patrol transition. */
  finalHomeDistance: number;
}

function runScenario(): { sim: GuardSim; result: RunResult } {
  const sim = GuardSim.create(DEFAULT_GUARD_CONFIG);
  const states: GuardState[] = [];
  const stateRuns: GuardState[] = [];
  let chaseTicks = 0;
  let maxChasePathLength = 0;
  let chaseStartCorners = -1;
  let chaseLastCorners = 0;
  let returnedHome = false;
  let finalHomeDistance = Number.POSITIVE_INFINITY;
  let prev: GuardState | null = null;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    const player = scriptedPlayer(tick);
    sim.tick(DT, player);
    const snap = sim.snapshot(player);
    states.push(snap.state);
    if (snap.state !== prev) {
      stateRuns.push(snap.state);
      if (prev === "return" && snap.state === "patrol") {
        returnedHome = true;
        finalHomeDistance = snap.distanceToHome;
        prev = snap.state;
        break; // stop the moment the guard is home and resumes patrol
      }
    }
    if (snap.state === "chase") {
      chaseTicks++;
      if (chaseStartCorners < 0) chaseStartCorners = snap.cornersAdvanced;
      chaseLastCorners = snap.cornersAdvanced;
      maxChasePathLength = Math.max(maxChasePathLength, snap.pathLength);
    }
    prev = snap.state;
  }

  const chaseCornerAdvance =
    chaseStartCorners < 0 ? 0 : chaseLastCorners - chaseStartCorners;
  return {
    sim,
    result: {
      stateRuns,
      states,
      chaseTicks,
      chaseCornerAdvance,
      maxChasePathLength,
      returnedHome,
      finalHomeDistance,
    },
  };
}

/** Index of `state`'s first occurrence in the distinct-runs list (-1 if absent). */
function firstRunIndex(runs: GuardState[], state: GuardState): number {
  return runs.indexOf(state);
}

describe("guard-ai: scripted FSM run", () => {
  let sim: GuardSim | undefined;
  let result: RunResult;

  beforeAll(async () => {
    await initNavmesh();
    const run = runScenario();
    sim = run.sim;
    result = run.result;
  });

  it("starts patrolling", () => {
    expect(result.states[0]).toBe("patrol");
  });

  it("fires transitions in the order patrol → detect → chase → return", () => {
    const p = firstRunIndex(result.stateRuns, "patrol");
    const d = firstRunIndex(result.stateRuns, "detect");
    const c = firstRunIndex(result.stateRuns, "chase");
    const r = firstRunIndex(result.stateRuns, "return");
    expect(p).toBe(0);
    expect(d).toBeGreaterThan(p);
    expect(c).toBeGreaterThan(d);
    expect(r).toBeGreaterThan(c);
  });

  it("actually spends time chasing (not a vacuous transition)", () => {
    expect(result.chaseTicks).toBeGreaterThan(MIN_CHASE_TICKS);
    // The chase path routed around the pillar → a real (non-empty) corridor.
    expect(result.maxChasePathLength).toBeGreaterThanOrEqual(2);
  });

  it("advances the chase path waypoint index (corridor progress)", () => {
    // Robust property: the monotonic corner counter increased while chasing.
    // NOT asserted: monotonic distance decrease (the detour breaks it).
    expect(result.chaseCornerAdvance).toBeGreaterThanOrEqual(1);
  });

  it("returns home and resumes patrol within the final distance threshold", () => {
    expect(result.returnedHome).toBe(true);
    expect(result.finalHomeDistance).toBeLessThan(FINAL_HOME_DISTANCE);
    // Free the navmesh exactly once, at the end of the suite.
    sim?.destroy();
    sim = undefined;
  });
});
