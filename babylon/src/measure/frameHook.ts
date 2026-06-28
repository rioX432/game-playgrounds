// A single render-loop frame hook the engine bootstrap invokes once per rendered
// frame, right before the draw call. Ordinary interactive play leaves it null (zero
// overhead); measure mode installs a hook to drive the RenderProbe off the REAL
// render cadence.
//
// Why a module-level sink instead of an instance field on the Engine: the Sample
// contract (SampleContext) does not expose the bootstrap Engine instance to samples,
// so a sample's mount() cannot reach an `engine.onFrame` setter. This tiny module is
// the minimal, self-contained bridge between the loop and the measure-mode sample.

let current: ((nowMs: number) => void) | null = null;

/** Install (or clear, with null) the per-frame measure hook. */
export function setFrameHook(hook: ((nowMs: number) => void) | null): void {
  current = hook;
}

/** Invoked by the engine bootstrap once per rendered frame, before the draw. */
export function runFrameHook(nowMs: number): void {
  current?.(nowMs);
}
