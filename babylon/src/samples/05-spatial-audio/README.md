# 05 — Spatial Audio: Proximity Falloff

## What it demonstrates
Positional (3D) audio with **distance attenuation** — a proximity-voice stand-in
in the spirit of REPO / Content Warning, where another player's voice gets louder
as you approach and fades as you walk away. Here the "voices" are three fixed
**sound beacons** (low / mid / high pitched tones, roughly G3 / E4 / C5) placed
across the field. You walk in first person; each beacon's volume swells as you
near it and fades to silence past a maximum range. HRTF panning lets you locate a
beacon by ear (left/right + front/back) before you see it.

The spatialization is Babylon's built-in WebAudio wrapper (`@babylonjs/core` 7.54):
- The stable `Sound` class with `spatialSound: true` configures a WebAudio
  `PannerNode`. Distance attenuation is set with `distanceModel: "linear"`,
  `refDistance`, `maxDistance`, and `rolloffFactor` (the same knobs as the Three.js
  twin sample). `sound.attachToMesh(mesh)` makes the panner track the beacon's
  world position each frame.
- The **listener** auto-tracks `scene.activeCamera.globalPosition` and orientation
  every frame. That tracking lives in the `@babylonjs/core/Audio/audioSceneComponent`
  side-effect import — without it, spatial sounds never pan or attenuate. So the
  camera IS the player's ears; no manual per-frame listener update is needed.
- **No audio asset files** (the playground forbids bespoke art assets). Each tone
  is generated procedurally: a one-period sine `AudioBuffer` is filled by hand
  (`sin(2π f t)`) from the engine's audio context and passed straight to the
  `Sound` constructor, which accepts an `AudioBuffer` directly (synchronous — no
  async load race). Looping one full period is seamless (no click at the seam).
  `switchPanningModelToHRTF()` upgrades the panning to HRTF.

It reuses the shared foundations: `createInput` (first-person pointer-lock look +
WASD), `createHud` (controls overlay + FPS), and `createLightPreset` /
`createGround` scene primitives. The first-person base is sample 04 with gravity/
jump removed (flat exploration). A small self-owned readout shows the audio state
and the distance to the nearest beacon, so the falloff is measurable by eye too.

## Controls
| Input | Action |
|---|---|
| Click canvas | Lock the mouse AND enable audio (the click is the user gesture that unlocks Babylon's audio engine) |
| Mouse | Look (yaw + pitch) |
| W / A / S / D | Move on the horizontal plane relative to facing |
| Esc | Release pointer lock |

Walk up to a beacon to hear its tone swell; back away to hear it fade out.

## Feel & difficulty notes
- The proximity falloff reads **clearly and instantly**: with the `linear` model a
  beacon is at full volume within ~2 m and ramps smoothly to true silence by 16 m.
  Crossing that boundary while walking gives a satisfying "entering earshot"
  moment that matches the proximity-chat feel the mechanic imitates.
- HRTF panning is a free bonus and genuinely helps you locate a beacon you can
  hear but not yet see. Turning your head pans the tone correctly because the
  listener tracks camera *orientation*, not just position.
- Tuning constants that shape the feel: `REF_DISTANCE` (2) = radius of full
  volume, `MAX_DISTANCE` (16) = the silence boundary, `ROLLOFF_FACTOR` (1) = how
  steep the ramp is between them, `BEACON_VOLUME` (0.25) = per-beacon base level
  so three overlapping tones don't clip.
- **Where it feels bad / honest caveats:**
  - **Continuous pure tones are unpleasant.** Real proximity chat carries varied
    speech; three steady sines droning at once is grating after a few seconds and
    muddy where beacons overlap. This is a faithful *attenuation* demo, not a
    pleasant *soundscape* — a real game would gate/duck or use varied samples.
  - The `linear` model's hard silence at `maxDistance` is easy to judge but feels
    artificial — volume hits exactly zero rather than trailing into an ambient
    floor. The `inverse` (real-world) model never reaches true silence, which
    sounds more natural but makes the proximity boundary much harder to *feel*.
    We chose legibility of the mechanic over realism.
  - No occlusion: the `PannerNode` alone won't muffle a beacon behind geometry
    (there's none here) — that needs raycasting + filtering.
  - First-frame audio: nothing plays until you click (browser autoplay policy).
    Until then the readout says "click to enable", which is the only honest option.
- Difficulty: **low–medium**. The spatial math is the browser's; the real work is
  the autoplay gate and disposing the audio graph without leaks.

## Babylon-specific gotchas
- **The `audioSceneComponent` side-effect import is mandatory.** It registers the
  audio engine factory AND the per-frame listener that tracks `scene.activeCamera`.
  Omit it and `spatialSound` sounds construct fine but never pan/attenuate, and
  `AbstractEngine.audioEngine` may be null. (Verified in `audioSceneComponent.js`:
  the after-render hook reads `scene.activeCamera.globalPosition`.)
- **Browser autoplay policy.** Babylon's `AudioContext` starts suspended; the
  audio engine resumes it on the first user gesture. We call `audioEngine.unlock()`
  on the same pointer-down that requests pointer lock, and flip the readout to
  "on" from `onAudioUnlockedObservable`. `autoplay: true` sounds begin as soon as
  the engine unlocks.
- **`Sound` accepts an `AudioBuffer` directly.** The constructor's
  `urlOrArrayBuffer` is typed `any` but handles `AudioBuffer` synchronously (sets
  the buffer and arms autoplay immediately — no `readyToPlayCallback` round-trip,
  no async-vs-dispose race for the buffer). Verified in the 7.54 `sound.d.ts`
  constructor doc ("it also works with MediaStreams and AudioBuffers") and
  `sound.js` (`_urlType === "AudioBuffer"` → `_audioBufferLoaded`).
- **`scene.dispose()` does NOT free `Sound` objects.** Their WebAudio nodes live
  on the process-wide audio engine singleton (`AbstractEngine.audioEngine`), which
  persists across sample switches. So each beacon `Sound` is `stop()` + `dispose()`
  explicitly in the sample's dispose fn, or the tones keep playing after you
  switch away.
- **Do NOT close the audio context on dispose.** Like Three's cached context,
  Babylon's audio engine is a singleton; closing its context would break the next
  audio sample. Cleanup stops + disposes the Sounds and leaves the context alone.
- **Procedural loop seam.** Generating exactly one sine period and looping it is
  click-free; an arbitrary buffer length would discontinue at the loop point and
  add an audible tick.
