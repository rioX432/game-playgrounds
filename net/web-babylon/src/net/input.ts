// Keyboard input capture. Produces the thin PlayerInput axis the server
// integrates authoritatively — the client never moves itself locally (no
// prediction; this sample is deliberately low-twitch, see the issue).

import { FLAG_FIRING } from "net-protocol";

/** A sampled control state ready to fold into a PlayerInput. */
export interface InputSample {
  /** Planar move axis, each component in [-1, 1]. */
  move: [number, number];
  /** Desired facing yaw, radians (atan2 of the move direction). */
  yaw: number;
  /** Pressed-button bitfield (FLAG_* from net-protocol). */
  buttons: number;
}

/**
 * Pure axis derivation from a set of held key codes (no DOM). The move axis is
 * normalized so diagonals are not faster than cardinals; yaw faces the move
 * direction and HOLDS `prevYaw` while idle so a released stick does not snap the
 * facing back to zero. Extracted from the DOM class so it is unit-testable.
 */
export function deriveInput(
  pressed: ReadonlySet<string>,
  prevYaw: number,
): InputSample {
  let x = 0;
  let z = 0;
  if (pressed.has("KeyA") || pressed.has("ArrowLeft")) x -= 1;
  if (pressed.has("KeyD") || pressed.has("ArrowRight")) x += 1;
  if (pressed.has("KeyW") || pressed.has("ArrowUp")) z -= 1;
  if (pressed.has("KeyS") || pressed.has("ArrowDown")) z += 1;

  let yaw = prevYaw;
  const len = Math.hypot(x, z);
  if (len > 0) {
    x /= len;
    z /= len;
    yaw = Math.atan2(z, x);
  }

  let buttons = 0;
  if (pressed.has("Space")) buttons |= FLAG_FIRING;

  return { move: [x, z], yaw, buttons };
}

// Codes consumed by movement/fire — their default browser action (scrolling on
// arrows/space) is suppressed while focused.
const MOVE_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
]);

/** Tracks held keys and derives an InputSample on demand. */
export class KeyboardInput {
  private readonly pressed = new Set<string>();
  private lastYaw = 0;
  private target: Window | null = null;

  /** Begin listening on the given window. */
  attach(target: Window): void {
    this.target = target;
    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
    target.addEventListener("blur", this.onBlur);
  }

  /** Stop listening and clear state. */
  dispose(): void {
    this.target?.removeEventListener("keydown", this.onKeyDown);
    this.target?.removeEventListener("keyup", this.onKeyUp);
    this.target?.removeEventListener("blur", this.onBlur);
    this.target = null;
    this.pressed.clear();
  }

  /** Current control state. Yaw holds its last value while idle. */
  sample(): InputSample {
    const out = deriveInput(this.pressed, this.lastYaw);
    this.lastYaw = out.yaw;
    return out;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (MOVE_CODES.has(e.code)) {
      e.preventDefault();
      this.pressed.add(e.code);
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.pressed.delete(e.code);
  };

  // Releasing focus must not leave keys stuck "down".
  private readonly onBlur = (): void => {
    this.pressed.clear();
  };
}
