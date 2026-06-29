// Pure, render-independent guard NPC: a hand-rolled finite-state machine
// (patrol → detect → chase → return) that integrates the Ch4 navmesh foundation
// (#194) for chase/return routing and the hand-rolled steering primitives
// (./steering) for patrol movement. No three.js / DOM imports — the same logic
// drives the GPU visualization (index.ts mount) and the headless proof
// (guard.test.ts). It owns one native (WASM) navmesh; free it with destroy().
//
// Movement split (deliberate, documented):
//   • patrol / return-to-patrol uses hand-rolled steering (arrive + avoid).
//   • chase / return-home FOLLOW a navmesh path (the path itself is the global
//     obstacle avoidance, so straight corner-following is enough). This exercises
//     BOTH the steering primitives and the #197 path-following integration.
//
// Determinism: there is no RNG and no wall-clock — given a fixed dt and a fixed
// scripted player sequence the simulation is fully reproducible (the "seed-fixed"
// requirement is met by construction). The only non-bit-exact input is Recast's
// navmesh build, so the tests assert ROBUST properties (transition order /
// waypoint advance / final distance), never an exact path point sequence.

import {
  type AabbXZ,
  type ObstacleCourse,
  type Vec3,
  Navmesh,
  buildObstacleCourse,
  generateNavmesh,
} from "../../ai/navmesh";
import { arrive, avoid, clampSpeed, distanceXZ } from "./steering";

/** The four guard behaviours, in their canonical transition order. */
export type GuardState = "patrol" | "detect" | "chase" | "return";

/** Tunable guard parameters (all world units / seconds). */
export interface GuardConfig {
  /** Movement speed, m/s, shared by steering and path-following. */
  maxSpeed: number;
  /** Player within this XZ range (m) is "seen" → patrol enters detect. */
  sightRadius: number;
  /** Player beyond this XZ range (m) during chase starts the give-up timer. */
  loseRadius: number;
  /** Continuous-sight time (s) in detect before committing to chase. */
  detectDuration: number;
  /** Time (s) the player must stay beyond loseRadius before the guard returns. */
  loseDuration: number;
  /** Slow-down + "reached" radius (m) for patrol waypoints and home. */
  arriveRadius: number;
  /** Distance (m) at which a navmesh path corner counts as reached. */
  cornerEps: number;
  /** Obstacle-avoidance influence radius (m) for steering. */
  avoidRadius: number;
  /** Player must move this far (m) since the last chase query to re-path. */
  repathMove: number;
  /** Safety cap (s): re-path at least this often while chasing. */
  maxRepathInterval: number;
}

/** Defaults tuned for the 20×20 m pillar course from the navmesh foundation. */
export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  maxSpeed: 3.5,
  sightRadius: 6,
  loseRadius: 12,
  detectDuration: 0.4,
  loseDuration: 1.0,
  arriveRadius: 0.6,
  cornerEps: 0.25,
  avoidRadius: 1.2,
  repathMove: 1.5,
  maxRepathInterval: 1.0,
};

// Patrol loop: two waypoints on the −X side of the arena, clear of the central
// pillar (footprint x[−2.5,2.5] z[−2.5,2.5]). The guard oscillates between them;
// the first is also "home" (the return target).
const PATROL_WAYPOINTS: readonly Vec3[] = [
  { x: -7, y: 0, z: -3 },
  { x: -7, y: 0, z: 3 },
];

/** An immutable read of the guard's state for tests and visualization. */
export interface GuardSnapshot {
  state: GuardState;
  /** Guard position (XZ; y is 0). */
  pos: Vec3;
  /** Planar distance to the player as of the last tick. */
  distanceToPlayer: number;
  /** Planar distance to the home (return) point. */
  distanceToHome: number;
  /** Corners in the active chase/return path (0 while patrolling/detecting). */
  pathLength: number;
  /** Index of the next unreached corner of the active path. */
  pathCornerIndex: number;
  /** Monotonic count of path corners reached — never reset on re-path. */
  cornersAdvanced: number;
}

/**
 * Stateful guard simulation over the fixed pillar course. {@link initNavmesh}
 * (from the navmesh foundation) MUST have resolved before {@link create}. Call
 * {@link tick} once per fixed step with the current player position; read state
 * via {@link snapshot} or the getters. Owns one navmesh — call {@link destroy}
 * exactly once when done.
 */
export class GuardSim {
  /** Base course (ground + central pillar) shared with sample 14. */
  readonly course: ObstacleCourse;
  /** Patrol waypoints (the guard loops through these). */
  readonly patrolWaypoints: readonly Vec3[];
  /** Return target — where the guard heads after losing the player. */
  readonly home: Vec3;

  private readonly cfg: GuardConfig;
  private readonly nav: Navmesh;
  private readonly obstacles: readonly AabbXZ[];

  private _state: GuardState = "patrol";
  private pos: Vec3;
  private patrolIndex = 0;

  // Active navmesh path (chase / return) and its progress.
  private path: Vec3[] = [];
  private cornerIndex = 0;
  private cornersAdvanced = 0;

  // Chase re-path bookkeeping.
  private repathTimer = 0;
  private lastPathPlayer: Vec3 | null = null;

  // Detect / lose timers and last seen player (for snapshot distance).
  private detectTimer = 0;
  private loseTimer = 0;
  private lastPlayer: Vec3;

  private constructor(course: ObstacleCourse, nav: Navmesh, cfg: GuardConfig) {
    this.course = course;
    this.cfg = cfg;
    this.nav = nav;
    this.obstacles = [course.obstacle];
    this.patrolWaypoints = PATROL_WAYPOINTS.map((w) => ({ ...w }));
    this.home = { ...PATROL_WAYPOINTS[0] };
    this.pos = { ...this.home };
    this.lastPlayer = { ...this.pos };
  }

  /** Build the navmesh and return a fresh guard in the `patrol` state. */
  static create(cfg: GuardConfig = DEFAULT_GUARD_CONFIG): GuardSim {
    const course = buildObstacleCourse();
    const result = generateNavmesh(course.mesh);
    if (!result.success) {
      throw new Error(`guard navmesh build failed: ${result.error}`);
    }
    return new GuardSim(course, result.navmesh, cfg);
  }

  get state(): GuardState {
    return this._state;
  }

  /**
   * The (static) navmesh, for the debug overlay only. The visualization MUST NOT
   * call its destroy() — {@link GuardSim.destroy} owns its lifetime.
   */
  get navmesh(): Navmesh {
    return this.nav;
  }

  /** Current guard position (defensive copy). */
  get position(): Vec3 {
    return { ...this.pos };
  }

  /** The active chase/return path corners (defensive copy). */
  get activePath(): Vec3[] {
    return this.path.map((p) => ({ ...p }));
  }

  /** Advance the simulation one fixed step with the current player position. */
  tick(dt: number, playerPos: Vec3): void {
    const player: Vec3 = { x: playerPos.x, y: 0, z: playerPos.z };
    const dToPlayer = distanceXZ(this.pos, player);

    switch (this._state) {
      case "patrol":
        this.stepPatrol(dt);
        if (dToPlayer <= this.cfg.sightRadius) {
          this._state = "detect";
          this.detectTimer = 0;
        }
        break;

      case "detect":
        // Acquiring the target: hold position (zero-velocity), then commit.
        this.detectTimer += dt;
        if (dToPlayer > this.cfg.sightRadius) {
          this.beginReturn(); // lost sight before committing → go home
        } else if (this.detectTimer >= this.cfg.detectDuration) {
          this._state = "chase";
          this.loseTimer = 0;
          this.beginChase(player);
        }
        break;

      case "chase":
        this.updateChasePath(dt, player);
        this.followPath(dt);
        if (dToPlayer > this.cfg.loseRadius) {
          this.loseTimer += dt;
          if (this.loseTimer >= this.cfg.loseDuration) this.beginReturn();
        } else {
          this.loseTimer = 0;
        }
        break;

      case "return": {
        const reachedEnd = this.followPath(dt);
        if (dToPlayer <= this.cfg.sightRadius) {
          // Player wandered back into view — re-engage.
          this._state = "detect";
          this.detectTimer = 0;
        } else if (
          reachedEnd ||
          distanceXZ(this.pos, this.home) <= this.cfg.arriveRadius
        ) {
          this._state = "patrol";
          this.patrolIndex = this.nearestPatrolIndex();
          this.path = [];
          this.cornerIndex = 0;
        }
        break;
      }
    }

    this.lastPlayer = player;
  }

  /** Immutable read of the current state (for tests / visualization). */
  snapshot(playerPos?: Vec3): GuardSnapshot {
    const player = playerPos
      ? { x: playerPos.x, y: 0, z: playerPos.z }
      : this.lastPlayer;
    return {
      state: this._state,
      pos: { ...this.pos },
      distanceToPlayer: distanceXZ(this.pos, player),
      distanceToHome: distanceXZ(this.pos, this.home),
      pathLength: this.path.length,
      pathCornerIndex: this.cornerIndex,
      cornersAdvanced: this.cornersAdvanced,
    };
  }

  /** Free the underlying navmesh's native (WASM) memory. Call exactly once. */
  destroy(): void {
    this.nav.destroy();
  }

  // --- internals ---------------------------------------------------------

  /** Steer toward the current patrol waypoint, looping when one is reached. */
  private stepPatrol(dt: number): void {
    const target = this.patrolWaypoints[this.patrolIndex];
    if (distanceXZ(this.pos, target) <= this.cfg.arriveRadius) {
      this.patrolIndex = (this.patrolIndex + 1) % this.patrolWaypoints.length;
    }
    this.stepSteer(dt, this.patrolWaypoints[this.patrolIndex]);
  }

  /** Kinematic steering toward `target`: arrive easing + obstacle avoidance. */
  private stepSteer(dt: number, target: Vec3): void {
    const desired = arrive(
      this.pos,
      target,
      this.cfg.maxSpeed,
      this.cfg.arriveRadius * 2,
    );
    const away = avoid(
      this.pos,
      this.obstacles,
      this.cfg.avoidRadius,
      this.cfg.maxSpeed,
    );
    const vel = clampSpeed(
      { x: desired.x + away.x, y: 0, z: desired.z + away.z },
      this.cfg.maxSpeed,
    );
    this.pos = {
      x: this.pos.x + vel.x * dt,
      y: 0,
      z: this.pos.z + vel.z * dt,
    };
  }

  /** Snap a world point onto the navmesh, falling back to the raw point. */
  private snap(p: Vec3): Vec3 {
    return (
      this.nav.closestPoint({ x: p.x, y: 0, z: p.z }) ?? {
        x: p.x,
        y: 0,
        z: p.z,
      }
    );
  }

  /**
   * Install a new active path, dropping any leading corner that coincides with
   * the current position (computePath returns the start point as points[0]), so
   * {@link cornersAdvanced} only counts genuine forward progress.
   */
  private setPath(points: Vec3[]): void {
    let start = 0;
    while (
      start < points.length &&
      distanceXZ(this.pos, points[start]) <= this.cfg.cornerEps
    ) {
      start++;
    }
    this.path = points.slice(start);
    this.cornerIndex = 0;
  }

  /** Begin chasing: query a navmesh path from the guard to the player. */
  private beginChase(player: Vec3): void {
    this.repathTimer = 0;
    this.lastPathPlayer = { ...player };
    const path = this.nav.findPath(this.snap(this.pos), this.snap(player));
    this.setPath(path.success ? path.points : []);
  }

  /** Re-query the chase path when the player moved enough / the cap elapsed. */
  private updateChasePath(dt: number, player: Vec3): void {
    this.repathTimer += dt;
    const moved = this.lastPathPlayer
      ? distanceXZ(player, this.lastPathPlayer)
      : Number.POSITIVE_INFINITY;
    const exhausted = this.cornerIndex >= this.path.length;
    if (
      moved > this.cfg.repathMove ||
      this.repathTimer >= this.cfg.maxRepathInterval ||
      exhausted
    ) {
      const path = this.nav.findPath(this.snap(this.pos), this.snap(player));
      if (path.success && path.points.length > 0) {
        this.setPath(path.points);
        this.repathTimer = 0;
        this.lastPathPlayer = { ...player };
      }
    }
  }

  /** Begin returning home: query a navmesh path from the guard to home. */
  private beginReturn(): void {
    this._state = "return";
    const path = this.nav.findPath(this.snap(this.pos), this.snap(this.home));
    this.setPath(path.success ? path.points : [{ ...this.home }]);
  }

  /**
   * Advance along the active path up to `maxSpeed * dt`, counting each corner
   * reached. Returns true once the final corner has been consumed.
   */
  private followPath(dt: number): boolean {
    if (this.cornerIndex >= this.path.length) return true;
    let budget = this.cfg.maxSpeed * dt;
    while (budget > 0 && this.cornerIndex < this.path.length) {
      const target = this.path[this.cornerIndex];
      const dx = target.x - this.pos.x;
      const dz = target.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= this.cfg.cornerEps) {
        this.cornerIndex++;
        this.cornersAdvanced++;
        continue;
      }
      const step = Math.min(budget, dist);
      this.pos = {
        x: this.pos.x + (dx / dist) * step,
        y: 0,
        z: this.pos.z + (dz / dist) * step,
      };
      budget -= step;
      if (step >= dist) {
        this.cornerIndex++;
        this.cornersAdvanced++;
      }
    }
    return this.cornerIndex >= this.path.length;
  }

  /** Index of the patrol waypoint nearest the guard (resume point). */
  private nearestPatrolIndex(): number {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    this.patrolWaypoints.forEach((w, i) => {
      const d = distanceXZ(this.pos, w);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }
}
