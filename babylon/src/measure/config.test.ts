import { describe, expect, it } from "vitest";
import { parseMeasureParams } from "./config";

describe("parseMeasureParams — renderer mode (#173)", () => {
  it("defaults to webgl when ?renderer is absent (PR1 baseline path)", () => {
    expect(parseMeasureParams("?sample=13-stress-bodies").rendererMode).toBe(
      "webgl",
    );
  });

  it("maps ?renderer=webgl to webgl", () => {
    expect(parseMeasureParams("?renderer=webgl").rendererMode).toBe("webgl");
  });

  it("maps ?renderer=webgpu to webgpu", () => {
    expect(parseMeasureParams("?renderer=webgpu").rendererMode).toBe("webgpu");
  });

  it("falls back to webgl for an unknown ?renderer value (never silently webgpu)", () => {
    expect(parseMeasureParams("?renderer=vulkan").rendererMode).toBe("webgl");
    expect(parseMeasureParams("?renderer=").rendererMode).toBe("webgl");
  });
});

describe("parseMeasureParams — existing params unchanged (#171)", () => {
  it("parses the measure flag, sample id, and numeric knobs", () => {
    const p = parseMeasureParams(
      "?sample=13-stress-bodies&measure=1&bodies=500&seed=7&warmupMs=1000&windowMs=2000&maxWindows=2",
    );
    expect(p.measure).toBe(true);
    expect(p.sample).toBe("13-stress-bodies");
    expect(p.bodies).toBe(500);
    expect(p.seed).toBe(7);
    expect(p.warmupMs).toBe(1000);
    expect(p.windowMs).toBe(2000);
    expect(p.maxWindows).toBe(2);
  });

  it("applies defaults when params are absent", () => {
    const p = parseMeasureParams("");
    expect(p.measure).toBe(false);
    expect(p.sample).toBe("");
    expect(p.bodies).toBe(2000);
    expect(p.seed).toBe(12345);
    expect(p.warmupMs).toBe(2000);
    expect(p.windowMs).toBe(4000);
    expect(p.maxWindows).toBe(3);
    expect(p.rendererMode).toBe("webgl");
  });
});
