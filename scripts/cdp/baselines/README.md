# Visual-regression baselines

Reference PNGs for `run-e2e-visual.mjs` (`bun run test:e2e:visual`). Each is a
deterministic screenshot of the live side panel at a named state, captured with
animations frozen and the compositor pumped (see `e2e-harness.mjs` /
`visual.mjs`). The scenario decodes both the baseline and a fresh capture (an
npm-free PNG decoder) and fails if more than ~2% of pixels differ.

| Baseline | State |
|---|---|
| `initial-screen.png` | fresh profile, pre-unlock (vault setup) |
| `idle-unlocked.png` | unlocked, ready, empty composer |
| `completed-turn.png` | one stubbed assistant turn rendered, idle |

## Updating

Regenerate after an **intentional** UI change and commit the new PNGs:

```
bun run test:e2e:visual:update   # UPDATE_BASELINES=1
```

## Environment note

These are captured on the maintainer's machine. Headless font/subpixel
rendering differs across OSes, so baselines are **environment-specific** — a
diff failure on a different machine usually means "regenerate here", not a real
regression. That's why the visual scenario is a **local** command and is NOT in
the blocking CI E2E suite (`test:e2e:all`), which stays environment-independent.
Wiring visual into CI needs an env-matched baseline set (or a soft/artifact
mode) — a deliberate follow-up.
