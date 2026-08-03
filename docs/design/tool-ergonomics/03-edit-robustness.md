# Design 3 — edit_file robustness: the wrong-path bug + the patch trio

All changes live in the edit subsystem — `edit/search-replace.js` (the pure
matcher, already Bun-tested), `edit/errors.js`, and `tools/defs/edit-file.js`.
Four fixes; the last three are the Hermes "patch" trio and land in one pure
function.

## 3a. No silent wrong-path writes (the confirmed bug)

### The bug

`edit-file.js:149-156` swallows a read failure to `source = ''`:
```js
let source = '';
try { source = (await readFile()) ?? ''; } catch { source = ''; }
```
Two bad outcomes on a typo'd `path`:
- Anchored edit (non-empty SEARCH) → `search_not_found` with the misleading
  "the file may have changed; re-read it" — never "that path doesn't exist."
- **Whole-file edit (empty SEARCH) → silently SUCCEEDS**, creating a new file
  at the wrong path, `ok: true`. A create and a typo are indistinguishable.

### The fix

Distinguish "file does not exist" (legitimate for a whole-file create) from
"file exists but read failed" and from "path is wrong." The matcher already
enforces that an empty SEARCH is a create; the tool must stop laundering a
typo into a create.

- Catch the read and inspect the error: a genuine not-found (OPFS
  `NotFoundError` DOMException, name `'NotFoundError'`) → `source = ''` is fine
  ONLY for the empty-SEARCH create path. For an anchored edit against a
  not-found file, return a distinct
  `code: 'file_not_found'` error naming the path and the list tool
  (`app_list_files` / `js_read_file` to check) — not `search_not_found`.
- A read error that is NOT not-found → surface it as `read_failed` (don't
  swallow to `''`), so an OPFS/permission fault isn't disguised as an empty
  file.
- For the whole-file create against a not-found path: keep it working (that's
  how you make a new file) BUT include the path in the success result so a
  typo is visible in the echo (it already returns `path`; ensure it's the
  resolved path). Optionally: if the kind's instance has other files and the
  target's PARENT dir doesn't exist, that's a stronger typo signal — out of
  scope, note it.

Net: no anchored edit ever runs against a silently-empty source, and a
whole-file create's target path is always echoed.

## 3b. Already-applied edit → idempotent no-op, not a hard error

### The bug

`search-replace.js:191-197`: `count === 0` throws `SearchNotFoundError`
regardless of WHY the search text is absent. A re-issued edit whose REPLACE
text already landed (a retry, or a prior identical edit) is indistinguishable
from a typo'd anchor, and gets the misleading "the file may have changed."

### The fix

Before declaring `search_not_found`, check whether the block's REPLACE text is
already present at the expected location (or the file already equals the
post-edit state). If applying the block would be a no-op because it's already
applied:
- Do NOT error. Return success for that block with an
  `alreadyApplied: true` marker in the result, so the model learns the edit is
  in place and stops retrying.
- Precise rule: for a block, if `count(search) === 0` AND `count(replace) >= 1`
  AND replace ≠ '' AND replace ≠ search, treat as already-applied (skip the
  block, mark it). Guard against false positives: if search and replace share
  a lot, or replace is trivially short (e.g. a single common token), fall
  through to the normal not-found error rather than guessing — document the
  heuristic's boundary. The module header (`search-replace.js:17-19`) argues
  against silent no-ops "because they let agents believe an edit landed when it
  didn't" — this is DIFFERENT: we only no-op when the replacement is provably
  already present, and we REPORT it (`alreadyApplied`), so the agent's belief
  is correct, not assumed.

## 3c. Ambiguous match → report the LOCATIONS, not just the count

### Today

`search-replace.js:198-204` reports `matched N times` and says "add
surrounding lines," but not WHERE the N matches are — so the agent must re-read
the whole file to disambiguate.

### The fix

`SearchAmbiguousError` already carries `count`. Add the match locations: for
each occurrence, compute its line number (the matcher works on offsets;
line = count of `\n` before the offset + 1) and a short surrounding context
(the matched line trimmed, ± the line before/after, capped). Attach as
`locations: [{ line, preview }]` on the error and include a compact rendering
in the message ("matched 3 times: L12, L47, L103 — add surrounding lines to
pick one"). Cap the number of locations rendered (e.g. first 5) to bound size.

## 3d. Whitespace/indentation diagnosis on a miss

### Today

The only normalization is CRLF→LF (`normalizeEol`). A leading-space, tab-vs-
space, or trailing-whitespace mismatch produces the identical undifferentiated
`SEARCH text not found` — and the WRONG advice ("the file may have changed"),
when the real cause is whitespace.

### The fix

On a true `count === 0` (after the 3b already-applied check), before throwing,
run a whitespace-insensitive probe: does the search match when both sides have
leading/trailing whitespace collapsed per line (or when compared
trimmed-per-line)? If yes → throw `SearchNotFoundError` with a whitespace-
specific message: "SEARCH text not found, but a whitespace-only difference
matched at L<n> — your indentation/tabs/trailing spaces differ from the file.
Re-read the exact bytes and rebuild the block." Include the line. This turns
the single most common real cause into a named, actionable error instead of a
misdirection.

Keep it a DIAGNOSTIC, not a fuzzy apply: peerd's policy (`search-replace.js:16`)
is "we do not fuzzy-match; a miss is a hard error." We honor that — we still
error, we just diagnose WHY correctly. No whitespace-insensitive edit is ever
applied.

## Touch points

| File | Change |
|---|---|
| `extension/peerd-runtime/edit/search-replace.js` | 3b already-applied check; 3c location computation; 3d whitespace probe; a small pure `lineOf(offset)` helper |
| `extension/peerd-runtime/edit/errors.js` | `SearchAmbiguousError.locations`; a distinct not-found-vs-whitespace signal (either a flag on `SearchNotFoundError` or a new subclass — prefer a flag to keep the taxonomy small); an `alreadyApplied` result path (not an error) |
| `extension/peerd-runtime/tools/defs/edit-file.js` | 3a: distinguish not-found / read-failed / create; echo resolved path; surface `alreadyApplied` in the success result; map the new error fields (`locations`, whitespace flag) |

## Tests (all Bun — the matcher is pure)

Extend the existing `search-replace` / edit test file:
- 3a: anchored edit on a not-found path → `file_not_found` (not
  `search_not_found`); whole-file create on a not-found path → success with the
  path echoed; a non-not-found read error → `read_failed` (not a silent empty).
- 3b: re-applying an already-applied block → success + `alreadyApplied:true`,
  file unchanged; the false-positive guard (short/shared replace) still errors.
- 3c: 3-match search → error with `locations:[{line,preview}×3]` and the lines
  in the message.
- 3d: indentation-only mismatch → whitespace-specific message naming the line;
  a genuinely-absent search → the normal not-found message (no false
  whitespace claim).

## Measurement (design 5)

`edit_file` is a top wasted-turn source (a miss burns a re-read + a rebuild).
Design 5's wasted-turn metric (repeated `edit_file` on the same target within
a task) is the before/after signal. Expect the largest wasted-turn drop here.

## Open questions

1. `alreadyApplied` as success-with-marker vs. a soft error code — recommend
   success (the agent should proceed, not repair).
2. Whitespace probe cost on large files — it's one extra normalized `indexOf`;
   bounded by `MAX_CONTENT_CHARS` (500k). Fine. Confirm no O(n²).
3. Should 3c locations render in the model text or only as a structured field?
   Recommend both (compact text line + full `locations` field), since the
   model reads text.
