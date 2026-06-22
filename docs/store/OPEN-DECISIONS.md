# Store submission — open decisions (blockers on purpose)

Everything mechanical is done (manifest, icons, package script, privacy
policy, justifications, reviewer notes). These four are judgment calls
that change review risk materially; decide them before submitting.

---

## STATUS — decisions taken (2026-06-11)

- **#1 `debugger` → resolved: option C ADOPTED (2026-06-13).** The
  initial store Chrome package ships WITHOUT `debugger`: the
  chrome.scripting / DOM-walk path is its default automation surface
  (same posture as Firefox), so initial Chrome Web Store approval isn't
  gated on the highest-risk permission. CDP stays the default in the
  preview/dev channels (where `debugger` ships, required at install) and
  is re-added to a store UPDATE after the first approval — a one-line
  flip (`STORE_STRIPPED_PERMISSIONS` in `packaging/gen-manifest.ts`). This
  SUPERSEDES the earlier "option B, optional_permissions" note (option B
  is impossible — Chrome forbids `debugger` as optional; see §1) and the
  interim option-A "ship required + in-app switch" posture. History kept
  below for the record.
- **#2 comment honesty pass → DONE** (commit `c398703`): "bypass CSP /
  bypass detection / banking" framing replaced with accurate
  Trusted-Types / trusted-input wording across debugger-pool.js,
  page-exec.js, type.js, click.js, CLAUDE.md.
- **#3 skills remote install → resolved: option B, IMPLEMENTED.**
  `REMOTE_SKILL_INSTALL = false` in `extension/shared/flags.js`; SW
  refuses git/manifest install, UI hides the URL tabs, local paste
  stays. Commit `b9539ab`.
- **#4 single-purpose framing → NOTED, owner-directed.** Listing copy
  already uses the one-assistant framing. The "peer daemon" P2P story is
  intentional roadmap, not in this package — owner is building on the
  distribution shim toward release; keep it out of the dashboard copy
  until it ships.

The original analysis for each is preserved below.

---

## 1. `debugger`: keep, gate, or drop for V1  — RESOLVED (B impossible → A interim → C ADOPTED: store scripting-first, CDP in preview/dev)

**Correction (2026-06-12).** Option B is IMPOSSIBLE in Chrome: the
`debugger` permission cannot be listed under `optional_permissions` —
Chrome warns "Permission 'debugger' cannot be listed as optional. This
permission will be omitted." and strips it, which silently killed the
whole CDP path (snapshot refs, page_exec, runner pre-seeding) on every
install. Implemented outcome: `debugger` is a REQUIRED install-time
permission (option A's posture) and the user-facing control became the
`advancedAutomationEnabled` SETTING (default on; Settings → Advanced;
the SW only wires the CDP pool into tool contexts while it's on). The
submission defense is option A's: denylist default-ON + audit log +
Chrome's banner, plus the in-product off switch. The original analysis
below is preserved for the record.

**ADOPTED as the initial-submission plan (owner directive,
2026-06-13).** Option C is no longer a contingency — it's how the store
build ships from the first submission. It's a manifest knob, not a
rewrite:

- The DOM-walk pseudo-snapshot is the UNIVERSAL no-CDP fallback, keyed
  on **CDP-pool availability, never browser detection**. Same path
  serves all three triggers: Firefox (no API), Chrome with
  `advancedAutomationEnabled` off (user choice), and the store package
  with the permission stripped. Code tolerates `chrome.debugger` being
  *absent*, not just the setting being off — different failure modes,
  both handled (`debuggerApiAvailable()` gates on the namespace).
- The build strips `debugger` per-channel for Firefox AND, now, for the
  store channel — `STORE_STRIPPED_PERMISSIONS` in `packaging/gen-manifest.ts`
  (asserted by `tests/store/store-posture.test.ts` and
  `packaging/verify-store-artifact.ts`). Re-adding CDP to a store update
  post-approval = delete `'debugger'` from that one list.
- Capabilities that honestly die with the permission in store/chrome —
  `page_exec` on Trusted-Types pages, `page_keys` (trusted/`isTrusted`
  input) — stay available in the preview channel, exactly like the
  Firefox posture. `read_state` does NOT die: it gained a
  chrome.scripting `world:'MAIN'` selector fallback
  (`peerd-runtime/dom/framework-state.js`), so framework introspection
  works without CDP given a CSS selector.
- Cost: hardened/bot-protected SPAs degrade in the store package;
  ordinary sites keep working through `read_page` + selector tools +
  the pseudo-snapshot (runner pre-seeding included), and the runner is
  told its channel up front so it doesn't reach for CDP-only tools.

The single highest-risk item. Options, in increasing concession order:

**A. Keep, defend (current state).**
Submit with the justification in PERMISSION-JUSTIFICATIONS.md, lean on
default-ON denylist + audit log + Chrome's banner. Risk: reviewers
treat `debugger` as reserved for dev-tools extensions; expect at least
one rejection round and a human re-review. Strongest version of the
defense requires the demo video to *show* the banner and the denylist
refusing a bank.

**B. Make it an optional permission.**
Move `debugger` to `optional_permissions`; `page_exec` requests it on
first use with an explainer ("this site blocks normal automation —
grant advanced automation?"). Core install reviews as a normal-risk
extension; the heavy permission becomes opt-in. Cost: one extra prompt
the first time a user hits Gmail/Notion; some review friction remains
but materially less. ~Half a day of work (request flow + degraded
fallback when denied).

**C. Drop for V1.0, ship as V1.0.1.**
Remove `debugger` + `page_exec`; `page_eval` still covers non-hardened
sites. Fastest possible approval, weakest product (fails on Gmail,
Notion, Slack). Re-adding later triggers a new review with a
permission-increase warning to existing users — you pay the review cost
eventually anyway.

### Note: the grant is global, not per-origin (deferred enhancement)

Worth knowing how the capability actually scopes: `debugger` is an
**API** permission, which Chrome treats as all-or-nothing — it cannot
be origin-scoped (only *host* permissions can carry `origins`). peerd
holds it browser-wide from install, bounded by the `<all_urls>` host
permission + the default-ON denylist + the advancedAutomationEnabled
setting.

What IS per-page is the **attachment**: the pool attaches `chrome.debugger`
to a tab lazily, only when a CDP tool runs on it (`debugger-pool.js`
`attach(tabId)`), so the "DevTools is debugging this tab" banner and the
actual debugging only ever touch the specific tab being driven. Idle tabs
are never attached. So the *behavior* is effectively page-scoped even
though the *grant* is global.

**Deferred — do NOT build unless a store reviewer challenges the global
grant:** a true per-origin gate (an app-level allowlist of origins where
CDP automation is permitted, checked in the pool before `attach()`, with
a per-site "allow advanced automation here?" prompt). Chrome doesn't give
this for free; it's a policy layer on top. The natural hook is the top of
`debugger-pool.js` `attach(tabId)`. Holding off — the global-grant +
lazy-per-tab-attach + denylist posture is defensible as-is, and the
prompt is already cited in PERMISSION-JUSTIFICATIONS / REVIEWER-NOTES.

Recommendation: **B**. It converts "why does an AI chat extension need
the most dangerous permission" into "the user explicitly grants an
advanced capability," which is the framing reviewers accept.

## 2. Comment honesty pass (do alongside whichever #1 you pick)

Not hiding anything — replacing adversarial framing with accurate
framing. The shipped files a reviewer will open:

- `background/debugger-pool.js:21` — "bypass page CSP including
  Trusted Types". Proposed: "Trusted-Types pages reject injected
  script elements, so agent automation runs via CDP's sanctioned
  `allowUnsafeEvalBlockedByCSP` evaluation path instead. Page CSP
  governs page-injected script; CDP evaluation is the
  user-privileged channel for user-directed automation."
- `peerd-runtime/tools/defs/page-exec.js:19-20` — "Mature peerd use
  will run in inactive/offscreen tabs where the banner is invisible
  anyway" reads as *wanting the debugger banner hidden from the user*.
  This sentence is worse than the bypass language. Delete it, or
  replace with: "The banner is a feature: it's the user-visible signal
  that automation is active."
- `CLAUDE.md` "What's shipped" — drop the word "banking" from the
  Trusted-Types example list (it's an orientation doc, not shipped,
  but reviewers can and do read public repos).

## 3. Skills remote install: ship, gate, or hide for V1

Reality check: skills are NOT a stub (CLAUDE.md is stale). Full
implementation: parse/store/registry/install + a sidepanel management
UI with local-paste, git-URL, and manifest-URL install paths.

**A. Ship as-is** with the RHC defense already drafted in
REVIEWER-NOTES.md §4 (markdown instructions ≠ code; user-initiated;
egress-gated; audited). Defensible, but it's the textbook RHC probe and
invites a slow review.

**B. V1 = local paste only.** Hide the git/manifest tabs in
`sidepanel/components/skills-view.js` behind a flag; keep install.js
shipped but unreachable from UI. Small change, kills the sharpest RHC
question, feature returns in V1.x with its own review. Reviewer notes
then truthfully say "skills are user-pasted text".

**C. Exclude skills entirely from the package.** Requires cutting the
re-exports in `peerd-runtime/index.js` + the sidepanel view + SW
handlers. Most invasive, least review risk. Probably overkill given B
exists.

Recommendation: **B**.

## 4. Single-purpose listing framing

LISTING.md is already written to the safe framing: one assistant,
capabilities not modules. Decide whether marketing copy elsewhere
(peerd.ai, README) stays "five modules / harness / sovereign" — that's
fine for the site, but never paste it into the dashboard. The one
remaining naming risk: the store name "peerd" + site tagline "peer
daemon" suggests P2P networking, which V1 does not ship
(peerd-distributed is excluded from the package). If a reviewer asks
"where's the peer part," the answer is "future roadmap, not in this
package."

---

## Already decided (for the record)

- CSP `connect-src` keeps `https:`: the agent fetches user-chosen pages
  from the SW (extension_pages CSP governs the SW), and the voice-model
  download follows HF's redirect to rotating CDN hosts — a fixed host
  list would break both. Blanket `wss:` and `http://localhost:11434`
  removed; only `wss://disks.webvm.io` remains.
- `tests/runner.html` WAR exposure removed; dev loop unaffected (direct
  chrome-extension:// navigation doesn't need WAR).
- `peerd-distributed/`, `tests/`, `eval/`, in-tree dev notes excluded
  from the uploaded package by the store channel of `packaging/package.ts`
  (verified by `bun run verify:store`; the older `scripts/package.sh`
  was superseded by the dual-channel build and removed).
