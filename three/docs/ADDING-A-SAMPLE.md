# Adding a Sample

A sample is a self-contained folder that implements one game mechanic. This is the exact contract `/dev-all` follows for each issue.

## 1. The contract

`src/samples/types.ts`:

```ts
export interface SampleContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
}

export interface Sample {
  id: string;        // kebab-case, matches the folder name, used in the URL hash
  title: string;
  summary: string;   // one line shown in the gallery + overlay
  tags: string[];
  mount(ctx: SampleContext): void | (() => void); // returned fn disposes the sample
}
```

## 2. Create the sample folder

`src/samples/<NN-name>/index.ts`:

```ts
import { Mesh, BoxGeometry, MeshStandardMaterial } from "three";
import type { Sample } from "../types";

const sample: Sample = {
  id: "NN-name",
  title: "Human Title",
  summary: "One line describing the mechanic.",
  tags: ["movement", "physics"],
  mount(ctx) {
    const box = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    ctx.scene.add(box);

    const onKey = (e: KeyboardEvent) => { /* ... */ };
    window.addEventListener("keydown", onKey);

    // dispose: remove every listener and free GPU resources you created
    return () => {
      window.removeEventListener("keydown", onKey);
      box.geometry.dispose();
      (box.material as MeshStandardMaterial).dispose();
      ctx.scene.remove(box);
    };
  },
};

export default sample;
```

Notes:
- Per-frame logic: register an updater (see `engine/bootstrap.ts`) and unregister it in dispose. Do not start your own `requestAnimationFrame` loop.
- Use `ctx.camera` / `ctx.renderer` / `ctx.canvas` — do not create your own renderer.

## 3. Register it

Add it to `src/samples/registry.ts`:

```ts
import nnName from "./NN-name";
export const samples: Sample[] = [ /* ...existing, */ nnName ];
```

## 4. Write the sample README

`src/samples/<NN-name>/README.md` with these sections:
- **What it demonstrates**
- **Controls**
- **Feel & difficulty notes** — be honest, including where it feels bad
- **Three.js gotchas** — anything that tripped you up

## 5. Verify

- `npm run build` and `npm run typecheck` must be green.
- Open `npm run dev`, deep-link `#/NN-name`, confirm the mechanic works and that switching away disposes cleanly (no console errors, no leaked listeners).

## Sizing

Keep each issue to **one PR**. If a sample needs a new shared helper (input, HUD, primitives), build that helper as its own foundation issue first and depend on it.
