# Contributing to peerd

Thanks for helping out. peerd is a browser-native AI agent that runs **entirely
in your browser** — no backend, no account, no telemetry, bring-your-own-key.
That promise is load-bearing (it's in the README, `CLAUDE.md`, and the manifest
itself), so the one hard rule for any change: **don't add a backend call,
telemetry, analytics, or anything that phones home.**

## The one thing to know: there is no build step

peerd is vanilla JavaScript + ES modules. The browser runs the code exactly as
written — no bundler, no transpiler, no watch process. The dev loop is just
**edit → reload the extension.**

## Setup

1. Clone, then `bun install`. This installs the **dev tooling only** (the test
   runner, ESLint, the type checker). The extension itself needs no install and
   no build to run.
2. Load it unpacked — follow the **"Load unpacked"** steps in the
   [README](README.md): `chrome://extensions` → enable Developer mode → **Load
   unpacked** → pick the `extension/` directory.
3. After an edit, click the reload icon on the extension's card (or reload the
   page you're testing). That's the whole loop.

`extension/manifest.json` and `extension/shared/channel-config.js` are
**generated** by `bun run gen:dev` (from `manifests/*.json` +
`packaging/default-settings.mjs`) — don't hand-edit them; edit the source and
regenerate. CI fails on drift.

## Read this first

[`CLAUDE.md`](CLAUDE.md) is the architecture orientation: the codebase is five
`peerd-*` modules, one per letter of the wordmark. Skim it before anything
non-trivial. The code is the spec — there's no separate design-doc corpus.

## Tests — three surfaces, different jobs

- **Bun** — `bun test ./tests`. Pure logic, no browser, runs in the terminal in
  under a second. *If your test is values-in, values-out, it goes here.*
- **In-browser** — `bun scripts/cdp/run-inbrowser-tests.mjs` (or open
  `extension/tests/runner.html`). Anything that needs a real browser: the DOM,
  `chrome.*`, IndexedDB, the side-panel components.
- **Live end-to-end** — `bun run e2e:verify`. Drives the real extension through
  the side panel via Chrome DevTools Protocol.

Rule of thumb: *if a test would have to mock half the world to run, it wants the
browser; if it's values in and values out, it wants Bun.*

The in-browser and e2e runners need Chrome for Testing — `bun run e2e:chrome`
fetches it.

## Before you push

Run **`bun run preflight`**. It mirrors CI (generated-file drift, ESLint, the
type check, the dweb boundary, the packaged-import check, and the Bun suite), so
a green preflight is a green CI in miniature. `bun run preflight -- --matrix`
additionally builds and boots the packaged artifacts (slower; needs Chrome for
Testing).

## House conventions

Most are enforced by `bun run lint` (ESLint autofixes much of it with
`eslint extension --fix`). The essentials:

- Vanilla JS, ES modules, **no new build step and no npm runtime dependency** in
  the extension — third-party code lives in `vendor/` with a `SOURCE.txt`.
- A module's `index.js` is its public API; import across modules only through it.
- Comments explain **why**, not what.
- Modern, functional JS — `const`/`let` not `var`, arrow callbacks, template
  literals, array methods.
- Filenames are `lower-hyphenated.js`.

The full list lives in `CLAUDE.md` and `eslint.config.js`.

## Opening a pull request

- Keep it focused — one concern per PR.
- Title it like `fix(area): …`, `feat(area): …`, or `test(area): …`.
- Make sure `bun run preflight` is green first.
- The pull-request template will prompt for the rest.

**New here?** Look for issues labelled **`good first issue`** — they're scoped to
be a clean first contribution.

Found a security issue? Please follow [`SECURITY.md`](SECURITY.md) rather than
opening a public issue.
