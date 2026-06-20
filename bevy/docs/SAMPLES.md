# Sample Backlog — bevy-playground

**engine: bevy** (`bevy 0.18` + `bevy_rapier3d 0.34`)

This is the work-list for `/dev-all`. **Each row below = one GitHub Issue = one PR.**
Same lineup as the sibling `../three` and `../babylon` playgrounds, ported to Bevy.
Issues are intentionally small so an AI agent can finish one in a single `/dev`
run while keeping `main` green.

## Sizing rules
- One issue = one coherent change that leaves `cargo check` green = exactly one PR.
- **Foundation** issues (shared helpers/plugins) are built first; samples depend
  on them (`depends on #N`).
- A **heavy** sample is split into `core` + `polish` issues.
- Definition of Done for every issue: `cargo check` green + at least one headless
  `#[test]` + module-doc header (What / Controls / Feel / 0.18 gotchas).

Status: ✅ done · ⬜ todo (→ GitHub issue)

## Seed (already built)
| ID | Sample | Status |
|----|--------|--------|
| 01 | Third-person character controller (capsule + follow camera, Transform-based) | ✅ |
| 02 | Physics grab & throw (rapier raycast + impulse) | ✅ |
| 03 | Paint-on-mesh (runtime-editable `Image`, paint at hit UV) | ✅ |

## Foundation (build first — shrinks every later sample)
| Issue | Title | Depends | What it adds |
|-------|-------|---------|--------------|
| F1 ✅ | Shared input plugin (keyboard + pointer-lock mouse look) + refactor sample 01 | — | reusable `engine/input` module/plugin |
| F2 | Shared HUD plugin (controls overlay + FPS via `FrameTimeDiagnosticsPlugin`) | — | reusable `hud` plugin |
| F3 | Shared scene-primitives helper (ground plane, box grid, light preset) | — | reusable `prims` helpers |

## Samples (one issue each)
| Issue | Title | Depends | One-line |
|-------|-------|---------|----------|
| 04 | First-person controller | F1, F2 | FPS move + pointer-lock look (camera-relative) |
| 05 | Spatial-audio proximity falloff | F2, F3 | Bevy `SpatialAudio` distance attenuation (proximity-voice stand-in) |
| 06 | Hide-and-seek prop disguise (mesh swap) | F1, F3 | swap the player's `Mesh3d`/`MeshMaterial3d` to a nearby prop |
| 08 | Red-light / green-light freeze detection | F1, F2 | だるまさんがころんだ state machine + motion check |
| 09 | Co-op carry physics | F3 | pick up + carry a body via a rapier joint |
| 10 | Emote / pose radial wheel | F2 | radial menu (Bevy UI) → apply a pose/emote |
| 11 | Top-down twin-stick movement | F1, F3 | top-down move + aim |

## Heavy samples (split into core + polish)
| Issue | Title | Depends | One-line |
|-------|-------|---------|----------|
| 07a | Ragdoll core (jointed capsules) | F3 | rapier joints skeleton |
| 07b | Ragdoll interactions + reset + feel notes | 07a | push / collapse / reset + README header |
| 12a | Spherical gravity + walk-on-sphere | F3 | align "up" to surface normal, walk on a sphere |
| 12b | Tiny-planet environment + camera + feel notes | 12a | planet scene + follow camera (Messenger-style) |

**Total: 14 issues.** Build order is foundation → samples → heavy splits;
`/dev-all` resolves it from the `depends on` links.
