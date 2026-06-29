// Headless proof for sample 14 (navmesh-pathfind). Runs in the `node` vitest
// environment with NO GPU and NO window. It asserts ROBUST properties of the
// dynamic-obstacle re-path — never an exact path point sequence (that drifts
// with WASM init / Recast params / float rounding; see design-ch4 §3.1):
//
//   1. The base A->B path reaches the goal and avoids the central pillar.
//   2. The base path INTRUDES the dynamic obstacle footprint — i.e. the obstacle
//      genuinely lies on the initial corridor, so a re-path is really required.
//   3. After dropObstacle(), the re-path still reaches the goal and avoids BOTH
//      the pillar and the new obstacle (this is the core mechanic).
//   4. The re-bake is DETERMINISTIC across fresh scenarios (finding: dynamic
//      re-bake was flagged as an untested risk by the foundation).

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  initNavmesh,
  pathEndDistanceXZ,
  pathIntrudesAabbXZ,
} from "../../ai/navmesh";
import { PathfindScenario } from "./pathfind";

// Goal-reached threshold: one path corner must land within this XZ distance of
// the goal. Generous vs. cs/ch (0.2 m) to stay robust to voxel quantization.
const GOAL_REACHED_DISTANCE = 0.5; // m

// The path may graze an obstacle border by up to the agent radius
// (walkableRadiusVx * cs = 1 * 0.2 m); intrusion is checked with that inset so a
// legitimate wall-hug is not flagged, but cutting through is.
const OBSTACLE_INTRUSION_MARGIN = 0.2; // m

// Number of independent fresh re-bakes to compare for determinism.
const DETERMINISM_RUNS = 3;

describe("navmesh-pathfind: dynamic-obstacle re-path", () => {
  let scenario: PathfindScenario | undefined;

  beforeAll(async () => {
    await initNavmesh();
  });

  afterEach(() => {
    // Null out after freeing: Navmesh.destroy() has no double-free guard, and a
    // later test that does not reassign `scenario` would otherwise re-destroy it.
    scenario?.destroy();
    scenario = undefined;
  });

  it("base path reaches the goal and avoids the central pillar", () => {
    scenario = PathfindScenario.create();
    const path = scenario.findPath();
    expect(path.success).toBe(true);
    expect(pathEndDistanceXZ(path.points, scenario.course.goal)).toBeLessThan(
      GOAL_REACHED_DISTANCE,
    );
    expect(
      pathIntrudesAabbXZ(
        path.points,
        scenario.course.obstacle,
        OBSTACLE_INTRUSION_MARGIN,
      ),
    ).toBe(false);
  });

  it("base path crosses the dynamic obstacle footprint (so a re-path is needed)", () => {
    // A path corner falling inside the (not-yet-baked) dynamic footprint proves
    // the obstacle actually invalidates the initial corridor — otherwise the
    // re-path test below would be vacuous.
    scenario = PathfindScenario.create();
    const path = scenario.findPath();
    expect(pathIntrudesAabbXZ(path.points, scenario.dynamicObstacle)).toBe(true);
  });

  it("re-path after dropObstacle avoids BOTH the pillar and the new obstacle", () => {
    scenario = PathfindScenario.create();
    expect(scenario.phase).toBe("initial");

    scenario.dropObstacle();
    expect(scenario.phase).toBe("blocked");

    const repath = scenario.findPath();
    expect(repath.success).toBe(true);
    // Still reaches the goal.
    expect(pathEndDistanceXZ(repath.points, scenario.course.goal)).toBeLessThan(
      GOAL_REACHED_DISTANCE,
    );
    // Avoids the original pillar.
    expect(
      pathIntrudesAabbXZ(
        repath.points,
        scenario.course.obstacle,
        OBSTACLE_INTRUSION_MARGIN,
      ),
    ).toBe(false);
    // Avoids the newly-dropped obstacle (the core re-path property).
    expect(
      pathIntrudesAabbXZ(
        repath.points,
        scenario.dynamicObstacle,
        OBSTACLE_INTRUSION_MARGIN,
      ),
    ).toBe(false);
    // A real detour, not a trivial two-point straight line.
    expect(repath.points.length).toBeGreaterThanOrEqual(3);
  });

  it("dropObstacle is idempotent (second call is a no-op)", () => {
    scenario = PathfindScenario.create();
    scenario.dropObstacle();
    const first = scenario.findPath();
    scenario.dropObstacle(); // no-op; must not re-bake or throw
    const second = scenario.findPath();
    expect(scenario.phase).toBe("blocked");
    expect(second.points.length).toBe(first.points.length);
  });

  it("re-bake is deterministic: independent runs avoid the obstacle identically", () => {
    // The foundation flagged dynamic re-bake determinism as an untested risk.
    // We assert the ROBUST invariant (every fresh re-bake reaches the goal and
    // avoids the new obstacle) rather than exact point equality. The point count
    // is additionally captured to surface any run-to-run drift.
    const counts: number[] = [];
    for (let run = 0; run < DETERMINISM_RUNS; run++) {
      const s = PathfindScenario.create();
      try {
        s.dropObstacle();
        const repath = s.findPath();
        expect(repath.success).toBe(true);
        expect(
          pathEndDistanceXZ(repath.points, s.course.goal),
        ).toBeLessThan(GOAL_REACHED_DISTANCE);
        expect(
          pathIntrudesAabbXZ(
            repath.points,
            s.dynamicObstacle,
            OBSTACLE_INTRUSION_MARGIN,
          ),
        ).toBe(false);
        counts.push(repath.points.length);
      } finally {
        s.destroy();
      }
    }
    // Observed deterministic in headless node; assert the robust invariant that
    // every run produced the same corner count.
    expect(new Set(counts).size).toBe(1);
  });
});
