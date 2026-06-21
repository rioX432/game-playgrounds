# 10 — Emote / Pose Radial Wheel

## What it demonstrates

A radial emote wheel, the way action games and shooters expose emotes/pings:

- **Hold a key to open** a 10-sector radial menu, drawn as a 2D `<canvas>`
  overlay over the gallery canvas.
- **Angle-based sector highlighting** with a **center dead zone** — aiming
  inside the dead-zone radius selects nothing (the center reads "cancel").
- **Snap to the highlighted sector** from the aim direction.
- **Release to apply** the chosen emote, which then **actually plays** on the
  character as a procedural pose.

The character is a simple multi-part primitive rig — a `Box` body + `Sphere`
head + two shoulder-pivoted arm boxes — so each pose reads clearly without any
art assets: Wave (oscillating arm), Jump (vertical hop), Spin (whole-body
rotation), Crouch (scale Y down), Sit (lower + lean back), Point, Clap, Nod,
Cheer, Bow. Each pose is driven by a time accumulator, plays for a fixed
duration, then returns to idle.

Babylon features used: `FollowCamera` (third-person so the pose is visible),
`TransformNode` pivots (arm shoulders + a rig root for whole-body spin), the
shared `createInput` pointer-lock look, shared scene primitives, and a self-owned
2D `<canvas>` overlay for the wheel (consistent with the project's "plain DOM for
HUD/gallery" stance).

## Controls

| Input | Action |
|---|---|
| Click canvas | Lock the pointer (required for look + aim). |
| WASD | Move (camera-relative). Suspended while the wheel is open. |
| Mouse | Orbit the follow camera / heading. |
| Hold F | Open the emote wheel; move the mouse to aim a sector. |
| Release F | Play the highlighted emote. Releasing in the center dead zone cancels. |
| Esc | Release the pointer. |

## Feel & difficulty notes

- **Opening / aiming feels good.** The wheel reads accumulated look delta (not an
  absolute cursor), so a quick flick in a direction snaps cleanly to that sector,
  and the highlighted sector + live cursor dot make the current choice obvious.
  The dead zone makes "cancel" a deliberate, reachable gesture.
- **The pointer-lock double-use is solved cleanly here — no event-swallow hack.**
  The shared `createInput` already routes mouse-look ONLY through
  `consumeLookX/Y()`; nothing reads the raw `mousemove` event. So while F is held
  we simply feed that consumed delta into the 2D selection vector instead of the
  heading yaw, and suspend WASD. The Three.js sibling needed a capture-phase
  `mousemove` listener calling `stopImmediatePropagation()` to keep the camera
  from spinning behind the wheel; Babylon's input shape makes that unnecessary.
- **The trade-off of that approach is a visible seam: the camera/heading freezes
  the instant the wheel opens.** Correct (the look delta now only aims the
  wheel), but it feels slightly abrupt compared to a game that smoothly slows
  time and dims the scene. Documented honestly rather than hidden.
- **Where it feels bad:** the selection vector is *velocity-integrated*, not an
  absolute pointer. Flick hard and the dot pins to the rim (fine); drift slowly
  and the dot can sit near the dead-zone edge where a tiny extra nudge flips the
  highlight between two neighbours — there is no cursor to rest precisely. A real
  game would re-center the dot or add boundary hysteresis; this sample keeps the
  raw mapping so the trade-off is visible.
- **Poses are procedural and deliberately readable, not animation-quality.** A
  box arm "waving" reads as a wave, but one-shot oscillating poses (Wave / Clap /
  Cheer) have no ease-in/out, so they "snap" to their first frame. Hops and bows
  use a single sine arch so they ease naturally. Honest: it communicates the
  mechanic, it is not juicy.
- Sustained poses (Crouch, Sit) hold for a longer fixed duration then pop back to
  idle — there is no "hold until released" mode, which would feel better for Sit
  specifically.
- **Difficulty: medium.** The mechanic is simple; the only real design problem is
  the pointer-lock double-use, and Babylon's `consumeLookX/Y()` input model makes
  the clean fix almost free.

## Babylon-specific gotchas

- **Pointer lock gives you no cursor.** A radial wheel normally wants an absolute
  cursor position relative to the wheel center. Under pointer lock you only get
  relative deltas. We integrate the consumed `consumeLookX()/consumeLookY()`
  delta into a selection vector so the wheel works *with* pointer lock (no
  exit/re-lock churn). `consumeLookY()` is already screen-y-down, which matches
  the overlay's y-down vector convention directly.
- **Route the look delta to ONE consumer per frame.** `createInput` accumulates
  the delta until consumed; we always consume it each frame and send it to either
  the selection vector (wheel open) or the heading yaw (wheel closed). Because
  nothing else reads the raw event, the camera cannot also spin — this is the
  clean alternative to the Three.js capture-phase swallow.
- **Rotate arms at the shoulder via `TransformNode` pivots, not the mesh.** Each
  arm box is parented to a `TransformNode` placed at shoulder height with the
  mesh offset down by half its length; rotating the *pivot node* swings the arm
  about the shoulder. Rotating the box mesh itself would spin it about its own
  midpoint. Whole-body Spin uses a separate rig-root `TransformNode` so it
  composes with — and never fights — the heading yaw on the player's yaw pivot.
- **`FollowCamera` follows a mesh, so target the body, not the rig root.** The
  camera locks onto the `Box` body mesh; the rig root and yaw pivot drive
  movement/heading underneath it.
- **Reset-then-apply each frame.** Every frame the rig is reset to idle and only
  the active emote re-applies its transforms, so poses never accumulate or leak
  state between emotes. `spinYaw` is composed *after* the reset onto the rig root.
- **Overlay canvas DPR.** The 2D overlay scales its backing store by
  `devicePixelRatio` (capped at 2) and the context by the same factor so the
  wheel stays crisp on HiDPI without blowing up memory.
- **Dispose everything.** The render observer is detached; shared `input` and
  `hud` are disposed; the wheel overlay `<canvas>`, the status `<div>`, all rig
  meshes/materials, the two arm-pivot `TransformNode`s, the rig root, and the
  yaw pivot are all freed — no DOM or scene-graph leak across a sample switch.
