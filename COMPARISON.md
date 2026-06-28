# Cross-Engine Findings — Three.js vs Babylon.js vs Bevy

This is the payoff of the playground: the **same 12 game mechanics** built in
three engines, and what we learned by actually touching them. It synthesizes the
honest feel notes recorded per sample (see each sample's `README.md` / module
header) plus measured code size and the AI-agent development experience.

> **Read this as opinion grounded in the samples, not a benchmark.** Where a claim
> is qualitative (feel, "performance is fine"), it says so. Where a gap exists
> (no load test yet), it says so too.

> **Parity note (important).** An early draft of this doc compared the engines
> assuming the three ports were mechanically equal. A later cross-engine code
> review (Claude Code + Codex, June 2026) found the **Bevy** ports were quietly
> *simplified* on several demos — 01 (no look/jump/gravity), 02 (shove, not
> grab/hold/throw), 03 (flat quad, one color, click-only), 05 (mono, no panning),
> 06 (box decoys, hard tint), 07 (impulse at the center of mass, no off-center
> spin), 10 (wheel mis-centered off the default window) — while Three.js ↔
> Babylon.js were already tight. Those gaps have since been **closed** (PRs
> #97–#103), plus a Babylon edge-jump fix (#104). The conclusions below now hold
> on near-equal mechanics; where the earlier convergence was partly an artifact
> of Bevy *not implementing* the differing feature, that is called out inline.

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
| **Code size (same mechanics)** | **leanest** (3,757 LOC) | close (3,922) | heaviest (~4,900 logic + ~1,240 tests) |
| **Performance (2000-body stress, 120 Hz Mac)** | 61 fps (16.4 ms) | 76 fps (13.1 ms) | **120 fps capped (~6.3 ms uncapped)** — most headroom (see §5) |
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
| 01 | Character controller | 166 | 153 | 344² |
| 02 | Physics grab & throw | 173 | 152 | 260² |
| 03 | Paint on mesh | 147 | 143 | 411² |
| 04 | First-person controller | 151 | 155 | 305 |
| 05 | Spatial audio | 307 | 320 | 515² |
| 06 | Hide & seek disguise | 333 | 359 | 464² |
| 07 | Ragdoll | 451 | 452 | 746² |
| 08 | Red light, green light | 371 | 382 | 642 |
| 09 | Co-op carry | 505 | 417 | 516 |
| 10 | Emote wheel | 482 | 496 | 740² |
| 11 | Top-down twin-stick | 216 | 192 | 377 |
| 12 | Tiny planet | 455 | 701¹ | 824 |
| | **Total (samples)** | **3,757** | **3,922** | **6,144²** |
| | Shared engine helpers | 741 | 657 | 647 |

¹ Babylon split 12 into `12a` spherical-gravity (280) + `12b` tiny-planet (421).
² Grew when the demo was brought to parity with the TS peers (PRs #97–#103); the
pre-parity figures were 190 / 154 / 240 / 494 / 474 / 701 / 729 and a 5,646 total.

**The Bevy gap is smaller than it looks.** Of Bevy's 6,144 sample LOC, ~1,240 are
inline `#[cfg(test)]` headless tests (the Bevy DoD requires at least one per
sample; the TS playgrounds have none inline). Excluding tests, Bevy sample logic
is **~4,900 LOC — roughly 25% heavier** than the TS versions. Part of that gap is
real parity work: closing the Bevy simplifications (see the Parity note) *added*
~500 LOC of genuine mechanic + test code, so the figure rose rather than fell once
the ports were made equal — which only sharpens the finding that Bevy is the
heaviest. The rest is the honest cost of Rust: explicit type signatures, ECS
plugin/system/component wiring, and more verbose Rapier setup. It buys
compile-time guarantees the TS samples don't get.

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

> **Caveat (the parity trap):** this only holds *after* the Bevy ports were brought
> to parity. Part of the original "identical feel" was an illusion of omission —
> e.g. you can't compare ragdoll-punch feel if Bevy applies the impulse at the
> center of mass (no spin), or spatial-audio direction if Bevy plays mono. Once
> those features were actually implemented (PRs #93, #91, …), the *tuned* feel did
> converge — but the convergence was earned, not free. Verify parity before
> trusting a cross-engine "feel is identical" claim.

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

**One deliberate physics-idiom divergence we kept:** in co-op carry (09) the
Babylon carriers are `ANIMATED` (kinematic) bodies driven by `setTargetTransform`
— they pull the joints but can't be shoved back by the plank — whereas the Three
and Bevy carriers are **dynamic, rotation-locked** bodies the plank *can* perturb.
We left this unequal on purpose: it's exactly the kinematic-vs-dynamic contrast
the playground exists to show, and both reach the same out-of-sync sway.

---

## 5. Performance — honest status

The gameplay samples are all *light* scenes (a few dozen meshes, one ragdoll, ~30
props) and run at frame rate with headroom in all three engines. To put a number
on the headroom, the **stress sample (13-stress-bodies)** — identical tuning in
all three (100-body batches, 0.3 m cubes, 24 m floor, up to 2000 dynamic bodies) —
was measured at matched body counts.

**Method (honest about its limits).** One machine: Apple Silicon Mac, **120 Hz
ProMotion** display. Production builds (`vite preview` for web, `cargo build
--release` for Bevy). The web engines were driven in real headed Chrome over the
DevTools Protocol; Bevy ran natively. The number is the sample's own EMA-smoothed
`ms/frame` read off its HUD at each body count. **Single run, EMA-smoothed, not a
rigorous benchmark** — and physics cost is not isolated from draw cost.

| bodies | Three (Rapier · WebGL) | Babylon (Havok · WebGL) | Bevy (Rapier · native wgpu) |
|------:|:----------------------:|:-----------------------:|:---------------------------:|
| 100   | 8.3 ms (120 fps) | 8.3 ms (120) | 8.3 ms (120) |
| 500   | 8.4 ms (120) | 8.4 ms (119) | 8.4 ms (120) |
| 1000  | 8.3 ms (120) | 8.3 ms (120) | 8.3 ms (120) |
| 1500  | 11.5 ms (87) | 9.7 ms (104) | 8.3 ms (120) |
| 2000  | **16.4 ms (61)** | **13.1 ms (76)** | **8.3 ms (120)** |

**Read it carefully — the 8.3 ms rows are the 120 Hz vsync cap, not the engine.**
Up to ~1000 bodies every engine is display-limited (8.3 ms = 1000/120), so those
rows say nothing about compute headroom. The signal is **where each engine falls
off the cap**:

- **Three (Rapier on WebGL)** saturates first — 87 fps at 1500, **61 fps (16.4 ms)
  at 2000**.
- **Babylon (Havok on WebGL)** holds longer — 104 fps at 1500, **76 fps (13.1 ms)
  at 2000**. On these scenes Havok+Babylon degrades less than Rapier+Three under
  the same WebGL ceiling (a combined physics+draw effect; not isolated here).
- **Bevy (native wgpu)** never drops below the 120 Hz cap, even at 2000 bodies.

To see *Bevy's* true cost (the cap hides it), a second run with **vsync off**:
~3.8 ms at 500 bodies, ~4.4 ms at 1000, ~5.3 ms at 1500, **~6.3 ms (~160 fps) at
2000**. So native renders + simulates the full 2000-body scene in the time the web
engines need just to stay at 60 fps — concretely confirming the `WebGL < native`
ladder. (Web can't be measured uncapped: `requestAnimationFrame` is vsync-locked,
so sub-8.3 ms web cost is simply unobservable in a browser.)

**Caveats this does NOT settle:** one machine / one run; physics vs. draw cost not
separated; deterministic (Bevy) vs. random (web) scatter (negligible for timing);
no WebGPU path measured (would lift the web ceiling); thermal/background-load
variance not controlled.

---

## 6. Deployment to Steam

- **Three / Babylon (web):** wrap the build in **Electron** → `.exe` → Steam.
  (Electron over Tauri for games: more consistent rendering across machines.)
- **Bevy:** already a native `.exe` → Steam, no wrapper.
- **Steam process (all three):** developer signup + $100 (recouped at $1,000
  earned) + store page + upload; you keep 70%.

**Exercised on macOS (arm64).** Both routes have been built end-to-end: the
Three.js build packages into an Electron `.dmg`/`.app` (≈95 MB) that launches and
renders the gallery, and Bevy's `cargo build --release` yields a native ≈95 MB
binary. Native (Bevy) is the shortest path; web needs the Electron shell but
reuses the entire codebase. Still **[maintainer]**: code signing / notarization,
the Windows `.exe` cross-build, and the Steamworks upload (all credential-gated).
See `docs/PACKAGING.md` for the verified commands and the packaged-content-path
fix (`process.resourcesPath`).

---

## 7. What this comparison does NOT establish

- **Load/perf is now measured** (§5) but single-machine / single-run, with
  physics-vs-draw cost not separated and **no WebGPU path** — so it bounds the
  WebGL-vs-native ladder, not the full `WebGL < WebGPU < native` staircase.
- **Steam path exercised** (§6) — Electron shell + native build run locally; the
  **actual store upload is blocked on credentials**, so end-to-end shipping is
  not validated.
- **No networking/multiplayer** — *was* out of scope here; now its own chapter (§8,
  `net/`). This §7 still scopes only the single-machine comparison above.
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
- **Performance ceiling →** Bevy — now measured (§5): native holds the 120 Hz cap
  at 2000 bodies (~160 fps uncapped) while the WebGL engines fall off it. Still
  **no WebGPU path measured**, which could lift the web ceiling.

The next high-value step is to close the staircase's missing middle: measure a
**WebGPU path** (Three's `WebGPURenderer` / Babylon's `WebGPUEngine`) together with
the **Electron/Tauri distribution overhead** of shipping a web engine to Steam.
Only together do they answer whether web is enough for PC/Steam, or whether Bevy's
ceiling actually pays off.

---

## 8. Networking (chapter 2) — measured

> Status: **measured.** Every number below comes from an **actual run on one
> machine** (Apple Silicon, arm64, macOS 26.6, Node v22, Bevy native) over
> **localhost** — same seed (`12345`), same scenario ids/stages across both stacks,
> so the lines join on `scenario` + stage knobs. The raw `metrics.jsonl` evidence
> (six files) lives in `net/measurements/n2/` with the exact commands; this section
> is the synthesis. Schema: `net/protocol/src/metrics.ts` (one `MetricsSample` ==
> one line). Chapter rules: `net/CLAUDE.md`. **This is single-machine / localhost,
> not a WAN or viral-scale benchmark** (see §8.6).

### 8.1 Scope & pattern — and what "cross-engine" really means here

- Server-authoritative simulation + client-side interpolation, the same pattern on
  both stacks. The client never trusts itself; it buffers timestamped snapshots and
  renders from `now − interpDelay`.
- The cross-engine axis is **web stack vs. native stack**, NOT three-vs-babylon:
  - **three and babylon share the SAME Colyseus server** (`net/server`) and the same
    room. Their N2 **server-side** metrics (tick cost, bytes, snapshot cadence) are
    therefore *identical by construction* — they differ only in the **client render**
    layer, which is a chapter-1 (N1) distinction, not a netcode one. So the web runs
    below are emitted once (engine label `three`); a babylon column would be a copy.
  - **Bevy + bevy_replicon + renet** is the independent native stack.
- So read §8 as **"web (Colyseus, three+babylon clients) vs. Bevy native
  (replicon/renet)"**. Presenting three fake-independent server columns would be
  dishonest (Core Value #1).

### 8.2 Measurement axes — and which are actually comparable

The schema shape is identical across engines, but two stacks **cannot mirror every
field's measurement basis**. Before any cross-engine read, separate the two classes
(full gap table: `net/bevy/CLAUDE.md` → "Honest-parity"; chapter note: `net/CLAUDE.md`):

**(a) Truly apples-to-apples — compare these directly:**

- **`serverTickSimMs`** — pure authoritative integration cost. Same definition both
  sides (timed sim set). **The one clean cross-engine performance number.**
- **`injectedDelayCtoSMs` / `injectedDelayStoCMs` / `lossPct`** — the impairment
  *knobs*, identical by definition (`lossPct = max(up,down)`).
- **`snapshotAgeMs`** — same *definition* (interp-buffer depth), and its **response**
  to a knob (rises with injected down-delay, falls with higher tick) is comparable.
  Its **absolute floor is not**: web uses an in-process shared monotonic clock (exact,
  ~1 ms), while the Bevy probe's in-process manual pump quantizes the floor to ≈ one
  tick period **plus interp delay** (so Bevy's floor is ~115–260 ms, not a real-network
  latency). Compare the **shape**, not the absolute.

**(b) Documented parity GAP — do NOT naively compare the two numbers:**

- **`bytesUpPerSec` / `bytesDownPerSec`** — web sizes the **JSON** payload
  (`JSON.stringify` length); Bevy sizes the **postcard** binary payload (replicon's
  native encoder) of only the *changed* components. Different **encoding**, not
  different netcode efficiency. The absolute bytes are incomparable; the **scaling
  with entity count / tick** is.
- **`transportBytesPerSec`** — on Bevy this is **real renet wire bytes**
  (`network_info`, incl. renet framing); on web it is an **estimate** (app payload +
  a constant framing overhead). Different basis entirely.
- **`rttP50Ms` / `rttP95Ms`** — web RTT is an **app-echo** that passes *through* the
  app-level latency shim, so it **includes** injected delay. Bevy RTT is **renet
  transport RTT**, measured *below* the app-level injection, so it **excludes**
  injected delay (GAP 2) and is additionally quantized by the manual pump. Comparing
  the two RTT columns directly is the headline trap of this chapter (§8.4, axis 2).
  (The GAP numbering follows `net/bevy/CLAUDE.md` → "Honest-parity": GAP 1 = both
  stacks inject impairment at the app level, not the transport — see §8.3.)
- **`bytesUpPerSec` under a tick sweep** (GAP 3) — web sends input at a fixed 30 Hz
  regardless of tick; Bevy sends input in `FixedUpdate`, i.e. at the tick rate. So
  uplink is flat on web but scales with tick on Bevy. Don't cross-compare uplink in
  the tick sweep.

### 8.3 Per-engine implementation notes

- **Web (Colyseus, three + babylon).** We **piggyback** Colyseus for rooms /
  transport / routing but broadcast our **own** snapshot frames each tick (no
  `@colyseus/schema` auto-sync) so application bytes are directly measurable and the
  pattern mirrors replicon. Latency/loss is an **app-level `TransportShim`** over
  Colyseus's reliable channel (no real UDP loss / congestion). Bots are
  server-internal entities (no socket); only real connected clients are RTT probes.
- **Bevy (replicon/renet).** Server writes small sim components via `set_if_neq`, so
  replicon sends only **changed** values (an idle player produces no traffic). renet
  2.0 ships **no network conditioner**, so impairment is injected **app-level** too
  (uplink: server folding a received input; downlink: probe client folding a
  replicated mutation into its interp buffer) — same observable effect as the web
  shim, but RTT sits above it (GAP 2). The probe boots a headless server + N real-UDP
  probe clients in one process and pumps `update()` at the tick cadence.

### 8.4 Numbers — the four axes

All runs: `seed=12345`, `clientCount=2`, `WARMUP_MS=500`, `MEASURE_MS=1500`. Bytes
in KB/s. **Web = three+babylon (same server); Bevy = native.** Mind the §8.2 gaps.

**Axis 1 — synchronized-entity ramp** (`n2-stress-ramp`, tick 20, clean link).
*How does cost grow as the synchronized world scales 2 → 100 bots?*

| bots | `serverTickSimMs` **(comparable)** | `bytesDownPerSec` (encoding gap) | `transportBytesPerSec` (basis gap) | `snapshotAgeMs` (shape only) |
|-----:|:--:|:--:|:--:|:--:|
| | web · bevy | web (JSON) · bevy (postcard) | web (est.) · bevy (real wire) | web · bevy |
| 2   | 0.028 · 0.019 ms | 13.8 · 2.1 KB/s | 18.7 · 2.7 KB/s | 0.5 · 115 ms |
| 24  | 0.057 · 0.022 ms | 94.0 · 13.4 KB/s | 98.7 · 5.7 KB/s | 0.8 · 254 ms |
| 100 | 0.124 · 0.025 ms | 370.7 · 53.5 KB/s | 375.5 · 13.6 KB/s | 1.3 · 262 ms |

- **Sim cost (comparable):** both stacks simulate 100 bots in **well under 0.13 ms**
  — i.e. **< 0.3 % of a 50 ms (20 Hz) tick budget**. Neither engine's simulation is
  the bottleneck at this scale; Bevy's is flatter (0.019 → 0.025 ms) than web's
  (0.028 → 0.124 ms), but both are noise against the tick budget.
- **Bytes (gap):** the ~7× web/Bevy downlink ratio at 100 bots (370.7 vs 53.5 KB/s)
  is **mostly the JSON-vs-postcard encoding plus replicon's changed-only delta**, NOT
  "Bevy is 7× more network-efficient as netcode". What *is* comparable is the
  **shape**: both grow ~linearly with entity count.

**Axis 2 — latency tolerance** (`n2-latency-sweep`, tick 20, 24 bots, symmetric
up/down delay). **This is the chapter's headline cross-engine finding.**

| inj. delay (each way) / loss | web `rttP50` · bevy `rttP50` | web `snapshotAge` · bevy `snapshotAge` |
|:--|:--:|:--:|
| 0 ms / 0 %   | 21.6 · 58.4 ms | 1.1 · 229 ms |
| 25 ms / 0 %  | 76.3 · 58.2 ms | 27.5 · 286 ms |
| 50 ms / 0 %  | 123.1 · 58.3 ms | 52.4 · 282 ms |
| 100 ms / 0 % | 215.5 · 58.7 ms | 102.1 · 339 ms |
| 50 ms / 5 %  | 123.2 · 58.8 ms | 52.2 · 272 ms |
| 50 ms / 10 % | 137.7 · 59.8 ms | 52.3 · 275 ms |

- **Web RTT tracks the injected delay** (≈ base + 2×delay: 22 → 76 → 123 → 216 ms),
  because the app-echo passes *through* the shim. **Bevy RTT stays pinned at the
  transport floor (~58 ms) no matter the injected delay** — because injection sits
  *above* netcode (GAP 2). A reader diffing the two RTT columns would wrongly conclude
  "Bevy has rock-steady ~58 ms latency under any network condition." **False** — it's
  a measurement-layer artifact, not a netcode property.
- On Bevy the injected delay surfaces in **`snapshotAge` instead** (229 → 286 → 339 ms
  as delay climbs; noisy because the pump quantizes it). On web it surfaces in **both**
  RTT and `snapshotAge` (≈ the one-way down-delay: 1.1 → 27.5 → 52.4 → 102.1 ms). So the
  honest cross-engine statement is: **latency is observable on different metrics per
  stack; you must read `snapshotAge` to see impairment on the Bevy path.**

**Axis 3 — bandwidth / freshness vs. tick rate** (`n2-tickrate-sweep`, 24 bots, clean).
*Higher tick = fresher snapshots but more bytes — where's the knee?*

| tick | web `bytesDown` · bevy `bytesDown` (encoding gap) | web `bytesUp` · bevy `bytesUp` (GAP 3) | web `snapshotAge` · bevy `snapshotAge` (shape) |
|-----:|:--:|:--:|:--:|
| 10 | 44.8 · 7.1 KB/s | 4.0 · 0.21 KB/s | 1.2 · 439 ms |
| 15 | 70.4 · 9.8 KB/s | 4.1 · 0.29 KB/s | 0.9 · 310 ms |
| 20 | 95.6 · 13.5 KB/s | 4.1 · 0.40 KB/s | 0.8 · 225 ms |
| 30 | 152.4 · 20.2 KB/s | 4.1 · 0.59 KB/s | 0.9 · 139 ms |

- **Downlink scales ~linearly with tick on both** (more snapshots/sec) — the
  comparable *shape*; absolute bytes differ by encoding (§8.2a).
- **Uplink (GAP 3):** web is **flat ~4 KB/s** (input fixed at 30 Hz); Bevy **scales
  with tick** (0.21 → 0.59 KB/s, input in `FixedUpdate`). **Do not cross-compare the
  uplink axis here.**
- **Freshness:** Bevy's `snapshotAge` falls sharply with tick (439 → 139 ms) because
  its floor is ~one tick period; web's is already at its ~1 ms in-process floor so it
  barely moves. Both confirm the qualitative law — higher tick is fresher — but the
  **optimum tick is machine- and stack-dependent** and these localhost numbers don't
  pick a universal winner (§8.6).

**Axis 4 — AI implementation speed (an OBSERVATION, not a verdict).** Building the web
side went faster than the Bevy side, but this is **confounded by training-data
volume**, exactly like chapter 1's "stale training data is the trap":

- Colyseus + `colyseus.js` have years of examples in the training set; the idioms
  came out roughly right on the first pass.
- `bevy_replicon 0.40` / `bevy_replicon_renet 0.16` / `renet 2.0` on **Bevy 0.18** are
  recent and sparsely represented; LLM training data is full of **older replicon/renet
  APIs that do not compile** (message-vs-event APIs, `Channel` variants, resource-vs-
  state types). Most Bevy time was spent re-verifying API names against docs.rs and
  the version-matched example, not on netcode logic.
- So **"web was faster to build with an AI agent" is an observation about library
  maturity + training-data coverage, NOT evidence that replicon is a worse
  abstraction.** Recorded honestly; not asserted as an engine verdict.

### 8.5 Feel / friction (honest per-stack notes, same spirit as §3/§4)

- **Web (Colyseus):** the room/transport/routing batteries are genuinely included;
  the friction was *resisting* them — keeping our own snapshot frames instead of
  letting `@colyseus/schema` auto-sync, so bytes stay measurable and the pattern
  mirrors replicon. The app-level shim is honest but is **not** real UDP impairment
  (no retransmit/congestion/HOL modelling).
- **Bevy (replicon):** `set_if_neq` + changed-only replication is a clean, idiomatic
  win (idle players cost nothing) and the type system caught real mistakes. The
  friction is real and twofold: **(1)** version-pin landmines (0.41/0.17 jump to Bevy
  0.19 — pins are EXACT `=`), and **(2)** renet ships no conditioner and takes a
  concrete `UdpSocket`, so impairment had to go app-level and RTT can't see it (GAP 2).
  The in-process manual pump quantizes RTT/`snapshotAge` floors to ~one tick — precise
  on bytes and tick-cost, coarse on absolute latency.
- **Net feel:** both reach a correct server-authoritative + interpolation pattern with
  comparable per-tick sim cost. The web path is faster to stand up; the Bevy path
  gives real wire-byte accounting and correctness-by-construction once the pins are
  nailed. Neither "feels" better as netcode at this scale — the differences are in
  *what you can measure* and *how much training data smooths the build*.

### 8.6 What §8 does NOT establish

Mirrors §7 — scope honesty is the point of the chapter.

- **Single-machine / localhost only.** No WAN, no real RTT, no jitter, no real NAT/
  hole-punching, no UDP transport loss (web loss is an app-level dropped frame; Bevy
  loss is an app-level fold skip). Nothing here predicts behavior over the public
  internet.
- **No viral-scale or cloud-cost behavior.** 2 probe clients + ≤100 server bots on one
  box says nothing about thousands of real connections, horizontal scaling, or hosting
  $/CCU. "It's cheap at 100 bots locally" ≠ "it's cheap at scale".
- **No cross-engine RTT *absolute*.** By construction the two stacks measure RTT at
  different layers (GAP 2) and Bevy quantizes it; only `serverTickSimMs`,
  `injectedDelay*`, `lossPct`, and the *shape* of `snapshotAge`/bytes are
  cross-comparable.
- **Tick-rate optimum is machine-dependent.** The sweep shows the *trend*, not a
  universal best tick.
- **Client-render-under-load: pipeline established (§8.7), real-GPU magnitudes
  deliberately not.** The measurement *pipeline* now exists and is wired across all
  three engines — the `ClientRenderSample` sidecar contract, the shared pure sampler,
  and a checked-in TS↔Rust parity fixture (#166 three / #167 babylon / #168 bevy). What
  is **still not established** is **real-GPU cross-stack absolute magnitudes**: the
  committed web sidecars are headless software-WebGL (SwiftShader) smokes, Bevy has no
  committed sidecar (this environment has no GPU window), and web↔bevy is a §8.2 basis
  GAP regardless. So only the *shape* of frame-time under load (intra-stack) and the
  sampler math (true parity) are comparable; absolute render numbers across stacks
  remain out of scope by design. (§8's server-side numbers are still identical across
  the two web clients on purpose — that part is unchanged.)
- **No voice / audio chat — and not a later chapter either.** Real-time voice
  differentiates *transport topology* (WebRTC mesh vs. SFU vs. raw-over-datachannel)
  and *platform* (browser WebRTC vs. native `webrtc-rs`), **not the three render
  engines** — so it fails the Core Value one-step test and is now a **Won't Do**
  (see root `CLAUDE.md`; supersedes the earlier "later chapter" note). Issue #161.
- **Bytes are not wire-comparable across engines** (JSON vs postcard; estimate vs real
  renet bytes) — see §8.2; only intra-stack scaling is meaningful.

### 8.7 Client render-under-load — the pipeline, and why magnitudes aren't cross-engine

§8.1–§8.6 are all *server-side / netcode* numbers (tick cost, bytes, RTT, snapshot
age). This subsection is the other half — **per-client render performance under the
same N2 load** — and it is deliberately a **pipeline + comparability** writeup, **not
a results table**, because there are **no real-GPU cross-engine magnitudes to report
yet** (see "Methodology honesty" below). That absence is the honest state, by design,
not an omission (Core Value #1). It refines the §8.6 bullet of the same name.

**What it measures.** Per-client **fps + frame-time p50/p95** over a fixed wall-clock
window while the server runs the N2 bot ramp, recorded as a `ClientRenderSample`
(`net/protocol/src/clientRender.ts`) — one line per measurement window in a **sidecar**
`client-render.jsonl`, NOT a field on the server `MetricsSample`. The sidecar carries
the same join keys as the server line (`scenario` / `engine` / `seed` / `tickRate` /
`botCount` + impairment knobs) and **LEFT JOINs** onto `metrics.jsonl`. `clientCount`
is deliberately **excluded** from the join: a render probe connects exactly ONE real
rendering client (plus the server's bots), so `clientCount=1` is **structural** — it
does not reproduce the 2-client server stages of §8.4 (mind the ~1-entity
rendered-load delta). Why a sidecar and not extra `MetricsSample` columns: web fps
comes from rAF deltas, Bevy fps from frame-time diagnostics — a §8.2-class parity gap —
so folding them onto every server tick would falsely imply one comparable "client
truth" exists per tick. It does not. (Rationale: `clientRender.ts` header +
`net/CLAUDE.md` "metrics.jsonl convention".)

**The three probes.** All reuse the SAME sidecar contract and the SAME pure sampler:

| stack | probe (#) | `measurementBasis` | raw frame-delta source |
|-------|-----------|--------------------|------------------------|
| three (`net/web-three`, #166) | `?probe=1` rAF loop | `web-raf-dt` | `requestAnimationFrame` present-to-present dt |
| babylon (`net/web-babylon`, #167) | `?probe=1` render loop | `web-raf-dt` | `performance.now()` per `runRenderLoop` frame |
| bevy (`net/bevy`, #168) | windowed `--client` probe | `bevy-frame-diagnostics` | `FRAME_TIME` diagnostic (raw `Time<Real>` delta) |

In all three the raw per-frame deltas pass through one shared pure function —
`aggregateRenderWindow` (TS) / `aggregate_render_window` (Rust) — that computes fps +
p50/p95 by a single nearest-rank rule, drops the first frame, excludes
tab-throttle/suspend deltas (`> THROTTLE_MAX_MS = 250`), and keeps ordinary foreground
spikes in the p95 tail. The smoothed HUD fps (three/babylon EMA, Bevy `.smoothed()`)
is **never** fed in — that would smear the tail. The TS and Rust samplers are pinned
**numerically identical** by a checked-in cross-language parity fixture
(`net/protocol/src/clientRenderFixtures.json`), asserted by both a TS test and the
Rust `client_render::tests::matches_shared_parity_fixture`.

**Comparability (the §8.2 (a)/(b) split, applied to render).**

**(a) What IS comparable:**

- The **sampler math** is **true parity** — same fixture, identical fps/percentile
  output for identical deltas, across TS and Rust. A verified equality, not a claim.
- The **SHAPE** of frame-time p50/p95 **as `botCount` grows, *within a single
  stack*** — does a client's frame cost degrade as the synchronized world scales
  2 → 24 → 100? That trend is meaningful intra-stack.
- three ↔ babylon is a **real, independent** render comparison (not a server-style
  "copy"): the two `*-client-render.jsonl` files are separate measurements of the same
  scenario/seed/tick/bot load through the same sampler — **but only on the same
  rendering basis** (see (b)).

**(b) What is NOT comparable:**

- **Absolute fps / frame-time across web ↔ bevy** — browser rAF vs native window/GPU +
  wgpu is a §8.2 measurement-basis **GAP** (`web-raf-dt` vs `bevy-frame-diagnostics`).
  Never cross-compare those magnitudes; only the shape-under-load is shared.
- Even **three ↔ babylon absolute magnitudes** are meaningful only on the **same
  rendering basis**. The illustration below shares one (software-WebGL), so it is
  same-basis — but it is software-rendered, not a real-GPU verdict.
- **fps is a ceiling indicator, not throughput.** A windowed/vsync-capped client
  flattens fps at the refresh rate and hides headroom, so **frame-time p50/p95 is the
  primary metric** and fps is read as a saturated cap (explicit in `net/bevy/CLAUDE.md`
  → "vsync caveat").

**Methodology honesty — why there is no real-GPU cross-engine table.** The
load-bearing caveat:

- The **committed web sidecars are headless software-WebGL (SwiftShader) smokes** —
  `net/measurements/n2/web-three-client-render.jsonl` and
  `web-babylon-client-render.jsonl`. Headless Chromium renders WebGL through
  SwiftShader, so their **fps / frame-time magnitudes are software-rendered, NOT
  real-GPU**. The pipeline and sample shape are faithful; the magnitudes are not.
- **Bevy has no committed sidecar at all** — by design, not omission. The windowed
  probe needs a real GPU window, this environment has none, and a headless
  `MinimalPlugins` run would time the `ScheduleRunner` loop rather than real render
  frames; committing that would be a faked magnitude. The sampler + cross-language
  parity are headless-tested instead (`cd net/bevy && cargo test`).
- So **real-GPU cross-stack render magnitudes are NOT established in this chapter, by
  design.** The exact commands to produce honest real-GPU sidecars live in the
  per-engine READMEs (`net/web-{three,babylon}/README.md` → "Client-render probe") and
  `net/bevy/CLAUDE.md` → "Manual real-GPU run".

*Illustration only — software-WebGL smoke; shape-not-magnitude; three/babylon
same-basis only; bevy not yet captured.* The committed web smokes (`n2-stress-ramp`,
24 bots, tick 20, clean link, `clientCount=1`, 3 windows each), per
`net/measurements/n2/web-{three,babylon}-client-render.jsonl`:

| stack (software-WebGL smoke, SwiftShader) | `clientFps` | frame-time p50 | frame-time p95 |
|-------------------------------------------|:-----------:|:--------------:|:--------------:|
| three | ~74 | ~16.5 ms | ~17 ms |
| babylon | ~76 | ~12.9 ms | ~14.7 ms |
| bevy | — not captured (needs a real GPU window) — |||

**Do NOT read this as a render verdict.** It shows only that the pipeline emits
well-formed same-shape samples and that three/babylon are independently measured. It
does **not** say babylon out-renders three (both are SwiftShader *software* numbers
near a software ceiling, not GPU throughput), and it says **nothing** about web vs
bevy (a basis GAP). Real-GPU numbers replace this illustration when the probes are run
on a GPU per the README/`CLAUDE.md` commands above — that is the honest next step, and
it closes the #160 epic on a measurement *pipeline*, not a fabricated table.
