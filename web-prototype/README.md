# peerd-lite — web-surface prototype

A real, piecemeal prototype of the in-page peerd ("peerd-lite") from
[`docs/specs/PEERD-WEB-SURFACE.md`](../docs/specs/PEERD-WEB-SURFACE.md). The
goal is to agree on the **output** by wiring REAL peerd components into a web
page, one slice at a time — **before** rearchitecting peerd's module structure
and adding the `web` packaging target. This is the manual, "what should it look
like" stage; the dynamic code-splitting / packaging comes later.

## Status

- **Slice 1 — Notebook substrate: DONE and real.** Notebook tabs run peerd's
  actual sealed worker. `console.log`, `peerd:std` imports, and
  `peerd.self.display` execute in a fresh sealed `Worker`; output renders through
  the real `output-render.js`.
- **Slice 2 — Real peer + browser-mirror shell + mobile PWA: DONE.**
  - The page mirrors a **browser**: a tab strip where each instance (Notebook,
    Peers, App, WebVM) is a tab, a `peerd://…` address bar, and the agent chat
    as a docked side panel (desktop) / bottom sheet (mobile).
  - The **Peers tab is a real dweb peer**: it joins the live lobby
    (`wss://bootstrap.peerd.ai`, topic `peerd/base/1`) **observe-only** as
    `kind:'website'` (its own cap pool; never publishes/announces/sends), and
    renders the live radial graph. Verified live (saw 5 real peers).
  - **Installable PWA**, mobile-first: `manifest.json`, a safe `sw.js`
    (bypasses blob:/ws:/wss:/cross-origin so the worker, modules, peer, and OPFS
    are never intercepted), 192/512 + maskable icons, iOS meta tags, install
    button, `100dvh` + `env(safe-area-inset-*)`, 44px touch targets.
- Next slices: the agent loop + BYOK vault + provider (chat goes live and
  drives the tabs), App (sandboxed iframe), WebVM (CheerpX behind COOP/COEP).

## How it's wired (derive, don't fork)

```
public/
  index.html                     browser-mirror shell (this repo's own UI)
  web/notebook-host.js           web host adapter — spawns the sealed worker,
                                 serves its postMessage bridges (analogue of
                                 notebook-tab.js)
  web/peer-host.js               web host adapter — starts an observe-only dweb
                                 peer over the vendored transport + the vanilla
                                 radial graph (analogue of the site peer widget)
  notebook-tab/                  VENDORED UNMODIFIED from extension/notebook-tab/
    worker-source.js  realm-seal.js  notebook-neutralizers.js
    notebook-std.js   output-render.js
  peerd-engine/
    module-resolver.js           VENDORED UNMODIFIED from extension/peerd-engine/
    opfs.js                      VENDORED UNMODIFIED
    index.js                     SLIM SHIM — re-exports the resolver only
  p2p/peerd-distributed/         VENDORED UNMODIFIED (the dweb transport)
  shared/bundle/                 VENDORED UNMODIFIED (peer deps, imported as
                                 /shared/bundle/* — root path, like the site)
  manifest.json  sw.js  icons/   PWA: manifest, service worker, app icons
  favicon.svg .ico 16/32  apple-touch-icon.png
```

The vendored files keep their original root-relative paths
(`/notebook-tab/...`, `/peerd-engine/...`) so they resolve unmodified, the same
way the site already vendors `/shared/bundle/*`. The bridges deferred to later
slices (network egress, `runAgent`, dweb) are stubbed fail-closed in
`notebook-host.js`; OPFS is real.

These are MANUAL snapshots for the prototype. The real `web` target will
import core modules directly (no copies) — see the spec's maintenance section.

## Run locally

```bash
npx serve -l 8123 web-prototype/public
# open http://localhost:8123
```

No special headers needed for slice 1 (the Notebook worker doesn't require
cross-origin isolation; CheerpX will, in the VM slice).

## Re-vendoring

To refresh the snapshots from the extension:
```
extension/notebook-tab/{worker-source,realm-seal,notebook-neutralizers,notebook-std,output-render}.js
extension/peerd-engine/{module-resolver,opfs}.js
```
copy into the matching `public/` paths (keep `peerd-engine/index.js` as the shim).
