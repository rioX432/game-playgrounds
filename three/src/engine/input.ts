/**
 * Reusable input module: keyboard state + pointer-lock mouse look.
 *
 * Samples create an InputController in `mount`, read its state in their update
 * loop, and call `dispose()` in their cleanup function. The controller owns all
 * of its DOM event listeners and removes every one of them on `dispose`, so
 * switching samples never leaks listeners.
 */

export interface InputOptions {
  /**
   * The element that receives pointer lock. Clicking it requests lock; mouse
   * deltas are only accumulated while this element holds the lock.
   */
  pointerLockTarget: HTMLElement;
  /** Mouse-look sensitivity (radians per pixel of movement). */
  lookSensitivity?: number;
  /** Initial yaw in radians (horizontal look). */
  initialYaw?: number;
  /** Initial pitch in radians (vertical look). */
  initialPitch?: number;
  /** Clamp range for pitch in radians [min, max] to avoid camera flip. */
  pitchClamp?: [number, number];
  /**
   * If true, request pointer lock on click of the target. Set false when a
   * sample wants to drive locking itself. Defaults to true.
   */
  lockOnClick?: boolean;
}

const DEFAULT_LOOK_SENSITIVITY = 0.0022;
const DEFAULT_PITCH_CLAMP: [number, number] = [-1.5, 1.5];

/**
 * Tracks keyboard state and pointer-lock-based mouse look. All listeners are
 * registered on construction and removed on `dispose`.
 */
export class InputController {
  /** Set of currently-pressed `KeyboardEvent.code` values. */
  private readonly pressed = new Set<string>();
  /** Codes pressed since the last `consumeJustPressed` / frame poll. */
  private readonly justPressed = new Set<string>();

  private readonly target: HTMLElement;
  private readonly lookSensitivity: number;
  private readonly pitchClamp: [number, number];
  private readonly lockOnClick: boolean;

  private _yaw: number;
  private _pitch: number;

  constructor(options: InputOptions) {
    this.target = options.pointerLockTarget;
    this.lookSensitivity = options.lookSensitivity ?? DEFAULT_LOOK_SENSITIVITY;
    this.pitchClamp = options.pitchClamp ?? DEFAULT_PITCH_CLAMP;
    this.lockOnClick = options.lockOnClick ?? true;
    this._yaw = options.initialYaw ?? 0;
    this._pitch = options.initialPitch ?? 0;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("blur", this.onBlur);
    if (this.lockOnClick) {
      this.target.addEventListener("click", this.onClick);
    }
  }

  /** Horizontal look angle in radians (accumulated from mouse movement). */
  get yaw(): number {
    return this._yaw;
  }

  /** Vertical look angle in radians (clamped to `pitchClamp`). */
  get pitch(): number {
    return this._pitch;
  }

  /** True while the pointer-lock target holds the lock. */
  get isPointerLocked(): boolean {
    return document.pointerLockElement === this.target;
  }

  /** True if the key (a `KeyboardEvent.code`) is currently held down. */
  isDown(code: string): boolean {
    return this.pressed.has(code);
  }

  /** True if any of the given codes is currently held down. */
  isAnyDown(...codes: string[]): boolean {
    return codes.some((c) => this.pressed.has(c));
  }

  /**
   * True if the key was pressed since the last call to this method for that
   * code. Useful for edge-triggered actions (jump, toggles) without tracking
   * previous state in the sample. Consuming clears the flag.
   */
  consumeJustPressed(code: string): boolean {
    if (this.justPressed.has(code)) {
      this.justPressed.delete(code);
      return true;
    }
    return false;
  }

  /** Request pointer lock on the target (e.g. to lock without a click). */
  requestPointerLock(): void {
    if (!this.isPointerLocked) {
      this.target.requestPointerLock();
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.pressed.has(e.code)) {
      this.justPressed.add(e.code);
    }
    this.pressed.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.pressed.delete(e.code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isPointerLocked) return;
    this._yaw -= e.movementX * this.lookSensitivity;
    this._pitch -= e.movementY * this.lookSensitivity;
    const [min, max] = this.pitchClamp;
    this._pitch = Math.max(min, Math.min(max, this._pitch));
  };

  private onClick = (): void => {
    if (!this.isPointerLocked) {
      this.target.requestPointerLock();
    }
  };

  /** Clear held keys when the window loses focus to avoid stuck keys. */
  private onBlur = (): void => {
    this.pressed.clear();
    this.justPressed.clear();
  };

  /** Remove every listener and release pointer lock if held. */
  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("blur", this.onBlur);
    if (this.lockOnClick) {
      this.target.removeEventListener("click", this.onClick);
    }
    if (this.isPointerLocked) {
      document.exitPointerLock();
    }
    this.pressed.clear();
    this.justPressed.clear();
  }
}
