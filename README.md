# game-playgrounds

An experiment repo to compare how it **feels, performs, and builds** to make the same game mechanics in **three different engines** — and how well each one is developed by AI agents.

| Dir | Stack | Runs on | Start |
|-----|-------|---------|-------|
| [`three/`](./three) | Three.js (**Web** / TypeScript + Rapier) | Browser | `cd three && npm install && npm run dev` |
| [`babylon/`](./babylon) | Babylon.js (**Web** / TypeScript + Havok) | Browser | `cd babylon && npm install && npm run dev` |
| [`bevy/`](./bevy) | Bevy (**Native** / Rust + bevy_rapier3d) | Desktop | `cd bevy && cargo run --features bevy/dynamic_linking` |

Each subdir is a self-contained project that implements the **same sample lineup** (character controller, physics grab/throw, paint-on-mesh, …), so you can build one mechanic in every engine and compare. New samples are added autonomously from GitHub Issues via Claude Code's `/dev-all` (issues are labeled `engine:three` / `engine:babylon` / `engine:bevy`).

---

## What this repo verifies

| Dimension | The question |
|-----------|--------------|
| **Buildability / AI-dev fit** | Which engine is fastest and easiest to build with an AI agent (Claude)? |
| **Feel** | How does the *same* mechanic actually feel in each engine? |
| **Performance** | How heavy a scene can each one handle? |
| **Deployment** | How do you ship it (e.g. to Steam)? |

The goal is not to decide on paper — it's to **actually touch and compare**, so we can later pick which engine to build the real game in.

➡️ **The findings are written up in [`COMPARISON.md`](./COMPARISON.md)** — the cross-engine verdict across all four axes, grounded in the per-sample feel notes and measured code size. All 12 mechanics are built in every engine.

### The chapters so far

The repo grew past the single-machine comparison into three measured chapters, all written up in `COMPARISON.md`:

1. **Single-machine mechanics** (`three/`, `babylon/`, `bevy/`, COMPARISON §1–§7) — the 12-mechanic cross-engine comparison above, including a 2000-body stress measurement.
2. **Networking / multiplayer** (`net/`, COMPARISON §8) — server-authoritative + client-interpolation, **web (Colyseus, three+babylon clients) vs. native (Bevy + bevy_replicon)**, with a locked `metrics.jsonl` schema and measured bandwidth / RTT / snapshot-age / tick-cost on localhost.
3. **Web-on-Steam viability** (`docs/web-on-steam/`, COMPARISON §9) — does a **WebGPU** renderer lift the web ceiling (measured: no, ≈ WebGL on these scenes), and what does the desktop wrapper cost (**Electron 237 MB vs. Tauri 5 MB**, with a macOS-26 WebGPU gate on Tauri)?

---

## Concepts cheat-sheet (the easy-to-confuse parts)

### 1. The big picture: 3 layers between you and the pixels

```
[you / engine]  →  [renderer = the "translator"]  →  [GPU API]  →  [GPU (the artist)]
 "draw it like this"     translates for the artist      OS level      actually draws
```

- **Engine / library** = the one giving instructions (Three / Babylon / Bevy)
- **Renderer / GPU API** = the **translator** that talks to the GPU
- **GPU** = the **artist** that actually draws

> ✅ Key point: **you don't write the renderer yourself.** Pick an engine and the drawing path comes with it.

### 2. The kinds of "translator" (the most confusing bit)

| Name | What it is | Where it's used | Who uses it |
|------|-----------|-----------------|-------------|
| **WebGL** | the old web translator | inside the browser | **three / babylon (this, today)** |
| **WebGPU** | the new web translator (faster) | inside the browser | three / babylon (future) |
| **wgpu** | the **Rust** translator (a Rust implementation of WebGPU) | **outside** the browser (native) | **Bevy** |
| Vulkan / Metal / DX12 | the OS-level final translator | the OS | automatically, under the above |

### 3. Common misconceptions (true/false)

- ❌ "WebGL doesn't use the GPU" → **It does.** Even with WebGL you're already drawing on the device GPU.
- ❌ "Web = only WebGPU" → **WebGL is the default today.** WebGPU is a newer, optional path.
- ❌ "Babylon = Rust / wgpu" → **No.** Babylon is **JavaScript + WebGL**. wgpu is the **Bevy (Rust)** story.
- ❌ "Godot = the Go language" → **No.** Godot uses GDScript / C#. Unrelated to Go (Godot isn't covered here anyway).
- ❌ "avvy-world = Electron" → **No.** avvy-world is **native Rust + Bevy + wgpu**. Not web. A separate project.

### 4. The performance ladder (fastest last)

```
in theory:   WebGL  <  WebGPU  <  Native (wgpu / Bevy)
measured*:   WebGL  ≈  WebGPU  <  Native (wgpu / Bevy)
```

- WebGL uses the GPU, but it's the *entry* tier of performance.
- WebGPU is the newer browser path — **in theory** faster.
- Want the ceiling? → **Native (Bevy)** — but AI iteration gets heavier.
- 👉 For the **light games** we're targeting, **WebGL is plenty.** The gap only shows in heavy games.

> \* **We actually measured it** (chapter 3, COMPARISON §5.1 / §9). On these
> physics-bound 2000-body scenes **WebGPU did *not* lift the web ceiling** — it
> landed at parity with WebGL (Three: a slightly tighter p99 tail only; Babylon:
> marginally *slower* on WebGPU). Native (Bevy) is still clearly ahead. So the
> measured ladder is `WebGL ≈ WebGPU < native`, not the textbook one — for *these*
> scenes. The real web-vs-native trade-off turned out to be **distribution** (§6),
> not the renderer.

### 5. How AI-friendly is it? (the "editor problem")

| Engine | Code | Assembly | AI auto-dev |
|--------|------|----------|-------------|
| **Three / Babylon** | all TypeScript | **code only** | ◎ |
| **Bevy** | all Rust | **code only (no editor)** | ○ (Rust is heavy, but `bevy/` is tuned for speed — see `bevy/CLAUDE.md`) |
| (ref) Unity | C# | **GUI editor** | △ (AI gets stuck on assembly) |
| (ref) Unreal | C++ / **Blueprint (visual)** | **GUI editor** | ✗ (Blueprints are visual — AI can't edit them) |

> ✅ **No editor = the AI can do everything in code.** That's why Three / Babylon / Bevy fit AI development. Rust is the heavy one, so the `bevy/` subdir compensates with a fast-iteration setup (`cargo check`-first, dynamic linking, headless tests, etc.).

### 6. Deployment (shipping on Steam)

- **Web (Three / Babylon):** wrap the build in a **desktop shell** → `.exe`/`.app` → Steam. Two shells, both now built and measured (chapter 3, COMPARISON §9):
  - **Electron** (bundled Chromium): **237 MB** installed, but WebGPU works on **any** macOS and it measures like a normal app. The safe, heavy default.
  - **Tauri** (system WebView): **5.0 MB** (~47× smaller), but WebGPU is **macOS-26+ only** and the webview throttles itself when not frontmost. The featherweight gamble.
- **Bevy:** it's already a **native `.exe`/binary** → Steam (no wrapping needed), and it holds the performance ceiling (§5).
- **Steam process:** developer signup + $100 (recouped once the game earns $1,000) + store page + upload. You keep 70%.
- Verified packaging commands + the Steam upload checklist: [`docs/PACKAGING.md`](./docs/PACKAGING.md).

### 7. We deliberately do NOT build a cross-engine adapter

"One codebase swapped across engines" is a trap: it can't span languages, it kills the comparison (you'd feel the adapter, not the engine), and it erases each engine's strengths.
**What we reuse is the *development pattern*, not the rendering code** — the sample contract, the `/dev-all` loop, the feel-note format. Those are kept consistent across all three subdirs.

---

## Usage

```bash
# Web (same for three and babylon)
cd three && npm install && npm run dev      # → http://localhost:5173
cd three && npm run build                    # keep this green

# Bevy
cd bevy && cargo check                        # fast verify — the main dev loop
cd bevy && cargo run --features bevy/dynamic_linking   # run it (fast incremental builds)
cd bevy && cargo test                         # headless logic verification
```

## Adding samples (AI auto-dev)

1. File an Issue for the mechanic (`engine:*` label + the `.github/ISSUE_TEMPLATE/sample.md` format).
2. In Claude Code, run `/dev-all` → it loops **implement → review → PR → merge → next**.
3. Rule of thumb: 1 Issue = 1 PR = that subdir's build stays green.

See [`CLAUDE.md`](./CLAUDE.md) for project rules, and each subdir's `CLAUDE.md` for engine-specific details (the Bevy one includes the Rust fast-iteration setup for AI agents).
