# peerd-lite — web-surface prototype

A real, piecemeal prototype of the in-page peerd ("peerd-lite") from
[`docs/specs/PEERD-WEB-SURFACE.md`](../docs/specs/PEERD-WEB-SURFACE.md). The
goal is to agree on the **output** by wiring REAL peerd components into a web
page, one slice at a time — **before** rearchitecting peerd's module structure
and adding the `web` packaging target. This is the manual, "what should it look
like" stage; the dynamic code-splitting / packaging comes later.

## Status

- **Slice 1 — Notebook substrate: DONE and real.** The notebook panel runs
  peerd's actual sealed worker. Click "Chart some numbers" or edit the code and
  hit Run: `console.log`, `peerd:std` imports, and `peerd.self.display` all
  execute in a fresh sealed `Worker`, and output renders through the real
  `output-render.js`.
- Next slices: App (sandboxed iframe), agent loop + BYOK vault + provider (the
  chat goes live), WebVM (CheerpX behind COOP/COEP), dweb peers.

## How it's wired (derive, don't fork)

```
public/
  index.html                     prototype shell (this repo's own UI)
  web/notebook-host.js           the ONLY new logic: web host adapter — spawns
                                 the worker, serves its postMessage bridges
                                 (the page-side analogue of notebook-tab.js)
  notebook-tab/                  VENDORED UNMODIFIED from extension/notebook-tab/
    worker-source.js  realm-seal.js  notebook-neutralizers.js
    notebook-std.js   output-render.js
  peerd-engine/
    module-resolver.js           VENDORED UNMODIFIED from extension/peerd-engine/
    opfs.js                      VENDORED UNMODIFIED
    index.js                     SLIM SHIM — re-exports the resolver only, so
                                 worker-source.js's `/peerd-engine/index.js`
                                 import resolves without the engine barrel
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
