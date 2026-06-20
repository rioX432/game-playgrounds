# 03 — Paint on Mesh

## What it demonstrates
Painting directly onto a 3D surface. A sphere's material uses a `CanvasTexture`
backed by an offscreen 2D canvas. A pointer raycast returns the hit's `uv`
coordinate, which maps to a texel position where a colored brush dot is drawn;
setting `texture.needsUpdate = true` re-uploads the canvas to the GPU. This is
the "めっちゃカメレオン" paint-to-disguise core.

## Controls
- **Drag on the sphere** — paint with the active color.
- **Palette (bottom)** — pick a brush color.
- **auto-rotate toggle** — pause/resume idle spin so you can reach all sides.

## Feel & difficulty notes
- Brush is a hard-edged filled circle (`BRUSH_RADIUS` texels). It feels like a
  marker, not an airbrush — add alpha falloff for softer strokes.
- Fast drags leave gaps because each pointermove paints one dot; interpolate
  between consecutive UVs to draw continuous strokes.
- There is visible seam distortion near the sphere's UV poles (standard sphere
  UV stretching) — expected, not a bug.
- Difficulty: **medium-low**. The UV→texel mapping and the V-flip are the only
  traps.

## Three.js-specific gotchas
- The intersection `uv` is only populated for geometries with UVs (built-in
  primitives have them). Always null-check `hits[0].uv`.
- UV origin is bottom-left but the 2D canvas origin is top-left, so flip V:
  `py = (1 - v) * TEX_SIZE`.
- Set `texture.colorSpace = SRGBColorSpace` for a color map, or painted colors
  shift.
- `texture.needsUpdate = true` after every draw — without it the GPU keeps the
  stale upload.
