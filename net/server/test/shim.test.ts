import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRng } from '../src/sim/rng.js';
import { TransportShim } from '../src/transport/shim.js';

describe('TransportShim', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('injects loss independently per direction', () => {
    // up: total loss; down: lossless. Proves the two links are separate.
    const shim = new TransportShim(
      { up: { delayMs: 0, lossPct: 100 }, down: { delayMs: 0, lossPct: 0 } },
      createRng(1),
    );

    let upDelivered = 0;
    let downDelivered = 0;

    const upOk = shim.up(() => upDelivered++);
    const downOk = shim.down(() => downDelivered++);

    expect(upOk).toBe(false);
    expect(upDelivered).toBe(0);
    expect(downOk).toBe(true);
    expect(downDelivered).toBe(1);
  });

  it('delivers immediately on the zero-delay fast path', () => {
    const shim = new TransportShim(
      { up: { delayMs: 0, lossPct: 0 }, down: { delayMs: 0, lossPct: 0 } },
      createRng(1),
    );
    let delivered = 0;
    shim.up(() => delivered++);
    expect(delivered).toBe(1);
  });

  it('defers delivery by the per-direction delay', () => {
    vi.useFakeTimers();
    const shim = new TransportShim(
      { up: { delayMs: 0, lossPct: 0 }, down: { delayMs: 50, lossPct: 0 } },
      createRng(1),
    );

    let delivered = 0;
    shim.down(() => delivered++);
    expect(delivered).toBe(0); // not yet

    vi.advanceTimersByTime(49);
    expect(delivered).toBe(0);
    vi.advanceTimersByTime(1);
    expect(delivered).toBe(1); // after 50ms
  });

  it('keeps the synchronous fast path when jitter is configured but no-op (sigma 0)', () => {
    const shim = new TransportShim(
      {
        up: { delayMs: 0, lossPct: 0, jitter: { sigmaMs: 0, distribution: 'normal', correlation: 0 } },
        down: { delayMs: 0, lossPct: 0 },
      },
      createRng(1),
      createRng(2),
      createRng(3),
    );
    let delivered = 0;
    shim.up(() => delivered++);
    expect(delivered).toBe(1); // sigma 0 ⇒ no-op sampler ⇒ still synchronous
  });

  it('jitter yields a reproducible, reordered delivery schedule (#159)', () => {
    vi.useFakeTimers();
    const cfg = {
      up: { delayMs: 0, lossPct: 0 },
      down: { delayMs: 50, lossPct: 0, jitter: { sigmaMs: 15, distribution: 'normal' as const, correlation: 0 } },
    };
    const run = (seed: number): number[] => {
      const shim = new TransportShim(cfg, createRng(seed), createRng(seed + 1), createRng(seed + 2));
      const order: number[] = [];
      for (let i = 0; i < 20; i++) shim.down(() => order.push(i));
      vi.advanceTimersByTime(10_000); // flush every deferred delivery
      return order;
    };
    const a = run(7);
    const b = run(7);
    expect(a).toEqual(b); // same seed ⇒ identical effective-delay schedule
    expect(a).toHaveLength(20); // none lost (lossPct 0)
    // Variable jitter ⇒ deliveries no longer arrive in strict send order.
    expect(a).not.toEqual([...Array(20).keys()]);
  });

  it('cancels pending deliveries on dispose', () => {
    vi.useFakeTimers();
    const shim = new TransportShim(
      { up: { delayMs: 0, lossPct: 0 }, down: { delayMs: 50, lossPct: 0 } },
      createRng(1),
    );

    let delivered = 0;
    shim.down(() => delivered++);
    shim.dispose();
    vi.advanceTimersByTime(100);

    expect(delivered).toBe(0);
  });
});
