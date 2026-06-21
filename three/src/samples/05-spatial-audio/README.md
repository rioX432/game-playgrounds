# 05 — Spatial Audio: Proximity Falloff

## What it demonstrates
Positional (3D) audio with **distance attenuation** — a proximity-voice stand-in
in the spirit of REPO / Content Warning, where another player's voice gets louder
as you approach and fades as you walk away. Here the "voices" are three fixed
**sound beacons** (low / mid / high pitched tones) placed across the field. You
walk around in first person; each beacon's volume swells as you near it and fades
to silence past a maximum range.

The spatialization is Three.js's built-in WebAudio wrapper:
- A single `THREE.AudioListener` is attached to the camera (`camera.add(listener)`).
  It auto-tracks the camera transform every frame, so it IS the player's ears.
- Each beacon mesh carries a `THREE.PositionalAudio` child
  (`mesh.add(audio)`), which auto-tracks the mesh's world position. Distance
  attenuation is configured with `setDistanceModel("linear")`, `setRefDistance`,
  `setMaxDistance`, and `setRolloffFactor`. The browser's `PannerNode` does the
  per-frame falloff math — proximity "just works" once listener + emitters track
  their transforms.
- **No audio asset files** (the playground forbids bespoke art assets). Each tone
  is generated procedurally: an `OscillatorNode` fed into the PositionalAudio via
  `setNodeSource(oscillator)`; the per-beacon base level is set with
  `audio.setVolume(...)` (the PositionalAudio's own gain), so no separate GainNode
  is needed. Each beacon uses a distinct frequency (G3 / E4 / C5) and waveform so
  you can tell them apart by ear and pinpoint them by direction (HRTF panning) as
  well as by distance.

It reuses the shared foundations: `InputController` (first-person look + WASD),
`Hud` (controls overlay + FPS), and `createLightPreset` / `createGround` scene
primitives (each a `PrimitiveSet` disposed on cleanup). A small self-owned readout
shows the current audio state and the distance to the nearest beacon, so the
falloff is measurable by eye as well as ear.

## Controls
- **Click canvas** — locks the mouse AND enables audio (the click is the user
  gesture that resumes the suspended AudioContext; oscillators start on resume).
- **Mouse** — look (yaw + pitch).
- **W / A / S / D** — move on the horizontal plane relative to facing.
- **Esc** — release pointer lock.
- Walk up to a beacon to hear its tone swell; back away to hear it fade out.

## Feel & difficulty notes
- The proximity falloff reads **clearly and instantly**: with the `linear` model,
  a beacon is at full volume within ~2 m and ramps smoothly to true silence by
  16 m. Crossing that boundary while walking gives a satisfying "entering earshot"
  moment that matches the proximity-chat feel the mechanic is imitating.
- HRTF panning (left/right + front/back) is a free bonus and genuinely helps you
  locate a beacon you can hear but not yet see. Turning your head pans the tone
  correctly because the listener tracks camera *orientation*, not just position.
- **Where it feels bad / honest caveats:**
  - **Continuous pure tones are unpleasant.** Real proximity chat carries varied
    speech; three steady oscillators droning at once is grating after a few
    seconds and makes overlapping beacons muddy. This is a faithful *attenuation*
    demo, not a pleasant *soundscape* — a real game would gate/duck or use varied
    samples.
  - The `linear` model's hard silence at `maxDistance` is easy to judge but feels
    artificial — volume hits exactly zero rather than trailing into a natural
    ambient floor. The `inverse`/real-world model never reaches true silence,
    which sounds more natural but makes the proximity boundary much harder to
    *feel* (you can faintly hear a beacon from across the map). The trade-off is
    real; we chose legibility of the mechanic over realism.
  - No occlusion: walls/boxes wouldn't muffle a beacon (there are none here, but a
    PannerNode alone won't model obstruction — that needs raycasting + filtering).
  - First-frame audio: nothing plays until you click (browser autoplay policy).
    Until then the readout says "click to enable", which is the only honest option.
- Difficulty: **low–medium**. The spatial math is the browser's; the real work is
  the autoplay gate and disposing the audio graph without leaks.

## Three.js-specific gotchas
- **Browser autoplay policy.** A WebAudio `AudioContext` starts `suspended` and
  only resumes from inside a user-gesture handler. We call
  `listener.context.resume()` on the canvas click (the same gesture that requests
  pointer lock) and start the oscillators only after the resume promise settles.
  Calling `resume()` outside a gesture is silently ignored, so the readout shows
  "click to enable audio" until then.
- **Oscillators are one-shot.** An `OscillatorNode` can be `start()`ed exactly
  once and `stop()`ped once; calling `stop()` on a never-started node throws. We
  guard both with an `oscillatorsStarted` flag and a try/catch on stop.
- **`setNodeSource` flips `hasPlaybackControl` to false.** That's correct for a
  live oscillator (it's not buffer-playback you `play()`/`pause()`). Importantly,
  `PositionalAudio.updateMatrixWorld` still updates the panner position in this
  mode, so the emitter keeps tracking its mesh — verified in
  `three/src/audio/PositionalAudio.js`.
- **Do NOT `context.close()` on dispose.** Three caches the `AudioContext` as a
  module-level singleton (`three/src/audio/AudioContext.js`) and never clears it,
  so a closed context would be reused — dead — by the next audio sample (or by
  re-entering this one). Cleanup therefore **suspends** the context instead, and
  stops + disconnects every oscillator and panner and removes the listener from
  the camera. After switching away, no oscillator keeps playing and the graph is
  detached, so there's no leak.
- **Removing a mesh doesn't free its material.** As with the other samples, the
  emitter materials are disposed explicitly; the shared sphere geometry is
  disposed once (all beacons share it); the `PrimitiveSet`s dispose the ground +
  lights. The sample also cancels its own `requestAnimationFrame` in dispose.
