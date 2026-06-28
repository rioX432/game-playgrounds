import { describe, expect, it } from "vitest";
import { createRng } from "./rng";
import { computeSpawnPositions } from "../samples/13-stress-bodies/spawn";

describe("createRng", () => {
  it("yields a fixed first-5 sequence for seed 12345 (mulberry32)", () => {
    const rng = createRng(12345);
    const seq = [rng(), rng(), rng(), rng(), rng()];
    expect(seq).toEqual([
      0.9797282677609473, 0.3067522644996643, 0.484205421525985,
      0.817934412509203, 0.5094283693470061,
    ]);
  });

  it("reproduces the same stream for the same seed", () => {
    const a = createRng(7);
    const b = createRng(7);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
  });
});

describe("computeSpawnPositions", () => {
  it("is identical across two calls with the same seed", () => {
    const a = computeSpawnPositions(64, createRng(999));
    const b = computeSpawnPositions(64, createRng(999));
    expect(a).toEqual(b);
  });

  it("differs for a different seed", () => {
    const a = computeSpawnPositions(64, createRng(999));
    const c = computeSpawnPositions(64, createRng(1000));
    expect(a).not.toEqual(c);
  });
});
