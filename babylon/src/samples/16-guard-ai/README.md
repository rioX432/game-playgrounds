# 16 — Guard AI (FSM patrol → detect → chase → return)

The Chapter 4 integration sample: a single NPC that ties together pathfinding
(#198's Recast/Detour navmesh) and a **hand-rolled finite state machine** driven by
**hand-rolled steering** (seek / arrive / avoid — no crowd, no steering library).
It is the minimal version of Ch6's "whole-structure" vertical slice.

## What it demonstrates

- A four-state FSM — **patrol → detect → chase → return** — with explicit,
  testable transition rules:
  - **patrol**: walk a back-and-forth route with *arrive* steering.
  - **detect**: the player entered the view cone (range + FOV + clear
    line-of-sight); hold and confirm the sighting for a short window.
  - **chase**: navmesh-path to the player and pursue with *arrive* steering,
    re-pathing on an interval; detour around the wall through its one gap.
  - **return**: the player stayed beyond the (larger, hysteretic) lose range long
    enough — give up, navmesh-path home, resume patrol.
- **Hand-rolled steering**: `seek`, `arrive` (brakes onto a target), and `avoid`
  (an outward push when overlapping a blocker's footprint), integrated against an
  acceleration cap so turns are smooth. The chase *follows the navmesh waypoints*
  with this steering rather than teleport-snapping.
- **Pure-core / visualization split** (the chapter's architecture): all decision +
  steering logic is render-independent in [`guard.ts`](./guard.ts) and proven
  headless under `NullEngine` in [`guard.test.ts`](./guard.test.ts); this folder's
  `index.ts` only draws it. The headless test asserts **robust** properties —
  transitions fire in the expected order, a chase waypoint index advances over a
  real (≥2-point) path, and the guard closes to within a catch distance — and
  deliberately **not** monotonic distance decrease or exact path equality (both are
  float-sensitive; see the Ch4 design notes).

## Controls

- **Drag** — orbit the near-top-down camera.
- Otherwise hands-off: a **scripted player** loops through the guard's view (far →
  in-view → across the wall → escape) so every FSM state plays automatically. The
  guard capsule is **tinted by state** (blue patrol, yellow detect, red chase,
  green return) and the current state is named in the top-center label.

## Feel & difficulty notes

- **Hysteresis matters.** Detection acquires the player at `detectRadius` (10) but
  the chase only breaks off past a larger `loseRadius` (20). Equal thresholds make
  the guard "flicker" between chase and return at the boundary; the gap is what
  makes pursuit feel committed.
- **The confirm window** (detect → chase after ~0.3 s of continuous sight) keeps a
  guard from snapping to full aggression the instant a player clips the edge of its
  cone — it reads as "did I just see something?" rather than an instant lock-on.
- **Arrive, not seek, onto the target** is what stops the capsule overshooting and
  oscillating around the player/home; with raw seek it visibly jitters on arrival.
- **Re-pathing cadence is a trade-off.** Chase re-queries the navmesh every ~0.25 s.
  Faster looks more reactive but spends more CPU on `computePath`; slower lets the
  guard briefly run at a stale corner before correcting.
- **Avoidance rarely fires here** because the navmesh path already keeps clear of
  the wall (Recast erodes the walkable area by the agent radius). It is kept as a
  safety/feel layer and is unit-tested directly; on tighter maps it earns its keep.

## Babylon-specific gotchas

- **Navmesh via the engine wrapper.** Babylon reaches the *same* Recast/Detour core
  as Three, but through `RecastJSPlugin` (`createNavMesh` / `computePath` /
  `getClosestPoint`). The plugin does not bundle the WASM — it is injected via the
  shared [`src/ai/recast.ts`](../../ai/recast.ts) loader.
- **The FSM core never touches Babylon types.** `guard.ts` depends only on a small
  `GuardNav` interface (closestPoint / computePath / blockers). In tests that is
  `buildHeadlessNav`'s `NavQuery`; in this sample it is a thin adapter wrapping the
  live plugin — so the exact logic the test proves is the logic that renders.
- **Debug-mesh material leak.** `createNavMeshDebug` attaches a `StandardMaterial`;
  `Mesh.dispose()` does **not** free a mesh's material by default, so dispose uses
  `dispose(false, true)`. The DOM state label lives outside the scene graph and is
  removed explicitly in the sample's dispose fn.
- **Async-load vs. disposal race.** Recast WASM may resolve after the user switched
  away; a `disposed` flag gates navmesh creation, matching the other Ch4 samples.

## Finding note — crowd vs. hand-rolled steering

Babylon ships a `RecastJSCrowd` (Detour crowd: agents, separation, local
avoidance). This sample deliberately does **not** use it: Chapter 4 controls the
steering axis across all three engines (Bevy has no Detour crowd), so steering is
hand-rolled everywhere and the engine-provided crowd is recorded here as a *finding*
rather than used. For a single guard the crowd would be overkill anyway; its value
is many co-steering agents, which is out of this sample's scope.
