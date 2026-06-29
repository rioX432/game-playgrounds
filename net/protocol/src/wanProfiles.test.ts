import { describe, expect, it } from 'vitest';
import {
  WAN_PROFILES,
  WAN_PROFILE_IDS,
  allWanProfiles,
  wanProfile,
} from './wanProfiles.js';
import {
  REORDER_NOTE,
  manifestEntryForProfileId,
  manifestEntryFromProfile,
} from './scenarioManifest.js';

describe('WAN profiles', () => {
  it('registry covers exactly the declared ids, keyed consistently', () => {
    expect(Object.keys(WAN_PROFILES).sort()).toEqual([...WAN_PROFILE_IDS].sort());
    for (const id of WAN_PROFILE_IDS) expect(WAN_PROFILES[id].id).toBe(id);
  });

  it('clean is the zero-injection control', () => {
    const c = WAN_PROFILES.clean;
    expect(c.oneWayDelayMs).toBe(0);
    expect(c.lossPct).toBe(0);
    expect(c.jitter.distribution).toBe('none');
    expect(c.jitter.sigmaMs).toBe(0);
  });

  it('impaired profiles increase delay monotonically and stay within sane bounds', () => {
    const ordered = ['good-wifi', '4g-mobile', 'transcontinental'] as const;
    const delays = ordered.map((id) => WAN_PROFILES[id].oneWayDelayMs);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    for (const id of ordered) {
      const p = WAN_PROFILES[id];
      expect(p.oneWayDelayMs).toBeGreaterThan(0);
      expect(p.jitter.sigmaMs).toBeGreaterThan(0);
      expect(p.jitter.distribution).not.toBe('none');
      expect(p.lossPct).toBeGreaterThanOrEqual(0);
      expect(p.lossPct).toBeLessThan(100);
      expect(p.jitter.correlation).toBeGreaterThanOrEqual(0);
      expect(p.jitter.correlation).toBeLessThan(1);
      expect(p.notes.length).toBeGreaterThan(0);
    }
  });

  it('allWanProfiles lists every profile, clean first', () => {
    const all = allWanProfiles();
    expect(all.map((p) => p.id)).toEqual([...WAN_PROFILE_IDS]);
    expect(all[0].id).toBe('clean');
  });

  it('wanProfile looks up by id and returns undefined for unknown', () => {
    expect(wanProfile('4g-mobile')?.id).toBe('4g-mobile');
    expect(wanProfile('nope')).toBeUndefined();
  });
});

describe('scenario manifest', () => {
  it('builds an entry that mirrors the profile knobs + the join key', () => {
    const e = manifestEntryForProfileId('n2-wan-profile-sweep', '4g-mobile', REORDER_NOTE.web);
    const p = WAN_PROFILES['4g-mobile'];
    expect(e).toEqual({
      scenario: 'n2-wan-profile-sweep',
      profile: '4g-mobile',
      oneWayDelayMs: p.oneWayDelayMs,
      jitterSigmaMs: p.jitter.sigmaMs,
      jitterDistribution: p.jitter.distribution,
      jitterCorrelation: p.jitter.correlation,
      lossPct: p.lossPct,
      reorderNote: REORDER_NOTE.web,
    });
  });

  it('reorder notes differ per stack (web approximate, bevy faithful)', () => {
    expect(REORDER_NOTE.web).toMatch(/APPROXIMATE/);
    expect(REORDER_NOTE.bevy).toMatch(/faithful/);
    const web = manifestEntryFromProfile('s', WAN_PROFILES.clean, REORDER_NOTE.web);
    const bevy = manifestEntryFromProfile('s', WAN_PROFILES.clean, REORDER_NOTE.bevy);
    expect(web.reorderNote).not.toBe(bevy.reorderNote);
  });
});
