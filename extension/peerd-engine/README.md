# peerd-engine

> The **`e`** (amber) in the peerd wordmark — the execution module.
> Sandboxes: the registries, persistence, and composition utilities
> behind peerd's four execution kinds. Part of
> [peerd](../../README.md); read the root README first, then
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md) and **DESIGN.md §8.5** (the
> full sandbox taxonomy).

**Status: 0.x — experimental beta.** WebVMs work but boot in ~10s,
cache the base image per-VM (no shared cache yet), and verify only the
head of the rootfs. Notebooks reset their JS realm every run by design.
See [known limitations](#known-limitations) — this module has the most
field-hardening work ahead.

---

## What it does

`peerd-engine` owns peerd's **Sandboxes** — sealed execution contexts
the agent runs code in. There are four kinds (the taxonomy lives in
DESIGN.md §8.5):

| Kind | Substrate | Isolation | Host | Persistence |
|---|---|---|---|---|
| **WebVM** | CheerpX-emulated Debian (WASM) | WASM confinement | own tab | per-VM IndexedDB disk overlay |
| **Notebook** | sealed JS Web Worker + OPFS | language realm seal + CSP | own tab | OPFS file tree (realm resets per run) |
| **App** | stored HTML in an opaque-origin iframe | real origin boundary | own tab | OPFS file tree |
| **headless worker** (`js_run`) | the Notebook's sealed worker, offscreen | language realm seal + CSP | offscreen, no tab | none (ephemeral) |

This module holds the **metadata registries** and the **composition
utilities** (the CodeMirror editor, OPFS helpers, the module resolver,
app composition, the rootfs integrity pin, artifact export/import, the
per-VM command queue). The **runtimes themselves live outside this
module** — in `vm-tab/`, `notebook-tab/`, `app-tab/`, and
`offscreen/job-runner.js` — with a tab tracker + RPC client per kind in
`background/`. The engine is the catalog and the shared machinery; the
tab pages are the hosts.

## How it works today

The lifecycle of each tab-hosted kind is split four ways:

- **Registry** (here, in `peerd-engine`) — the persistent catalog
  (`chrome.storage.local`) plus per-session defaults. A shared
  `registry-factory.js` backs all three; per-kind files
  (`vm-registry.js`, `notebook-registry.js`, `app-registry.js`) inject
  the fields that differ.
- **Tracker** (`background/<kind>-tab-tracker.js`) — the in-memory
  instance-id ↔ tab-id map, rebuilt from `chrome.tabs.query()` on
  service-worker boot.
- **Client** (`background/<kind>-client.js`) — resolves the target,
  ensures the tab exists, and dispatches the RPC.
- **Tab** (`<kind>-tab/`) — the host runtime (CheerpX, the worker, the
  iframe).

### WebVM (CheerpX Linux)

A real Debian, emulated to WebAssembly, in a visible tab. Each VM gets
its own IndexedDB write **overlay** stacked over the streamed stock
rootfs (read-through: reads fall to the base image, writes land in the
overlay), so a VM's disk survives browser restarts. HTTP egress
(`curl`/`wget`/`git`) is intercepted by bash function wrappers that
route every request back through `peerd-egress`'s audited `webFetch`
before it leaves the browser — the VM has no IP stack, so SSH, raw
TCP/UDP, and custom protocols simply aren't addressable.

Robustness work that's landed:

- **Tab-close interrupt** — closing the tab rejects pending RPCs
  immediately (`VMTabClosedError`) instead of stalling to a 90s timeout.
- **Per-VM FIFO command queue** (`command-queue.js`) — serializes
  concurrent `vm_run` calls so the single bash output buffer can't be
  clobbered; different VMs stay concurrent; lanes detach on interrupt.
- **TOFU rootfs integrity pin** (`image-pin.js`) — records the rootfs's
  total size + first-64 KiB SHA-256 on first boot and verifies it on
  every subsequent boot; a mismatch fails boot **closed** (silent
  base-byte drift under an existing overlay is the risk it guards).

### Notebook (sealed worker + OPFS)

A sealed Web Worker with its own JS realm and an OPFS file tree, in a
visible tab. The realm is hard-sealed: the bridged `peerd.egress.fetch`
is its only network (pinned non-configurable), every raw primitive (XHR,
WebSocket, EventSource, WebTransport, `sendBeacon`, `importScripts`,
nested Worker) is deleted off the prototype chain, and `connect-src
'none'` is the second fence. **Each run spawns a fresh worker**, so
in-memory state (`globalThis`, `let`/`const`) does *not* carry between
runs — the OPFS tree is the durable workspace; persist with
`peerd.self.writeFile`/`readFile`.

### App (opaque-origin iframe)

A multi-file HTML app peerd builds *for the user*, composed into a
single document (`app-compose.js` inlines local `<link>`/`<script src>`)
and rendered in a sandboxed, opaque-origin iframe with no `chrome.*`
access and a `default-src 'self'` CSP (no network by default). Edit mode
mounts the shared CodeMirror editor over the iframe; saves auto-reload
the open tab so iterations show live. dweb-installed apps carry their
publisher/version metadata for update tracking.

### Headless worker (`js_run`)

The *same* sealed worker as a Notebook, run in the offscreen document
with **no tab** and an ephemeral OPFS that's nuked when the job ends.
It's the agent's own quick compute and peerd's "code mode" — one script
instead of a chain of tool calls — not a workspace you watch. Capped at
4 concurrent jobs.

## Public API (`index.js`)

- **Registries:** `createVmRegistry` / `VM_TAB_PATH`,
  `createNotebookRegistry` / `NOTEBOOK_TAB_PATH` / `NOTEBOOK_OPFS_ROOT`,
  `createAppRegistry` / `APP_TAB_PATH`.
- **Module resolver:** `buildModule`, `buildEntry`.
- **Editor & files:** `createEditor`, `opfsHelpers`.
- **App composition:** `composeApp`, `withNewTabLinks`, `stripMetaRefresh`.
- **Command serialization:** `createKeyedQueue`.
- **Rootfs pin:** `parseContentRangeTotal`, `evaluateImagePin`,
  `IMAGE_PIN_HEAD_BYTES`, `IMAGE_PIN_STORAGE_KEY`.
- **Artifact export/import (`.peerd` envelopes):** `buildAppExport`,
  `buildNotebookExport`, `buildVmRecipeExport`, `openEnvelope`,
  `inspectEnvelope`, `exportFilename`, `EXPORT_LIMIT_BYTES`.
- **Errors:** `VMNotReadyError`, `VMBootFailedError`,
  `VMRunTimeoutError`, `VMNetworkDeniedError`, `VMTabClosedError`,
  `ArtifactTooLargeError`, `EnvelopeFormatError`,
  `EnvelopeIntegrityError`.

## Known limitations

- **Base-image caching is per-VM, not shared.** Every WebVM caches stock
  Debian blocks in its *own* IndexedDB overlay, so N VMs cache the same
  image N times. A shared read-only base cache + per-VM write overlay
  would dedupe it, but CheerpX's overlay-nesting and multi-tab IDB
  behavior are undocumented and need real boot testing first
  (`TODO(shared-base-cache)`).
- **No persisted custom VM images.** Every VM boots the same hardcoded
  stock image; a custom, faster-booting peerd image is scoped in
  `docs/engine/VM-IMAGE.md` but not shipped (no `VmRecord.image` field
  yet).
- **Rootfs verification is head-only.** The TOFU pin hashes the first
  64 KiB + total size; a malicious host could serve a faithful head and
  a tampered tail. Full verification needs a per-block hash manifest +
  custom block device.
- **~10s WebVM boot** (emulation + image stream + bash init). Notebooks
  boot in hundreds of ms.
- **No JS state between Notebook/`js_run` runs** — fresh realm each time,
  by design. State belongs in OPFS files.
- **App iframes have no network** (CSP `default-src 'self'`). Fine for
  the trusted apps peerd builds today; the per-app grant + quota
  machinery that dweb-delivered apps will need is not wired yet.
- **`.peerd` export envelopes are unsigned** (v1) — they carry a
  verified manifest + chunks but no publisher signature yet.

## TODO / backlog

Backlog — engine robustness residuals (GitHub Issues)
and [`docs/engine/VM-IMAGE.md`](../../docs/engine/VM-IMAGE.md):

- **Shared read-only WebVM base-image cache** to dedupe per-VM copies —
  blocked on settling CheerpX overlay nesting
  (`vm-tab.js` `TODO(shared-base-cache)`).
- **Per-block hash manifest + custom block device** for *full* rootfs
  stream verification — pairs with the peerd-built image.
- **A custom peerd Debian image** (python3/pandas/pip/jq/git/ripgrep
  preinstalled), hosted with immutable versioning, selectable per VM —
  scoped in `docs/engine/VM-IMAGE.md`, not yet staffed.
- **Per-app capability grants + quota** for dweb-delivered apps that
  need `engine.*` / `provider.*` / network access.

## See also

- **DESIGN.md §8.5** — the full four-kind sandbox taxonomy and the
  isolation rationale.
- [`docs/engine/VM-IMAGE.md`](../../docs/engine/VM-IMAGE.md) — the custom
  VM image plan.
- [`peerd-egress`](../peerd-egress/README.md) — the egress gate every
  sandbox routes through.
- [`peerd-runtime`](../peerd-runtime/README.md) — the `vm_*` / `js_*` /
  `app_*` tool families that drive these registries.
