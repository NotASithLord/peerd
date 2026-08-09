# Chrome Web Store dashboard text

This file is the draft source for the **Privacy practices** tab of the developer
dashboard. Do not paste it into a submission until every maintainer note and
blocker below is resolved against the package being uploaded.

---

## Single-purpose statement

> peerd has one purpose: it is an AI assistant that performs tasks in
> the user's browser on the user's instruction. The user types or
> speaks a request in the side panel; the assistant carries it out by
> reading and interacting with web pages in the user's tabs. Every
> capability in the extension exists to serve that one assistant: the
> sandboxed WebAssembly Linux VM and JavaScript sandbox are where the
> assistant runs computations a task needs, voice input is another way
> to give the assistant a task, and the local audit log shows the user
> what the assistant did. There is no second product: no content
> alteration, no search/new-tab takeover, no developer-operated data
> collection. The
> extension is local-first. The user configures their own provider, using
> either their own API key or a supported local provider. There is no backend
> service.

---

## Permission justifications

### `debugger` is not requested by the store package

> The store package does **not** request the `debugger` permission. The
> assistant operates web pages entirely through `chrome.scripting`
> (reading content, building an accessibility-style snapshot, and
> selector/element click & type), which covers ordinary sites. There is
> no Chrome DevTools Protocol use in this package and nothing to justify
> here.
>
> (Maintainer note, not dashboard copy: the optional Chrome DevTools
> Protocol path is used only to drive sites that ship Trusted Types or
> strict CSP, which reject injected scripts. It ships in the separate
> GitHub-distributed *preview* channel, gated by an in-app "Advanced
> automation" switch. If it is ever added to a store update, it will be
> declared as a required permission with its own justification at that
> time, since Chrome forbids `debugger` under `optional_permissions`.)

### `scripting`

> The assistant reads page content and performs DOM actions (click,
> type, extract text) in the user's current task context by injecting
> small, bundled content functions via `chrome.scripting.executeScript`.
> All code injected into a page ships inside the extension package. Page
> injection happens only when the user has given the assistant a task that
> requires the page.

### `tabs`

> The assistant works across tabs: it lists open tabs so the user can
> point it at one ("summarize the article in my other tab"), opens new
> tabs for tasks, navigates, and tracks which tab a task is operating
> on. Tab URLs/titles are read for this orchestration and are not
> collected or transmitted anywhere except, when relevant to a task, to
> the AI provider the user configured.

### `webNavigation`

> The assistant uses child-tab navigation events to identify the exact child
> opened by a tab it is already driving. It applies the child tab's network
> guard before allowing that child to continue to a public destination. A child
> aimed at a protected destination is closed. Events
> from ordinary user tabs are ignored. The extension does not keep navigation
> history or send these events to a developer server. During a service-worker
> restart, early handling requires both restored source ownership and the
> complete surviving private-network rule set on that exact source. Without
> both, the extension leaves the child alone until ownership data has loaded.
>
> Firefox may summarize this as "Access browser activity during navigation."
> In peerd, the permission is used only for the child-tab correlation above.

### `webRequest` and `webRequestBlocking` (Firefox only)

> Firefox uses these permissions to synchronously cancel a private-network,
> local, cloud-metadata, or denylisted request from the exact child of a tab the
> assistant is already driving. This closes the first-request gap while the child's
> tab-scoped network rules are installed, then the temporary child marker is
> released. peerd does not read request bodies, alter public requests, or apply
> this guard to children from ordinary user tabs. A subrequest stopped by this
> temporary guard produces a URL-free tool and Activity receipt. A request
> blocked first by the declarative rule is silent. Chrome packages do not
> request these permissions.

### `tabGroups`

> The assistant's sandboxes (Linux VM, Notebook, app pages) each run
> in their own tab; peerd groups these working tabs so the user's
> window stays organized and the assistant's tabs are visually
> distinguishable from the user's own browsing.

### `storage`

> The encrypted API-key vault, conversation history, settings, denylist,
> and audit log are stored in `chrome.storage.local` or IndexedDB. peerd
> does not sync this storage to a developer server. Messages and task
> context are sent only as needed to the model provider selected by the
> user.

### `offscreen`

> The offscreen document hosts isolated worker processes for delegated
> assistants and headless JavaScript jobs. It also keeps extension work
> alive across service-worker suspension, extracts web pages and documents,
> and hosts microphone capture and Moonshine speech transcription without a
> visible page. Audio stays on the device when Moonshine is selected.

### `sidePanel`

> The side panel is the product's primary task UI. It shows the conversation
> beside the page the assistant is working on. Settings and the Activity log
> open in a separate extension page.

### Host permission `<all_urls>`

> The assistant must be able to read and act on whatever page the user gives it
> a task on. Which site that is remains the user's choice at task time and
> cannot be enumerated in advance. Page injection and page automation occur
> only during an active user task. A default-ON denylist constrains page access
> on sensitive sites such as banks, health portals, and password managers.
> Direct fetch, document reading, and browser automation also block
> private-network targets. Driven tabs use tab-scoped network rules so page
> redirects and tab-associated requests cannot bypass that check. Private-network
> rules also cover service-worker fetches from public domains visited in the
> driven tab until custody ends. A user-owned tab on the same matching domain
> can temporarily lose private-network service-worker fetch access. A child tab
> is guarded only when the browser identifies its exact source as a tab the
> assistant is already driving. Protected children are closed. Other tabs are
> not navigated, closed, or focused.
> Provider setup and user-enabled runtime downloads are separate user-initiated
> network uses.
> The local Activity log records tool outcomes, direct open-web fetches, and
> policy denials.

---

## Remote code question

**Do not answer No until the fetched-data execution policy is resolved.**

The Store Script and Notebook resolver refuses direct HTTP and HTTPS JavaScript
imports without requesting the module source. The package generates
`REMOTE_MODULE_IMPORTS_ENABLED = false`, both hosts consume it, and the
resolver requires an explicit true value before it can use the audited fetch
relay. Supported Preview targets keep that import path.

This does not settle every remote code question. A run can still fetch bytes as
data and later use local JavaScript or WebAssembly execution surfaces. The open
fetched-data execution policy must decide and document that broader contract
before the dashboard answer is final.

Current source: `extension/peerd-engine/module-resolver.js`,
`extension/offscreen/job-runner.js`,
`extension/engine-tabs/notebook-tab/notebook-tab.js`,
`packaging/gen-channel-config.ts`, and
`packaging/verify-store-artifact.ts`.

---

## Data-usage form (Privacy practices tab)

The current behavior handles at least:

- **Authentication information:** the user's own AI-provider API key.
  Stored encrypted, locally; transmitted only to the provider the user
  configured, never to the developer (no developer servers exist).
- **Website content:** pages the assistant reads to perform a task the
  user gave it. This is sent to the user's configured AI provider as part
  of the user's own prompt. `fetch_url`, document readers, and browser tools
  may also request the third-party site needed for the task. Those paths use
  SSRF checks, a sensitive-site denylist where applicable, and the local audit
  log. No website content is sent to the developer.
- **Web browsing activity:** peerd reads task-relevant tab URLs and titles. The
  local Activity log records tool outcomes, direct open-web fetches, and policy
  denials. peerd does not read or upload the browser's general history database.
- **Personal communications and user-provided content:** prompts, conversation
  history, and task-relevant page content may be stored locally and sent to the
  selected model provider. Page content can itself contain messages or other
  personal data.
- **Voice input:** voice is off by default. When enabled, the default automatic
  engine prefers the browser's Web Speech service, which may send audio to the
  browser vendor. The user can select local Moonshine transcription to keep
  audio on the device.

Do not use a blanket "everything else not collected" statement. A user can ask
peerd to process page content containing personally identifiable, financial, or
health information, even though the default denylist reduces that exposure.
Review the current dashboard category names and the uploaded package before
selecting the final checkboxes.

Certifications (check all three):
- I do not sell or transfer user data to third parties, outside of the
  approved use cases ✔
- I do not use or transfer user data for purposes that are unrelated to
  my item's single purpose ✔
- I do not use or transfer user data to determine creditworthiness or
  for lending purposes ✔

Privacy policy URL: `https://peerd.ai/privacy` (publish
`docs/store/PRIVACY.md` through the `peerd-site` repository first).
