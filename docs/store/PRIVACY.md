# peerd Privacy Policy

**Effective date:** July 12, 2026
**Applies to:** the peerd browser extension ("peerd" on the Chrome Web
Store and Firefox Add-ons)

> **TODO before publishing:** publish this page at
> `https://peerd.ai/privacy` and paste that URL into the store
> dashboards.

## The short version

peerd collects nothing. There are no servers, no accounts, no
analytics, no telemetry, and no crash reporting. The developer never
receives, stores, or has access to any of your data. Everything peerd
knows lives in your browser on your device, and the only network
requests it makes are the ones your own use of it causes: calls to the
AI provider you configured with your own API key, requests to the
websites you ask the assistant to work on, and one-time downloads of
public runtime assets.

## What stays on your device

All of peerd's data is stored in the extension's local browser storage
and never reaches the developer:

- **Your API key(s)** — kept in an encrypted vault, unlocked with a
  passphrase or your device's biometrics (Touch ID / Windows Hello).
- **Your conversations, settings, and history.**
- **The audit log** — a local record of every network request the
  assistant made, allowed or denied, so you can see exactly what it
  did. It is never transmitted.
- **Sandbox files and caches** — Linux VM disks, notebook files, and
  the downloaded voice model.

Voice input is transcribed locally on your device by default; audio is
never stored.

## What leaves your device

1. **Calls to your AI provider.** Your messages — including page
   content the assistant reads for a task you gave it — are sent to
   the provider you configured, authenticated with your own key. peerd
   only ever sends your key to the provider you chose. That provider's
   privacy policy governs its handling of those requests.
2. **Websites the assistant works on.** When you give the assistant a
   task, it requests the pages needed to carry it out, the same way
   your browser does when you visit them. A denylist (on by default)
   blocks sensitive sites such as banks, health portals, and government
   services; a private-network block prevents access to localhost and
   LAN addresses; and every request, allowed or denied, is written to
   the local audit log.
3. **One-time public asset downloads.** Enabling local voice downloads
   a public speech-recognition model from huggingface.co
   (integrity-verified, then cached). Booting the Linux VM streams a
   public Debian disk image from disks.webvm.io. These are static
   public files; the requests carry no personal data or credentials.
4. **Optional browser speech fallback.** If local transcription is
   unavailable and you use the browser's built-in speech recognition
   instead, your browser (not peerd) may send audio to its vendor's
   speech service. peerd's default is the local transcriber.

Nothing else leaves your device. peerd has no backend and phones home
to no one. The usage costs shown in the UI are computed locally from
your own API responses.

## What we never do

- Collect, receive, or store your data — there is nowhere for it to go.
- Analytics, tracking, telemetry, crash reporting, or ads.
- Sell, share, or monetize data in any way.

## Deleting your data

Everything is retained locally until you delete it. You can clear
conversations, caches, VM disks, and the vault from peerd's settings.
Uninstalling the extension removes all of its stored data.

## Children

peerd is not directed at children under 13.

## Changes to this policy

Changes will be published at this URL with an updated effective date.
Because peerd has no server, a change to this policy can never
retroactively grant access to your data — there is nothing to access.

## Contact

contact@peerd.ai
