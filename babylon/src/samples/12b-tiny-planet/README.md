# 12b — Tiny Planet: Environment + Camera

The **polish** half of the tiny-planet pair. Sample 12a built the core mechanic
(radial gravity + walk-on-sphere via manual kinematics); 12b keeps that exact
controller and adds the two things that make moving around a tiny planet actually
feel good: **scattered environment props** and a **damped, horizon-curving follow
camera**.

Run 12a and 12b back to back — the controller is identical, but 12b stops the
view from whipping on every turn and gives you landmarks to gauge motion against.

## What it demonstrates

- **Radial prop placement.** 30 props (rock dodecahedra + stacked-cone trees) are
  scattered with a deterministic Fibonacci-sphere distribution so they cover the
  whole globe evenly — including the underside. Each prop is oriented with
  `Quaternion.FromLookDirectionLH(tangent, normal)` so its local +Y points along
  the surface normal at its spot; they "stand up" correctly everywhere, no Euler
  angles, no pole flip.
- **Frame-rate-independent damped follow camera.** The camera position eases
  toward its target with the blend `1 − exp(−rate·dt)` instead of snapping, so a
  turn swings the view around smoothly. dt is clamped so a stutter can't overshoot.
- **Smoothed horizon roll.** The camera's up-vector is damped separately toward
  the surface normal, so the horizon *curves* as you orbit rather than re-levelling
  in one frame — the single biggest feel upgrade over 12a.
- **Antiparallel-safe up blending.** When the smoothed up and the target up are
  nearly opposite (you've crossed to the far side fast), the up-vector snaps
  instead of lerping, avoiding the degenerate flip a naive interpolation hits.

## Controls

| Input | Action |
|-------|--------|
| `W` / `S` | Walk forward / back along the surface |
| `A` / `D` | Turn the heading (tank-style) |
| `Space` | Jump (outward, away from the planet center) |

The camera follows automatically; there is no manual camera control.

## Feel & difficulty notes

- **Feel: much calmer than 12a.** The damped position + curving horizon turn the
  nauseating snap of 12a into a smooth orbit. Walking over a pole now reads as the
  world gently rolling under you instead of flipping. The props give constant
  parallax so slow walking no longer looks like standing still — the second honest
  weak point of 12a is gone.
- **Where it feels bad — the lag/stiffness trade-off.** Damping is a compromise.
  At `CAM_POS_RATE` 6 / `CAM_UP_RATE` 4 the camera trails the player slightly on
  fast direction changes; push the rates higher and you reclaim 12a's snappiness
  but lose the smooth curve; push them lower and the camera feels sluggish and
  sea-sick on its own. There is no setting that is both perfectly responsive and
  perfectly smooth — this is the inherent cost of smoothing, and the sample ships
  the middle ground on purpose.
- **Where it feels bad — fast pole crossings.** If you sprint straight over a pole
  the up-vector can swing far enough in one stretch that the antiparallel snap
  fires, and the horizon jumps for a frame instead of curving. It's rare with
  these rates but it is the visible seam in the illusion.
- **Tuning constants that matter:** `CAM_POS_RATE` / `CAM_UP_RATE` are the whole
  feel of the camera — position vs. horizon stiffness. `PROP_COUNT` (30) and the
  Fibonacci scatter set how dense the landmarks are; too few and the motion cue is
  weak, too many and the tiny planet looks cluttered. Movement constants
  (`MOVE_SPEED`, `TURN_SPEED`, `GRAVITY`, `JUMP_SPEED`) are unchanged from 12a.
- **Difficulty: medium.** The controller is inherited; the new work is the camera
  damping (getting frame-rate independence and the antiparallel guard right) and
  the per-prop quaternion orientation. Both are small once you commit to
  look-direction quaternions over Euler angles.

## Babylon-specific gotchas

- **Frame-rate-independent damping needs `1 − exp(−rate·dt)`, not a raw factor.**
  A fixed per-frame lerp amount (`lerp(a, b, 0.1)`) makes the camera stiffer at
  high FPS and mushier at low FPS. The exponential form gives the same response in
  wall-clock seconds regardless of frame rate; pair it with a `dt` clamp so a long
  stall can't blend past the target.
- **Lerping an up-vector flips through the antiparallel point.** When the current
  and target up are ~180° apart, the linear interpolation passes through (or near)
  the zero vector and the orientation spins unpredictably. Guard it: if
  `dot(camUp, up) < −0.99`, snap to the target instead of lerping.
- **`Quaternion.FromLookDirectionLH` orients props from a (tangent, normal) pair.**
  Aligning a prop's local +Y to the surface normal with Euler angles gimbal-flips
  at the poles. Building the quaternion directly from a tangent + the normal (the
  same trick the controller uses) places props correctly everywhere on the globe.
- **`CreateCylinder` with `diameterTop: 0` is the idiomatic cone**, and
  `CreatePolyhedron` with `type: 2` is the dodecahedron used for rocks — both need
  their side-effect builder imports (`cylinderBuilder`, `polyhedronBuilder`) or
  they silently no-op under tree-shaken imports.
- **Parent props under one node for one-call disposal.** Everything hangs off a
  single `props` `TransformNode`; `propsRoot.dispose()` recurses through all prop
  meshes, and the three shared materials are disposed explicitly next to it — no
  per-mesh bookkeeping, no leak on gallery switch.
