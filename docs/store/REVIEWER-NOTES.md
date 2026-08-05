# Chrome Web Store reviewer notes

One placeholder must be filled before submitting: the demo video URL below.
No test API key is provided. The demo video covers
the full flow instead.

---

## What this extension is

peerd is an AI assistant in the browser side panel. The user types or
speaks a task; the assistant performs it by reading and interacting
with web pages, and by running computations in sandboxes (a WebAssembly
Linux VM and a JavaScript sandbox that can also run WebAssembly (WASI)
programs) that exist entirely inside the browser. It is local-first, uses
bring-your-own-key providers, and has no account, hosted agent backend,
analytics, or telemetry. The developer does not receive or store extension
data through the extension.

## How to test

1. Install, open the side panel (toolbar icon).
2. Onboarding asks for an AI provider API key. peerd is
   bring-your-own-key with no accounts, so there is no test credential
   to share; the demo video below shows every flow end-to-end instead.
3. Ask something that exercises page automation, e.g. open any article
   and ask "summarize this page", or "open hacker news and tell me the
   top three stories".
4. VM demo: ask "boot a linux vm and run uname -a". First boot streams
   the public Debian image from disks.webvm.io (see below).
5. The audit log (in the side panel) shows every outbound request the
   agent made, including denied ones.

**Demo video** (full agent flow, VM boot, automation, audit log):
«VIDEO URL»

## Remotely hosted code

There is no remotely hosted code. These are the five places a scan
will flag:

1. **CheerpX (x86-in-WASM runtime) is fully vendored** in
   `vendor/cheerpx/`, version-pinned, with provenance and the SHA-256
   of the entry file documented in `vendor/cheerpx/SOURCE.txt`. Every
   vendored dependency in `vendor/` carries the same SOURCE.txt
   treatment. No CDN script loading anywhere; the package is vanilla,
   unobfuscated ES modules.
2. **`disks.webvm.io` (vm-tab)** streams a stock Debian *filesystem
   image*. These bytes are interpreted as an ext2 disk by the sandboxed WASM VM.
   It is data, not extension code, equivalent to a game loading an
   asset file. It is the public image published by Leaning Technologies
   (CheerpX's authors), fetched read-only when the user boots a VM.
3. **`huggingface.co` (voice/model-store.js)** downloads the public
   Moonshine speech model when the user enables local voice. Every
   asset URL is pinned to a specific HF commit AND verified against a
   pinned SHA-384 hash before use; a hash mismatch throws and nothing
   is cached. The code fails closed: an asset with no pinned hash
   refuses to download in production. ONNX model weights are data
   consumed by the bundled inference runtime, not executable code.
4. **Skills (`peerd-runtime/skills/`)** let the user import a SKILL.md
   instruction file. It contains markdown instructions for the model, in the
   same category as a user typing a long prompt. It is parsed and stored locally,
   never evaluated as code. In the store build the only install path is
   pasting text: remote install (fetch a SKILL.md from a git/manifest
   URL) is gated OFF via `extension/shared/flags.js`
   (`REMOTE_SKILL_INSTALL = false`). The side panel hides the URL tabs
   and, more importantly, the service worker refuses the
   `skills/installGit` / `skills/installManifest` messages outright, so
   no remote fetch of agent-actioned files can happen, even from a
   crafted message. The installer code ships but is unreachable; the
   remote paths return in a later version with their own review.
5. **WASI modules (`engine-tabs/notebook-tab/notebook-wasi.js`)**. The JavaScript
   sandbox can run wasm32-wasi programs (e.g. query a SQLite file the
   user provides, decode an archive) via `WebAssembly.compile`, under
   the same `wasm-unsafe-eval` CSP allowance the bundled WASM above
   already uses. The runtime that hosts them is fully vendored and
   audited (`vendor/browser-wasi-shim/SOURCE.txt`); the module bytes
   are user-directed data on the same footing as item 2's disk image and are
   confined more tightly than the JavaScript around them. A module's
   only imports are the bundled shim's WASI syscalls, every descriptor
   behind those syscalls is constructed by our wrapper (stdin bytes,
   size-capped stdout/stderr, an in-memory file table built from the
   call), and it has **no network, DOM, storage, or `chrome.*` reach because
   no such import exists to link against**. It executes inside the
   already-sealed Notebook/worker realm described below, bounded by
   that run's timeout.

## How the assistant operates pages (no `debugger` in this build)

This store package does **not** request the `debugger` permission. The
assistant operates pages entirely through `chrome.scripting`: it reads
content, builds an accessibility-style snapshot by walking the DOM, and
performs selector and element click or type actions with bundled, in-package
code (nothing fetched or generated remotely). There is no Chrome
DevTools Protocol use in this package.

The assistant's core job is operating pages on the user's instruction,
and three things keep that honest regardless of channel:

- A denylist, ON by default, refuses to operate on banks, brokerages,
  crypto exchanges and wallets, health portals, government services,
  password managers, and identity providers (the categories where
  automation could do harm). See
  `peerd-egress/denylist/default.json`; the service worker blocks all
  tool dispatch until the denylist is loaded (no cold-start race).
- Page actions run only during an active, user-initiated task.
- Every action goes to the local audit log, including denied attempts.

Maintainer note (not for the dashboard): an optional Chrome DevTools
Protocol path for sites that ship Trusted Types or strict CSP (Gmail,
Notion, Slack), which reject injected scripts, ships in the separate
GitHub-distributed *preview* channel, gated by the in-app "Advanced
automation" switch and Chrome's visible "is debugging this browser"
banner. It is intentionally held out of the initial store submission so
approval isn't gated on the `debugger` permission, and would be added to
a later store update as a required permission with its own review (Chrome
forbids `debugger` under `optional_permissions`).

## Why `<all_urls>`

Which site the user will ask the assistant to work on is the user's
choice at task time. Access is exercised only during an active user
task and is constrained by the same denylist + SSRF block + audit log.

## Egress posture (honest scope)

We separate two things on purpose:
- **Credentialed provider path** (`safeFetch`): a hardcoded allowlist.
  Your API key can only reach a provider you configured. Sending the
  key/conversation to an arbitrary host is closed as a class.
- **Open-web path** (`webFetch`: the agent's web-read tools, the VM HTTP
  egress, and the Notebook's `peerd.egress.fetch` bridge): this path has no host
  allowlist because the target is user-selected. It enforces a scheme
  check, an SSRF/private-network block (IPv4 + structural IPv6, incl.
  the cloud-metadata IP and IPv4-mapped forms), a sensitive-site
  denylist, fail-closed redirect handling, and a full audit log, but
  **not** a per-host allowlist. Traffic to an arbitrary *public* domain
  over this path is not categorically prevented. The web actor is keyless, its tool access is
  narrowed, and the audit log records every request. We do not claim otherwise.

The Notebook specifically: the `js_notebook` Web Worker runs
agent-authored code, so its raw network primitives (XHR / WebSocket /
EventSource / WebTransport, plus native `fetch` recovered off the
prototype, and any nested `Worker`) are neutralized at the boundary by
the host page's CSP `connect-src 'none'` (extension/engine-tabs/notebook-tab/index.html),
which the worker and its descendants inherit and which tests verify. The
only egress that leaves the Notebook is the audited `peerd.egress.fetch` bridge,
which is governed by the open-web `webFetch` gates above.

## CSP note

`connect-src` includes `https:` deliberately: the assistant fetches
pages the user asks it to read from the extension's service worker.
The target set is user-chosen and cannot be enumerated in a manifest.
The egress layer enforces what the manifest cannot express: a hardcoded
allowlist for credentialed provider calls, the denylist + SSRF block
for everything else, and the audit log for all of it. The generated manifest
and store posture tests are the authority for the narrow non-HTTPS sources used
by local providers and runtime assets.

## Privacy posture (for the data form)

No hosted agent backend, analytics, or telemetry. The only metering in the
code computes local cost estimates from the user's own API responses.
Messages and task context go to the configured AI provider. User-directed web
requests go to their requested destinations. Runtime assets are downloaded from
the sources listed above. API keys are stored in an encrypted vault
(passphrase or WebAuthn PRF / platform biometrics).
