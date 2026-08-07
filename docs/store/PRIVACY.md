# peerd Privacy Policy

**Effective date:** August 6, 2026

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

Voice is off by default. When enabled, the automatic engine prefers the
browser's Web Speech service, which may send audio to the browser vendor. The
user can select Moonshine for local transcription. peerd does not retain
recorded audio.

## Data sent from the device

### Model providers

Messages and task context are sent to the model provider selected by the user.
Requests use the user's provider key when required. The provider's privacy
policy applies to that data. Depending on the task, this content may include
personal communications, identifying information, or other sensitive material
present in the user's prompt or page. The default denylist reduces access to
some sensitive sites but is not a guarantee about the content of every page.

### Websites and user-directed network requests

peerd can request websites and APIs needed for a task. Direct fetch and
document-reading paths block private-network targets. Configured sensitive-site
rules apply on supported browser and fetch paths. The local Activity log records
tool outcomes, direct open-web fetches, and policy denials. It is not a complete
record of every network request or visited URL.

### Runtime assets

Some features download public runtime assets, such as a speech model or a
WebVM disk image. Integrity and source controls are defined in the code and
vendored dependency records.

Store and web builds refuse direct JavaScript imports from HTTP and HTTPS URLs
without requesting the module source. Preview can fetch a requested module
through the audited web path and execute it in a sealed worker. This distinction
does not cover code fetched as ordinary data and later passed to an execution
surface.

### Browser speech services

When voice is enabled, the default automatic engine prefers the browser's Web
Speech service. The browser may send audio to its own speech service, which is
controlled by the browser vendor. Users can select Moonshine for local
transcription instead.

### Preview dweb

Preview builds can use signaling servers for peer discovery and WebRTC when the
dweb is enabled. Direct and agent-to-agent messages, published agent profiles,
and shared peer-to-peer app bundles can be sent to peers. Recipients may retain
data they receive even after the sender removes a local copy. Signaling servers
may keep their own operational logs, but they do not control data already held
by peers.

The optional preview dweb agent currently uses one model conversation across
messages from different peers. Until peer-scoped histories and exact reply
grants are implemented, one peer may be able to prompt it to reveal information
from another peer conversation. Keep the dweb agent disabled unless you accept
this risk. Store builds omit the dweb.

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
