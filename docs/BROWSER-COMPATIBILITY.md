# Browser compatibility

Peerd targets desktop Chromium and Firefox. This is the single durable ledger
for browser-platform differences that cause a concrete loss of Peerd
functionality or isolation. It is not a general roadmap or a claim that two
browsers expose identical extension APIs.

Last audited: **2026-08-11**. The packaged Firefox 149 Pod smoke rejected the
raw blob module Worker before it executed; the ordinary shell/WASI/persistence
checks passed. Firefox 154 sandbox support is an upstream milestone and has not
yet been adopted or verified by Peerd. Upstream statuses below are snapshots;
follow the linked issues for their live state. An upstream issue closing is not
enough to remove a guard: the exit check in this file must pass in a packaged
extension.

## Current user-visible differences

| Surface | Chromium | Firefox | Classification |
|---|---|---|---|
| WebVM and threaded WebAssembly | WebVM can boot in a cross-origin-isolated extension page | WebVM cannot boot from an extension page; WebAssembly that needs shared memory/threads is unavailable. Non-threaded WASI in Notebooks and Pods is unaffected | Blocked upstream |
| Pod JavaScript | `js` runs Web-standard JavaScript in a sealed module Worker | `js` is refused; the shell, OPFS, Git, HTTP bridge, and WASI remain available | Platform behavior under review plus a Peerd guard |
| Apps | Opaque-origin manifest-sandbox runner is available | Unavailable in the current Peerd Firefox package | Upstream fixed for Firefox 154; Peerd adoption pending |
| Headless/offscreen services | Headless `script`/`page_code`, site-client and A2A code runners, PDF/document conversion, rich HTML extraction, voice/local-model hosts, and per-actor Worker heaps are available | Those offscreen-hosted tools are absent or fall back; notably, bound actors fall back to the service-worker heap and lose the dedicated memory boundary | Peerd architecture gap; upstream API request is WONTFIX |
| Advanced tab automation | Preview/dev builds can use CDP; the store build uses the scripting fallback | Uses the scripting fallback: core read/navigate/click/type work, but `page_exec`, trusted `page_keys`, cross-frame accessibility snapshots, and some hardened-site flows are unavailable | Accepted fallback around a missing API |

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

### FF-SANDBOX: manifest sandbox support landed in Firefox 154

- **Peerd impact:** Apps are disabled because Peerd's current Firefox manifest
  strips the `sandbox` key and the runtime refuses to open an App without a
  proven opaque-origin runner.
- **Upstream:** [Mozilla Bug 1685123](https://bugzilla.mozilla.org/show_bug.cgi?id=1685123)
  is `RESOLVED FIXED` for Firefox 154.
- **Peerd status:** this is no longer an upstream blocker. Peerd must decide when
  Firefox 154 is an acceptable minimum, retain `sandbox` plus its CSP in the
  Firefox manifest, and remove the Firefox-only App refusal.
- **Exit check:** packaged Firefox App tests prove an opaque origin, no extension
  API access, no ambient network, correct Worker rewriting, and normal
  create/edit/preview/version/reopen behavior.

### FF-OFFSCREEN: Firefox uses event pages instead of `chrome.offscreen`

- **Peerd impact:** the headless tools and document/media/model hosts listed in
  the table are unavailable or degraded. More importantly, actor turns can fall
  back to the service-worker realm; the exact security consequence is documented
  as [residual risk R1](security/THREAT-MODEL.md#8-known-residual-risks).
- **Upstream:** [Mozilla Bug 1807830](https://bugzilla.mozilla.org/show_bug.cgi?id=1807830)
  is `RESOLVED WONTFIX`; Mozilla's stated replacement is the DOM-capable MV3
  event page. The cross-browser API discussion remains in
  [WECG issue 170](https://github.com/w3c/webextensions/issues/170).
- **Peerd status:** this is a Peerd architecture task, not something to wait for
  Mozilla to fix. The current gate is `offscreenAvailable` in
  [`service-worker.js`](../extension/background/service-worker.js).
- **Exit check:** a Firefox event-page or equivalent host provides the same
  lifecycle, cancellation, keyless Worker boundary, and document/media
  capabilities, with Firefox browser tests covering both success and recovery.

### FF-DEBUGGER: no compatible `chrome.debugger` extension API

- **Peerd impact:** Firefox uses the same `chrome.scripting`/DOM-walk path as the
  initial Chromium store build. It cannot provide CDP-only trusted input,
  `page_exec` on Trusted-Types pages, or the full cross-frame accessibility
  tree.
- **Upstream:** [Mozilla Bug 1316741](https://bugzilla.mozilla.org/show_bug.cgi?id=1316741)
  remains `NEW`; the older direct Chrome-parity request,
  [Bug 1241448](https://bugzilla.mozilla.org/show_bug.cgi?id=1241448), is
  `RESOLVED WONTFIX`.
- **Peerd fallback:** the capability gate and exact fallback surface are in
  [`service-worker.js`](../extension/background/service-worker.js); the
  top-frame-only snapshot constraint is in
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
