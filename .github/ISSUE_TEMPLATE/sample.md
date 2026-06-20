---
name: New sample
about: Add (or split) a game-mechanic sample
title: "[sample] <id> <name>"
labels: sample
---

## Mechanic
<!-- Which game mechanic, and the classic × twist + reference game.
     e.g. "REPO-style physics grab/throw", "めっちゃカメレオン paint-disguise", "だるまさんがころんだ". -->

## Scope (one PR)
<!-- Exactly one coherent change. If a shared helper is needed first, link it: "depends on #N". -->

## Acceptance Criteria
- [ ] `src/samples/<NN-name>/index.ts` implements the `Sample` interface and is registered in `src/samples/registry.ts`
- [ ] The mechanic works in the gallery via deep-link `#/<NN-name>`
- [ ] `mount(ctx)` returns a dispose fn that removes every observer/listener it added (no leaks when switching samples)
- [ ] `src/samples/<NN-name>/README.md`: **What it demonstrates / Controls / Feel & difficulty notes / Babylon gotchas**
- [ ] `npm run build` and `npm run typecheck` are green
- [ ] Honest feel note recorded (including where it feels bad)

## Files expected to change
<!-- src/samples/<NN-name>/index.ts, src/samples/<NN-name>/README.md, src/samples/registry.ts -->

## Dependencies
<!-- "depends on #N" for a foundation helper, or "none". -->
