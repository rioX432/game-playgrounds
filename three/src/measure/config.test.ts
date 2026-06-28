import { describe, expect, it } from "vitest";
import { parseMeasureParams } from "./config";

describe("parseMeasureParams — renderer mode (#172)", () => {
  it("defaults to the classic WebGLRenderer path when ?renderer is absent", () => {
    expect(parseMeasureParams("?measure=1").rendererMode).toBe("classic");
    expect(parseMeasureParams("").rendererMode).toBe("classic");
  });

  it("maps ?renderer=webgpu to the WebGPU backend", () => {
    expect(parseMeasureParams("?renderer=webgpu").rendererMode).toBe("webgpu");
  });

  it("maps ?renderer=webgl to the WebGPURenderer WebGL2 fallback (NOT classic)", () => {
    // PR0 §re-baseline: `webgl` is WebGPURenderer's WebGL2 backend, distinct from the
    // classic WebGLRenderer baseline (which is the param-absent default).
    expect(parseMeasureParams("?renderer=webgl").rendererMode).toBe(
      "webgpu-webgl2",
    );
  });

  it("falls back to classic for an unknown ?renderer value", () => {
    expect(parseMeasureParams("?renderer=vulkan").rendererMode).toBe("classic");
    expect(parseMeasureParams("?renderer=").rendererMode).toBe("classic");
  });
});

describe("parseMeasureParams — existing fields stay intact", () => {
  it("keeps the documented defaults", () => {
    const p = parseMeasureParams("");
    expect(p.measure).toBe(false);
    expect(p.bodies).toBe(2000);
    expect(p.seed).toBe(12345);
  });

  it("parses the full measure URL contract", () => {
    const p = parseMeasureParams(
      "?sample=13-stress-bodies&measure=1&bodies=500&seed=7&renderer=webgpu",
    );
    expect(p.measure).toBe(true);
    expect(p.sample).toBe("13-stress-bodies");
    expect(p.bodies).toBe(500);
    expect(p.seed).toBe(7);
    expect(p.rendererMode).toBe("webgpu");
  });
});
