# Sample Backlog — babylon-playground

This is the work-list for `/dev-all`. **Each row below = one GitHub Issue = one PR.**
Issues are intentionally small so an AI agent can finish one in a single `/dev` run while keeping `main` build-green.

## Sizing rules
- One issue = one coherent change that leaves `npm run build` green = exactly one PR.
- **Foundation** issues (shared helpers) are built first; samples depend on them (`depends on #N`).
- A **heavy** sample is split into `core` + `polish` issues.
- Definition of Done for every issue: see `.github/ISSUE_TEMPLATE/sample.md`.

Status: ✅ done · ⬜ todo (→ GitHub issue)

## Seed (already built)
| ID | Sample | Status |
|----|--------|--------|
| 01 | Third-person character controller | ✅ |
| 02 | Physics grab & throw (Havok) | ✅ |
| 03 | Paint-on-mesh (DynamicTexture) | ✅ |

## Foundation (build first — shrinks every later sample)
| Issue | Title | Depends | What it adds |
|-------|-------|---------|--------------|
| F1 | Shared input module (keyboard + pointer-lock look) + refactor sample 01 | — | reusable `engine/input.ts` |
| F2 | Shared HUD helper (controls overlay + FPS counter) | — | reusable `engine/hud.ts` |
| F3 | Shared scene primitives (ground, box grid, light preset) | — | reusable `engine/prims.ts` |

## Samples (one issue each)
| Issue | Title | Depends | One-line |
|-------|-------|---------|----------|
| 04 | First-person controller | F1, F2 | FPS move + pointer-lock look |
| 05 | Spatial-audio proximity falloff | F2, F3 | positional audio + distance attenuation (proximity-voice stand-in) |
| 06 | Hide-and-seek prop disguise (mesh swap) | F1, F3 | swap the player mesh to a nearby prop |
| 08 | Red-light / green-light freeze detection | F1, F2 | だるまさんがころんだ state machine + motion check |
| 09 | Co-op carry physics | F3 | pick up + carry a body via a physics constraint |
| 10 | Emote / pose radial wheel | F2 | radial menu → apply a pose/emote |
| 11 | Top-down twin-stick movement | F1, F3 | top-down move + aim |

## Heavy samples (split into core + polish)
| Issue | Title | Depends | One-line |
|-------|-------|---------|----------|
| 07a | Ragdoll core (jointed capsules) | F3 | physics joints skeleton |
| 07b | Ragdoll interactions + reset + README | 07a | push / collapse / reset + feel notes |
| 12a | Spherical gravity + walk-on-sphere | F3 | align "up" to surface normal, walk on a sphere |
| 12b | Tiny-planet environment + camera + README | 12a | planet scene + follow camera (Messenger-style) |

**Total: 14 issues.** Build order is foundation → samples → heavy splits; `/dev-all` resolves it from the `depends on` links.
