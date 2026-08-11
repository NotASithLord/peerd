# Contributing to peerd

Thanks for helping out. peerd is a browser-native AI agent with no hosted agent
backend, account, or telemetry. It supports user-configured cloud and local
providers.
That requirement applies to every change. It is documented in the README,
`CLAUDE.md`, and the manifest. **Do not add a backend call,
telemetry, analytics, or an undeclared network service.**

## The one thing to know: there is no build step

peerd is vanilla JavaScript + ES modules. The browser runs the code exactly as
written. There is no bundler, transpiler, or watch process. The dev loop is
edit, then reload the extension.

## Setup

1. Clone, then `bun install`. This installs the **dev tooling only** (the test
   runner, ESLint, the type checker). The extension itself needs no install and
   no build to run.
2. Load it unpacked. Follow the **"Load unpacked"** steps in the
   [README](README.md). Open `chrome://extensions`, enable Developer mode,
   choose **Load unpacked**, and select the `extension/` directory.
3. After an edit, click the reload icon on the extension's card (or reload the
   page you're testing). That's the whole loop.

`extension/manifest.json` and `extension/shared/channel-config.js` are
**generated** by `bun run gen:dev` (from `manifests/*.json` +
`packaging/default-settings.mjs`). Do not hand-edit them. Edit the source and
regenerate. CI fails on drift.

## Read this first

[`CLAUDE.md`](CLAUDE.md) is the architecture orientation: the codebase is five
`peerd-*` modules, one per letter of the wordmark. Skim it before anything
non-trivial. The code is the spec. There is no separate current design-doc corpus.

## Tests: three surfaces, different jobs

- **Bun:** `bun test ./tests`. Use this for pure logic with no browser.
- **In-browser:** `bun scripts/cdp/run-inbrowser-tests.mjs` (or open
  `extension/tests/runner.html`). Anything that needs a real browser: the DOM,
  `chrome.*`, IndexedDB, the side-panel components.
- **Live end-to-end:** `bun run e2e:verify`. Drives the real extension through
  the side panel via Chrome DevTools Protocol.

Rule of thumb: *if a test would have to mock half the world to run, it wants the
browser; if it's values in and values out, it wants Bun.*

The in-browser and e2e runners need Chrome for Testing. `bun run e2e:chrome`
fetches it.

For UI work, inspect `scripts/cdp/artifacts/result.json` and every generated
screenshot. A passing assertion does not replace visual inspection.

## Before you push

Run **`bun run preflight`**. It covers local generation, lint, type, unit,
security-invariant, and package-boundary checks. Use the in-browser suite for
browser behavior. For UI or complete flow changes, also run `bun run e2e:verify`
and inspect its result file and screenshots. CI runs additional security,
network, browser, package, and visual lanes.

## House conventions

Most are enforced by `bun run lint` (ESLint autofixes much of it with
`eslint extension --fix`). The essentials:

- Vanilla JS, ES modules, **no new build step and no npm runtime dependency** in
  the extension. Third-party code lives in `vendor/` with a `SOURCE.txt`.
- A module's `index.js` is its public API; import across modules only through it.
- `peerd-distributed` is stricter. Nothing outside that module imports it,
  including its `index.js`. Use `shared/dweb-interface.js` and
  `shared/dweb-loader.js`.
- Comments explain **why**, not what.
- Modern, functional JS: `const`/`let` not `var`, arrow callbacks, template
  literals, array methods.
- Filenames are `lower-hyphenated.js`.

The full list lives in `CLAUDE.md` and `eslint.config.js`.

## Opening a pull request

- Keep it focused. Use one concern per PR.
- Use a title such as `fix(area): description`, `feat(area): description`, or
  `test(area): description`.
- Make sure `bun run preflight` is green first.
- The pull-request template will prompt for the rest.

For a first contribution, choose a small open issue with a clear acceptance
case. Ask on the issue before expanding its scope.

Found a security issue? Please follow [`SECURITY.md`](SECURITY.md) rather than
opening a public issue.
