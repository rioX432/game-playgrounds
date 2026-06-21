# 08 — Red Light, Green Light

Freeze-detection state machine (だるまさんがころんだ / Squid Game's first round).

## What it demonstrates

A green(move)/red(freeze) phase state machine with motion detection:

- **Phase loop** — a `dt`-driven timer cycles `GREEN → TURNING → RED → GREEN`.
  GREEN is safe to move; TURNING is a short telegraph while the doll rotates to
  face you (still safe); RED is the watch window.
- **Legible watcher** — a doll mesh whose head/face plate eases to face *away*
  during GREEN and *toward the player* during RED, plus a background tint that
  shifts green → amber → red. Both make the current phase readable peripherally.
- **Motion detection** — speed is measured as `distanceMoved / dt` each frame
  (independent of the input flags, so float jitter can't fake motion and a held
  key with no displacement can't hide it). During RED, speed above a small
  threshold flips the run to **CAUGHT**.
- **Fair grace window** — detection is suppressed for the first `RED_GRACE`
  seconds of RED so a player mid-step gets a beat to stop.
- **Reset** — `R` returns to a fresh GREEN run at the start. A finish line past
  the doll gives a **WIN** condition.

## Controls

- **Click canvas** — lock the mouse (pointer lock).
- **WASD** — move (only safe during GREEN / TURNING).
- **Mouse** — orbit the follow camera.
- **R** — reset to a fresh run.

Goal: cross the yellow finish line beyond the doll without being caught moving
during RED.

## Feel & difficulty notes

- **The telegraph is what makes it fair.** Without the TURNING phase + the amber
  tint, RED arrives with no warning and the game feels like a coin flip. The
  short rotation + color shift is the difference between "twitchy" and "tense".
- **The grace window is a real trade-off, honestly documented.** `RED_GRACE =
  0.18s` forgives the player who *just* started a step. Too long and you can
  cheese a free half-step into every RED; too short and stopping feels
  impossible because input + render latency already eats ~1–2 frames. 0.18s
  felt like the smallest value that didn't feel unfair — but it does mean a
  fast tapper can steal a little distance each cycle, which is a slightly cheap
  way to win.
- **Threshold detection feels slightly binary.** Catching is all-or-nothing the
  instant you cross `MOTION_THRESHOLD`. There's no "you were caught creeping"
  nuance — it's hard to *feel* how close to the line you are, so getting caught
  can feel sudden. A graduated suspicion meter (Squid Game's actual tell) would
  read better but is out of scope for this freeze-detection spike.
- **Mouse-orbit during RED is a non-issue but looks like one.** Because speed is
  measured from the player's world position, orbiting the camera while frozen
  does *not* trigger a catch — correct, but a first-time player instinctively
  freezes the mouse too, which is a nice (accidental) bit of tension.
- **Responsiveness is good.** Movement is direct (`MOVE_SPEED * dt`, no
  acceleration), so stopping is immediate — exactly what a freeze game needs.

## Three.js gotchas

- **Camera-consistent forward.** Movement basis uses `forward = (-sin yaw, 0,
  -cos yaw)` so W always walks toward where the (yaw-0-looks-`-Z`) camera faces.
  Getting this sign wrong inverts the controls — a bug a prior sample hit.
- **`scene.background` is a `Color` object, mutate it in place.** Lerping the
  background each frame means `(scene.background as Color).copy(...)` after
  easing a persistent `Color`; reassigning a new `Color` every frame would
  allocate per frame.
- **The doll is a `Group`, rotate the group not the meshes.** Facing is one
  `dollGroup.rotation.y`; the face plate is a child offset on +Z so it reads as
  "looking at you" when the group yaws to π.
- **Dispose everything you `new`.** This sample creates its own geometries and
  materials (doll body/head/face, finish line, player) — each is disposed in the
  cleanup function. The shared light/ground `PrimitiveSet`s dispose themselves.
  rAF is cancelled and the status `<div>` is removed so switching away leaks
  nothing.
