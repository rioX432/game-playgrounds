import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import HavokPhysics from "@babylonjs/havok";

let pluginPromise: Promise<HavokPlugin> | null = null;

/**
 * Loads the Havok WASM runtime exactly once and returns a HavokPlugin.
 *
 * Gotcha: `HavokPhysics()` fetches a `.wasm` asset. Under Vite we exclude
 * `@babylonjs/havok` from optimizeDeps (see vite.config.ts) so the binary is
 * served untouched. The HavokPlugin instance is reusable across scenes; only
 * the per-scene `scene.enablePhysics(gravity, plugin)` call is repeated.
 */
export async function getHavokPlugin(): Promise<HavokPlugin> {
  if (!pluginPromise) {
    pluginPromise = HavokPhysics().then((havok) => new HavokPlugin(true, havok));
  }
  return pluginPromise;
}
