import { describe, expect, it } from 'vitest';
import { WAN_PROFILES, allWanProfiles } from 'net-protocol';
import {
  n2StressRamp,
  n2LatencySweep,
  n2TickrateSweep,
  n2WanProfileSweep,
  profileToShim,
  adhoc,
  SCENARIOS,
} from '../src/scenarios/defs.js';
import { planSegments } from '../src/scenarios/runner.js';

describe('scenario definitions (#144)', () => {
  it('n2-stress-ramp ramps the default sync-entity counts at a fixed tick', () => {
    const def = n2StressRamp();
    expect(def.id).toBe('n2-stress-ramp');
    expect(def.stages.map((s) => s.botCount)).toEqual([2, 8, 16, 24, 50, 100]);
    // Fixed tick + zero impairment across the whole ramp.
    expect(new Set(def.stages.map((s) => s.tickRate))).toEqual(new Set([20]));
    for (const s of def.stages) {
      expect(s.shim.up).toEqual({ delayMs: 0, lossPct: 0 });
      expect(s.shim.down).toEqual({ delayMs: 0, lossPct: 0 });
    }
  });

  it('n2-stress-ramp collapses to ONE room segment (live bot ramp)', () => {
    expect(planSegments(n2StressRamp().stages)).toHaveLength(1);
  });

  it('n2-tickrate-sweep is one fresh room per tick (tick is fixed at onCreate)', () => {
    const def = n2TickrateSweep();
    expect(def.stages.map((s) => s.tickRate)).toEqual([10, 15, 20, 30]);
    // Bots fixed; only the tick differs.
    expect(new Set(def.stages.map((s) => s.botCount)).size).toBe(1);
    expect(planSegments(def.stages)).toHaveLength(def.stages.length);
  });

  it('n2-latency-sweep is one fresh room per shim point', () => {
    const def = n2LatencySweep();
    expect(def.stages.length).toBeGreaterThanOrEqual(2);
    expect(planSegments(def.stages)).toHaveLength(def.stages.length);
  });

  it('builders honor caller overrides (tiny test runs)', () => {
    const def = n2StressRamp({ botStages: [2, 4], clientCount: 1, warmupMs: 10, measureMs: 20 });
    expect(def.stages.map((s) => s.botCount)).toEqual([2, 4]);
    expect(def.stages.every((s) => s.clientCount === 1)).toBe(true);
    expect(def.stages.every((s) => s.warmupMs === 10 && s.measureMs === 20)).toBe(true);
  });

  it('adhoc defaults to a single 8-bot stage (the #141 baseline)', () => {
    expect(adhoc().stages.map((s) => s.botCount)).toEqual([8]);
  });

  it('adhoc carries a single caller-supplied shim across the ramp', () => {
    const shim = { up: { delayMs: 30, lossPct: 0 }, down: { delayMs: 60, lossPct: 5 } };
    const def = adhoc({ botStages: [2, 8], shim });
    expect(def.id).toBe('adhoc');
    expect(def.stages.every((s) => s.shim === shim)).toBe(true);
    // Same shim/tick/clients => one live-ramped room.
    expect(planSegments(def.stages)).toHaveLength(1);
  });

  it('registry exposes every named scenario', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(
      [
        'adhoc',
        'n2-latency-sweep',
        'n2-stress-ramp',
        'n2-tickrate-sweep',
        'n2-wan-profile-sweep',
      ].sort(),
    );
  });
});

describe('n2-wan-profile-sweep (#159)', () => {
  it('has one stage per WAN profile, clean first', () => {
    const def = n2WanProfileSweep();
    expect(def.id).toBe('n2-wan-profile-sweep');
    expect(def.stages).toHaveLength(allWanProfiles().length);
    // First stage is the clean control (zero injection).
    expect(def.stages[0].shim.up.delayMs).toBe(0);
    expect(def.stages[0].shim.up.lossPct).toBe(0);
    expect(def.stages[0].shim.up.jitter?.distribution).toBe('none');
  });

  it('carries each profile delay/loss/jitter symmetrically up + down', () => {
    const def = n2WanProfileSweep();
    for (const [i, profile] of allWanProfiles().entries()) {
      const s = def.stages[i].shim;
      expect(s.up.delayMs).toBe(profile.oneWayDelayMs);
      expect(s.down.delayMs).toBe(profile.oneWayDelayMs);
      expect(s.up.lossPct).toBe(profile.lossPct);
      expect(s.up.jitter).toEqual(profile.jitter);
      expect(s.down.jitter).toEqual(profile.jitter);
    }
  });

  it('is one fresh room per profile (each profile differs in delay/loss)', () => {
    const def = n2WanProfileSweep();
    expect(planSegments(def.stages)).toHaveLength(def.stages.length);
  });

  it('profileToShim mirrors a profile into a symmetric shim', () => {
    const shim = profileToShim(WAN_PROFILES['4g-mobile']);
    expect(shim.up).toEqual(shim.down);
    expect(shim.up.delayMs).toBe(25);
    expect(shim.up.lossPct).toBe(1.0);
    expect(shim.up.jitter?.distribution).toBe('pareto');
  });
});

describe('planSegments grouping', () => {
  const stage = (botCount: number, tickRate: number, downDelay = 0) => ({
    botCount,
    clientCount: 1,
    tickRate,
    shim: { up: { delayMs: 0, lossPct: 0 }, down: { delayMs: downDelay, lossPct: 0 } },
    warmupMs: 0,
    measureMs: 0,
  });

  it('groups consecutive stages that share room-construction params', () => {
    const segs = planSegments([stage(2, 20), stage(8, 20), stage(16, 20)]);
    expect(segs).toHaveLength(1);
    expect(segs[0].map((s) => s.botCount)).toEqual([2, 8, 16]);
  });

  it('splits on a tickRate change', () => {
    expect(planSegments([stage(8, 20), stage(8, 30)])).toHaveLength(2);
  });

  it('splits on a shim change', () => {
    expect(planSegments([stage(8, 20, 0), stage(8, 20, 50)])).toHaveLength(2);
  });

  it('returns [] for no stages', () => {
    expect(planSegments([])).toEqual([]);
  });
});
