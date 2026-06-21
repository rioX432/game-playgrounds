# 08 — Red Light, Green Light

Freeze-detection state machine (だるまさんがころんだ / Squid Game's first round).

## What it demonstrates

A green(move)/red(freeze) phase state machine with motion detection:

- **Phase loop** — a `dt`-driven timer cycles `GREEN → TURNING → RED → GREEN`.
  GREEN is safe to move; TURNING is a short telegraph while the doll rotates to
  face you (still safe); RED is the watch window.
- **Legible watcher** — a doll built on a `TransformNode` parent whose head/face
  plate eases to face *away* during GREEN and *toward the player* during RED,
  plus a background tint that shifts green → amber → red. Both make the current
  phase readable peripherally.
- **Motion detection** — speed is measured as `distanceMoved / dt` from the
  player's WORLD position delta each frame (independent of the input flags, so
  float jitter can't fake motion and a held key with no displacement can't hide
  it). During RED, speed above a small threshold flips the run to **CAUGHT**.
- **Fair grace window** — detection is suppressed for the first `RED_GRACE`
  seconds of RED so a player mid-step gets a beat to stop.
- **Reset** — `R` (edge-triggered) returns to a fresh GREEN run at the start. A
  finish line past the doll gives a **WIN** condition.

Reuses sample 01's third-person model: `FollowCamera` + a `yawPivot` + the
shared pointer-lock look, and the same movement basis.

## Controls

| Input | Action |
|---|---|
| **Click canvas** | Lock the mouse (pointer lock) |
| **WASD** | Move (only safe during GREEN / TURNING) |
| **Mouse** | Look / orbit the follow camera |
| **R** | Reset to a fresh run |

Goal: cross the yellow finish line beyond the doll without being caught moving
during RED.

## Feel & difficulty notes

- **The telegraph is what makes it fair.** Without the TURNING phase + the amber
  tint, RED arrives with no warning and the game feels like a coin flip. The
  short doll rotation + color shift is the difference between "twitchy" and
  "tense". This is the single most important tuning decision in the sample.
- **The grace window is a real trade-off, honestly documented.** `RED_GRACE =
  0.18s` forgives the player who *just* started a step. Too long and you can
  cheese a free half-step into every RED; too short and stopping feels
  impossible because input + render latency already eats ~1–2 frames. 0.18s
  felt like the smallest value that didn't feel unfair — but it does mean a
  fast tapper can steal a little distance each cycle, a slightly cheap way to win.
- **Threshold detection feels slightly binary.** Catching is all-or-nothing the
  instant you cross `MOTION_THRESHOLD` (0.25 u/s). There's no "you were caught
  creeping" nuance — it's hard to *feel* how close to the line you are, so
  getting caught can feel sudden. A graduated suspicion meter (Squid Game's
  actual tell) would read better but is out of scope for this freeze spike.
- **Mouse-orbit during RED is a non-issue but looks like one.** Because speed is
  measured from the player's WORLD position (the `yawPivot`), orbiting the camera
  while frozen does *not* trigger a catch — correct, but a first-time player
  instinctively freezes the mouse too, a nice (accidental) bit of tension.
- **Responsiveness is good.** Movement is direct (`MOVE_SPEED * dt`, no
  acceleration), so stopping is immediate — exactly what a freeze game needs.
  The `FollowCamera` smoothing lags slightly, but that's camera-only and never
  feeds the motion check.

Implementation difficulty: **low–moderate.** The state machine and detection are
simple; getting the doll-facing signs and the in-place `clearColor` mutation
right are the only fiddly parts.

## Babylon-specific gotchas

- **Movement basis (left-handed).** Reuses sample 01's proven basis: `worldX =
  strafe·cos + forward·sin`, `worldZ = forward·cos − strafe·sin`. With yaw 0, W
  moves **+Z**, so the player starts at `-Z` and walks toward `+Z` where the
  doll and finish line sit. Getting these signs wrong inverts the controls.
- **`scene.clearColor` is a persistent `Color4` — mutate it in place.** The phase
  tint eases the `.r/.g/.b` components of the existing `clearColor` each frame
  (`bg.r += (target − bg.r) * k`). Assigning a `new Color4(...)` every frame
  would allocate per frame; we never do.
- **Babylon's forward is +Z; rotate the PARENT.** The doll is a `TransformNode`
  with body/head/face children; facing is one `dollPivot.rotation.y`. The face
  plate is offset on **+Z** (the node's forward) so it reads as "looking at you".
  Because the player sits on `-Z`, GREEN faces away at `yaw = π` and RED faces
  the player at `yaw = 0` — the opposite signs from the right-handed Three.js
  sibling, which is the LH/RH frame difference in a nutshell.
- **`FollowCamera.rotationOffset = 0`** trails the camera on `-Z` (behind the
  player as they walk `+Z`), so we always see the doll's face down-range.
- **Side-effect builder imports.** `capsule`, `cylinder`, `sphere`, and `box`
  builders each need their `@babylonjs/core/Meshes/Builders/*` import or they
  silently no-op at runtime.
- **Dispose everything you `new`.** Doll parts (pivot + body/head/face meshes &
  materials), finish line, player capsule + yaw pivot, the `FollowCamera`, the
  status `<div>`, the render observer, and the shared input/HUD are all torn down
  in the dispose fn. The shared light/ground primitives are scene-owned and freed
  by `scene.dispose()`.
