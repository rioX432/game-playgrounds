# 10 — Emote / Pose Radial Wheel

## What it demonstrates

A radial emote wheel, the way action games and shooters expose emotes/pings:

- **Hold a key to open** a 10-sector radial menu, drawn as a 2D `<canvas>`
  overlay over the gallery canvas.
- **Angle-based sector highlighting** with a **center dead zone** — aiming
  inside the dead-zone radius selects nothing (the center reads "cancel").
- **Snap to the nearest sector** from the aim direction.
- **Release to apply** the chosen emote, which then **actually plays** on the
  character as a procedural pose.

The character is a simple multi-part primitive rig (body + head + two
shoulder-pivoted arm boxes) so each pose reads clearly without any art assets:
Wave (oscillating arm), Jump (vertical hop), Spin (whole-body rotation), Crouch
(scale Y down), Sit (lower + lean back), Point, Clap, Nod, Cheer, Bow. Each pose
is driven by a time accumulator, plays for a fixed duration, then returns to
idle.

The view is third-person follow so the pose is always visible.

## Controls

- **Click canvas** — lock the mouse (pointer lock; required for look + aim).
- **WASD** — move (camera-relative). Movement is suspended while the wheel is open.
- **Mouse** — orbit the follow camera.
- **Hold F** — open the emote wheel; move the mouse to aim a sector.
- **Release F** — play the highlighted emote. Releasing with the aim in the
  center dead zone cancels (no emote).

## Feel & difficulty notes

- **Opening / aiming feels good.** Because the wheel reads accumulated mouse
  delta (not an absolute cursor), a quick flick in a direction snaps cleanly to
  that sector, and the highlighted sector + live cursor dot make the current
  choice obvious. The dead zone makes "cancel" a deliberate, reachable gesture.
- **Pointer-lock conflict is the real design problem here, and the chosen fix
  has a visible seam.** The shared `InputController` uses pointer lock, so there
  is *no cursor* — only relative `movementX/Y`. We accumulate that delta into a
  2D selection vector while F is held (reset to center on open) and pick the
  sector from its angle. To stop that same delta from *also* orbiting the camera,
  a capture-phase `mousemove` listener swallows the event while the wheel is
  open. It works, but it means **the camera freezes the instant the wheel opens**
  — correct, yet it feels slightly abrupt compared to a game that smoothly slows
  time and dims the scene.
- **Where it feels bad:** the selection vector is *velocity-integrated*, not an
  absolute pointer. If you flick hard the dot pins to the rim (fine), but if you
  drift slowly the dot can sit near the dead-zone edge and a tiny extra nudge
  flips the highlight between two neighbours — there is no cursor to rest
  precisely. A real game would re-center the dot or add hysteresis at sector
  boundaries; this sample intentionally keeps the raw mapping so the trade-off is
  visible.
- **Poses are procedural and deliberately readable, not animation-quality.** A
  box arm "waving" reads as a wave, but there is no easing in/out at the start
  and end of one-shot poses, so Wave/Clap/Cheer "snap" to their first frame. Hops
  and bows use a single sine arch so they ease naturally; the oscillating poses
  do not. Honest: it communicates the mechanic, it is not juicy.
- Sustained poses (Crouch, Sit) hold for a longer fixed duration then pop back
  to idle — there's no "hold until released" mode, which would feel better for
  Sit specifically.

## Three.js gotchas

- **Pointer lock gives you no cursor.** A radial wheel normally wants an absolute
  cursor position relative to the wheel center. Under pointer lock you only get
  `event.movementX/Y`. Approach (a) — integrate the delta into a selection vector
  — is used here so the wheel works *with* pointer lock (no exit/re-lock churn).
- **Event ordering to suppress the camera.** Capture-phase listeners on the same
  target fire before bubble-phase listeners regardless of registration order, so
  a `{ capture: true }` `mousemove` listener that calls
  `stopImmediatePropagation()` reliably preempts `InputController`'s bubble-phase
  look handler while the wheel is open. (Verified against MDN/`javascript.info`.)
  Both add and remove must pass the same `{ capture: true }` option or the
  listener won't be removed.
- **Rotate arms at the shoulder, not the mesh center.** Each arm box is parented
  to an empty `Group` placed at shoulder height with the mesh offset down by half
  its length; rotating the *pivot group* swings the arm about the shoulder. A
  plain `Mesh` rotation would spin the arm about its own midpoint.
- **Reset-then-apply each frame.** Every frame the rig is reset to idle and only
  the active emote re-applies its transforms, so poses never accumulate or leak
  state between emotes. `spinYaw` is composed *after* the reset with the facing
  yaw so Spin and movement-facing don't fight.
- **Overlay canvas DPR.** The 2D overlay scales its backing store by
  `devicePixelRatio` (capped at 2) and the context by the same factor so the
  wheel stays crisp on HiDPI without blowing up memory.
- **Dispose everything.** rAF is cancelled; the extra capture `mousemove`
  listener, the HUD, the wheel overlay canvas, and the status `<div>` are all
  removed; the rig's geometries/materials and every `PrimitiveSet` are disposed.
