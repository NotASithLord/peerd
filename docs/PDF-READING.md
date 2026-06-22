# Reading PDFs in peerd

peerd can read the **text of a PDF the agent encounters in a tab**. Before
this, the only PDF path was a *user* attaching a PDF to a chat message, which
only worked on Anthropic (native `document` blocks) and was send-once — the
agent had no way to read a PDF it navigated to itself, and nothing worked on
OpenRouter/Ollama.

## The shape

- **`read_pdf` — a RUNNER-ONLY tool.** It is hidden from the main agent
  (`tools/exposure.js` `MAIN_AGENT_HIDDEN_TOOLS`) and lives in the
  browser-runner's toolsets (`runner/index.js` `DO_TOOLSET` + `READ_TOOLSET`).
  Like every page reader, its output is untrusted, so it lands in the
  disposable runner's context — never the main loop. The main agent reaches
  it through `do`/`get`/`check`. Chrome renders PDFs in a non-HTML viewer that
  `snapshot`/`read_page` can't see; `read_pdf` closes that gap. The runner
  prompt tells it to reach for `read_pdf` on a PDF tab.

- **Default engine: pdf.js (text layer).** Mozilla's `pdfjs-dist` is vendored
  (`extension/vendor/pdfjs/`, SRI-pinned in `SOURCE.txt`) — no download,
  always available. Because the output is plain text, it works on **every
  provider**.

- **Heavy engine: on-device OCR — opt-in download.** Scanned/image-only PDFs
  have no text layer. OCR (Tesseract) is downloaded once and cached, the exact
  pattern as the Moonshine voice model: streamed with progress, SHA-384
  SRI-verified, IndexedDB-cached (`peerd-runtime/pdf/ocr-store.js`). Surfaced
  under **Settings → Voice & OCR**.

## Where it runs

pdf.js parses in a Worker, which a service worker cannot host — so extraction
runs in the **offscreen document** (`offscreen/pdf-extract.js`), the same host
as voice and `js_run`. Flow:

```
read_pdf (SW tool)
  → background/offscreen-pdf-client.js  (ensureOffscreen + 'pdf/extract' msg)
    → offscreen/pdf-extract.js          (fetch bytes → pdf.js text layer)
  ← structured pages
  → peerd-runtime/pdf/extract-format.js (assemble + cap, PURE)
  → wrapUntrusted(<untrusted_web_content>)
```

The denylist is enforced at the tool boundary (`resolveTargetTab`, plus a
check on any explicit `url` override). Extraction only reads text — never runs
the PDF's JS (`isEvalSupported:false`, no rendering, no form scripting).

## Module layout (`peerd-runtime/pdf/`)

| File | Role |
|---|---|
| `engines.js` | PURE: engine catalog, `chooseEngine` (auto/pdfjs/ocr), `looksScanned` heuristic |
| `extract-format.js` | PURE: per-page text assembly, output cap, model-facing body |
| `ocr-store.js` | OCR opt-in download/verify/cache (Moonshine-voice pattern) |
| `errors.js` | typed errors |
| `index.js` | public surface |

## Shipping the OCR engine (pending vendoring + SRI pinning)

The recognition step is **wired** — `offscreen/pdf-extract.js` renders each page
to an `OffscreenCanvas` and recognizes glyphs with tesseract.js
(`extractViaOcr`), and `'auto'` escalates to it when a PDF `looksScanned` and the
engine is installed. Two things remain, both requiring network access this code
was written without:

1. **Vendor the tesseract.js driver** — `tesseract.esm.min.js` + `worker.min.js`
   into `extension/vendor/tesseract/` (see that dir's `SOURCE.txt`). The driver
   is code, vendored like pdf.js; only the heavy core WASM + language model are
   the runtime download.
2. **Pin the asset SRIs** — run `scripts/compute-ocr-sri.sh` against the pinned
   URLs and paste the `sri` / `sizeBytes` into `OCR_ASSETS` in
   `pdf/ocr-store.js`. Until then `hasValidOcrSris()` is `false`, production
   refuses the download, and the settings button reads "not available in this
   build yet" — exactly how voice's Moonshine upgrade behaved pre-hashes.
3. **Validate in a browser** — the corePath/langPath blob-URL wiring and the
   offscreen CSP's `worker-src` can only be confirmed with the real driver
   loaded. Smoke-test `read_pdf` with `engine:'ocr'` and `'auto'` on a scanned
   PDF, and `'auto'` on a born-digital one (must NOT escalate).

OCR is **fail-closed**: until the driver is vendored and the SRIs pinned,
escalation catches the failure and falls back to the text layer with the
"looks scanned" note. The default pdf.js text-layer path needs none of this — it
works today.

## Known limitations

- **Scanned PDFs** return their (empty) text layer plus a clear "looks
  scanned" note until the OCR driver is vendored and its SRIs pinned (above).
- **`blob:` PDFs** created in another tab aren't reachable from the offscreen
  fetch; download the PDF into a sandbox first.
- **CJK / non-embedded fonts**: pdf.js cMaps/standard-font assets are not
  vendored (text extraction rarely needs them); add `cMapUrl` /
  `standardFontDataUrl` if a document needs them.
- **Credentialed PDFs** behind a login may not fetch with the user's tab
  session.
