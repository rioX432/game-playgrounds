import { describe, expect, it } from 'vitest';
import { FLAG_FIRING, FLAG_GROUNDED, type PlayerInput } from 'net-protocol';
import { World } from '../src/sim/world.js';

const input = (over: Partial<PlayerInput>): PlayerInput => ({
  seq: 1,
  clientTimeMs: 0,
  move: [0, 0],
  yaw: 0,
  buttons: 0,
  ...over,
});

describe('World', () => {
  it('integrates position from the latest input over a fixed step', () => {
    const w = new World();
    w.add('p1', false);

    w.applyInput('p1', input({ seq: 1, move: [1, 0] }));
    w.step(1); // 1 second at PLAYER_SPEED=5 -> x = 5

    const snap = w.buildSnapshot(0, 0);
    expect(snap.players[0].pos[0]).toBeCloseTo(5);
    expect(snap.players[0].pos[2]).toBeCloseTo(0);
  });

  it('rejects stale or duplicate input seqs to prevent state rewind', () => {
    const w = new World();
    w.add('p1', false);

    w.applyInput('p1', input({ seq: 5, move: [1, 0] }));
    w.applyInput('p1', input({ seq: 3, move: [-1, 0] })); // stale, ignored
    w.step(1);

    const snap = w.buildSnapshot(0, 0);
    expect(snap.players[0].pos[0]).toBeCloseTo(5);
    expect(snap.players[0].seq).toBe(5);
  });

  it('echoes the last processed seq and maps firing button to a flag', () => {
    const w = new World();
    w.add('p1', false);

    w.applyInput('p1', input({ seq: 7, buttons: FLAG_FIRING }));
    const snap = w.buildSnapshot(0, 0);

    expect(snap.players[0].seq).toBe(7);
    expect(snap.players[0].flags & FLAG_GROUNDED).toBe(FLAG_GROUNDED);
    expect(snap.players[0].flags & FLAG_FIRING).toBe(FLAG_FIRING);
  });

  it('clamps position to the arena bounds', () => {
    const w = new World();
    w.add('p1', false);

    w.applyInput('p1', input({ seq: 1, move: [1, 0] }));
    w.step(100); // would overshoot far past the arena

    const snap = w.buildSnapshot(0, 0);
    expect(snap.players[0].pos[0]).toBeLessThanOrEqual(25);
  });

  it('counts bots and players separately', () => {
    const w = new World();
    w.add('p1', false);
    w.add('bot-0', true);
    w.add('bot-1', true);

    expect(w.count()).toBe(3);
    expect(w.count('player')).toBe(1);
    expect(w.count('bot')).toBe(2);

    w.remove('bot-0');
    expect(w.count('bot')).toBe(1);
  });
});
