// Headless unit tests for the hand-rolled steering primitives. Pure math, no
// GPU / WASM — runs in the `node` vitest environment. AAA pattern.

import { describe, expect, it } from "vitest";
import type { AabbXZ, Vec3 } from "../../ai/navmesh";
import { arrive, avoid, clampSpeed, distanceXZ, seek } from "./steering";

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const MAX_SPEED = 4;

describe("steering: seek", () => {
  it("returns a velocity of maxSpeed pointing at the target", () => {
    const v = seek(ORIGIN, { x: 10, y: 0, z: 0 }, MAX_SPEED);
    expect(v.x).toBeCloseTo(MAX_SPEED);
    expect(v.z).toBeCloseTo(0);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(MAX_SPEED);
  });

  it("returns zero when already on the target", () => {
    const v = seek(ORIGIN, { ...ORIGIN }, MAX_SPEED);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(0);
  });
});

describe("steering: arrive", () => {
  it("matches seek (full speed) outside the slow radius", () => {
    const slowRadius = 2;
    const v = arrive(ORIGIN, { x: 10, y: 0, z: 0 }, MAX_SPEED, slowRadius);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(MAX_SPEED);
  });

  it("ramps the speed down linearly inside the slow radius", () => {
    const slowRadius = 4;
    // Target 1 m away with a 4 m slow radius → quarter speed.
    const v = arrive(ORIGIN, { x: 1, y: 0, z: 0 }, MAX_SPEED, slowRadius);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(MAX_SPEED * (1 / 4));
  });
});

describe("steering: avoid", () => {
  const box: AabbXZ = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };

  it("pushes directly away from the obstacle's nearest border", () => {
    // Agent just to the +X side of the box, inside the avoid radius.
    const v = avoid({ x: 1.5, y: 0, z: 0 }, [box], 1, MAX_SPEED);
    expect(v.x).toBeGreaterThan(0); // pushed further +X (away from the box)
    expect(v.z).toBeCloseTo(0);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(MAX_SPEED);
  });

  it("returns zero when no obstacle is within the avoid radius", () => {
    const v = avoid({ x: 5, y: 0, z: 0 }, [box], 1, MAX_SPEED);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(0);
  });
});

describe("steering: clampSpeed", () => {
  it("scales an over-fast velocity down to maxSpeed", () => {
    const v = clampSpeed({ x: 30, y: 0, z: 40 }, MAX_SPEED); // length 50
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(MAX_SPEED);
  });

  it("leaves a slow-enough velocity unchanged", () => {
    const v = clampSpeed({ x: 1, y: 0, z: 0 }, MAX_SPEED);
    expect(v.x).toBeCloseTo(1);
  });
});

describe("steering: distanceXZ", () => {
  it("ignores the Y component", () => {
    const d = distanceXZ({ x: 0, y: 99, z: 0 }, { x: 3, y: -99, z: 4 });
    expect(d).toBeCloseTo(5);
  });
});
