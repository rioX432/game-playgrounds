# 06 — Hide & Seek: Prop Disguise

Prop-hunt style stealth. The player can swap their visible mesh to one of the
nearby environment prop shapes (crate / barrel / cone / sphere) to blend in. The
disguise is only convincing while you stand still: **moving breaks it**.

## What it demonstrates

- **Disguise swap (visual identity change).** A fixed catalog of prop types
  `{geometry, material}` is built once. The player is a single mesh that
  re-points its geometry at the selected catalog entry — pressing `Q`/`E`
  cycles the disguise. The scene is littered with immovable decoys of the same
  shapes, so a still, correctly-matched player visually disappears into the
  crowd.
- **A legible "tell".** Standing still = **HIDDEN**. Moving above a small speed
  threshold = **EXPOSED**: the prop tints red and wobbles. This is the honest
  core of prop-hunt — the tension is "can I get into position and freeze before
  the seeker looks?" The HUD shows the current disguise and HIDDEN/EXPOSED
  state.
- **Leak-free GPU resource handling.** Every catalog geometry and material is
  disposed on switch-away (not just the active disguise), the player's own
  tintable material is disposed, and the shared stage primitives free
  themselves. Cycling disguises allocates nothing.

## Controls

- **Click canvas** — lock the mouse (pointer lock)
- **WASD** — move (camera-relative)
- **Mouse** — orbit the third-person follow camera
- **Q / E** — cycle disguise backward / forward
- **Esc** — release the mouse

Third-person camera is intentional: you need to *see your own disguise* to judge
whether you blend in.

## Feel & difficulty notes

- **Stop-to-hide reads instantly.** The red tint + wobble snapping off the
  moment you stop is satisfying and immediately teaches the rule. The eased
  fade (rather than a hard cut) makes "I'm settling into cover" feel smooth.
- **Where it feels bad — no actual seeker.** This is a mechanic spike, not a
  full game. There's no AI hunter scanning for you, so the stealth has no
  *stakes*: blending in is a visual exercise, not a survival one. The tension
  prop-hunt gets from a real seeker isn't here, and you feel its absence.
- **Where it feels bad — blend quality depends on you eyeballing it.** Nothing
  enforces "you must match a nearby decoy." You can stand as a lone purple
  sphere in an empty patch and still read as HIDDEN. A real version would gate
  hiding on proximity to a matching prop; here it's on the honor system, which
  makes the disguise feel slightly hollow.
- **Wobble amplitude is a compromise.** Big enough to be unmistakable, but on a
  tall cone it looks a touch comical rather than threatening. Tuning the tell to
  feel "dangerous" vs "goofy" is genuinely hard without a threat model.

## Three.js gotchas

- **Swapping `mesh.geometry` does not dispose the old one** — that's exactly the
  property we exploit. The old geometry still belongs to the catalog and stays
  alive; only on switch-away do we dispose the whole catalog. If you naively
  created a fresh geometry per swap you'd leak one per cycle.
- **Decoys must share the catalog's geometry/material**, not clone them. Sharing
  means there's nothing extra to dispose and the decoy color tracks the catalog
  base color for free. The player needs its *own* material instance, though,
  because tinting it red must not bleed into the shared decoys.
- **`mesh.geometry =` reassignment** is the idiomatic, allocation-free way to
  change a mesh's shape in Three; there's no need to recreate the `Mesh`.
- **Rest height per shape.** Each prop sits on the ground via a precomputed
  `restY` (half-height for box/cylinder/cone, radius for sphere). Forgetting
  this sinks the sphere halfway into the floor.
