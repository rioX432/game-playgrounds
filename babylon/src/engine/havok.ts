import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import HavokPhysics from "@babylonjs/havok";

// The Havok WASM runtime is the expensive part (fetch + compile + Emscripten
// init), so we memoize the resolved module exactly once. The HavokPlugin,
// however, must NOT be cached: its native world is created in the constructor
// and released by `dispose()`, which `scene.dispose()` triggers on sample
// switch. A cached plugin would be dead for every physics sample after the
// first. So we build a fresh plugin per call from the warm WASM module.
let havokModulePromise: Promise<Awaited<ReturnType<typeof HavokPhysics>>> | null = null;

/**
 * Builds a fresh HavokPlugin backed by the cached Havok WASM runtime.
 *
 * The WASM module is loaded once and reused; each call constructs a NEW
 * HavokPlugin (with its own native world) because the plugin's world is owned
 * with a per-scene lifetime — `scene.dispose()` disposes the plugin. The plugin
 * only references the shared module, it does not take ownership of it, so
 * constructing many plugins from one module is safe.
 *
 * Gotcha: `HavokPhysics()` fetches a `.wasm` asset. Under Vite we exclude
 * `@babylonjs/havok` from optimizeDeps (see vite.config.ts) so the binary is
 * served untouched.
 *
 * Async-race pitfall: if the caller has already switched away by the time this
 * resolves, the returned plugin was never handed to a scene and will leak its
 * native world. Callers must `plugin.dispose()` in their disposed-guard branch.
 */
export async function createHavokPlugin(): Promise<HavokPlugin> {
  if (!havokModulePromise) {
    havokModulePromise = HavokPhysics();
  }
  const havok = await havokModulePromise;
  return new HavokPlugin(true, havok);
}
