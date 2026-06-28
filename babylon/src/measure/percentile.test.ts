import { describe, expect, it } from "vitest";
import { percentileNearestRank } from "./percentile";

describe("percentileNearestRank", () => {
  it("returns 0 for an empty array", () => {
    expect(percentileNearestRank([], 50)).toBe(0);
    expect(percentileNearestRank([], 95)).toBe(0);
    expect(percentileNearestRank([], 99)).toBe(0);
  });

  it("computes nearest-rank p50/p95/p99 on a known array (1..10)", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // rank = ceil(p/100 * 10): p50 -> 5 (idx4=5); p95 -> 10 (idx9=10); p99 -> 10.
    expect(percentileNearestRank(sorted, 50)).toBe(5);
    expect(percentileNearestRank(sorted, 95)).toBe(10);
    expect(percentileNearestRank(sorted, 99)).toBe(10);
    expect(percentileNearestRank(sorted, 100)).toBe(10);
  });

  it("clamps the rank at p=0 to the first element", () => {
    expect(percentileNearestRank([3, 7, 9], 0)).toBe(3);
  });

  it("handles a single-element array at every percentile", () => {
    expect(percentileNearestRank([42], 50)).toBe(42);
    expect(percentileNearestRank([42], 95)).toBe(42);
    expect(percentileNearestRank([42], 99)).toBe(42);
  });
});
