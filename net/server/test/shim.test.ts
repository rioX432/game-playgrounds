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
