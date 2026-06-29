# 16 — Guard AI (FSM: patrol → detect → chase → return)

The minimal NPC of Ch4: a hand-rolled **finite-state machine** guard that
integrates the two earlier building blocks — the navmesh path query (#197 /
sample 14) and **hand-rolled steering** (seek / arrive / avoid). It is the
smallest "whole NPC" (sense → decide → move) and the rehearsal for Ch6's
vertical-slice structure.

## What it demonstrates

- **A four-state FSM**, the canonical enemy-AI loop:
  - **patrol** — loops between two waypoints using hand-rolled steering
    (`arrive` toward the waypoint + `avoid` repulsion from the pillar).
  - **detect** — the player enters sight range; the guard holds and *acquires*
    for `detectDuration` before committing (a deliberate reaction delay).
  - **chase** — follows a **navmesh path** to the player, re-querying when the
    player moves; the path itself routes *around* the central pillar.
  - **return** — the player is lost for `loseDuration`; the guard paths **home**
    and resumes patrol on arrival.
- **A pure, render-independent AI core.** `steering.ts` and `guard.ts` import no
  three.js / DOM. The same `GuardSim` drives both the GPU visualization
  (`index.ts`) and the headless proof (`guard.test.ts`), mirroring the
  `measure/probe` "no-DOM, headless-testable purity" idiom.
- **Two movement styles, deliberately split:** patrol uses local *steering*;
  chase/return *follow a navmesh path* (the path is the global avoidance). This
  exercises both the hand-rolled primitives and the #197 path-following code.

## Controls

The demo is **auto-driven**: a decoy "player" sphere loops on a fixed path that
takes it past the guard's route and across the arena, so all four transitions
play out continuously. The guard capsule is **recoloured by state**:

| Colour | State |
|---|---|
| Blue | patrol |
| Yellow | detect |
| Red | chase |
| Green | return |

- **R** — reset the run.
- The status line shows the current state and the live distances to the player
  and to home.

## Feel & difficulty notes

- **Reads clearly.** The colour-per-state capsule plus the drawn navmesh path
  make the decision layer legible at a glance — you can *see* the guard commit,
  round the pillar, then peel off home.
- **The detect delay matters for feel.** Without `detectDuration` the guard
  snaps from patrol straight into a chase the instant the player clips the sight
  radius, which reads as twitchy/omniscient. The short acquire window makes the
  guard feel like it *noticed* you.
- **Steering is kinematic (no inertia).** `seek/arrive/avoid` return a desired
  velocity that is integrated directly — there is no acceleration or mass, so
  the guard can change direction instantly. That is the honest cost of keeping
  the core deterministic and trivially headless-testable; a force/mass model
  would feel weightier but adds a tuning axis with no cross-engine signal.
- **Chase looks smart for free.** Because chase follows a Recast/Detour path,
  the guard hugs the pillar corner instead of walking into it — the
  "intelligence" is the navmesh, not the FSM.

## Headless test (robust properties only)

`guard.test.ts` drives `GuardSim` with a **scripted player position sequence** at
a fixed timestep and asserts only properties that survive Recast's
non-bit-exact build (design-ch4 §3):

1. **Transition order** — `patrol → detect → chase → return (→ patrol)` in that
   order, with vacuity guards (chase observed for many ticks, chase path
   non-empty).
2. **Waypoint index advances** — the monotonic corner counter increases during
   chase (corridor progress around the pillar). *Not* asserted: monotonic
   distance decrease (the detour breaks it) or an exact path point sequence.
3. **Return reaches home** — the final distance to home when patrol resumes is
   below the arrive threshold.

`steering.test.ts` unit-tests the `seek / arrive / avoid / clampSpeed` math
directly. There is no RNG or wall-clock, so the whole simulation is deterministic
("seed-fixed" by construction).

## Three.js / integration gotchas

- **Fixed-step accumulator.** The visualization advances the FSM in constant
  `1/60 s` slices (decoupled from the render frame) so the AI is frame-rate
  independent and matches the headless test exactly; long frames are clamped and
  the catch-up backlog is bounded so a tab-switch can't teleport anyone.
- **WASM init is async, `mount` is sync.** As in sample 14, `initNavmesh()` is
  kicked off in `mount` and the scene is wired up in its `.then`, guarded against
  a dispose that races the load.
- **Native memory ownership.** `GuardSim` owns one navmesh; the sample frees it
  via `guard.destroy()` and must **not** free `guard.navmesh` directly (the
  getter is for the debug overlay only).

## Findings / follow-ups (out of scope here)

- **No crowd / steering library** — steering is hand-rolled on purpose, to keep
  the three engines on an identical algorithm rather than comparing middleware
  (design-ch4 §4/§5). Detour's crowd is an "engine-provided steering" option on
  the web side only; recorded as a finding, not used.
- **Detection is range-only (no line-of-sight).** The guard "sees" the player
  within `sightRadius` even through the pillar — which conveniently keeps the
  chase alive while the player ducks behind cover. A segment-vs-AABB LoS test
  would be a faithful add but is left as a follow-up to keep the detect rule
  deterministic and minimal.
- **Single guard, no separation.** `separation` (the steering-sample primitive)
  is unneeded with one agent; it would matter for a guard *squad*.
