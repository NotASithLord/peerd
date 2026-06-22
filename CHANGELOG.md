# Changelog

All notable changes to peerd are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows `VERSIONING.md` — **`0.MINOR.PATCH`**, minor = milestone,
patch = fix, with `store`/`preview`/`dev` channels as an orthogonal axis.

peerd is **0.x — experimental preview**: breaking changes are likely and
storage formats may move until the surface stabilizes.

## [Unreleased]

The staged integration of the open-PR backlog onto one verified branch
(the next milestone). Highlights:

### Added
- **PDF reading** (`read_pdf`) — pdf.js text-layer extraction in the
  offscreen document for born-digital PDFs; runner-only, output wrapped
  as untrusted web content.
- **On-device OCR for scanned PDFs** — render→recognize pipeline wired
  (Tesseract), `auto` escalates when a PDF looks scanned and the opt-in
  engine is installed. Fail-closed: falls back to the text layer until
  the driver is vendored and the asset SRIs are pinned. See
  `docs/PDF-READING.md`.
- **Browser-native VM networking** — full HTTP, multi-host `git clone`,
  npm/pip/gem install via host-side resolution, response cache.
- **Session robustness** — auto-resume after a service-worker restart,
  per-message session store, provider failover chain.
- **Whole-extension type coverage** — `// @ts-check` across the
  extension (100% of eligible files), enforced by a coverage floor.
- **Verbose VM diagnostics** — `devMode` setting wires shell tracing
  into the WebVM bridge.

### Changed
- Service worker restructured into per-route modules with injected
  per-module state stores; handlers stay thin.
- README reordered to lead with install + project conventions; Tesseract
  / pdf.js / Gemma credited in the open-source list.

### Fixed
- Settings normalizer now persists the web-write confirm + robustness
  keys that were dropped during the route extraction.

---

## [0.1.0] — 2026

Initial **experimental preview** — the core buildout, integrated:

### Added
- **Providers** — Anthropic (streaming, adaptive extended thinking,
  prompt caching, retry), OpenRouter, keyless Ollama; opt-in local
  WebGPU inference (one proven model, Gemma-4-E2B).
- **Security (egress)** — passphrase + WebAuthn-PRF vault, idle
  auto-lock, `safeFetch` allowlist, denylist, audit log.
- **Sandboxes** — four execution kinds: WebVM (CheerpX), Notebook
  (sealed worker + OPFS), App (opaque-origin iframe), and the headless
  worker (`js_run`).
- **Agent runtime** — the agent loop and tool inventory (inspect,
  DOM/page via do/get/check, tabs, VM/Notebook/App, edit, subagents,
  memory, review, clock, web, skills), Plan/Act permissions, sessions,
  cost telemetry, voice (Moonshine + Web Speech), lineage-based context
  compaction, contacts.
- **The dweb** (`peerd-distributed`, preview channel only) — always-on
  P2P base network (mesh + DHT + gossip), did:key identity, signed
  content addressing, the dwapp bridge, and a peer-to-peer app store.
- **Distribution** — dual store/preview channels, generated manifests,
  CI gates (bun tests, strict typecheck, lint, dweb boundary, drift,
  in-browser CDP job, artifact matrix).

[Unreleased]: https://github.com/NotASithLord/peerd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NotASithLord/peerd/releases/tag/v0.1.0
