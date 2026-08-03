# Design 3 — remote module imports: make them real AND audited, or delete the claim

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
  apply to module fetches exactly as to data fetches. The run is marked
  `usedEgress` → output fenced. No new chokepoint, no new policy.
- Bare specifiers (`lodash`) keep failing with today's clear resolver error.
  We are not building npm resolution; a script wanting a library names a
  full URL and owns that choice, or the dependency gets vendored properly.
- Caps: remote module source counts against a per-module size ceiling
  (propose the same order as `js_write_file`'s per-file cap) and a
  per-run remote-module count ceiling (propose single digits) — fan-out
  module graphs are a hostile-input amplification vector.
- Caching: per-run memory cache only (the resolver's existing `cache` map).
  No persistent module cache in v1 — stale third-party code silently pinned
  in IDB is a worse failure mode than a re-fetch.

### Integrity (optional hardening, same PR or follow-up)

Support `import 'https://…#sha256-<base64>'`: when the fragment is present,
hash the fetched source and refuse on mismatch. Cheap (one `crypto.subtle`
call host-side), makes reproducible notebooks possible, and gives the
security-review story a pin. Not required for v1 since the fetch is already
denylisted + fenced, but it's small enough to consider immediately.

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
  size/count cap refusals, sha256 mismatch refusal if shipped).
- **In-browser**: end-to-end — a notebook run statically importing a fixture
  URL gets the module through the audited path; denylisted URL refused with
  the resolver's error; `page_code` lane refused.

## Open questions

1. Real-then-audited (proposed) vs delete-the-claim — owner call; this is a
   philosophy decision about third-party code, not an implementation detail.
2. Ship the `#sha256` pin in v1? Proposed: yes if the diff stays small.
