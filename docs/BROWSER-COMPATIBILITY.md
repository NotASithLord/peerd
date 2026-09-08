# Browser compatibility

Peerd targets desktop Chromium and Firefox. This is the single durable ledger
for browser-platform differences that cause a concrete loss of Peerd
functionality or isolation. It is not a general roadmap or a claim that two
browsers expose identical extension APIs.

The packaged Firefox acceptance lane targets Firefox 154 or later. Apps have
passed the opaque-origin sandbox, isolation, import/open, Git, and restart
checks. Pod JavaScript remains guarded because the raw blob module Worker is
still rejected before execution; ordinary shell/WASI/persistence checks pass.
Upstream statuses below are snapshots; follow the linked issues for their live
state. An upstream issue closing is not enough to remove a guard: the exit
check in this file must pass in a packaged extension.

## Current user-visible differences

| Surface | Chromium | Firefox | Classification |
|---|---|---|---|
| WebVM and threaded WebAssembly | WebVM can boot in a cross-origin-isolated extension page | WebVM cannot boot from an extension page; WebAssembly that needs shared memory/threads is unavailable. Non-threaded WASI in Notebooks and Pods is unaffected | Blocked upstream |
| Pod JavaScript | `js` runs Web-standard JavaScript in a sealed module Worker | `js` is refused; the shell, OPFS, Git, HTTP bridge, and WASI remain available | Platform behavior under review plus a Peerd guard |
| Apps | Opaque-origin manifest-sandbox runner is available | Available on Firefox 154 or later with the same no-network sandbox floor | Supported with packaged acceptance |
| Headless/offscreen services | Headless `script`/`page_code`, site-client and A2A code runners, PDF/document conversion, rich HTML extraction, voice/local-model hosts, and per-actor Worker heaps are available | The sealed controller and per-actor Workers run from the event page and preserve their separate keyless heaps; voice has a background-page host. Sealed jobs, document/PDF conversion, rich HTML extraction, local WebGPU, and dweb/A2A hosts remain unavailable, so their dependent tools are not exposed | Isolation parity is implemented; hosted capability gaps remain |
| Advanced tab automation | Preview/dev builds can use CDP; the store build uses the scripting fallback | Uses the scripting fallback for core read/navigate/click/type work and `tabs.captureTab(tabId)` for exact-tab vision; cross-frame accessibility snapshots, network capture, trusted CDP input, and some hardened-site flows remain unavailable | Accepted fallback around a missing API |

The side panel/sidebar naming difference is not a capability loss. Minor UI
differences such as tab grouping are also omitted unless they begin preventing
a user or agent workflow.

## Upstream issue ledger

### FF-COI: extension pages cannot opt into cross-origin isolation

- **Peerd impact:** WebVM (CheerpX) cannot boot, and threaded WebAssembly cannot
  share memory with Workers from a Firefox extension page. This does not block
  ordinary WebAssembly or WASI Preview 1 commands.
- **Upstream:** [Mozilla Bug 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477)
  (`REOPENED`) and the cross-browser proposal in
  [WECG issue 1039](https://github.com/w3c/webextensions/issues/1039) (`OPEN`).
  Mozilla tracks per-extension process isolation separately in
  [Bug 1827085](https://bugzilla.mozilla.org/show_bug.cgi?id=1827085).
- **Peerd guard:** Firefox packages strip the unsupported COOP/COEP manifest
  keys in [`packaging/gen-manifest.ts`](../packaging/gen-manifest.ts), and the
  WebVM preflight explains the limitation through
  [`firefox-webvm-note.js`](../extension/engine-tabs/vm-tab/firefox-webvm-note.js).
- **Exit check:** a packaged Firefox extension page reports
  `crossOriginIsolated === true`, can transfer a `SharedArrayBuffer` to a Worker,
  and passes the WebVM boot and threaded-WASM browser tests.

### FF-MV3-WORKERS

Dynamic Worker/CSP behavior is not yet a stable Firefox Pod contract.

- **Peerd impact:** Firefox Pods refuse the `js` command. Shell commands, files,
  browser-native Git, brokered HTTP, and installed WASI commands continue to
  work.
- **Upstream:** [Mozilla Bug 1869152](https://bugzilla.mozilla.org/show_bug.cgi?id=1869152)
  (`NEW`) tracks inconsistent Worker behavior in Manifest V3 extensions,
  including blob Workers and extension-packaged Worker scripts. It is the
  behavior tracker, not a promise that Firefox will permit Peerd's generated
  code path.
- **Peerd guard:** [`pod-tab.js`](../extension/engine-tabs/pod-tab/pod-tab.js)
  refuses the dynamic module Worker on Firefox, and the packaged smoke in
  [`run-pod-smoke.mjs`](../scripts/firefox/run-pod-smoke.mjs) pins the honest
  error and directly probes the browser's raw blob-module-Worker behavior
  instead of silently routing to a weaker execution boundary.
- **Exit check:** the final Firefox MV3 package can create the sealed blob module
  Worker under its shipped CSP, AMO policy permits the construction, and the
  same realm-seal, cancellation, egress, and red-team tests pass as Chromium.

### FF-OFFSCREEN: Firefox uses event pages instead of `chrome.offscreen`

- **Peerd impact:** Firefox has no offscreen document, so sealed jobs,
  document/PDF conversion, rich HTML extraction, local WebGPU, and dweb/A2A
  hosts remain unavailable. The runtime capability projection removes dependent
  tools instead of routing them through a weaker host. This does not move
  reasoning into the privileged background heap: the orchestrator and every
  actor run in separate keyless dedicated Workers.
- **Upstream:** [Mozilla Bug 1807830](https://bugzilla.mozilla.org/show_bug.cgi?id=1807830)
  is `RESOLVED WONTFIX`; Mozilla's stated replacement is the DOM-capable MV3
  event page. The cross-browser API discussion remains in
  [WECG issue 170](https://github.com/w3c/webextensions/issues/170).
- **Peerd status:** Firefox uses a sealed event-page controller and actor host.
  A run-scoped acknowledged `storage.session` heartbeat keeps the event page
  alive only while actor work is active; loss pauses work and recovery refuses
  uncertain replay. Voice uses its dedicated background-page host. There is no
  service-worker-heap reasoning fallback.
- **Exit check:** new Firefox hosts add the currently unavailable sealed-job,
  document/media, rich-HTML, local-model, or dweb capabilities without weakening
  the existing Worker isolation, lifecycle, cancellation, and recovery proofs.

### FF-DEBUGGER: no compatible `chrome.debugger` extension API

- **Peerd impact:** Firefox uses the same `chrome.scripting`/DOM-walk path as the
  initial Chromium store build and `tabs.captureTab(tabId)` for exact-tab
  vision. It cannot provide CDP-only trusted input, site-client network capture,
  or the full cross-frame accessibility tree.
- **Upstream:** [Mozilla Bug 1316741](https://bugzilla.mozilla.org/show_bug.cgi?id=1316741)
  remains `NEW`; the older direct Chrome-parity request,
  [Bug 1241448](https://bugzilla.mozilla.org/show_bug.cgi?id=1241448), is
  `RESOLVED WONTFIX`.
- **Peerd fallback:** the top-frame-only snapshot constraint is in
  [`walk-injected.js`](../extension/peerd-runtime/dom/walk-injected.js).
- **Exit check:** Firefox exposes a reviewed automation API with the required
  trusted-input and inspection semantics, or Peerd implements equivalent
  behavior without weakening page or user security.

## Maintenance rules

Update this file when a browser guard/fallback changes, an upstream issue moves
state or milestone, or a packaged-browser test changes the verified result. For
each entry:

1. Keep the user-visible loss precise; do not write “Firefox unsupported” when
   only one execution path is missing.
2. Link the narrowest primary upstream issue, not a project-wide issue list.
3. Say whether Peerd is blocked upstream or owes its own implementation.
4. Remove the entry only after the packaged exit check passes and the weaker
   fallback/guard is deleted.
