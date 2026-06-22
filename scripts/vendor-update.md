# Vendor update procedure

Third-party code lives under `extension/vendor/<name>/`. We do NOT use
`npm install`; the vendor files are committed and audited. To add a new
dep or bump an existing one:

## Mithril

```bash
# 1. Fetch the UMD release.
curl -sSL -o /tmp/mithril.umd.js "https://unpkg.com/mithril@X.Y.Z/mithril.js"
shasum -a 256 /tmp/mithril.umd.js  # → record in SOURCE.txt

# 2. Read it. The whole file. Not a skim.
less /tmp/mithril.umd.js

# 3. Convert UMD → ESM. The conversion strips the IIFE wrapper and
#    appends `export default m;`. The body is otherwise byte-identical.
python3 << 'PY'
import pathlib
src = pathlib.Path('/tmp/mithril.umd.js').read_text()
prefix = ';(function() {\n"use strict"\n'
suffix = 'if (typeof module !== "undefined") module["exports"] = m\nelse window.m = m\n}());'
# Tolerate trailing newline drift between releases:
suffix_alt = suffix + '\n'
src_stripped = src.rstrip('\n')
assert src.startswith(prefix), 'prefix changed — re-inspect Mithril upstream'
assert src_stripped.endswith(suffix.rstrip()), 'suffix changed — re-inspect'
body = src_stripped[len(prefix):-len(suffix.rstrip())]
out = (
    '// Mithril X.Y.Z — UMD-to-ESM conversion. See SOURCE.txt for provenance.\n'
    '// Original IIFE wrapper and module/window export tail stripped;\n'
    '// body is otherwise byte-identical to upstream UMD.\n'
    + body + 'export default m;\n'
)
pathlib.Path('extension/vendor/mithril/mithril.js').write_text(out)
PY

# 4. Re-record SHA-256s and the date in SOURCE.txt.
# 5. Run the test suite.
```

## webextension-polyfill

```bash
curl -sSL -o extension/vendor/browser-polyfill.js \
  "https://unpkg.com/webextension-polyfill@X.Y.Z/dist/browser-polyfill.js"
shasum -a 256 extension/vendor/browser-polyfill.js

# Re-append the ESM adapter (verbatim from SOURCE.txt) to the file.
cat >> extension/vendor/browser-polyfill.js <<'EOF'

// === peerd ESM adapter — appended at vendor time ===
// The UMD IIFE above sets `globalThis.browser` in non-AMD/CommonJS environments.
// Re-export it as the module default so feature code can `import browser from ...`.
// This file is otherwise byte-identical to the upstream webextension-polyfill X.Y.Z.
export default globalThis.browser;
EOF

shasum -a 256 extension/vendor/browser-polyfill.js  # → record in SOURCE.txt
```

## CheerpX

Not yet wired (V1 step 10). When it lands, the same discipline applies:
fetch from a known URL, record SHA-256, read the loader, document in
`extension/vendor/cheerpx/SOURCE.txt`.

## Discipline rules

1. **Read the whole file.** Not `wc -l`. Not a glance. The point of
   vendoring is that we own the audit. If a dep is too large to read,
   it's too large to vendor.
2. **Record the source URL and a SHA-256.** Always in `SOURCE.txt`
   under the vendor directory.
3. **Date the review.** Future-you will want to know how old this is.
4. **No transitive deps.** If the dep wants to load other code, vendor
   that too — explicitly, with its own SOURCE.txt. The CSP forbids
   remote scripts anyway, so this rule is more discipline than
   enforcement.
