# 06 — Hide & Seek: Prop Disguise

Prop-hunt style stealth. The player can swap their visible mesh to one of the
nearby environment prop shapes (crate / barrel / cone / sphere) to blend in. The
disguise is only convincing while you stand still: **moving breaks it**.

## What it demonstrates

- **Disguise swap (Babylon idiom: enable/disable a catalog).** Babylon meshes
  don't swap geometry the way Three reassigns `mesh.geometry`, so instead a
  **catalog** of one mesh per prop shape is built once, all parented to the
  player's yaw pivot. Exactly one mesh is `setEnabled(true)` at a time; pressing
  `Q`/`E` flips which index is enabled. This swaps shape with **zero per-cycle
  allocation** — nothing is created or freed mid-run. The scene is littered with
  immovable decoys of the same shapes, so a still, correctly-matched player
  visually disappears into the crowd.
- **A legible "tell".** Standing still = **HIDDEN**. Moving above a small speed
  threshold = **EXPOSED**: the active prop tints red and wobbles. This is the
  honest core of prop-hunt — the tension is "can I get into position and freeze
  before the seeker looks?" The HUD shows the current disguise and HIDDEN/EXPOSED
  state.
- **Isolated tinting.** Each disguise mesh owns its **own** `StandardMaterial`
  instance, so lerping its `diffuseColor` toward red on EXPOSED never bleeds into
  the shared decoys (decoys reuse one base material per shape and are never
  tinted).
- **Leak-free GPU resource handling.** On switch-away the sample disposes every
  disguise mesh + its material, every decoy mesh + its shared material, and the
  pivot, then tears down the shared input/HUD and the render observer.

## Controls

| Input | Action |
|---|---|
| Click canvas | lock the mouse (pointer lock) |
| WASD | move (camera-relative) |
| Mouse | orbit the third-person follow camera |
| Q / E | cycle disguise backward / forward |
| Esc | release the mouse |

Third-person camera is intentional: you need to *see your own disguise* to judge
whether you blend in.

## Feel & difficulty notes

- **Stop-to-hide reads instantly.** The red tint + wobble snapping off the
  moment you stop is satisfying and immediately teaches the rule. The eased fade
  (rather than a hard cut) makes "I'm settling into cover" feel smooth.
- **Follow-camera lag is a mild double-edged sword.** Babylon's `FollowCamera`
  eases toward the target (`cameraAcceleration`), so the camera glides behind you
  — pleasant, but it briefly trails when you stop, which can make a freshly-stopped
  prop read as "still settling" for a beat. Tuning `cameraAcceleration` /
  `maxCameraSpeed` trades smoothness against snappiness.
- **Where it feels bad — no actual seeker.** This is a mechanic spike, not a full
  game. There's no AI hunter scanning for you, so the stealth has no *stakes*:
  blending in is a visual exercise, not a survival one. The tension prop-hunt
  gets from a real seeker isn't here, and you feel its absence.
- **Where it feels bad — blend quality is on the honor system.** Nothing enforces
  "you must match a nearby decoy." You can stand as a lone purple sphere in an
  empty patch and still read as HIDDEN. A real version would gate hiding on
  proximity to a matching prop; here it's eyeballed, which makes the disguise feel
  slightly hollow.
- **Wobble amplitude is a compromise.** Big enough to be unmistakable, but on the
  tall cone it looks a touch comical rather than threatening. Tuning the tell to
  feel "dangerous" vs "goofy" is genuinely hard without a threat model.

## Babylon-specific gotchas

- **Don't swap geometry — toggle enabled meshes.** Babylon has no idiomatic
  `mesh.geometry =` reassignment like Three. The allocation-free equivalent is to
  pre-build all shapes and `setEnabled` the active one. Building a fresh mesh per
  swap would leak one mesh+material per cycle.
- **The player needs its OWN material per disguise.** Tinting a material mutates
  it in place; if disguises shared a material with the decoys (or with each
  other's untinted base), the red EXPOSED tint would bleed onto scenery. Decoys
  share one base material per shape *because* they're never tinted.
- **Reset state on swap.** When a disguise is hidden, its tilt (`rotation`) and
  tinted `diffuseColor` are reset before re-showing, so a re-enabled prop never
  flashes a stale red wobble from a previous EXPOSED frame.
- **Rest height per shape.** Each prop sits on the ground via a precomputed
  `restY` — half-height for box/cylinder/cone, but **radius** for the sphere.
  Forgetting the sphere case sinks it halfway into the floor.
- **A cone is a zero-top cylinder.** `MeshBuilder.CreateCylinder` with
  `diameterTop: 0` produces the cone; there's no separate cone builder import.
- **`FollowCamera.lockedTarget` is typed `AbstractMesh`.** Targeting a
  `TransformNode` (the yaw pivot) works at runtime — it only reads `.position` —
  but requires a narrow cast (documented with a `// reason:` comment).
