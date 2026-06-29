// Hand-rolled steering primitives (seek / arrive / avoid). Pure and
// render-independent (no three.js / DOM): the same code drives the GPU
// visualization and the headless test. The Ch4 design deliberately keeps
// steering hand-rolled — NOT a crowd / steering library — so the three engines
// are compared on an identical algorithm rather than on differing middleware
// (design-ch4 §4, §5: "hand-rolled steering, crowd is a finding note only").
//
// Model: KINEMATIC steering. Each function returns a DESIRED VELOCITY in the XZ
// plane (y is always 0). A caller sums the contributions, clamps the result to
// the agent's max speed, and integrates position directly (no mass / no
// acceleration). This is simpler and fully deterministic — the honest trade-off
// is that motion has no inertia (documented in the sample README).

import type { AabbXZ, Vec3 } from "../../ai/navmesh";

// Below this magnitude a vector is treated as zero (avoids divide-by-zero when
// the agent sits exactly on its target / on an obstacle border).
const ZERO_EPS = 1e-9;

/** Planar (XZ) distance between two points. */
export function distanceXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Steer straight toward `target` at the full `maxSpeed` (XZ plane). Returns a
 * zero vector when already on the target.
 */
export function seek(pos: Vec3, target: Vec3, maxSpeed: number): Vec3 {
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const d = Math.hypot(dx, dz);
  if (d < ZERO_EPS) return { x: 0, y: 0, z: 0 };
  return { x: (dx / d) * maxSpeed, y: 0, z: (dz / d) * maxSpeed };
}

/**
 * Like {@link seek} but ramps the speed down linearly once within `slowRadius`,
 * so the agent eases onto the target instead of overshooting it. Outside
 * `slowRadius` it is identical to {@link seek}.
 */
export function arrive(
  pos: Vec3,
  target: Vec3,
  maxSpeed: number,
  slowRadius: number,
): Vec3 {
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const d = Math.hypot(dx, dz);
  if (d < ZERO_EPS) return { x: 0, y: 0, z: 0 };
  const speed =
    slowRadius > 0 && d < slowRadius ? maxSpeed * (d / slowRadius) : maxSpeed;
  return { x: (dx / d) * speed, y: 0, z: (dz / d) * speed };
}

/**
 * Repulsion velocity away from any obstacle whose nearest border lies within
 * `radius` of `pos`. Hand-rolled local avoidance: it keeps the agent from
 * clipping a wall when seeking a waypoint whose straight line grazes it. The
 * push direction is from the obstacle's closest XZ point toward the agent, and
 * its strength grows linearly from 0 (at `radius`) to `maxSpeed` (at contact).
 * Contributions from multiple obstacles are summed, then re-scaled to at most
 * `maxSpeed`. Returns zero when nothing is close enough.
 */
export function avoid(
  pos: Vec3,
  obstacles: readonly AabbXZ[],
  radius: number,
  maxSpeed: number,
): Vec3 {
  let ax = 0;
  let az = 0;
  for (const o of obstacles) {
    // Closest point of the AABB to the agent, on the XZ plane.
    const cx = clamp(pos.x, o.minX, o.maxX);
    const cz = clamp(pos.z, o.minZ, o.maxZ);
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d = Math.hypot(dx, dz);
    if (d < radius && d > ZERO_EPS) {
      const strength = (radius - d) / radius; // 1 at contact → 0 at radius
      ax += (dx / d) * strength;
      az += (dz / d) * strength;
    }
    // d ≈ 0 (agent on the border / inside) gives no direction; the navmesh keeps
    // the agent out of solids, so this soft nudge can safely skip that case.
  }
  const m = Math.hypot(ax, az);
  if (m < ZERO_EPS) return { x: 0, y: 0, z: 0 };
  return { x: (ax / m) * maxSpeed, y: 0, z: (az / m) * maxSpeed };
}

/** Clamp a velocity's XZ magnitude to at most `maxSpeed`, preserving direction. */
export function clampSpeed(v: Vec3, maxSpeed: number): Vec3 {
  const s = Math.hypot(v.x, v.z);
  if (s <= maxSpeed || s < ZERO_EPS) return { x: v.x, y: 0, z: v.z };
  return { x: (v.x / s) * maxSpeed, y: 0, z: (v.z / s) * maxSpeed };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
