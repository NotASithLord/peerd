# "Pull in peerd" on regular web pages — investigation & recommendation

> Status: **decided + implemented.** Handoff from PR #56, which shipped the
> engine-tab "pull in peerd" button (`extension/shared/pull-in-peerd.js`) and
> deliberately left regular web pages out of scope. This document answered
> whether to extend the affordance to the web pages peerd opens (`open_tab`),
> and at what cost.
>
> **Outcome:** the injected in-page button was **declined** (Chrome-only +
> breaches the fail-closed SW boundary). The underlying need — summon the chat
> onto a peerd-opened web page without a round-trip — was instead solved by
> making the **toolbar icon situational** (home when none is open, pull the
> panel in when home is already up) plus a dedicated **`Alt+Shift+P` command**,
> both first-party gesture contexts on Chrome AND Firefox, no boundary change.
> Recorded as `docs/DECISIONS.md` #26; implemented in
> `extension/background/panel-affordance.js` (pure decision) + service-worker
> §7 + the `commands` manifest key + the agent-tab-card hint
> (`extension/sidepanel/components/chat-view.js`). §§1–6 below are the original
> investigation that led here.

---

## TL;DR — recommendation: **conditional, leaning DON'T (as designed)**

Do **not** ship the injected in-page button as the primary way to summon
the panel from a peerd-opened web page. Three facts decide it:

1. **It is Chrome-only.** The relay it depends on (page button →
   `runtime.sendMessage` → SW → `sidePanel.open`) works on Chrome but is
   **rejected on Firefox**: a background message handler is not a
   user-action context there (`sidebarAction.open()` throws). So the
   feature would silently be Chrome-only — a regression from PR #56, whose
   engine-tab button works on *both* browsers because it runs in a
   first-party extension page, not a content-script world.
2. **It permanently breaches a fail-closed boundary.** `shared/messaging.js`
   + `shared/sender-trust.js` exist specifically so that *nothing*
   content-script-reachable can hit the SW dispatch surface. Supporting web
   pages means adding the first-ever content-script-reachable route. The
   route itself can be made genuinely low-risk (see §2), but the boundary
   stops being "no holes" and becomes "one audited hole" — a property worth
   keeping if we can.
3. **A strictly-better, cross-browser, zero-boundary alternative exists.**
   A `commands` keyboard shortcut (Chrome `chrome.commands.onCommand` →
   `sidePanel.open`; Firefox built-in `_execute_sidebar_action`) opens the
   panel from a *valid* user-gesture context on both browsers, needs **no**
   content-script route, and graffitis nobody's page (§6).

**What to ship instead:** solve the underlying need ("I'm standing on a
peerd-opened web page with the panel closed and want the chat without a
round-trip through home") with the keyboard command, and lean on the
existing "go there" card. Reserve the injected button as a **Chrome-only,
preview-channel, explicitly-decided** fallback *only if* on-page
discoverability turns out to be a validated need the shortcut can't meet —
and then only with the precise isolation in §2–§3.

The rest of this document is the evidence and, should the owner want the
button anyway, the concrete design + the exact boundary change to make and
document.

---

## 0. Background: why engine tabs were easy and web pages are not

PR #56's button lives in `pull-in-peerd.js`, which is **imported as an ES
module by the engine tab pages** (`vm-tab/`, `notebook-tab/`, `app-tab/`).
Those pages are first-party extension origins
(`chrome-extension://<id>/vm-tab/index.html`). The button therefore runs
**in an extension context with `chrome.sidePanel` in scope** and calls
`sidePanel.open()` / `sidebarAction.open()` *directly* inside its own click
handler. No SW, no message, no trust boundary — which is why it works
identically on Chrome and Firefox.

A regular web page peerd opens via `open_tab` is a **third-party origin**
(`https://example.com/...`). Any button peerd puts there lives in a
**content-script / page world** with **no `chrome.sidePanel`**. To open the
panel it must message the SW and have the SW call `open()`. That single
fact is the whole problem:

- the SW dispatch surface is **fail-closed against content-script senders**
  (`makeDispatcher` → `isFirstPartySender`: `sender.url` must start with our
  own extension origin; a content script's `sender.url` is the *web page*),
  so a new route must be added *outside* that guard; and
- the gesture must survive the page → SW hop, which Chrome allows and
  Firefox does not.

---

## 1. Does it even work? (the gating question)

### 1.1 Chrome — **yes**, with strict timing constraints

Chrome propagates user activation through extension messaging: when a
content script calls `runtime.sendMessage` *inside a user gesture*, the SW's
`onMessage` handler runs with a **"restricted" user gesture**, and
`chrome.sidePanel.open()` accepts it. This is the documented, intended path
("The side panel can be triggered by a user interaction on an extension page
or content script, such as clicking a button"), and there is a canonical
working sample — `Antony-Q/example-side-panel` — that does exactly:

```js
// content script (isolated world)
button.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'open_side_panel' });
});

// service worker
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'open_side_panel') {
    // first statement in the handler — no awaited call before it
    chrome.sidePanel.open({ tabId: sender.tab.id });
  }
});
```

For peerd's window-global panel we'd pass `{ windowId: sender.tab.windowId }`
instead of `{ tabId }`. Note a nice simplification: **the SW already knows
the real `windowId` synchronously** from `sender.tab.windowId`, so the
`windowId`-resolution dance `pull-in-peerd.js`/`home.js` does (caching it
because `tabs.getCurrent()` is async) is unnecessary on this path.

The constraints — all of which the codebase already respects elsewhere — are
real and must be honored or the open is dropped with "may only be called in
response to a user gesture":

- **Send synchronously in the gesture.** The content-script listener must
  `sendMessage` directly in the handler; no `await` before it. `mousedown`
  is a slightly more robust trigger than `click` (fires earlier in the
  gesture, less risk of the ~5s activation window lapsing under load), but
  `click` works in the reference sample.
- **Open synchronously in the SW handler.** `sidePanel.open(...)` must be
  the *first* statement reached for that message — **no `await`, no
  `lastError` check, no `tabs.get` before it**. Every "it fails even though I
  clicked" report traces to an awaited call (or a callback) preceding
  `open()` and consuming/voiding the restricted gesture
  (`chromium #355266358`, samples `#1001`).
- **One message per gesture.** The restricted gesture can't be re-broadcast;
  the open must ride the first message.

**Conclusion (Chrome): feasible and not exotic.** It is, however, the
fragile-by-construction corner of the API, so the SW handler must be a
*dedicated, minimal, synchronous* listener — not a `makeDispatcher` route
(which is async by design: `Promise.resolve().then(handler)`; that deferral
alone would void the gesture). This dovetails with the isolation requirement
in §2.

### 1.2 Firefox — **no** (via this path)

Firefox is explicit (MDN, *User actions*): `sidebarAction.open()` "may only
be called from inside the handler for a user action," and **a background
message handler responding to a content-script message is *not* such a
handler**. MDN's example is precisely our case — a content-script button that
messages the background — and states the background handler "is not
considered to be handling a user action." Valid user-action contexts on
Firefox are limited to: the extension's browser/page action, an extension
context-menu item, and an extension **keyboard shortcut**. Awaiting a promise
also drops the status.

**Conclusion (Firefox): the relayed in-page button cannot open the sidebar.**
There is no per-tab `sidebarAction.open({ tabId })` escape hatch and no
gesture-propagation-through-messaging. Any web-page button on Firefox would
be dead — or would need a fundamentally different trigger (the keyboard
command of §6, which *is* a valid Firefox user action).

> This asymmetry is the single most important finding: PR #56 achieved
> Chrome+Firefox parity *because* it stayed in the extension page. Crossing
> to web pages breaks that parity for an intrinsic, non-fixable reason.

---

## 2. Threat model of the new route, and how to keep it isolated

The proposed route does **exactly one thing**: open *the user's own* side
panel for the window the sender tab lives in. It carries no payload that
selects behavior, returns no data, and touches no state.

### 2.1 What the route can and cannot do

- **Cannot reach any privileged handler.** It must be a **separate
  `onMessage` listener**, registered alongside the existing dedicated
  listeners (the SW already has several: local-model deltas, the
  voice/VM forwarder, the tab-ready tracker — all independent of
  `makeDispatcher`). It is *physically not wired* to the
  `makeDispatcher` handler table (vault/*, tool dispatch, subagent/spawn,
  provider keys, sw/web-fetch, …). There is no string a page can send to this
  listener that reaches those routes; the listener matches one `type` and
  ignores everything else.
- **Web pages can't reach it on their own.** No `externally_connectable`
  entry exists (and none is added), so a page's own JS cannot
  `runtime.sendMessage` to peerd at all. Only code peerd *injects* into a tab
  (isolated world) can message the SW. The page can see the button exists,
  but cannot forge the message or invoke the route without a real
  same-tab user gesture.
- **Worst-case abuse is "the panel opens."** Even if a hostile page somehow
  triggered it (e.g. tricked the user into clicking, or a future bug let page
  JS reach the isolated-world button), the *entire* consequence is that the
  user's own side panel opens in their own window. No secret is read, written,
  or exfiltrated; no tool runs; no navigation happens. This is a
  nuisance/clickjacking-grade outcome, **categorically below** the
  vault/tool-dispatch surface the boundary protects.

### 2.2 Residual risk, quantified

| Risk | Severity | Mitigation |
|---|---|---|
| Page JS invokes the route directly | n/a | No `externally_connectable`; page JS can't message the SW. Only the injected isolated-world script can. |
| Hostile page spoofs the message from the injected world | Low | The injected script is peerd's own code; the page can't run code in the isolated world. The SW additionally validates `sender.tab.id ∈ peerdOpenedTabs` (§3.1) and `sender.frameId === 0`. |
| Clickjacking the button to open the panel | Very low | Outcome is "panel opens" — no capability gained. The button is dismissible (§5) and visually labelled. |
| The new listener becomes a foothold for future routes | **This is the real cost** | Keep the listener single-purpose and *documented as load-bearing*: it is the one place `isFirstPartySender` is intentionally not applied, and a comment + `sender-trust.js` note must say so, so nobody "reuses" it. |

The genuine residual risk is **not** the route's behavior (which is inert);
it is the **precedent**: the codebase's strongest invariant ("nothing
untrusted reaches the SW dispatch surface") becomes "nothing untrusted
reaches it *except this one inert listener*." That is a real downgrade in how
simply the security story can be stated, and it is the main thing weighed
against the modest UX win.

### 2.3 The isolation contract (mandatory if shipped)

1. **Separate listener, never `makeDispatcher`.** Register a standalone
   `browser.runtime.onMessage.addListener` that:
   - matches exactly one `type` (e.g. `'panel/pull-in'`) and returns `false`
     for everything else (lets other listeners run);
   - **does not** call `isFirstPartySender` (that is the whole point — it
     must accept a content-script sender) but instead asserts:
     `sender?.tab?.id` is present, is in `peerdOpenedTabs`, and
     `sender.frameId === 0` (top frame only);
   - calls `browser.sidePanel.open({ windowId: sender.tab.windowId })`
     **as its first statement**, synchronously, then returns `false`
     (fire-and-forget; the page ignores the reply).
2. **No data in, no data out.** The message has no fields beyond `type`; the
   reply is meaningless. The route can never be made to read or return
   anything.
3. **`makeDispatcher` stays fail-closed and unchanged.** It will still log
   `rejected untrusted sender for panel/pull-in` because every listener sees
   every message — that warning is *expected and harmless* (the dedicated
   listener has already opened the panel). Optionally add `'panel/pull-in'`
   to a tiny "don't warn" set in `makeDispatcher` purely to keep the console
   clean; this does **not** make it a dispatcher route.
4. **Firefox no-op.** Guard with `if (!browser.sidePanel?.open) return false;`
   so the listener is inert on Firefox (where the gesture wouldn't propagate
   anyway).

---

## 3. Injection mechanism

No persistent content script (architecture rule). Inject **programmatically**
via `chrome.scripting.executeScript` — the exact mechanism `dom/capture.js`
already uses for `domWalkInjected` — onto **only the tabs peerd itself
opens**, never the user's own tabs the agent merely navigates.

### 3.1 Tracking peerd-opened tab ids

Today nothing tracks the *set* of peerd-opened web tabs. `open_tab` calls
`ctx.noteTab → noteAgentTab`, which only updates the **single** "current
agent tab" card (`agentTabId`), not a durable set. Add a SW-side
`Set<number> peerdOpenedTabs`:

- **Add** in `open_tab.execute` (and only there — this is the seam that
  separates "peerd opened this" from "the user opened this") after
  `tabs.create`, via a new injected `ctx` hook.
- **Remove** in the existing `browser.tabs.onRemoved` listener (next to the
  tracker/`domRefs.clear` cleanup) so ids don't leak.
- **Origin pinning (important).** Record the origin peerd opened
  (`new URL(opts.url).origin`). The button is injected for that tab **only
  while its origin matches**. The instant the user navigates that tab to a
  *different* origin, drop it from the set and stop re-injecting — it has
  become "the user's tab," and re-injecting would both graffiti their
  browsing and risk injecting onto a sensitive site they navigated to.
- **Denylist parity.** Never inject onto an origin the denylist would block
  for DOM tools, even if peerd opened it. Reuse the same denylist check the
  tool gates use; if blocked, skip injection silently.

### 3.2 Re-injecting on navigation (the DOM gets wiped)

A full navigation destroys the DOM *and* the isolated-world globals, so the
button vanishes and must be re-added:

- **Full loads:** extend the **existing** `browser.tabs.onUpdated` listener
  (it already fires on `status === 'loading'` to clear `domRefs`). Add a
  `status === 'complete'` branch: if `tabId ∈ peerdOpenedTabs` *and* the
  tab's current origin still matches the pinned origin, re-run
  `executeScript`. No new permission — `tabs` + `scripting` already cover
  this. (`webNavigation` is **not** needed and should not be added.)
- **SPA route changes:** these don't wipe the isolated world but may detach
  the button if the SPA replaces `document.body`. Handle it *inside* the
  injected script with a lightweight `MutationObserver` on `document.body`
  that re-appends the host node if it goes missing (debounced; disconnect
  bound). This keeps SPA resilience self-contained and avoids a flood of
  `executeScript` calls.
- **Idempotency:** the injected script must early-return if its host node
  already exists (same pattern as `mountPullInPeerd`'s
  `querySelector('.peerd-pull')` guard), so a redundant inject is a no-op.

### 3.3 ES5 classic-script-body constraint

The injected function is serialized (`.toString()`) and re-evaluated in the
page's world, so it must be **fully self-contained**: `'use strict'`, no
imports, no closed-over identifiers, and **ES5 style** (`var`, `function`) —
the same rule and the same ESLint exemption as
`dom/walk-injected.js`, `dom/framework-state.js`, `debugger-pool.js`,
`watch-changes.js`. A new file (e.g.
`peerd-runtime/dom/pull-in-injected.js`) must be **added to that exemption
list** in `eslint.config.js`. Crucially, the injected body **cannot** reuse
`shared/pull-in-peerd.js` — that is an ES module that imports the polyfill,
uses `chrome.sidePanel` directly, and relies on `brand.css` custom
properties. The web-page version shares none of those affordances; it is a
separate, ES5, self-contained file. (It calls `chrome.runtime.sendMessage`
directly — available in the isolated world that `executeScript` injects into
by default; `world: 'MAIN'` would *not* have `chrome.runtime` and must not be
used here.)

### 3.4 Shadow-DOM style isolation + CSP / Trusted-Types pitfalls

The page's CSS must not bleed into the button and vice-versa, and strict-CSP
/ Trusted-Types pages (Gmail, Notion, Slack) must not break it:

- **Shadow DOM for DOM/style isolation.** Mount a single host `<div>` and
  attach a shadow root; build the button inside it with
  `createElement` + `textContent` (no `innerHTML` — that's a Trusted-Types
  *script* sink and is blocked on TT-enforcing pages). The engine-tab version
  already builds nodes, not `innerHTML`; keep that discipline.
- **Style via CSSOM, not `<style>`.** A page's `style-src` CSP (without
  `'unsafe-inline'`) blocks injected `<style>` elements **even inside a
  shadow root** (CSP is per-document). So apply the essential styling
  (`position: fixed`, offsets, colors, z-index) via **`element.style.*` /
  `element.style.cssText`** — CSSOM property assignment is *not* subject to
  `style-src` and survives strict CSP. The brand colors must be **hardcoded
  hex** in the injected body (no `brand.css` on a third-party page).
- **Trusted Types** governs script sinks only; `createElement`,
  `textContent`, and `element.style` touch none of them, so the node-built +
  CSSOM-styled button is TT-safe by construction.
- **Honest degradation:** transitions/hover niceties that *would* want a
  `<style>` block degrade gracefully (apply them inline where they matter; a
  page with a brutal CSP gets a plainer-but-functional chip). The *open*
  action never depends on styling.
- Pages the browser refuses to inject into (`chrome://`, `about:`, the web
  stores, `view-source:`) throw on `executeScript` — swallow exactly like
  `dom/capture.js` does; no button there, which is fine (peerd can't open
  those via `open_tab` anyway — it rejects non-`http(s)` schemes).

---

## 4. Permissions / footprint

- **No new permissions.** `scripting` and `<all_urls>` already ship
  (`manifests/base.json`); `tabs` covers `onUpdated`/`onRemoved`. The
  keyboard-command alternative (§6) would add a `commands` manifest **key**
  (not a permission) and is the only net-new manifest surface in any option.
- **But "no new permission" ≠ "no new privacy/store surface."** Today peerd's
  store story is tight and defensible: injection happens **only on a page the
  user gave the assistant a task on**
  (`docs/store/PERMISSION-JUSTIFICATIONS.md` → `scripting`). Injecting a
  **persistent, branded UI element onto third-party pages** — even only ones
  peerd opened — is a *visible* expansion of that surface and a foreseeable
  reviewer question ("why does this extension draw its own widget on
  arbitrary sites?"). It also nudges peerd toward looking like the
  content-script-injecting extensions Web Store review scrutinizes. The
  `scripting` justification text would need to be widened to disclose
  UI injection, and the privacy posture ("injection only in service of an
  active task") gets fuzzier (the button persists after the task turn).
- **Mitigation if shipped:** scope injection to peerd-opened, origin-pinned,
  non-denylisted tabs (§3.1); make it dismissible and session-respecting
  (§5); and ship it **preview-channel first** so it isn't part of the initial
  store submission's surface — mirroring how `debugger`/dweb are held back
  (`gen-manifest.ts` `STORE_STRIPPED_PERMISSIONS`, the dweb prune). The
  feature would ride a `CHANNEL_DEFAULTS` flag, off on store until the
  listing copy is updated.

---

## 5. UX

- **Persistence across navigations:** the button should survive same-origin
  SPA/full navigations (§3.2) but **disappear when the user leaves the
  pinned origin** (§3.1) — at that point it's their tab, not peerd's.
- **Overlap with the page's own fixed UI:** unlike the engine tabs (peerd
  owns the whole page), a third-party page has its own
  bottom-right/floating chrome (chat widgets, cookie banners, "back to top").
  A fixed chip at `right/bottom: 14px` *will* collide on some sites. Keep it
  small, faint (the existing `opacity: 0.55`), and **dismissible**; consider
  a less-contended anchor or letting the user nudge it. It must never cover
  the page's primary actions.
- **Dismissibility (new requirement vs. engine tabs):** on a third-party page
  the chip is an uninvited guest, so it needs an explicit dismiss (× on
  hover) that **persists** — at least for the session, ideally per-origin in
  `chrome.storage` — so peerd doesn't re-graffiti a page the user waved off.
  The engine-tab button has no dismiss because peerd owns that surface; here
  it's mandatory.
- **Auto-hide when the panel is already open:** the injected world can't see
  panel state, and adding an inbound "is the panel open?" query would *widen*
  the content-script-reachable surface — avoid it. Instead, push state
  **outbound** (SW → content) via `browser.tabs.sendMessage(tabId,
  {type:'panel-state', open})` whenever the SW opens/closes the panel; the
  button hides/shows on receipt. SW→content messaging is always allowed and
  one-directional, so it adds **zero** inbound attack surface. Cheapest
  acceptable fallback: don't auto-hide at all — clicking when the panel is
  already open is a harmless `open()` no-op, and the chip is faint. (The
  engine-tab button doesn't auto-hide either.)
- **Accessibility:** carry over PR #56's pattern — real `<button>`,
  descriptive `aria-label` (the wordmark stays `aria-hidden`),
  `:focus-visible`, `prefers-reduced-motion`. Inside a shadow root, ensure the
  button is reachable in tab order (it is, for an open shadow root) and that
  its contrast holds on unknown page backgrounds (the chip's own translucent
  dark background handles this; verify against light pages).

---

## 6. Alternatives that avoid the boundary entirely (recommended)

These solve the same underlying need without a content-script-reachable
route and **without** the Chrome-only asymmetry:

1. **Keyboard command (best).** Add a `commands` manifest key with a
   suggested shortcut. On Chrome, `chrome.commands.onCommand` fires **in the
   SW with a valid user gesture**, so the handler can call `sidePanel.open`
   directly — no page, no relay, no hole. On Firefox, the built-in
   `_execute_sidebar_action` command opens the sidebar natively, and a custom
   keyboard command is itself a *valid user action*. Net: cross-browser,
   no new permission (just a manifest key), no boundary change, works from
   *any* tab (peerd-opened or not), discoverable via the shortcut and the
   commands page. The only downside is discoverability for users who don't
   read shortcuts — addressable with a one-line hint on the "go there" card.
2. **Action-button behavior.** The toolbar icon is a first-party gesture that
   can open the panel directly on both browsers
   (`sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` /
   Firefox sidebar toggle). peerd currently uses the action click to open
   **home** (DECISIONS #-, `service-worker.js` action.onClicked). A modifier
   or a secondary affordance could route to the panel. Lower-effort but
   muddies the "icon opens home" model.
3. **Status quo + nudge.** The "go there" card already opens the panel when
   clicked from home/side-panel. If the real gap is "I navigated to a
   peerd tab directly," the keyboard command covers it; the injected button
   is the heaviest possible answer to the lightest gap.

---

## 7. Recommendation & decision record

**Recommendation: do not ship the injected in-page button by default; ship a
`commands` keyboard shortcut instead (option 6.1).** Treat the injected
button as a **conditional, Chrome-only, preview-channel** experiment that is
only justified if user feedback shows on-page discoverability is a real need
the shortcut doesn't meet — and then only with the §2.3 isolation contract,
§3 injection discipline, and §5 dismissibility.

Rationale, one line: the injected button buys a small, Chrome-only UX
convenience at the cost of peerd's cleanest security invariant and a wider
store/privacy surface, while a keyboard command buys the same convenience
cross-browser with neither cost.

### The precise boundary change (only if the button is pursued)

> Add exactly one content-script-reachable `onMessage` listener that accepts
> a sender **iff** `sender.tab.id ∈ peerdOpenedTabs` and `sender.frameId === 0`,
> does nothing but `sidePanel.open({ windowId: sender.tab.windowId })`
> synchronously, and is **never** wired into `makeDispatcher`. This is the
> single, documented exception to the "no content-script-reachable SW routes"
> invariant; `makeDispatcher` itself stays fail-closed and unchanged.

### Where this gets documented

- **`docs/DECISIONS.md` → new "#26. The side panel can be pulled in from a
  peerd-opened web page (or: it can't)."** Record the choice (shortcut vs.
  injected button), the Chrome/Firefox asymmetry from §1, and — if the button
  ships — the boundary exception verbatim, so it isn't silently re-litigated.
  The decisions log currently ends at #25.
- **`DESIGN.md`** — extend the messaging/sender-trust section (the
  fail-closed dispatch surface) to name the one sanctioned exception and the
  reason it's safe (inert, single-purpose, origin-gated). Cross-reference
  DESIGN §8.5 only insofar as engine tabs vs. web tabs differ in *who owns
  the page* (extension origin vs. third-party), which is the root of the
  whole asymmetry.
- **`extension/shared/sender-trust.js`** — its doc comment currently asserts
  "a future surface fails CLOSED here." If the exception ships, add a pointer:
  the panel-pull listener is the deliberate, audited carve-out and explains
  why it does *not* go through `isFirstPartySender`.
- **`docs/store/PERMISSION-JUSTIFICATIONS.md`** — widen the `scripting`
  justification to disclose injected UI, and note the preview-channel gating
  if the button is held out of the initial store submission.
- **`extension/shared/pull-in-peerd.js`** — its header already forward-refs
  "the security/UX writeup"; point it at this document.

---

## Sources

- [chrome.sidePanel | Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) — `open()` user-gesture requirement; triggerable from content-script interaction.
- [chromium issue 355266358 — sidePanel.open() failing with user-gesture error when invoked from a message with user gesture](https://issues.chromium.org/issues/355266358)
- [chrome-extensions-samples #1001 — sidepanel does not open even though triggered by a user gesture](https://github.com/GoogleChrome/chrome-extensions-samples/issues/1001) — async/callback before `open()` voids the gesture.
- [chromium-extensions thread — "Something strange about sidepanel.open() in response to a user gesture"](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/LpzS-uV__6I) — "restricted user gesture" semantics for extension messaging.
- [Antony-Q/example-side-panel](https://github.com/Antony-Q/example-side-panel) — working content-script-button → SW → `sidePanel.open({ tabId })` reference.
- [MDN — sidebarAction.open()](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/open) and [MDN — User actions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/User_actions) — Firefox: a background message handler is **not** a user-action context; valid actions are browser/page action, context menu, keyboard shortcut; awaiting a promise drops the status.
