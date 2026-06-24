# The E2E verify loop

A live end-to-end test surface built so an **agent can self-drive a
change → verify → fix loop**. It loads the real unpacked extension in Chrome
for Testing, drives the side panel through a set of states, and leaves behind
artifacts an agent can read: a screenshot per state, a structured `result.json`,
and a diff-highlight image on a visual miss.

> **For an agent (you):** the loop is — edit code → `bun run e2e:verify` →
> read `scripts/cdp/artifacts/result.json` and the screenshots → fix → repeat
> until `ok: true`. You can `Read` the PNGs, so you can *look* at what the UI
> actually rendered, not just pass/fail.

## Run it

```
bun run e2e:verify                 # all states (functional asserts + visual compare)
bun run e2e:verify --functional    # functional states only (env-independent; CI)
bun run e2e:verify --only=goal     # one state (or --only=goal,stop)
bun run e2e:verify --visual        # visual states only
UPDATE_BASELINES=1 bun run e2e:verify --visual   # (re)write visual baselines
```

One Chrome hosts every state back-to-back (reset the session + swap the model
responder between), so a full pass is **~6s**, not one launch per scenario.

Requires Chrome for Testing (branded Chrome ignores `--load-extension`):
`bun run e2e:chrome` provisions it, or set `CHROME_PATH`.

## What you get — `scripts/cdp/artifacts/` (gitignored)

- `result.json` — the verdict. Shape:
  ```jsonc
  {
    "ok": true,
    "summary": { "states": 7, "checksTotal": 19, "checksFailed": 0, "visualFailed": 0 },
    "states": [
      { "name": "goal", "kind": "functional", "ok": true,
        "checks": [{ "name": "loop drove >1 autonomous turn", "pass": true, "detail": "model calls: 3" }],
        "screenshots": [{ "label": "final", "path": "scripts/cdp/artifacts/goal-final.png" }],
        "visuals": [] },
      { "name": "completed-turn", "kind": "visual", "ok": false,
        "visuals": [{ "name": "completed-turn", "ratio": 0.108, "threshold": 0.02, "pass": false,
                      "current": "...-current.png", "baseline": "...", "diff": "...-diff.png" }] }
    ]
  }
  ```
- `<state>-<label>.png` — screenshots to **look at** (e.g. `goal-final.png`,
  `stop-busy.png`). Even on a pass, read these to judge whether a change *looks*
  right — there's no baseline for new UI, so your eyes are the test.
- `<name>-current.png` / `<name>-diff.png` — on a visual state: the fresh capture
  and (on a miss) a diff image with changed pixels in **red** over a dimmed
  layout, so you can see exactly *what* moved.

`process.exit` is `0` when `ok`, else `1`.

## The states — `scripts/cdp/states.mjs`

The single source of truth for what's driven and asserted. Each state:

```js
{ name, kind: 'functional'|'visual', phase: 'pre-unlock'|'post-unlock',
  responder,                 // per-call model behaviour (faked at the wire)
  async run(ctx, rec) { … }  // drive the panel + record:
}                            //   rec.check(name, pass, detail)  — assertion
                             //   rec.shot(label)                — screenshot artifact
                             //   rec.visual(name, opts)         — capture + baseline compare
```

**Add a state**: append to `STATES`. A functional state sends via `rpc` + asserts
via `rec.check` + leaves a `rec.shot`. A visual state captures via `rec.visual`
and is baselined. Run `UPDATE_BASELINES=1 bun run e2e:verify --visual` once to
seed any new visual baseline, then commit it.

## How the model is faked

Zero test-only code ships. The keyless Ollama provider's one network call
(`POST …/v1/chat/completions`) is intercepted over CDP's Fetch domain and
fulfilled with canned bytes — text, a tool call, an error status, or a delayed
response. Everything above the socket (the real adapter, `safeFetch`, the stream
parser, the agent loop, the goal runner) runs for real. The responder is
**swappable per state** (`ctx.setModelResponder`), which is what lets one Chrome
serve every state.

## Visual baselines are environment-specific

Baselines (`scripts/cdp/baselines/`) are captured on the maintainer's machine;
headless font/subpixel rendering differs per OS. A visual diff on a different
machine usually means "regenerate here", not a real regression. That's why
**CI runs `--functional`** (no visual), and the full visual compare is a local
tool. Wiring visual into CI needs env-matched baselines or a soft/artifact mode.

## Architecture

- `e2e-harness.mjs` — launch the extension, find the SW, arm CDP Fetch
  interception, open the panel, unlock; `ctx.screenshot()` (with the headless
  `bringToFront`-once + nudge-pump fixes), `setModelResponder`, `resetSession`,
  `freezeAnimations`.
- `states.mjs` — the states.
- `visual.mjs` — npm-free PNG decode/encode + tolerant pixel diff + baseline
  compare + diff-image writer.
- `run-e2e-verify.mjs` — the runner: one Chrome, all states, artifacts +
  `result.json`.
