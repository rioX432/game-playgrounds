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
WebGL  <  WebGPU  <  Native (wgpu / Bevy)
```

- WebGL uses the GPU, but it's the *entry* tier of performance.
- Want more? → **WebGPU** (faster, still in the browser).
- Want the ceiling? → **Native (Bevy)** — but AI iteration gets heavier.
- 👉 For the **light games** we're targeting, **WebGL is plenty.** The gap only shows in heavy games.

### 5. How AI-friendly is it? (the "editor problem")

| Engine | Code | Assembly | AI auto-dev |
|--------|------|----------|-------------|
| **Three / Babylon** | all TypeScript | **code only** | ◎ |
| **Bevy** | all Rust | **code only (no editor)** | ○ (Rust is heavy, but `bevy/` is tuned for speed — see `bevy/CLAUDE.md`) |
| (ref) Unity | C# | **GUI editor** | △ (AI gets stuck on assembly) |
| (ref) Unreal | C++ / **Blueprint (visual)** | **GUI editor** | ✗ (Blueprints are visual — AI can't edit them) |

> ✅ **No editor = the AI can do everything in code.** That's why Three / Babylon / Bevy fit AI development. Rust is the heavy one, so the `bevy/` subdir compensates with a fast-iteration setup (`cargo check`-first, dynamic linking, headless tests, etc.).

### 6. Deployment (shipping on Steam)

- **Web (Three / Babylon):** **wrap it in Electron** → `.exe` → Steam. (Electron over Tauri for games: more consistent rendering across machines.)
- **Bevy:** it's already a **native `.exe`** → Steam (no wrapping needed).
- **Steam process:** developer signup + $100 (recouped once the game earns $1,000) + store page + upload. You keep 70%.

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
