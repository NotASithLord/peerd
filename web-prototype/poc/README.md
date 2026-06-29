# peerd-lite PoC — the Notebook substrate in a plain web page

A runnable proof of the central claim in
[`docs/specs/PEERD-WEB-SURFACE.md`](../../docs/specs/PEERD-WEB-SURFACE.md): peerd's
execution substrates are **host-agnostic** (DECISIONS #25 — "the sandbox is the
isolate; a tab is one way to host it"), so the sealed Notebook worker runs in a
regular web page with **no extension** — the substrate ships verbatim, only the
host adapter changes.

This PoC takes the most portable substrate (the Notebook / sealed `js_run`
worker) and runs it in a plain page, then proves it with a headless check.

## What's reused verbatim vs. new

**Verbatim from the extension tree** (imported unmodified — change a byte and the
PoC breaks):

- `/notebook-tab/worker-source.js` — `buildWorkerSource`, the realm seal, the
  `peerd.*` surface, `NOTEBOOK_BUILTINS` (incl. `peerd:std`)
- `/peerd-engine/index.js` — `opfsHelpers`, `buildModule` (the module resolver)

**New — the entire delta is the host adapter** ([`notebook-host.js`](./notebook-host.js)),
which differs from the extension host (`offscreen/job-runner.js` +
`notebook-tab/notebook-tab.js`) in exactly three places:

1. **OPFS is durable** (a stable `['peerd-notebooks', id]` subtree) — like a
   Notebook tab, not the headless ephemeral scratch. OPFS is a web-platform API,
   so `opfsHelpers` works in a plain page unchanged.
2. **The fetch bridge is an in-page `fetch`**, not the extension SW's
   `sw/web-fetch` route — a page has no service worker to relay to. (The page can
   pass a denylist-gated `fetchImpl`.)
3. **No subagent relay** — subagents drive the user's real tabs, which is the
   extension's surface. An origin-confined page declines them. *That decline is
   the upgrade funnel, by construction.*

Everything else — the worker message protocol (`log` / `display` /
`fetch-request` / `opfs-request` / `done`), the seal, code-mode — is identical.

## Run it

Headless validation (serves `extension/` at root + this PoC, drives Chrome over
CDP):

```sh
bun web-prototype/poc/run-poc.mjs
```

It runs three cells in the page and asserts **7/7**: the worker runs, code-mode
returns the computed index, the console bridge works, the index file lands in
OPFS, **OPFS persists across two separate worker runs** (a fresh worker reads the
prior run's file), and the **in-page fetch bridge** resolves the seal-pinned
fetch to the host fetch.

To see it visually, serve the repo with `extension/` at root and `/poc/` mapped
to this folder, then open `/poc/` — a one-cell Notebook running the personal-data
index on device.

## Why this matters

The demo cell is the [personal-data index](../../docs/specs/LOCAL-FIRST-PERSONAL-DATA-AGENT.md)
(build + query an on-device OPFS index) — so this also shows that feature's
compute running, unchanged, in peerd-lite. The realm seal makes the worker
incapable of egress except through the audited bridge, in the page exactly as in
the extension.

This is the foundation slice: with the Notebook substrate proven portable, the
remaining peerd-lite work (the App iframe + WebVM substrates, the agent loop, the
BYOK vault) follows the same substrate-ships-verbatim / swap-the-host pattern.
