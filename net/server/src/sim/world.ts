// Authoritative world simulation — PURE logic, zero Colyseus / transport deps.
//
// This is the server-authoritative core the chapter is really about: apply the
// latest input per entity, integrate, and produce a thin snapshot. Keeping it
// transport-free makes it headless-testable (cargo-test equivalent) and is the
// exact shape the Bevy/replicon authority will mirror.

import {
  FLAG_FIRING,
  FLAG_GROUNDED,
  type PlayerInput,
  type PlayerSnapshot,
  type SnapshotMessage,
} from 'net-protocol';
import { ARENA_HALF, PLAYER_SPEED } from '../config.js';

interface Entity {
  id: string;
  x: number;
  z: number;
  yaw: number;
  /** Latest input axis applied each step. */
  moveX: number;
  moveZ: number;
  buttons: number;
  /** Last input seq processed for this entity (echoed back in snapshots). */
  lastSeq: number;
  isBot: boolean;
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** The authoritative game world: entities + fixed-step integration. */
export class World {
  private readonly entities = new Map<string, Entity>();

  /** Add a player or bot at the origin. Idempotent per id. */
  add(id: string, isBot: boolean): void {
    if (this.entities.has(id)) return;
    this.entities.set(id, {
      id,
      x: 0,
      z: 0,
      yaw: 0,
      moveX: 0,
      moveZ: 0,
      buttons: 0,
      lastSeq: 0,
      isBot,
    });
  }

  /** Remove an entity (client disconnect / bot teardown). */
  remove(id: string): void {
    this.entities.delete(id);
  }

  /** Number of entities, optionally filtered by kind. */
  count(kind?: 'bot' | 'player'): number {
    if (!kind) return this.entities.size;
    let n = 0;
    for (const e of this.entities.values()) {
      if ((kind === 'bot') === e.isBot) n++;
    }
    return n;
  }

  /**
   * Apply a client (or bot-driver) input. `seq` is monotonic per entity: stale
   * or duplicate inputs (seq <= lastSeq) are ignored so out-of-order delivery
   * from the transport shim cannot rewind authoritative state.
   */
  applyInput(id: string, input: PlayerInput): void {
    const e = this.entities.get(id);
    if (!e) return;
    if (input.seq <= e.lastSeq) return;
    e.lastSeq = input.seq;
    e.moveX = clamp(input.move[0], -1, 1);
    e.moveZ = clamp(input.move[1], -1, 1);
    e.yaw = input.yaw;
    e.buttons = input.buttons;
  }

  /** Advance the whole world by `dt` seconds (fixed step). */
  step(dt: number): void {
    const d = PLAYER_SPEED * dt;
    for (const e of this.entities.values()) {
      e.x = clamp(e.x + e.moveX * d, -ARENA_HALF, ARENA_HALF);
      e.z = clamp(e.z + e.moveZ * d, -ARENA_HALF, ARENA_HALF);
    }
  }

  /** Build the thin authoritative snapshot for all entities. */
  buildSnapshot(tick: number, serverTimeMs: number): SnapshotMessage {
    const players: PlayerSnapshot[] = [];
    for (const e of this.entities.values()) {
      let flags = FLAG_GROUNDED;
      if ((e.buttons & FLAG_FIRING) !== 0) flags |= FLAG_FIRING;
      players.push({
        id: e.id,
        pos: [e.x, 0, e.z],
        yaw: e.yaw,
        flags,
        seq: e.lastSeq,
      });
    }
    return { tick, serverTimeMs, players };
  }
}
