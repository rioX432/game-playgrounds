// Server-side simulated players. Bots are pure server-internal entities (no
// socket, no transport), so the synchronized-entity count can scale 2 -> 24 ->
// 100+ without opening that many real connections. They add simulation +
// serialization + downlink-bandwidth load, which is the point of the stress
// scenarios. Real connected clients (not bots) are the RTT/snapshot-age probes.

import type { PlayerInput } from 'net-protocol';
import { BOT_DIR_CHANGE_PROB } from '../config.js';
import type { Rng } from '../sim/rng.js';
import type { World } from '../sim/world.js';

interface BotState {
  id: string;
  seq: number;
  moveX: number;
  moveZ: number;
  yaw: number;
}

/** Drives N bots with seeded random-walk movement. Count is parameterizable. */
export class BotDriver {
  private readonly bots: BotState[] = [];

  constructor(
    private readonly world: World,
    private readonly rng: Rng,
  ) {}

  /** Current bot count. */
  get count(): number {
    return this.bots.length;
  }

  /**
   * Grow or shrink the bot population to `target`. Adding registers a new world
   * entity; removing tears one down. Lets a scenario ramp entity count live.
   */
  setCount(target: number): void {
    while (this.bots.length < target) {
      const id = `bot-${this.bots.length}`;
      this.world.add(id, true);
      this.bots.push({ id, seq: 0, moveX: 0, moveZ: 0, yaw: 0 });
    }
    while (this.bots.length > target) {
      const b = this.bots.pop();
      if (b) this.world.remove(b.id);
    }
  }

  /** Produce one input per bot for this tick and feed it to the world. */
  tick(): void {
    for (const b of this.bots) {
      if (this.rng.next() < BOT_DIR_CHANGE_PROB) {
        const angle = this.rng.range(0, Math.PI * 2);
        b.moveX = Math.cos(angle);
        b.moveZ = Math.sin(angle);
        b.yaw = angle;
      }
      b.seq += 1;
      const input: PlayerInput = {
        seq: b.seq,
        clientTimeMs: 0,
        move: [b.moveX, b.moveZ],
        yaw: b.yaw,
        buttons: 0,
      };
      this.world.applyInput(b.id, input);
    }
  }
}
