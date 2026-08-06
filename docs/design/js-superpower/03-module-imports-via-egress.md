# Design 3 — remote module imports: make them real AND audited, or delete the claim

## Current implementation note

Both execution hosts fetch HTTPS module source through `sw/web-fetch` and run
it as blob modules in sealed workers. The headless Script host records that the
run used egress and fences its result. The visible Notebook host does not yet
carry that provenance into `js_notebook` output, so remote-controlled console,
error, and return text reaches the Notebook actor without an untrusted-content
fence. Treat that as an open security gap, not as the completed guarantee in
the original design below.

Optional `#sha256-<base64>` integrity fragments are implemented and fail closed
on a mismatch. An import without a fragment can change at the publisher's
discretion. In the visible Notebook, imported code inherits the run's audited
egress bridge, OPFS access, and subagent capability. The store-package policy
decision is tracked in `docs/store/OPEN-DECISIONS.md`.

## Problem

The module resolver passes absolute-URL and bare specifiers through untouched,
and three places document "CDN imports work" as a Notebook feature
(`peerd-engine/module-resolver.js` header, `notebook-neutralizers.js`,
`engine-tabs/notebook-tab/index.html`). Two problems:

1. **It likely doesn't work.** The manifest's extension-pages CSP is
   `script-src 'self' 'wasm-unsafe-eval'` (`manifests/base.json` → generated
   `manifest.json`), blob workers inherit the owner document's CSP, and a
   cross-origin static module import is script-src territory. The only test
   asserts pass-through, not that anything loads.
2. **If it DID work, it would be wrong**: the worker's native loader would
   fetch third-party code with no denylist, no audit, no egress record —
   the one hole in "every outward byte crosses peerd-egress".

Either outcome demands a change. This design proposes making it real
*through* egress; the fallback is deleting the feature claim.

## Step 0 (do this first, its own tiny PR)

An in-browser test (`extension/tests/`) that attempts a static
`import 'https://…'` from a sealed worker against a fixture URL and records
the actual behavior per host (notebook tab vs offscreen). This settles the
CSP question on real Chrome + real Firefox instead of by argument, and
becomes the regression test for whichever path we pick. If it somehow loads
today, that is a live egress bypass and bumps this design's priority.

## The design: resolver-fetched remote modules

Route remote module source through the same audited pipe as everything else,
then blob it like a local file:

- `ResolverDeps` (`peerd-engine/module-resolver.js`) gains
  `fetchRemote?: (url: string) => Promise<string>`. Pure module stays pure —
  the host injects it.
- In `buildModule`/`rewriteModuleSource`: an `https:` specifier is fetched
  via `fetchRemote`, its source recursively transformed (relative imports
  inside a remote module resolve against ITS url, so `resolveRelativePath`
  grows a URL branch), and re-blobbed. From the worker's perspective it's
  just another same-realm blob — the CSP question disappears.
- Hosts inject `fetchRemote` as the SAME audited fetch their fetch bridge
  uses (`sw/web-fetch`): denylist, SSRF, redirect fail-closed, audit all
  apply to module fetches exactly as to data fetches. The design requires the
  run to be marked `usedEgress` and its output fenced. The headless host does
  this; the visible Notebook host does not yet propagate that provenance.
- Bare specifiers (`lodash`) keep failing with today's clear resolver error.
  We are not building npm resolution; a script wanting a library names a
  full URL and owns that choice, or the dependency gets vendored properly.
- Caps: remote module source counts against a per-module size ceiling and a
  per-run module count ceiling. The live values are exported by
  `module-resolver.js` and tested with the resolver.
- Caching: per-run memory cache only (the resolver's existing `cache` map).
  No persistent module cache in v1 — stale third-party code silently pinned
  in IDB is a worse failure mode than a re-fetch.

### Integrity

`import 'https://…#sha256-<base64>'` hashes the fetched source and refuses a
mismatch. Base64url is also accepted. The pin is optional, so an unpinned
module remains controlled by its publisher.

### Capability interaction

Remote imports ride the run's egress capability: a profile with
`egress:false` (page_code, site_client_run) or a host-refused lane (a2a)
gets NO `fetchRemote` — the resolver error for an https specifier in those
lanes states why ("this run has no network"). That keeps the invariant that
`page_code`/`a2a_run` cannot pull bytes from the open web, now provably
including code bytes.

## The fallback

If the owner would rather not open ANY third-party-code door: delete the
"CDN imports" claims from the three files, make the resolver *reject*
absolute-URL specifiers with a clear error ("remote imports are not
supported; vendor the dependency or inline it"), and keep Step 0's test as
the fence. This is a strictly honest position — but it leaves the library
gap to Designs 2 and 6 alone.

## Touch points

| File | Change |
|---|---|
| `extension/peerd-engine/module-resolver.js` | `fetchRemote` dep; URL-base relative resolution; size/count caps; or the rejection branch |
| `extension/engine-tabs/notebook-tab/notebook-tab.js` | inject `fetchRemote` (tab host) |
| `extension/offscreen/job-runner.js` | inject `fetchRemote` (headless host), egress-capability-gated |
| `extension/tests/` | Step 0 behavior test |
| `tests/peerd-engine/module-resolver.test.ts` | remote-resolution unit tests (injected fake `fetchRemote`), cycle/limit cases |
| docs claims in `module-resolver.js` / `notebook-neutralizers.js` / `index.html` | updated either way |

## Tests

- **Bun**: remote graph resolution with a fake `fetchRemote` (remote→remote
  relative import, remote→builtin, cycle detection across the URL branch,
  size/count cap refusals, and sha256 mismatch refusal).
- **In-browser**: end-to-end — a notebook run statically importing a fixture
  URL gets the module through the audited path; denylisted URL refused with
  the resolver's error; `page_code` lane refused.

## Open questions

1. Whether remote imports may ship in the store artifact remains a policy and
   packaging decision.
2. Preview builds still need an explicit capability and trust policy for remote
   code in visible Notebooks.
