# peerd Privacy Policy

**Effective date:** July 12, 2026

**Applies to:** all peerd browser extension distribution channels

The public policy URL is `https://peerd.ai/privacy`. Confirm that the published
copy matches this file before each store submission.

## Summary

peerd has no account system, analytics, telemetry, or crash reporting. peerd
does not operate a hosted agent backend. Store builds do not send extension data
to a peerd service. Preview signaling servers process the rendezvous metadata
needed to connect peers and may retain normal service logs.

Model requests go directly from the extension to the provider selected by the
user. Other network requests occur only when needed for a user task, a runtime
asset, an optional browser service, or an enabled preview feature.

## Data stored on the device

peerd stores local extension data such as:

- provider secrets in an encrypted vault
- conversations, settings, and history
- the local audit log
- sandbox files, caches, and downloaded runtime assets

Vault encryption does not apply to every item in extension storage. The
security documentation defines the current storage boundaries.

Voice input is transcribed locally by default. peerd does not retain recorded
audio.

## Data sent from the device

### Model providers

Messages and task context are sent to the model provider selected by the user.
Requests use the user's provider key when required. The provider's privacy
policy applies to that data.

### Websites and user-directed network requests

peerd can request websites and APIs needed for a task. Network policy blocks
private network targets and configured sensitive sites on supported paths. The
local audit log records allowed and denied requests.

### Runtime assets

Some features download public runtime assets, such as a speech model or a
WebVM disk image. Integrity and source controls are defined in the code and
vendored dependency records.

### Browser speech services

If local transcription is unavailable and the user chooses the browser speech
fallback, the browser may send audio to its own speech service. The browser
vendor controls that service.

### Preview dweb

Preview builds can use signaling servers for peer discovery and WebRTC for
peer-to-peer traffic when the dweb is enabled. Store builds omit the dweb.

## What peerd does not do

- sell user data
- use extension data for advertising
- run analytics or telemetry
- send crash reports
- provide extension data to a peerd-hosted agent service

## Data deletion

Local data remains until the user deletes it. peerd settings provide controls
for local records and caches. Uninstalling the extension asks the browser to
remove extension storage, subject to browser behavior.

## Children

peerd is not directed at children under 13.

## Changes

Policy changes will be published at the public policy URL with an updated
effective date.

## Contact

contact@peerd.ai
