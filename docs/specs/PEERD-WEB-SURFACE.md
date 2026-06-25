# peerd web surface ("peerd-lite") — design spec

> Status: **proposed.** A design for running peerd's sandboxes, agent loop,
> and dweb inside a regular web page (peerd.ai), derived from the existing
> extension codebase rather than forked. Grounded in a seam audit of
> `origin/main` (see "Portability map" below); LOC/effort figures are
> estimates.

---

## 1. Problem

"Browser-native, BYOK, privacy-first, local-first, multi-agent" is now a
category, not a moat (DEVS, agentOS, others share the ethos). The peerd.ai
site states the thesis and runs two live proofs already (the CheerpX VM
demo, the dweb peers widget), but a visitor can't *use* peerd without first
installing the extension. That's a high-friction funnel for a product whose
"aha" is watching an agent actually run code, boot a Linux VM, build an app,
and talk to other agents.

Meanwhile the one thing that genuinely separates peerd from the SPA-class
competitors is structural: peerd is an **extension** that drives the user's
real browser, tabs, and authenticated sessions. A web page is origin-confined
and cannot. That limitation is not a weakness to hide; it is the upgrade
pitch.

## 2. Goals

1. Let a visitor try peerd's **origin-confined** capabilities in the page,
   with their own model key, no install: a BYOK agent that runs Notebooks,
   builds Apps, (optionally) boots a WebVM, and joins the dweb.
2. Make the demo's ceiling the funnel: every capability the page *can't*
   reach (your tabs, your sessions, do/get/check, cross-site DOM) is exactly
   what the extension adds. "You just did this in a sandbox — install the
   extension to point it at your real browser."
3. **Derive from core peerd, do not fork.** All divergence confined to (a) a
   host adapter and (b) a packaging target. The agent loop, vault, providers,
   egress, tool-exposure, and the four substrates ship verbatim.
4. Keep the security story honest about the lower trust of a page-hosted
   vault, and turn that into another reason to upgrade.

## 3. Non-goals (the funnel boundary, by construction)

peerd-lite **deliberately omits**, because a page structurally cannot do
them — and saying so is the pitch, not an apology:

- driving the user's real tabs/pages (`do`/`get`/`check`, the disposable
  runner, `chrome.scripting`, CDP, `page_exec`/`page_keys`)
- reading the user's logged-in sessions / cross-origin DOM
- `list_tabs` / `open_tab` and anything tab-spanning
- persistent, cross-restart background work (no MV3 service worker)

These are not ported. They are the "install the extension" surface.

---

## 4. Core principle: substrate vs. host

peerd already embodies the insight that makes this a derivation, not a
rewrite (DECISIONS #25): **the sandbox is the isolate; a tab is one way to
host it.** Each execution kind splits cleanly:

- **substrate** — the runtime that actually runs code. Host-agnostic.
  - Notebook / headless `js_run`: the sealed worker, `notebook-tab/worker-source.js`
  - App: the opaque-origin sandboxed iframe, `app-tab/runner.html` + `peerd-engine/app-compose.js`
  - WebVM: CheerpX in `vendor/cheerpx/` + `peerd-engine/vm-net/`
- **host** — how the substrate is created and talked to. Extension-specific.
  - tab creation (`chrome.tabs`), tab tracking (`background/*-tracker.js`),
    RPC (`background/vm-client.js`, `notebook-client.js`,
    `chrome.tabs.sendMessage` / `chrome.runtime.onMessage`)

The extension hosts substrates in **tabs**. The web surface hosts the *same
substrates* in **iframes/workers**, swapping `chrome.tabs` creation for
iframe creation and `chrome.runtime` messaging for `postMessage`. The
substrate code is unchanged (and already vendored into the site today for the
VM demo and the dweb peer).

The same pattern peerd already runs for `signaling-node` (one pure reducer,
two shells: `worker.js` + `bun-server.mjs`) generalizes here: one core, two
hosts (extension SW + web page).

---

## 5. Portability map (from a seam audit of `origin/main`)

Per-area verdict. 🟢 = ships verbatim, 🟡 = thin adapter, 🔴 = extension-only
(not ported).

| Area | Key files | Verdict |
|---|---|---|
| **Agent loop** | `peerd-runtime/loop/agent-loop.js`, `loop/turn-driver.js` | 🟢 Pure. Zero `chrome.*`; every IO injected (`callModel`, `getSecret`, `safeFetch`, `sessions`, `toolDispatch`, `appendAudit`). Runs in a page unchanged. |
| **Tool exposure / gates** | `peerd-runtime/tools/exposure.js`, `gates.js`, `manifests.js` | 🟢 Pure, unit-tested. Hiding is behavioral (`mainAgentDescriptors`, `filterByDwebEnabled`, `exposureGate`). Add a `web` surface that simply doesn't register browser-control tools. |
| **Vault + crypto** | `peerd-egress/vault/vault.js`, `keys.js` | 🟢 WebCrypto only (AES-GCM, PBKDF2/Argon2id-WASM, WebAuthn PRF). No extension API. Portable to any origin with WebCrypto + IndexedDB. |
| **Providers** | `peerd-provider/adapters/*` | 🟢 Pure fetch + BYOK (Anthropic/OpenRouter/Ollama/local-webgpu). No SDK, no `chrome.*`. |
| **Egress gates** | `peerd-egress/fetch/safe-fetch.js`, `web-fetch.js`, `allowlist.js` | 🟢 `makeSafeFetch({getAllowlist, audit, fetchFn})` + denylist/SSRF block are pure. |
| **Notebook / headless substrate** | `notebook-tab/worker-source.js`, `offscreen/job-runner.js` | 🟢 Sealed worker (realm-sealed: deletes `fetch`/XHR/WS before user code). Runs in a page-spawned `Worker` unchanged. |
| **App substrate** | `app-tab/runner.html`, `peerd-engine/app-compose.js` | 🟢 Sandboxed opaque-origin iframe via `srcdoc`/`document.write`; gets isolation from the parent for free. |
| **WebVM substrate** | `vendor/cheerpx/`, `peerd-engine/vm-net/` | 🟡 Code portable; needs COOP/COEP headers + SharedArrayBuffer (already true for the live `/vm-demo/`). |
| **Storage** | `peerd-egress/storage/kv.js` (chrome.storage.local), `session-cache.js` (chrome.storage.session), `idb.js` (IndexedDB) | 🟡 `idb.js` already web-standard. Point `kv` at IndexedDB; replace `session-cache` (DK persistence across SW restarts) with an in-memory `Map` (a page reload re-locks — same lifecycle intent). |
| **Host RPC** | `background/vm-client.js`, `notebook-client.js`, `app-client.js`, `routes/*`, `chrome.tabs.sendMessage` | 🟡 Replace tab-RPC with iframe/worker `postMessage`; replace `chrome.runtime.onMessage` dispatch with an in-page message bus. ~500 LOC of glue. |
| **SW chassis** | `background/service-worker.js` (~1100 LOC wiring / ~200 logic) | 🟡 Rewrite as a **web wiring shell** that assembles the same dep graph with web adapters and invokes the unchanged loop. |
| **Packaging** | `packaging/gen-channel-config.ts`, `gen-manifest.ts`, `package.ts`, `default-settings.mjs`, `manifests/*` | 🟡 Add `web` as a target: a `web` channel in `default-settings.mjs`, no manifest (skip the browser-transform), prune browser-control tools + `chrome.*` adapters. |
| **Browser control** | `do/get/check`, `dom/*`, `debugger-pool.js`, `chrome.scripting` | 🔴 Not ported. The funnel boundary. |

Net: the **value** (loop, sandboxes, dweb, vault, providers, egress) is 🟢.
The **divergence** is 🟡 and localized to host/storage adapters + a packaging
target. Nothing about the demo requires editing core logic.

---

## 6. Architecture: "web" as a third packaging target

Today's matrix is `{chrome,firefox} × {dev,preview,store}`. Add a **`web`**
target that produces a deployable bundle the site embeds, *not* an extension.

Three new pieces, all quarantined:

1. **Web wiring shell** (`web/` in the extension repo, new): the page-side
   analogue of `background/service-worker.js`. Assembles the dep graph with
   web adapters and runs `runUserTurn` from `peerd-runtime/loop` unchanged.
2. **Host adapters** (new, thin):
   - storage: `kv` → IndexedDB (`idb.js`), `sessionCache` → in-memory `Map`
   - instances: `vmClient`/`jsClient`/`appClient` → iframe/worker managers
     speaking `postMessage` instead of `chrome.tabs.sendMessage`
   - message bus: an in-page event bus replacing `chrome.runtime` dispatch
3. **Tool surface = `web`** (config, not new logic): register only the
   origin-confined tools. Reuse the *existing* `exposure.js`/`gates.js`
   machinery — the same way `filterByDwebEnabled` already strips dweb on
   store. Browser-control tool defs are simply not registered for `web`.

Everything else is imported from the existing modules verbatim.

### UX shift: tabs → panels/iframes

The extension's model is "more contexts → more tabs"; each VM/Notebook/App is
a watchable, killable tab. In the page there are no tabs, so contexts become
**panels (iframes) inside the SPA** — a tabbed/tiled workbench. This is a
host-shell concern (the new `web/` UI), not a core change. The agent
addresses instances by label exactly as today.

---

## 7. Capability tiers (what ships, in what order)

Ordered by portability cost; lead with what's already proven on-site.

- **Tier 0 — already live on peerd.ai, derived from core:** CheerpX VM demo,
  dweb peers widget. (Existence proof that vendoring-from-core works.)
- **Tier 1 — cheapest port, no headers, no CheerpX:** Notebook + headless
  `js_run` (sealed worker in the page) and App-gen (sandboxed iframe). Prove
  the host-adapter seam here first, *before* the loop, with a "run this code"
  panel.
- **Tier 2 — the agent:** wire the web shell + vault (BYOK) + providers +
  egress so the agent can drive Tier 1 (write a notebook, run it, build an
  app) live in chat.
- **Tier 3 — WebVM:** add CheerpX behind the COOP/COEP headers the site
  already sets for `/vm-demo/`.
- **Tier 4 — dweb in the agent loop:** the agent uses the existing live peer
  for discovery / capability exchange / signed app sharing.

## 8. Token-trust posture (honest, and a funnel lever)

The vault crypto is identical, but **a page-origin vault is lower trust than
the extension's**: any XSS on peerd.ai, or a compromised dependency, runs in
the same origin and can read the decrypted key in memory. The extension has
origin isolation, a strict CSP, and no third-party page script.

Decisions:

- Default peerd-lite to a **session-only / ephemeral** key (held in memory,
  never persisted), with explicit opt-in to persist. Say so in the UI.
- Keep peerd.ai's CSP strict and fully self-hosted (already the posture).
- Frame it plainly: "for your key's real home, use the extension." The trust
  delta *is* an upgrade reason. Record as a DECISIONS entry.

## 9. CheerpX licensing

Cleared with the CheerpX team: the public, agent-driven WebVM use is fine, so
this is **not a blocker** for Tier 3. (The v86 / BSD-2 migration remains
tracked for its own reasons, but is independent of this surface.)

## 10. Maintenance discipline (how it stays a derivation)

The risk is drift into a fork. Guardrails:

- The web bundle **imports** core modules; it never copies logic. Only
  `web/` (shell + adapters + UI) and a `web` config block are web-specific.
- A CI check that the `web` target imports the same `peerd-runtime/loop`,
  `peerd-egress/vault`, `peerd-provider`, `peerd-egress/fetch`, and
  `peerd-runtime/tools` (exposure/gates) as the extension — fail if web grows
  a parallel copy. (Mirror the spirit of `check-dweb-boundary.ts`.)
- Substrate code (`worker-source.js`, `runner.html`, CheerpX) is **vendored
  by the site exactly as today** (the existing `deploy.sh` already snapshots
  `peerd-distributed`, `shared/bundle`, `cheerpx`, `xterm`). The web target
  extends that list; it does not duplicate the files.
- peerd.ai's `_headers` already carries COOP/COEP for the VM demo; the web
  surface reuses it.

## 11. Open questions / risks

- **Web wiring shell scope.** The loop is pure, but `service-worker.js` is
  ~1100 LOC of wiring. The shell must reproduce the dep graph without `chrome.*`.
  This is the single largest piece of net-new code; Tier 1 should de-risk the
  adapter pattern before committing to it.
- **Subagents / turn-slots.** Some orchestration (offscreen job runner,
  turn-slot claiming) assumed an SW. Confirm each maps to a page/worker.
- **Voice / local WebGPU.** Offscreen-hosted today; defer for web (workers).
- **Bundling.** The extension is no-build (load-unpacked). The web target may
  need a bundler/import-map for page delivery without a thousand module
  fetches. Decide build posture for `web` only (keep the extension no-build).
- **Where the web bundle is built/served.** Build the `web` artifact in the
  peerd repo (`packaging/`), publish it, and have peerd-site embed it — the
  same vendor-snapshot pattern the site already uses. Avoids peerd-site
  holding any logic.

## 12. Alternatives considered

- **Light showcase only** (videos/embeds of the extension, no live runtime):
  cheapest, zero fork risk, but doesn't deliver the "try it" aha and doesn't
  exploit peerd's live-on-site differentiators (VM, dweb). Good as an interim;
  insufficient as the funnel.
- **Full fork / standalone SPA** (a DEVS-style separate app): fastest to a
  flashy demo, worst long-term — two diverging codebases, exactly what the
  owner ruled out.
- **Ship the agent loop in the existing site without the packaging target**
  (hand-wire it in peerd-site): violates "derive from core" and puts logic in
  the site repo. Rejected; the `web` target keeps logic in peerd.

---

## Appendix: precise coupling points (replace vs. reuse)

**Must replace (host-specific):**
- `background/service-worker.js` dep assembly → web wiring shell
- `kv` (chrome.storage.local) → IndexedDB; `session-cache` → in-memory Map
- `vm-client.js` / `notebook-client.js` / `app-client.js` tab-RPC → iframe/worker postMessage managers
- `routes/*` `chrome.runtime.onMessage` dispatch → in-page message bus
- `debugger-pool.js`, `chrome.scripting`, `dom/*`, `do`/`get`/`check` → **not ported**
- `offscreen/*` (chrome.offscreen) → page-spawned workers/iframes

**Reuse verbatim:**
- `peerd-runtime/loop/*` (agent loop + turn driver)
- `peerd-egress/vault/*`, `peerd-egress/fetch/*`
- `peerd-provider/*`
- `peerd-runtime/tools/exposure.js`, `gates.js`, `manifests.js`
- `notebook-tab/worker-source.js`, `app-tab/runner.html`, `peerd-engine/app-compose.js`
- `peerd-egress/storage/idb.js`
