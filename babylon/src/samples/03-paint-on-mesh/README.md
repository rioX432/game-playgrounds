# 03 — Paint on Mesh (DynamicTexture)

## What it demonstrates

Painting directly onto a mesh's surface at runtime. The sphere's diffuse map is a
`DynamicTexture` (a backing 2D canvas). On pointer pick we read the hit UV via
`pickResult.getTextureCoordinates()` and stamp a colored brush dot at the
corresponding texel. This is the core of the "めっちゃカメレオン" paint-to-disguise
mechanic.

## Controls

| Input | Action |
|-------|--------|
| Left-drag (empty space) | Orbit camera |
| Mouse wheel | Zoom |
| Pointer down / drag (on sphere) | Paint brush dots |
| Palette swatches (top-left) | Pick brush color |

## Feel & difficulty notes

- **Feel**: Immediate and tactile — dots appear exactly under the cursor with no
  perceptible latency at 1024² texture size. Dragging paints a continuous-ish
  stroke (one dot per pointer-move event; fast drags leave gaps).
- **Difficulty**: Low-medium. The mechanic is a few lines; the subtlety is the
  UV → canvas-pixel mapping and the V-axis flip.
- For smoother strokes you would interpolate between the previous and current UV
  and stamp along the segment; here we keep it minimal.

## Babylon-specific gotchas

- `getTextureCoordinates()` returns UV in `[0,1]`. Canvas Y is **flipped** vs.
  texture V, so paint at `y = (1 - v) * size`. Getting this wrong paints mirrored.
- The mesh **must** have a material whose `diffuseTexture` is the `DynamicTexture`
  for `getTextureCoordinates()` to return meaningful UVs on a pick.
- Call `dynTex.update()` after every draw or the GPU copy is stale.
- `getContext()` returns a standard `CanvasRenderingContext2D`; any 2D canvas API
  (arc, fillRect, drawImage) works for brushes.
- Sphere UVs have a seam/pole pinch — brush dots near the poles smear. A box or
  custom-unwrapped mesh avoids this if uniform brush size matters.
- Palette UI is appended into the shared `#overlay` element and removed in the
  sample's dispose fn, so it never leaks into the next sample.
