# Adding a Sample

This is the detailed how-to for implementing, registering, and documenting a new
playground sample. It is the procedure `/dev-all` follows for each GitHub issue in
`docs/SAMPLES.md`.

## 1. The contract

Every sample implements the `Sample` interface from `src/samples/types.ts`:

```ts
export interface SampleContext {
  engine: Engine;            // shared, long-lived — do NOT recreate
  scene: Scene;              // fresh per sample — disposed on switch
  canvas: HTMLCanvasElement; // the single #app canvas
}

export interface Sample {
  id: string;        // kebab-case, unique; also the deep link `#/<id>`
  title: string;     // sidebar label
  summary: string;   // one-line overlay description
  tags: string[];    // sidebar chips, e.g. ["physics", "raycast"]
  mount(ctx: SampleContext): void | (() => void); // optional dispose fn
}
```

`mount` builds the scene into `ctx.scene`. If it returns a function, that function
is the **dispose** callback: it runs when the user switches away, *before*
`scene.dispose()`, so the sample can detach window/document listeners, exit pointer
lock, remove overlay DOM, and unhook observables it added outside the scene.

## 2. Create the folder

```
src/samples/NN-kebab-name/
├── index.ts     // implements + exports the Sample
└── README.md    // the 4 required sections (see §5)
```

Use the next free `NN` prefix (`04-`, `05-`, …) matching `docs/SAMPLES.md`.

## 3. Implement `index.ts`

Skeleton:

```ts
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder"; // side-effect import
import type { Sample, SampleContext } from "../types";

function mount(ctx: SampleContext): () => void {
  const { scene, canvas } = ctx;

  const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.5, 8,
    Vector3.Zero(), scene);
  camera.attachControl(canvas, true);
  new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);

  // ... build the mechanic, add observables/listeners ...

  return () => {
    // detach EVERYTHING this sample added outside the scene
  };
}

export const sampleNN: Sample = {
  id: "NN-kebab-name",
  title: "Human Title",
  summary: "One line: what the mechanic is and how you interact with it.",
  tags: ["..."],
  mount,
};

export default sampleNN;
```

### Rules that matter

- **Tree-shaken imports.** Import from deep paths (`@babylonjs/core/...`), not the
  barrel. For mesh builders, physics, raycasting, etc. add the matching
  side-effect import or the feature silently no-ops at runtime.
- **Never create an Engine or render loop.** Use `ctx.engine` / `ctx.scene`.
- **Own your cleanup.** Window/document listeners and overlay DOM are NOT cleaned
  up by `scene.dispose()`. Return a dispose fn that removes them.
- **Guard async setup.** If you `await` anything (e.g. Havok), the sample may be
  disposed first — track a `disposed` boolean and bail. See sample 02.
- **Physics:** call `createHavokPlugin()` from `src/engine/havok.ts`, then
  `scene.enablePhysics(gravity, plugin)`. Use `PhysicsAggregate` (v2 API).
- **Overlay UI:** append controls into `document.getElementById("overlay")` and
  remove them in dispose. Style with `pointer-events: auto` (the overlay is
  pass-through by default).

## 4. Register it

In `src/samples/registry.ts`:

```ts
import { sampleNN } from "./NN-kebab-name/index";
export const samples: Sample[] = [/* ...existing..., */ sampleNN];
```

Order in the array = order in the sidebar.

## 5. Write the README

`src/samples/NN-kebab-name/README.md` must have exactly these four sections:

- **What it demonstrates** — the mechanic and the Babylon features used.
- **Controls** — a table of inputs → actions.
- **Feel & difficulty notes** — honest feel: snappy/floaty, the tuning constants
  that shape feel, and an implementation difficulty rating.
- **Babylon-specific gotchas** — the non-obvious traps you hit (UV flips, async
  WASM, side-effect imports, pointer-lock gestures, etc.).

## 6. Verify (the gate)

```bash
npm run typecheck   # clean
npm run lint        # clean
npm run build       # MUST pass (tsc --noEmit && vite build)
npm run dev         # eyeball it at http://localhost:5173/#/NN-kebab-name
```

A red build blocks the next sample. Done means green.
