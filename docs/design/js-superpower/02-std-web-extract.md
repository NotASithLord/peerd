# Design 2 — HTML for code mode: `extract` on the bridged fetch, and a deliberate `peerd:std` growth path

## Problem

CODE MODE's pitch is "orchestrate many `peerd.egress.fetch` calls + compute in
one script" (`tools/defs/script.js`). But most fetched bytes are HTML, and the
sealed worker has **no `DOMParser`** (a Window API — workers never get it).
Today a script can only regex at markup. Meanwhile the extension already ships
the exact solution one bridge away: `offscreen/web-extract.js` turns HTML into
clean markdown via vendored Readability + Turndown, and it runs in the same
offscreen document that hosts the headless job runner.

Don't vendor a worker-side HTML parser first. Reuse the shipped, audited
pipeline; grow `peerd:std` only with pure helpers.

## 2a. `extract` option on the bridged fetch

### Shape

```js
const res = await peerd.egress.fetch(url, { extract: 'markdown' });
const md = await res.text();   // clean markdown, not raw HTML
```

- New `init` key on the sealed realm's bridged fetch
  (`engine-tabs/notebook-tab/notebook-neutralizers.js` marshals `init` —
  add `extract` to the allowed shape): `'markdown'` (Readability + Turndown,
  the `fetch_url` pipeline) or `'text'` (strip to readable text). Absent →
  today's raw behavior, byte-for-byte unchanged.
- The relay applies extraction AFTER the audited fetch returns, so the
  egress chokepoint (`sw/web-fetch` → denylist, SSRF, redirect fail-closed,
  audit, confirm-on-write) is untouched — extraction is a post-processing
  step on bytes the run was already allowed to hold.
- Headless host: `offscreen/job-runner.js`'s `fetch-request` handler calls
  the local `web-extract` entry directly (same document — no new route).
- Notebook tab host: the tab's fetch relay (`notebook-tab.js`) forwards to
  the SW route that already fronts offscreen extraction for `fetch_url`;
  if that route is currently private to the fetch_url path, widen it to
  accept the tab's relay — do NOT duplicate the pipeline in the tab.
- The fake-Response the bridge returns gains `contentType:
  'text/markdown'` and an `extracted: true` marker so code can tell.
- Non-HTML content with `extract` set: return the body unchanged with
  `extracted: false` (don't throw — scripts fan out over mixed URLs).

### Why this and not `DOMParser`-in-worker

- Zero new attack surface: the extraction code already runs against
  arbitrary web HTML today, in the same offscreen document.
- The output is what the model actually wants (readable text), not a DOM it
  would then serialize anyway.
- Keeps the worker realm dependency-free; no vendored parser to audit.

### Fencing

No change needed: any run that fetched already sets `usedEgress` and its
output re-enters fenced (`tools/defs/script.js`). Extracted markdown is the
same provenance as the raw bytes.

## 2b. `peerd:std` growth — pure helpers only

`peerd:std` (`engine-tabs/notebook-tab/notebook-std.js`) stays a pure module:
no I/O, no globals, descriptors + functions only. Additions, in order of
observed need:

1. **CSV**: `parseCsv(text, { header?, delimiter? })` → row objects;
   `toCsv(rows)`. Hand-rolled, RFC-4180-quote-aware, ~100 lines. The JSONL
   helpers set the precedent.
2. **HTML utilities** (regex-grade, honestly named): `stripTags(html)`,
   `textOfTag(html, tag)`, `extractLinks(html)` → `[{href, text}]`. These
   cover the "I have a fragment, not a page" cases 2a doesn't, without
   pretending to be a parser. Document the limits in the JSDoc.
3. **`fetchAll(urls, { limit, extract })`** — bounded-concurrency fan-out
   over `peerd.egress.fetch`, settled-results shape. This one is NOT pure
   (it closes over the bridged fetch), so it does not belong in `peerd:std`;
   if wanted, it goes in the tool description as a recipe instead. Proposed:
   recipe only — teaching `Promise.allSettled` + a semaphore in the
   `JS_PITFALLS_NOTE` costs zero code.

Rejected for now: vendoring a real HTML parser (htmlparser2-class) into
`vendor/`. Reconsider only if field use shows structured HTML queries the
extract path can't serve; that PR would need the standard `SOURCE.txt` +
license audit (no copyleft) and adds a real maintenance surface.

## Touch points

| File | Change |
|---|---|
| `extension/engine-tabs/notebook-tab/notebook-neutralizers.js` | pass `extract` through the fetch bridge's marshalled init |
| `extension/offscreen/job-runner.js` | apply extraction in `fetch-request` when requested |
| `extension/engine-tabs/notebook-tab/notebook-tab.js` | forward `extract` on the tab's fetch relay |
| `extension/offscreen/web-extract.js` | export a callable entry for the relay (if not already shaped for it) |
| `extension/engine-tabs/notebook-tab/notebook-std.js` | CSV + HTML string helpers (pure) |
| `extension/peerd-runtime/tools/defs/script.js` / `code-style-note.js` | one description sentence + pitfalls-note recipe |

## Tests

- **Bun**: CSV round-trip incl. quoted/embedded-delimiter cases; HTML string
  helpers; extract-flag marshalling shape (pure part of the bridge init).
- **In-browser**: a `fetch-request` with `extract:'markdown'` returns
  markdown for an HTML fixture and passthrough for JSON; the notebook tab
  path returns the same for the same fixture (parity check between hosts).

## Open questions

1. Should `extract:'markdown'` results flow through the same size budget as
   `fetch_url` (with spill to the Design-1b run cache once that lands)?
   Proposed: yes, once 1b exists; until then the value cap already governs.
2. `'text'` mode worth shipping, or is `'markdown'` alone enough? Proposed:
   markdown only in v1; `'text'` is `stripTags` away in std.
