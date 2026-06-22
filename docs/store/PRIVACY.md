# peerd Privacy Policy

**Effective date:** June 11, 2026
**Applies to:** the peerd browser extension (Chrome Web Store listing "peerd")

> **TODO before publishing:** publish this page at
> `https://peerd.ai/privacy` and paste that URL into the Chrome Web
> Store dashboard.

## Summary

peerd is a local-first AI assistant. It has **no backend, no accounts,
no analytics, and no telemetry**. The developer of peerd never receives,
stores, or has access to any of your data. Everything peerd knows lives
in your browser's local storage on your device. The only network
traffic peerd produces is (1) calls to the AI model provider **you**
configure with **your own API key**, (2) downloads of openly published
runtime assets (a voice-recognition model, a Linux disk image) when you
turn those features on, and (3) requests to websites that **you** ask
the assistant to read or act on.

## What peerd does

peerd is an AI assistant that lives in your browser's side panel. You
give it a task in plain language; it can read and interact with web
pages in your tabs, and run computations in sandboxes (a WebAssembly
Linux VM, a JavaScript sandbox) that exist entirely inside your browser.

## Data peerd handles, and where it lives

All of the following is stored **only on your device**, in the
extension's isolated browser storage (`chrome.storage.local` and
IndexedDB):

- **Your API key(s).** Stored in an encrypted vault. The encryption key
  is derived from a passphrase you choose, or from your device's
  platform authenticator (Touch ID / Windows Hello via WebAuthn PRF).
  Keys are decrypted in memory only to sign requests to the model
  provider you configured. They are never sent anywhere else.
- **Conversations and sessions.** Your chat history with the assistant.
- **Page content.** When you ask the assistant to work with a page, it
  reads that page's content in order to do the task.
- **The audit log.** A local record of every outbound network request
  the assistant makes (allowed and denied), kept so *you* can inspect
  what the agent did. It is never transmitted.
- **Voice data.** Voice input is transcribed locally by default (the
  Moonshine model running in WebAssembly on your device). Audio is not
  stored.
- **Sandbox data.** Files in the Linux VM and Notebooks (disk
  overlays, OPFS files) live in your browser's storage.

## What leaves your device

1. **Calls to your model provider.** Your messages — including page
   content the assistant reads while doing a task you gave it — are
   sent to the AI model API **you configured** (for example,
   `api.anthropic.com`), authenticated with your own key. That
   provider's privacy policy governs its handling of those requests.
   peerd hardcodes an allowlist of provider endpoints for this
   key-bearing path, so your **API key** can only be sent to a provider
   you configured, never to an arbitrary host.
2. **Websites you direct the assistant to.** When you ask the assistant
   to read or fetch a site, peerd requests that site, like your browser
   does when you visit it. This path is deliberately open (the whole web
   is the point), so it is **not** restricted to an allowlist: it is
   constrained by the protections below — a private-network/SSRF block, a
   sensitive-site denylist, and a full local audit log — but those are a
   partial control, not a guarantee that data can never reach an
   arbitrary public site. The audit log records every such request so you
   can see exactly where the assistant went.
3. **One-time feature downloads.**
   - Voice model files from `huggingface.co` (public Moonshine model,
     downloaded when you enable local voice; integrity-verified against
     pinned cryptographic hashes, then cached locally).
   - A stock Debian Linux disk image streamed from `disks.webvm.io`
     when you boot a VM (public image published by Leaning
     Technologies, the makers of the CheerpX runtime).
   These are public, static assets; the requests carry no personal
   data and no credentials.
4. **Web Speech fallback (optional).** If local voice is unavailable
   and you use the browser's built-in speech recognition instead, your
   browser (not peerd) may send audio to its speech service (for
   Chrome, Google's). peerd's default is the local transcriber.

**Nothing else leaves your device.** peerd has no server of its own and
phones home to no one. Usage/cost metering shown in the UI is computed
locally from your own API responses.

## What we never do

- We never collect, receive, or store your data — we have no servers.
- No analytics, no tracking, no telemetry, no crash reporting.
- We never sell data, share data, or show ads.
- Your data is never used for any purpose other than performing the
  tasks you give the assistant on your device.

## Browser permissions peerd uses

- **Side panel, storage, offscreen** — host the assistant UI, keep your
  data local, and run voice transcription in the background.
- **Tabs, tab groups, scripting, access to websites** — let the
  assistant read and act on pages when you give it a task.
- **Debugger** — used to type, click, and run automation on complex
  web apps that block injected scripts. Chrome requires this permission
  to be granted at install (it cannot be optional), but peerd only uses
  it while the "Advanced automation" switch (Settings → Advanced) is
  on — turn it off any time and the debugger is never attached. Chrome
  shows a banner whenever it is actually active, so it is always
  visible to you.

## Security measures

- API keys are encrypted at rest; unlock requires your passphrase or
  platform biometrics.
- A **denylist, on by default**, blocks the assistant from acting on
  sensitive sites — banks, brokerages, crypto exchanges and wallets,
  health portals, government services, password managers, and identity
  providers.
- A private-network block prevents the assistant from reaching
  localhost or LAN addresses (SSRF defense).
- Every outbound request is checked against these gates and written to
  the local audit log — including denied attempts.
- Downloaded model assets are verified against pinned SHA-384 hashes
  before use; mismatches are rejected and not cached.
- Code that runs in the VM and sandboxes is isolated by WebAssembly and
  the browser's sandboxing; it cannot touch your extension data.

## Data retention and deletion

All data is retained locally until you delete it. You can clear
sessions, the voice-model cache, VM disks, and the vault from peerd's
settings. Uninstalling the extension removes all of its stored data.

## Children

peerd is not directed at children under 13.

## Changes to this policy

Changes will be published at this URL with an updated effective date.
Because peerd has no server, a policy change can never retroactively
grant access to data — there is nothing to access.

## Contact

contact@peerd.ai
