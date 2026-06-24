# Contributing to peerd

Thanks for your interest in peerd — a browser-native AI agent that runs
entirely in your browser (BYOK, no backend, no telemetry). This guide
covers how to get set up, the rules that keep the project coherent, and
how to land a change.

> **peerd is `0.x` — experimental alpha.** Breaking changes are frequent
> and intentional: there is **no pre-release compatibility commitment**
> (`docs/DECISIONS.md` #17). `main` moves fast across several worktrees.
> Read **["Working with a fast-moving `main`"](#working-with-a-fast-moving-main)**
> before you start anything non-trivial.

## TL;DR

1. **Open an issue first** for anything beyond a small fix — so we can
   confirm it fits and isn't already in flight.
2. Fork, branch, make the change in **vanilla JS (no build step)**.
3. Make the checks pass: `bun run preflight`.
4. **Sign off your commits** (`git commit -s`) — we use the DCO.
5. Open a PR against `main` and fill in the template.

## Read this first (in order)

- **`README.md`** — what peerd is, install, dev setup, repo layout.
- **`ARCHITECTURE.md`** — the five-module breakdown and dependency graph.
- **`docs/DECISIONS.md`** — recorded tradeoffs; saves you from
  re-litigating settled calls.
- **`CLAUDE.md`** — *agent-facing* project context (peerd is built with an
  AI coding agent). It's useful background, but it's written **for the
  agent, not for human contributors** — `README.md` + `ARCHITECTURE.md`
  are your canonical docs.

## Development setup

No build step, no bundler, no transpiler — the browser runs the source as
written.

```bash
bun install              # dev tooling only (tests, linters, packaging)
```

**Load the extension (the dev loop is: load unpacked → edit → refresh):**

- **Chrome/Edge:** `chrome://extensions` → enable *Developer mode* →
  *Load unpacked* → select the `extension/` directory. Re-load after edits.
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary
  Add-on* → pick `extension/manifest.json`.

**To actually exercise the agent you need a model key (BYOK):** open the
peerd side panel, set up the vault, and add an Anthropic or OpenRouter API
key in Settings. Nothing leaves your machine except calls to that
provider.

See `README.md` → *Getting started* and `PACKAGING.md` for more.

## Required checks

CI runs the release checks on every PR; run them locally first:

```bash
bun run preflight
```

For the current check list, read `package.json`, `packaging/preflight.ts`,
and the CI workflow. Do not copy the full check list into docs; it changes as
the project changes.

**Two test surfaces, two jobs:** put pure value-in/value-out logic in
`tests/**/*.test.ts` (Bun); put anything needing a real browser (DOM,
`chrome.*`, IDB, Mithril components, the SW) in
`extension/tests/unit/**/*.test.js` (the in-browser runner) and register
it in `extension/tests/index.js`.

## Non-negotiable conventions

These keep the codebase coherent (the full list is in `CLAUDE.md` /
`README.md` → *Project conventions*):

- **Vanilla JS, ES modules, no build step.** No new runtime npm
  dependencies inside `extension/`.
- **`index.js` is the public API per module.** Don't deep-import into a
  `peerd-*` module from outside it (ESLint enforces this).
- **Functional core, imperative shell.** Reducers/policy are pure
  functions; IO is injected, never imported inside a module.
- **JSDoc types** (the strict `tsc` gate makes them real). **Mithril** for
  UI. **Named error subclasses**, not bare `Error`.
- **Filenames** lowercase-hyphenated; comments explain **why**, not what.
- **The name is always lowercase: `peerd`** — even at the start of a
  sentence (`docs/DECISIONS.md`).
- **Third-party code is vendored** under `extension/vendor/` with a
  `SOURCE.txt` (origin + version) and SHA/SRI pinning — never an npm
  runtime import. Audit before vendoring.
- **Docs defer to code and CI for live state.** Do not hard-code dynamic
  facts such as test counts, tool counts, gate matrices, release artifacts,
  generated-file contents, extension IDs, channel behavior, or provider/model
  inventories. Link to the source file, script, generated artifact, release,
  or CI/preflight command that computes the current answer.

## Licensing of contributions

### DCO (Developer Certificate of Origin)

By contributing, you certify the [DCO](https://developercertificate.org/)
— that you wrote the patch (or have the right to submit it under the
project license). **Sign off every commit:**

```bash
git commit -s -m "your message"      # appends: Signed-off-by: Name <email>
```

(There is no CLA.)

### Keep peerd copyleft-clean — this is load-bearing

peerd is **Apache-2.0** and deliberately avoids copyleft contamination.

- **Only contribute code you wrote, or code under an Apache-2.0-compatible
  permissive license** (MIT, BSD, ISC, Apache-2.0).
- **Never paste GPL / AGPL / LGPL / other copyleft source** into peerd,
  and don't transliterate it. (When studying a copyleft project for ideas,
  work from its public docs/behavior and write original code.)
- Vendoring a permissive dep is fine — add its `SOURCE.txt` + license and
  pin it.

A copyleft slip can poison the whole project's license, so PRs that look
copied from a copyleft source will be declined.

## Danger zones (expect deeper review / coordinate first)

These areas are security- or invariant-critical. Small, well-discussed
PRs only, and expect maintainer review:

- `extension/peerd-egress/` — vault, `safeFetch`/`webFetch`, the denylist,
  audit (the egress chokepoint).
- `extension/peerd-runtime/tools/gates.js` + the policy-gated dispatcher;
  the `do`/`get`/`check` runner boundary (`tools/exposure.js`, `runner/`).
- `extension/js-tab/sandbox-neutralizers.js` and the sandbox-sealing code
  — **do not "modernize" or refactor for style**; the exact shape is the
  security boundary.
- The **dweb boundary**: nothing outside `peerd-distributed/` may import
  it; core uses `shared/dweb-interface.js` + `shared/dweb-loader.js`.
- The agent loop (`peerd-runtime/loop/`), the manifest/CSP, and
  `packaging/`.

If you're unsure whether something is a danger zone, ask in the issue.

## Working with a fast-moving `main`

Because `main` churns and there's no pre-release compat:

- **Keep PRs small and focused** — one logical change. Large refactors
  rot fast and are hard to land.
- **Open an issue and get a 👍 before large work** so you don't build on
  something about to change.
- **Expect to rebase.** Rebase onto the latest `main` before asking for
  review.
- Don't add backwards-compat shims for pre-release behavior — we delete,
  we don't deprecate (#17).

## Filing issues

Use the templates (bug / feature). For **security**, do **not** open an
issue — see [`SECURITY.md`](SECURITY.md). For questions and ideas, use
[Discussions](https://github.com/NotASithLord/peerd/discussions).

Be respectful and constructive in issues, PRs, and discussions. A formal
Code of Conduct is forthcoming.
