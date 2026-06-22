# Cross-Engine Findings — Three.js vs Babylon.js vs Bevy

This is the payoff of the playground: the **same 12 game mechanics** built in
three engines, and what we learned by actually touching them. It synthesizes the
honest feel notes recorded per sample (see each sample's `README.md` / module
header) plus measured code size and the AI-agent development experience.

> **Read this as opinion grounded in the samples, not a benchmark.** Where a claim
> is qualitative (feel, "performance is fine"), it says so. Where a gap exists
> (no load test yet), it says so too.

- **The lineup:** character controller · grab & throw · paint-on-mesh ·
  first-person · spatial audio · hide-and-seek disguise · ragdoll ·
  red-light/green-light · co-op carry · emote wheel · top-down twin-stick ·
  tiny-planet gravity.
- **The four questions** (from the root README): *Buildability / AI-dev fit*,
  *Feel*, *Performance*, *Deployment*.

---

## TL;DR verdict

| Axis | Three.js | Babylon.js | Bevy |
|------|----------|-----------|------|
| **AI-dev fit** | ◎ fast loop, tiny surface | ◎ fast loop, batteries-included | ○ slow compiles, but `cargo check` + types catch bugs early |
| **Feel (these mechanics)** | same as Babylon — feel came from *our* tuning, not the engine | same as Three | same — identical tuning, identical feel |
| **Physics ergonomics** | manual Rapier step + transform sync | **Havok auto-steps & syncs** (least boilerplate) | manual Rapier, but writes back to `Transform` for you |
| **Code size (same mechanics)** | **leanest** (3,757 LOC) | close (3,922) | heaviest (~4,550 logic + ~1,100 tests) |
| **Performance (these scenes)** | fine (WebGL) | fine (WebGL) | fine (native), most headroom — *not load-tested* |
| **Deployment to Steam** | wrap in Electron | wrap in Electron | already a native `.exe` |

**One-line take:** for *these* light, single-machine mechanics the three engines
land in the same place on *feel*; the real differences are **developer
ergonomics** (Babylon does the most for you; Three is the smallest; Bevy trades
compile time for compile-time safety) — not the pixels.

---

## 1. Code size & shape

Measured (`wc -l`) on sample source only:

| # | Mechanic | Three | Babylon | Bevy |
|---|----------|------:|--------:|-----:|
| 01 | Character controller | 166 | 153 | 190 |
| 02 | Physics grab & throw | 173 | 152 | 154 |
| 03 | Paint on mesh | 147 | 143 | 240 |
| 04 | First-person controller | 151 | 155 | 305 |
| 05 | Spatial audio | 307 | 320 | 494 |
| 06 | Hide & seek disguise | 333 | 359 | 474 |
| 07 | Ragdoll | 451 | 452 | 701 |
| 08 | Red light, green light | 371 | 382 | 642 |
| 09 | Co-op carry | 505 | 417 | 516 |
| 10 | Emote wheel | 482 | 496 | 729 |
| 11 | Top-down twin-stick | 216 | 192 | 377 |
| 12 | Tiny planet | 455 | 701¹ | 824 |
| | **Total (samples)** | **3,757** | **3,922** | **5,646** |
| | Shared engine helpers | 741 | 657 | 647 |

¹ Babylon split 12 into `12a` spherical-gravity (280) + `12b` tiny-planet (421).

**The Bevy gap is smaller than it looks.** Of Bevy's 5,646 sample LOC, ~1,099 are
inline `#[cfg(test)]` headless tests (the Bevy DoD requires at least one per
sample; the TS playgrounds have none inline). Excluding tests, Bevy sample logic
is **~4,547 LOC — roughly 20% heavier** than the TS versions. That remainder is
the honest cost of Rust: explicit type signatures, ECS plugin/system/component
wiring, and more verbose Rapier setup. It buys compile-time guarantees the TS
samples don't get.

**Three is consistently the leanest** because Three.js is a *rendering library* —
you compose Rapier and a few helpers and nothing else is in the way. Babylon is a
hair larger per sample but bundles more (FollowCamera, PhysicsAggregate,
DynamicTexture, observables) so the *logic* you write is comparable.

---

## 2. AI-developability (the real differentiator)

This repo was built almost entirely by Claude Code's `/dev-all` loop (one issue →
one PR → green build → next). What actually mattered:

**Three / Babylon (TypeScript):**
- **Tight loop.** `vite` hot-reload + `tsc --noEmit` gives sub-second feedback.
  The agent's edit→verify cycle is essentially instant.
- **Small failure surface.** A type error is local to one sample; the gallery
  isolates samples so one red build doesn't hide others.
- **Babylon is more "batteries included"** — fewer decisions per sample (the
  camera, physics aggregate, texture all exist), which is *easier* for an agent
  that would otherwise have to assemble them. Three asks the agent to compose more
  but keeps each piece obvious.

**Bevy (Rust):**
- **Compiles are slow** — the first build of Bevy is minutes; this is the single
  biggest tax on AI iteration. The subdir is tuned to fight it: **`cargo check`
  first** (skips codegen/link), `dynamic_linking` for runs, a shared
  `CARGO_TARGET_DIR` across worktrees, optional `lld`/`mold`.
- **The borrow checker and the type system pay back the wait.** Errors are precise
  and *at compile time* — for an autonomous agent, a class of runtime bugs simply
  never ships. Strictness is a net win when no human is watching the window.
- **Stale training data is the trap.** LLMs emit pre-0.15 Bevy APIs that don't
  compile (`PbrBundle`, `StateScoped`, `delta_seconds()`, `Res<RapierContext>`).
  Pinning to 0.18 and referencing a known-good project (`avvy-world`) was
  essential — see `bevy/CLAUDE.md` "Bevy 0.18 gotchas".
- **Headless `#[test]` (MinimalPlugins)** let the agent verify mechanic logic
  without a GPU window — a real advantage for unattended runs.

**Verdict:** all three are genuinely AI-developable because all three are
**code-first, no GUI editor** (the property that rules out Unity/Unreal for this
workflow). Web wins on raw iteration speed; Bevy wins on "if it compiles, it's
more likely correct." For *rapid* agent iteration, Three/Babylon. For a codebase
where compile-time guarantees matter more than loop speed, Bevy.

---

## 3. Feel — and the surprising finding

The honest feel notes across 36 sample writeups converge on one thing:

> **For these mechanics, feel was driven by our implementation choices, not by the
> engine.** The same tuning produced the same feel in all three.

Recurring verdicts that appear **identically** in Three, Babylon, *and* Bevy:
- **"arcade-stiff / slidey-free"** — every movement sample uses instant
  accel/decel (no momentum), so all three feel snappy-but-robotic. That's our
  choice, reproduced faithfully, not an engine trait.
- **"floaty mid-jump"** — air control equals ground control in every FPS sample.
- **"ragdoll jank is the point"** — constraint-only joints with no muscle tone
  collapse the same way under Rapier (Three/Bevy) and Havok (Babylon).
- **"no real seeker / honor-system stealth"**, **"continuous pure tones are
  unpleasant"**, **"twin-stick aim is non-uniform near screen edges on a tilted
  camera"** — all engine-independent, all documented honestly.

Where the engine *did* change feel, it was small and indirect:
- **Camera smoothing** is the highest-leverage feel knob (tiny-planet 12a→12b: the
  raw snap-every-frame follow is "borderline nauseating"; frame-rate-independent
  damping `t = 1 - exp(-rate·dt)` fixes it). This is identical work in all three.
- **Physics solver "rubberiness"** reads slightly differently between Havok and
  Rapier in the grab/hold spring, but both are tunable to the same place.

**Takeaway:** don't pick an engine for "feel" on mechanics like these. Pick it for
ergonomics and reach. Feel is in your tuning constants.

---

## 4. Engine-specific friction (the gotchas that actually bit)

| Theme | Three.js | Babylon.js | Bevy |
|-------|----------|-----------|------|
| **Coordinate system** | right-handed, forward **−Z** | **left-handed, forward +Z** → recurring `atan2` / facing sign bugs | right-handed, forward **−Z** |
| **Physics integration** | manual `world.step()` + copy translation/rotation to meshes every frame | **auto-steps and syncs** — least code; `PhysicsAggregate` bundles body+shape | manual stepping, but `bevy_rapier` writes pose back to `Transform` for you |
| **Physics init** | async WASM (`RAPIER.init()`), needs `disposed` guard + `world.free()` | async WASM (`HavokPhysics()`), needs Vite `optimizeDeps.exclude`, singleton, `disposed` guard | native — no WASM, no async init race |
| **Audio** | WebAudio autoplay policy: starts suspended, resume on gesture; `AudioContext` is a cached singleton — *suspend, don't close* | same WebAudio constraints; `audioSceneComponent` side-effect import mandatory | autoplay needs **no gesture**; custom source via `Decodable` + `rodio` |
| **Resource cleanup** | removing a mesh does **not** free geometry/material — track & dispose explicitly | `scene.dispose()` frees observables but **not** `Sound`s on the audio singleton | `DespawnOnExit(state)` auto-cleans entities; **`Resource`s are not cleared** — reset them in `OnEnter` |
| **Imports** | plain ESM | tree-shaken: side-effect imports per builder/component (easy to forget) | normal Rust `use` |

**Net:** Babylon does the most physics work for you (auto-step + auto-sync) but
makes you manage tree-shaken imports and a left-handed basis. Three is the most
explicit and the most transparent. Bevy removes the entire web-WASM/async/autoplay
class of problems but adds ECS lifecycle rules (despawn vs. resource reset).

---

## 5. Performance — honest status

**Not yet rigorously benchmarked.** Every sample here is a *light* scene (a few
dozen meshes, one ragdoll, ~30 props), and all three engines run them at frame
rate with headroom. That is the honest extent of what we can claim today.

What we can say from architecture (see the root README "performance ladder"):
`WebGL < WebGPU < native`. Bevy (native wgpu) has the most ceiling; Three/Babylon
on WebGL are the entry tier but **plenty for the light games this playground
targets**. The gap only appears under heavy load — which we have **not** stress-
tested. A proper comparison needs a stress sample (thousands of bodies / draw
calls) and frame-time capture in each engine. **That is the most valuable missing
piece of this repo** and the obvious next issue.

---

## 6. Deployment to Steam

- **Three / Babylon (web):** wrap the build in **Electron** → `.exe` → Steam.
  (Electron over Tauri for games: more consistent rendering across machines.)
- **Bevy:** already a native `.exe` → Steam, no wrapper.
- **Steam process (all three):** developer signup + $100 (recouped at $1,000
  earned) + store page + upload; you keep 70%.

Not yet exercised in this repo (no sample has been packaged). Native (Bevy) is the
shortest path; web needs the Electron shell but reuses the entire codebase.

---

## 7. What this comparison does NOT establish

- **No load/perf benchmark** (§5) — light scenes only.
- **No packaged build** — Steam path is researched, not done.
- **No networking/multiplayer** — out of scope by design (a separate spike).
- **No hand-made art** — primitives/procedural only, so this says nothing about
  asset pipelines or shader authoring.
- **Feel is single-evaluator and qualitative** — recorded honestly per sample, but
  not user-tested.

---

## Bottom line

For light, single-machine, PC/Steam-first mechanics:

- **Fastest to build with an AI agent →** Three.js or Babylon.js. Babylon if you
  want batteries included; Three if you want the smallest, most transparent code.
- **Most correctness-by-construction →** Bevy, if you can absorb the compile
  times (and the subdir is tuned to minimize them).
- **Feel →** a wash; it lives in your tuning, so don't let it decide.
- **Performance ceiling →** Bevy, but unproven here and irrelevant until a game is
  actually heavy.

The next high-value step is a **stress/perf sample** across all three to turn §5
from "fine, probably" into numbers.
