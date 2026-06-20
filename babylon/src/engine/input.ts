import { KeyboardEventTypes } from "@babylonjs/core/Events/keyboardEvents";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { KeyboardInfo } from "@babylonjs/core/Events/keyboardEvents";
import type { PointerInfo } from "@babylonjs/core/Events/pointerEvents";
import type { SampleContext } from "../samples/types";

/**
 * Reusable input for the Babylon playground: keyboard key-state polling plus
 * pointer-lock mouse-look accumulation. It is built on Babylon's *scene*
 * observables (`onKeyboardObservable`, `onPointerObservable`), which are owned
 * by the scene and torn down by `scene.dispose()` — the gallery disposes the
 * whole scene on every sample switch, so this design is leak-safe for that
 * lifecycle by construction.
 *
 * What this module's own `dispose()` still cleans up (because sample dispose
 * runs *before* `scene.dispose()`, and to stay correct if a future caller
 * reuses a scene): it removes its scene observers, drops the `pointerlockchange`
 * DOM listener it added on `document`, and — only if this instance currently
 * holds the lock — exits pointer lock via the engine helper. It does NOT create
 * any engine-scoped resource (no `DeviceSourceManager`, no raw window/canvas
 * listeners beyond the single document `pointerlockchange`), so there is nothing
 * engine-scoped left for it to free.
 */
export interface InputController {
  /** True while the key (by `KeyboardEvent.code`, e.g. "KeyW") is held. */
  isKeyDown(code: string): boolean;
  /**
   * Consume the accumulated raw horizontal look movement (pixels) since the last
   * call, then reset it to 0. Callers apply their own sensitivity scaling.
   */
  consumeLookX(): number;
  /** Same as {@link consumeLookX} for vertical look. */
  consumeLookY(): number;
  /** True while this controller currently owns pointer lock on the canvas. */
  readonly isPointerLocked: boolean;
  /** Detach observers/listeners and release pointer lock if owned. Idempotent. */
  dispose(): void;
}

export interface InputOptions {
  /**
   * Engage pointer lock on a canvas pointer-down gesture (browsers require a
   * user gesture). Default: true.
   */
  pointerLock?: boolean;
}

/**
 * Create an {@link InputController} bound to a sample's context. The concrete
 * `ctx.engine` (an `Engine`, not the abstract base) is required for the
 * pointer-lock helpers. Call the returned controller's `dispose()` from the
 * sample's dispose fn.
 */
export function createInput(
  ctx: SampleContext,
  options: InputOptions = {},
): InputController {
  const { scene, canvas } = ctx;
  const engine = ctx.engine;
  const usePointerLock = options.pointerLock ?? true;

  const pressed = new Set<string>();
  let lookX = 0;
  let lookY = 0;
  let pointerLocked = false;
  let disposed = false;

  // --- Keyboard: scene-owned observable (cleared by scene.dispose). ---
  const keyboardObserver: Observer<KeyboardInfo> | null =
    scene.onKeyboardObservable.add((info) => {
      const code = info.event.code;
      if (info.type === KeyboardEventTypes.KEYDOWN) {
        pressed.add(code);
      } else if (info.type === KeyboardEventTypes.KEYUP) {
        pressed.delete(code);
      }
    });

  // --- Pointer: scene-owned observable for down (lock) + move (look). ---
  const pointerObserver: Observer<PointerInfo> | null =
    scene.onPointerObservable.add((info) => {
      if (info.type === PointerEventTypes.POINTERDOWN) {
        if (usePointerLock && document.pointerLockElement !== canvas) {
          // Must originate from a user gesture; pointer-down qualifies.
          engine.enterPointerlock();
        }
        return;
      }
      if (info.type === PointerEventTypes.POINTERMOVE) {
        if (!usePointerLock || document.pointerLockElement !== canvas) return;
        lookX += info.event.movementX;
        lookY += info.event.movementY;
      }
    });

  // --- Pointer-lock state tracking (document-scoped DOM listener). ---
  // This is the one listener NOT owned by the scene; dispose() removes it.
  const onPointerLockChange = (): void => {
    pointerLocked = document.pointerLockElement === canvas;
    if (!pointerLocked) {
      // Drop stale look deltas when focus/lock is lost (e.g. user pressed Esc).
      lookX = 0;
      lookY = 0;
    }
  };
  if (usePointerLock) {
    document.addEventListener("pointerlockchange", onPointerLockChange);
  }

  return {
    isKeyDown(code: string): boolean {
      return pressed.has(code);
    },
    consumeLookX(): number {
      const v = lookX;
      lookX = 0;
      return v;
    },
    consumeLookY(): number {
      const v = lookY;
      lookY = 0;
      return v;
    },
    get isPointerLocked(): boolean {
      return pointerLocked;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.onKeyboardObservable.remove(keyboardObserver);
      scene.onPointerObservable.remove(pointerObserver);
      if (usePointerLock) {
        document.removeEventListener("pointerlockchange", onPointerLockChange);
        // Only release the lock if THIS controller currently owns it.
        if (document.pointerLockElement === canvas) {
          engine.exitPointerlock();
        }
      }
      pressed.clear();
      pointerLocked = false;
    },
  };
}
