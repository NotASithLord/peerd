# Chrome Web Store — paste-ready dashboard text

Everything in this file is written to be pasted into the **Privacy
practices** tab of the developer dashboard. Each justification is under
the dashboard's length limit. Do not free-type at submission; copy from
here.

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
> alteration, no search/new-tab takeover, no data collection. The
> extension is local-first — the user supplies their own AI provider
> API key, and there is no backend service.

---

## Permission justifications

### `debugger` — NOT requested by the store package

> The store package does **not** request the `debugger` permission. The
> assistant operates web pages entirely through `chrome.scripting`
> (reading content, building an accessibility-style snapshot, and
> selector/element click & type), which covers ordinary sites. There is
> no Chrome DevTools Protocol use in this package and nothing to justify
> here.
>
> (Maintainer note — not dashboard copy: the optional Chrome DevTools
> Protocol path — used only to drive sites that ship Trusted Types /
> strict CSP, which reject injected scripts — ships in the separate
> GitHub-distributed *preview* channel, gated by an in-app "Advanced
> automation" switch. If it is ever added to a store update, it will be
> declared as a required permission with its own justification at that
> time, since Chrome forbids `debugger` under `optional_permissions`.)

### `scripting`

> The assistant reads page content and performs DOM actions (click,
> type, extract text) in the user's current task context by injecting
> small, bundled content functions via `chrome.scripting.executeScript`.
> All injected code ships inside the extension package; nothing is
> fetched or generated remotely. Injection happens only when the user
> has given the assistant a task that requires the page.

### `tabs`

> The assistant works across tabs: it lists open tabs so the user can
> point it at one ("summarize the article in my other tab"), opens new
> tabs for tasks, navigates, and tracks which tab a task is operating
> on. Tab URLs/titles are read for this orchestration and are not
> collected or transmitted anywhere except, when relevant to a task, to
> the AI provider the user configured.

### `tabGroups`

> The assistant's sandboxes (Linux VM, Notebook, app pages) each run
> in their own tab; peerd groups these working tabs so the user's
> window stays organized and the assistant's tabs are visually
> distinguishable from the user's own browsing.

### `storage`

> All user data is local by design: the encrypted API-key vault,
> conversation history, settings, the denylist, and the audit log live
> in `chrome.storage.local` / IndexedDB. Nothing is synced or
> transmitted; this permission is what makes the no-backend design
> possible.

### `offscreen`

> Voice input is transcribed locally by a WebAssembly speech model
> (Moonshine). The offscreen document hosts the microphone capture and
> the WASM transcriber so they can run while the user works, without
> requiring a visible page. Audio never leaves the device in this path.

### `sidePanel`

> The side panel is the product's primary UI: the conversation with the
> assistant, settings, and the audit log live there, alongside the page
> the assistant is working on.

### Host permission `<all_urls>`

> The assistant must be able to read and act on whatever page the user
> gives it a task on — which site that is is the user's choice at task
> time and cannot be enumerated in advance. Access is exercised only in
> service of an active user task; it is constrained by a default-ON
> denylist of sensitive sites (banks, health, password managers, etc.),
> a private-network/SSRF block, and a local audit log of every request,
> allowed or denied.

---

## Remote code question

Answer: **No, I am not using remote code.**

> All executable code — JavaScript and WebAssembly, including the
> CheerpX VM runtime — is packaged in the extension. Vendored
> third-party code is pinned and hash-documented in per-directory
> SOURCE.txt files. Network fetches retrieve data only: model API
> responses, a voice model verified against pinned SHA-384 hashes
> before use, a Debian filesystem image interpreted as data by the
> sandboxed WASM VM, and web pages the user asks the assistant to read.

---

## Data-usage form (Privacy practices tab)

What the extension handles. Check ONLY:

- **Authentication information** — the user's own AI-provider API key.
  Stored encrypted, locally; transmitted only to the provider the user
  configured, never to the developer (no developer servers exist).
- **Website content** — pages the assistant reads to perform a task the
  user gave it. This is sent to the user's configured AI provider as part
  of the user's own prompt; and, for the open-web read tools
  (`call_api`/`read_article`/`web_search`), peerd also requests the
  third-party site itself (as a browser would). That open-web path is not
  allowlist-restricted — it is gated by an SSRF block, a sensitive-site
  denylist, and a local audit log. No website content is sent to the
  developer (there are no developer servers).

Everything else (location, web history, user activity, personal
communications, financial/health info, personally identifiable info):
**not collected**. Note: the denylist specifically blocks the assistant
from operating on financial and health sites.

Certifications (check all three):
- I do not sell or transfer user data to third parties, outside of the
  approved use cases ✔
- I do not use or transfer user data for purposes that are unrelated to
  my item's single purpose ✔
- I do not use or transfer user data to determine creditworthiness or
  for lending purposes ✔

Privacy policy URL: `https://peerd.ai/privacy` (publish
`the website/privacy.html` there first).
