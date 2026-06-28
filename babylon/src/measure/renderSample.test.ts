import { describe, expect, it } from "vitest";
import {
  aggregateRenderWindow,
  LONG_FRAME_THRESHOLD_MS,
  type RenderSampleMeta,
} from "./renderSample";

const META: RenderSampleMeta = {
  engine: "babylon",
  backend: "webgl",
  host: "browser",
  bodies: 2000,
  seed: 12345,
};

describe("aggregateRenderWindow", () => {
  it("computes exact aggregates over a fixed delta array (with long frames)", () => {
    // 8 steady 10 ms frames + a 60 ms and a 120 ms hitch (both > threshold).
    const rawDt = [10, 10, 10, 10, 10, 10, 10, 10, 60, 120];
    const sample = aggregateRenderWindow(rawDt, META);

    // Identity passes through verbatim.
    expect(sample.engine).toBe("babylon");
    expect(sample.backend).toBe("webgl");
    expect(sample.host).toBe("browser");
    expect(sample.bodies).toBe(2000);
    expect(sample.seed).toBe(12345);

    // sorted: [10,10,10,10,10,10,10,10,60,120], n=10.
    // p50 -> rank ceil(5)=5 idx4 = 10; p95/p99 -> rank 10 idx9 = 120.
    expect(sample.frameTimeP50Ms).toBe(10);
    expect(sample.frameTimeP95Ms).toBe(120);
    expect(sample.frameTimeP99Ms).toBe(120);

    const expectedLong = rawDt.filter((d) => d > LONG_FRAME_THRESHOLD_MS).length;
    expect(expectedLong).toBe(2);
    expect(sample.longFrameCount).toBe(2);

    // sumDt = 80 + 60 + 120 = 260.
    expect(sample.sampleWindowMs).toBe(260);
    expect(sample.frameCount).toBe(10);
    // fpsMean = 10 / (260/1000) = 38.4615...
    expect(sample.fpsMean).toBeCloseTo(38.4615, 3);
  });

  it("guards an empty window (no divide-by-zero)", () => {
    const sample = aggregateRenderWindow([], META);
    expect(sample.frameCount).toBe(0);
    expect(sample.sampleWindowMs).toBe(0);
    expect(sample.fpsMean).toBe(0);
    expect(sample.frameTimeP50Ms).toBe(0);
    expect(sample.frameTimeP95Ms).toBe(0);
    expect(sample.frameTimeP99Ms).toBe(0);
    expect(sample.longFrameCount).toBe(0);
  });
});
