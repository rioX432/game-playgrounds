// Recast (Detour) WASM loader for Babylon's V1 navigation plugin.
//
// Chapter 4 (NPC/AI) foundation. Babylon's engine-integrated `RecastJSPlugin`
// wraps the Recast/Detour navmesh core but does NOT bundle the WASM itself — it
// expects a Recast module to be injected. `recast-detour` ships that module as an
// Emscripten factory (default export: `() => Promise<RecastModule>`). It runs in
// Node with no DOM/GPU, which is what makes the headless navmesh proof possible.
//
// reason: recast-detour ships an ambient namespace-style `.d.ts` whose default
// export type cannot be referenced as a value-level type cleanly, so the loaded
// module is treated as an opaque token. It is only ever handed straight to
// `RecastJSPlugin` (whose `recastInjection` parameter is typed `any`), so the
// loss of structural typing here is contained to this boundary.
import RecastFactory from "recast-detour";

/** Opaque handle to the loaded Recast/Detour Emscripten module. */
export type RecastModule = unknown;

let cached: Promise<RecastModule> | null = null;

/**
 * Load (and memoise) the Recast WASM module. Emscripten init is expensive, so the
 * first call wins and every later caller shares the same module instance.
 */
export function loadRecast(): Promise<RecastModule> {
  if (!cached) {
    // recast-detour's Emscripten glue ends with `this["Recast"] = Module`. Under
    // ESM strict mode (the browser/Vite path) top-level `this` is undefined, so a
    // bare `RecastFactory()` throws "Cannot set properties of undefined". Bind
    // `this` to globalThis so that assignment lands on the global object instead.
    // (Node's CJS path binds `this` to module.exports, which is why the headless
    // NullEngine tests never hit this — see header.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Emscripten factory default export, see file header
    const loading = (RecastFactory as any).call(globalThis) as Promise<RecastModule>;
    // Drop the cache on failure so a transient WASM-init error stays retryable
    // rather than poisoning every later caller with a permanently rejected promise.
    cached = loading.catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}
