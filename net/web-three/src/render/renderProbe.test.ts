import { describe, expect, it } from "vitest";
import type { ClientRenderSample } from "net-protocol";
import { MIN_VALID_SAMPLES, THROTTLE_MAX_MS } from "net-protocol";
import {
  buildClientRenderSample,
  RenderProbe,
  type RenderJoinKeys,
} from "./renderProbe";

const KEYS: RenderJoinKeys = {
  scenario: "n2-stress-ramp",
  engine: "three",
  seed: 12345,
  tickRate: 20,
  clientCount: 1,
  botCount: 24,
  injectedDelayCtoSMs: 0,
  injectedDelayStoCMs: 0,
  lossPct: 0,
  clientIndex: 0,
};

/** A window of `count` identical foreground deltas, comfortably above the floor. */
function steadyDeltas(dtMs: number, count: number): number[] {
  return Array.from({ length: count }, () => dtMs);
}

describe("buildClientRenderSample", () => {
  it("merges join keys with aggregates and stamps the web-raf-dt basis", () => {
    // Arrange: a clean 50-frame window at a steady 10 ms/frame.
    const deltas = steadyDeltas(10, 50);

    // Act
    const sample = buildClientRenderSample(
      deltas,
      { windowStartMs: 1000, windowDurationMs: 500, dropFirstFrame: false },
      KEYS,
    );

    // Assert
    expect(sample).not.toBeNull();
    const s = sample as ClientRenderSample;
    expect(s.measurementBasis).toBe("web-raf-dt");
    expect(s.engine).toBe("three");
    expect(s.scenario).toBe("n2-stress-ramp");
    expect(s.botCount).toBe(24);
    expect(s.clientIndex).toBe(0);
    expect(s.windowStartMs).toBe(1000);
    expect(s.windowDurationMs).toBe(500);
    expect(s.clientFps).toBeCloseTo(100, 6); // 50 frames / 0.5 s
    expect(s.clientFrameTimeP50Ms).toBe(10);
    expect(s.clientFrameTimeP95Ms).toBe(10);
    expect(s.sampleCount).toBe(50);
  });

  it("returns null for a throttled window (a delta above the throttle ceiling)", () => {
    // Arrange: a long foreground stretch plus one tab-throttle artifact.
    const deltas = [...steadyDeltas(10, 50), THROTTLE_MAX_MS + 1];

    // Act
    const sample = buildClientRenderSample(
      deltas,
      { windowStartMs: 0, windowDurationMs: 600, dropFirstFrame: false },
      KEYS,
    );

    // Assert
    expect(sample).toBeNull();
  });

  it("returns null for a statistically-weak window (below the sample floor)", () => {
    // Arrange: fewer valid deltas than the contract's minimum.
    const deltas = steadyDeltas(16, MIN_VALID_SAMPLES - 1);

    // Act
    const sample = buildClientRenderSample(
      deltas,
      { windowStartMs: 0, windowDurationMs: 500, dropFirstFrame: false },
      KEYS,
    );

    // Assert
    expect(sample).toBeNull();
  });
});

/** Feed a probe a contiguous rAF stream; mark ready at the first timestamp. */
function drive(
  probe: RenderProbe,
  opts: { startMs: number; dtMs: number; frames: number },
): void {
  for (let i = 0; i < opts.frames; i++) {
    const now = opts.startMs + i * opts.dtMs;
    probe.markReady(opts.startMs);
    probe.recordFrame(now);
  }
}

describe("RenderProbe", () => {
  it("emits nothing until markReady is called", () => {
    // Arrange
    const emitted: ClientRenderSample[] = [];
    const probe = new RenderProbe({
      keys: KEYS,
      sink: (s) => emitted.push(s),
      warmupMs: 0,
      windowDurationMs: 200,
      maxWindows: 1,
    });

    // Act: feed frames WITHOUT markReady.
    for (let i = 0; i < 100; i++) probe.recordFrame(i * 10);

    // Assert
    expect(emitted).toHaveLength(0);
    expect(probe.windowCount).toBe(0);
  });

  it("excludes the warmup window and emits a steady-state sample after it", () => {
    // Arrange: 100 ms warmup, 500 ms window, 10 ms/frame.
    const emitted: ClientRenderSample[] = [];
    const probe = new RenderProbe({
      keys: KEYS,
      sink: (s) => emitted.push(s),
      warmupMs: 100,
      windowDurationMs: 500,
      maxWindows: 1,
    });

    // Act: drive past warmup + one full window (t = 0..700).
    drive(probe, { startMs: 0, dtMs: 10, frames: 71 });

    // Assert: exactly one window, opened at the warmup boundary (~100 ms), and
    // its sample count reflects ONLY post-warmup frames (not the warmup ones).
    expect(emitted).toHaveLength(1);
    const s = emitted[0];
    expect(s.measurementBasis).toBe("web-raf-dt");
    expect(s.windowStartMs).toBe(100);
    expect(s.windowDurationMs).toBe(500);
    expect(s.clientFrameTimeP50Ms).toBe(10);
    // 500 ms window at 10 ms/frame ≈ 50 deltas — far fewer than the 70 frames fed.
    expect(s.sampleCount).toBe(50);
    expect(s.clientFps).toBeCloseTo(100, 6);
  });

  it("stops after the configured number of kept windows", () => {
    // Arrange
    const emitted: ClientRenderSample[] = [];
    const probe = new RenderProbe({
      keys: KEYS,
      sink: (s) => emitted.push(s),
      warmupMs: 0,
      windowDurationMs: 500,
      maxWindows: 2,
    });

    // Act: drive enough frames for three windows.
    drive(probe, { startMs: 0, dtMs: 10, frames: 200 });

    // Assert: capped at two.
    expect(emitted).toHaveLength(2);
    expect(probe.done).toBe(true);
  });

  it("drops a throttled window without emitting and keeps the count at zero", () => {
    // Arrange: a window whose final delta is a tab-throttle gap.
    const emitted: ClientRenderSample[] = [];
    const probe = new RenderProbe({
      keys: KEYS,
      sink: (s) => emitted.push(s),
      warmupMs: 0,
      windowDurationMs: 300,
      maxWindows: 1,
    });

    // Act: steady frames 0..290, then a 300 ms jump (a background pause) closes
    // the window with a throttle artifact present.
    probe.markReady(0);
    for (let t = 0; t <= 290; t += 10) probe.recordFrame(t);
    probe.recordFrame(290 + THROTTLE_MAX_MS + 10);

    // Assert
    expect(emitted).toHaveLength(0);
    expect(probe.windowCount).toBe(0);
  });
});
