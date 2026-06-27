import { describe, expect, it } from "vitest";
import { FLAG_FIRING } from "net-protocol";
import { deriveInput } from "./input";

const keys = (...codes: string[]): Set<string> => new Set(codes);

describe("deriveInput", () => {
  it("produces a zero axis and holds prevYaw when idle", () => {
    const r = deriveInput(keys(), 1.23);
    expect(r.move).toEqual([0, 0]);
    expect(r.yaw).toBe(1.23);
    expect(r.buttons).toBe(0);
  });

  it("maps W to forward (-z) and faces along it", () => {
    const r = deriveInput(keys("KeyW"), 0);
    expect(r.move[0]).toBe(0);
    expect(r.move[1]).toBe(-1);
    expect(r.yaw).toBeCloseTo(-Math.PI / 2, 6); // atan2(-1, 0)
  });

  it("treats arrow keys identically to WASD", () => {
    expect(deriveInput(keys("ArrowRight"), 0).move).toEqual(
      deriveInput(keys("KeyD"), 0).move,
    );
  });

  it("normalizes diagonals to unit length (no faster diagonal)", () => {
    const r = deriveInput(keys("KeyW", "KeyD"), 0);
    expect(Math.hypot(r.move[0], r.move[1])).toBeCloseTo(1, 6);
    expect(r.yaw).toBeCloseTo(Math.atan2(-1, 1), 6); // up-right
  });

  it("cancels opposing keys to a zero axis and keeps prevYaw", () => {
    const r = deriveInput(keys("KeyA", "KeyD", "KeyW", "KeyS"), 0.5);
    expect(r.move).toEqual([0, 0]);
    expect(r.yaw).toBe(0.5);
  });

  it("sets the FLAG_FIRING bit while Space is held", () => {
    expect(deriveInput(keys("Space"), 0).buttons & FLAG_FIRING).toBe(FLAG_FIRING);
  });
});
