import { describe, expect, it } from "vitest";
import type { PlayerSnapshot, SnapshotMessage } from "net-protocol";
import { FLAG_FIRING, FLAG_GROUNDED } from "net-protocol";
import { SnapshotBuffer } from "./snapshotBuffer";

function player(
  id: string,
  x: number,
  z: number,
  yaw = 0,
  flags = FLAG_GROUNDED,
): PlayerSnapshot {
  return { id, pos: [x, 0, z], yaw, flags, seq: 0 };
}

function frame(
  serverTimeMs: number,
  players: PlayerSnapshot[],
  tick = 0,
): SnapshotMessage {
  return { tick, serverTimeMs, players };
}

describe("SnapshotBuffer", () => {
  it("returns empty when no frames are buffered", () => {
    expect(new SnapshotBuffer().sampleAt(0)).toEqual([]);
  });

  it("interpolates position linearly between two frames at the midpoint", () => {
    const buf = new SnapshotBuffer();
    buf.push(frame(1000, [player("a", 0, 0)]));
    buf.push(frame(1100, [player("a", 10, -4)]));

    const [p] = buf.sampleAt(1050);
    expect(p.id).toBe("a");
    expect(p.pos[0]).toBeCloseTo(5, 6);
    expect(p.pos[2]).toBeCloseTo(-2, 6);
  });

  it("interpolates yaw along the shortest arc across the PI/-PI wrap", () => {
    const buf = new SnapshotBuffer();
    // From +170deg to -170deg the shortest arc is +20deg (through 180deg),
    // NOT the -340deg long way around.
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    buf.push(frame(0, [player("a", 0, 0, a)]));
    buf.push(frame(100, [player("a", 0, 0, b)]));

    const [p] = buf.sampleAt(50);
    expect(p.yaw).toBeCloseTo(Math.PI, 6); // halfway is exactly 180deg
  });

  it("clamps to the oldest frame before the buffer start (no back-extrapolation)", () => {
    const buf = new SnapshotBuffer();
    buf.push(frame(1000, [player("a", 2, 2)]));
    buf.push(frame(1100, [player("a", 8, 8)]));

    const [p] = buf.sampleAt(900);
    expect(p.pos[0]).toBe(2);
    expect(p.pos[2]).toBe(2);
  });

  it("holds the newest frame after the buffer end (no forward-extrapolation)", () => {
    const buf = new SnapshotBuffer();
    buf.push(frame(1000, [player("a", 2, 2)]));
    buf.push(frame(1100, [player("a", 8, 8)]));

    const [p] = buf.sampleAt(5000);
    expect(p.pos[0]).toBe(8);
    expect(p.pos[2]).toBe(8);
  });

  it("takes boolean flags from the newer frame, not the older one", () => {
    const buf = new SnapshotBuffer();
    buf.push(frame(0, [player("a", 0, 0, 0, FLAG_GROUNDED)]));
    buf.push(frame(100, [player("a", 0, 0, 0, FLAG_GROUNDED | FLAG_FIRING)]));

    const [p] = buf.sampleAt(50);
    expect(p.flags & FLAG_FIRING).toBe(FLAG_FIRING);
  });

  it("snaps a newly-appeared entity to the newer frame's pose", () => {
    const buf = new SnapshotBuffer();
    buf.push(frame(0, [player("a", 0, 0)]));
    buf.push(frame(100, [player("a", 10, 0), player("b", 4, 6)]));

    const sample = buf.sampleAt(50);
    const b = sample.find((p) => p.id === "b");
    expect(b).toBeDefined();
    expect(b?.pos[0]).toBe(4);
    expect(b?.pos[2]).toBe(6);
  });

  it("drops an entity that is absent from the newer frame", () => {
    const buf = new SnapshotBuffer();
    buf.push(frame(0, [player("a", 0, 0), player("gone", 1, 1)]));
    buf.push(frame(100, [player("a", 10, 0)]));

    const ids = buf.sampleAt(50).map((p) => p.id);
    expect(ids).toEqual(["a"]);
  });

  it("ignores out-of-order frames older than the newest buffered", () => {
    const buf = new SnapshotBuffer();
    buf.push(frame(1000, [player("a", 0, 0)]));
    buf.push(frame(1100, [player("a", 10, 0)]));
    buf.push(frame(1050, [player("a", 999, 0)])); // stale — must be ignored

    expect(buf.size).toBe(2);
    const [p] = buf.sampleAt(1050);
    expect(p.pos[0]).toBeCloseTo(5, 6);
  });

  it("evicts the oldest frames beyond the capacity bound", () => {
    const buf = new SnapshotBuffer(3);
    for (let i = 0; i < 6; i++) buf.push(frame(i * 100, [player("a", i, 0)]));
    expect(buf.size).toBe(3);
    expect(buf.latestServerTimeMs()).toBe(500);
  });
});
