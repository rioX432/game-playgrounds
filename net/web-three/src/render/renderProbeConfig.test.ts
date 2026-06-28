import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOT_COUNT,
  DEFAULT_SCENARIO,
  DEFAULT_SEED,
  DEFAULT_TICK_RATE,
  parseRenderProbeParams,
} from "./renderProbeConfig";
import {
  DEFAULT_MAX_WINDOWS,
  DEFAULT_WARMUP_MS,
  DEFAULT_WINDOW_DURATION_MS,
} from "./renderProbe";

describe("parseRenderProbeParams", () => {
  it("is disabled when the probe flag is absent", () => {
    expect(parseRenderProbeParams("").enabled).toBe(false);
    expect(parseRenderProbeParams("?scenario=x").enabled).toBe(false);
  });

  it("enables the probe with the documented defaults on probe=1", () => {
    // Arrange / Act
    const params = parseRenderProbeParams("?probe=1");

    // Assert
    expect(params.enabled).toBe(true);
    expect(params.warmupMs).toBe(DEFAULT_WARMUP_MS);
    expect(params.windowDurationMs).toBe(DEFAULT_WINDOW_DURATION_MS);
    expect(params.maxWindows).toBe(DEFAULT_MAX_WINDOWS);
    expect(params.keys.scenario).toBe(DEFAULT_SCENARIO);
    expect(params.keys.engine).toBe("three");
    expect(params.keys.seed).toBe(DEFAULT_SEED);
    expect(params.keys.tickRate).toBe(DEFAULT_TICK_RATE);
    expect(params.keys.botCount).toBe(DEFAULT_BOT_COUNT);
  });

  it("maps every join key + window knob from the query string", () => {
    // Arrange
    const search =
      "?probe=1&scenario=n2-latency-sweep&seed=42&tickRate=30" +
      "&clientCount=2&botCount=100&clientIndex=1" +
      "&delayCtoSMs=25&delayStoCMs=50&lossPct=10" +
      "&warmupMs=1000&windowDurationMs=3000&maxWindows=5";

    // Act
    const params = parseRenderProbeParams(search);

    // Assert
    expect(params.warmupMs).toBe(1000);
    expect(params.windowDurationMs).toBe(3000);
    expect(params.maxWindows).toBe(5);
    expect(params.keys).toEqual({
      scenario: "n2-latency-sweep",
      engine: "three",
      seed: 42,
      tickRate: 30,
      clientCount: 2,
      botCount: 100,
      injectedDelayCtoSMs: 25,
      injectedDelayStoCMs: 50,
      lossPct: 10,
      clientIndex: 1,
    });
  });

  it("fixes the engine to three even if the URL tries to override it", () => {
    // engine is not a recognised param, so it can never be spoofed.
    const params = parseRenderProbeParams("?probe=1&engine=babylon");
    expect(params.keys.engine).toBe("three");
  });

  it("treats a non-positive maxWindows as run-indefinitely (null)", () => {
    expect(parseRenderProbeParams("?probe=1&maxWindows=0").maxWindows).toBeNull();
    expect(parseRenderProbeParams("?probe=1&maxWindows=-3").maxWindows).toBeNull();
  });

  it("falls back to defaults for unparseable numeric params", () => {
    const params = parseRenderProbeParams("?probe=1&seed=abc&tickRate=&botCount=NaN");
    expect(params.keys.seed).toBe(DEFAULT_SEED);
    expect(params.keys.tickRate).toBe(DEFAULT_TICK_RATE);
    expect(params.keys.botCount).toBe(DEFAULT_BOT_COUNT);
  });
});
