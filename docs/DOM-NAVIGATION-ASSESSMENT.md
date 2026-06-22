# DOM navigation — assessment + overhaul plan

> Grounded assessment of peerd's CURRENT DOM layer against the mid-2026
> SOTA research brief (subagent 11). Read the brief first; this doc says
> where peerd actually is, what's already good, the real gap, and a
> phased, verification-aware plan to close it.

---

## TL;DR (the verdict)

peerd's DOM layer splits cleanly in two:

- **Defense — already SOTA-aligned and ~80% built.** The brief's §6
  (lethal-trifecta defense) is mostly done: a **default-deny egress
  allowlist** on the credentialed provider path (`safeFetch`; the open-web
  tools use the allowlist-free `webFetch` — SSRF block + denylist + audit,
  but arbitrary-public-host exfil is not fully closed there),
  **consistent `<untrusted_web_content>` tagging on every DOM-derived
  string** (read_page, query_dom, page_eval/exec, page_keys, @tab), and
  a **sensitive-site denylist** that gates both tool origin and @tab
  inlining. This is the defensible pitch the brief calls "peerd's win
  condition," and it's real today, not aspirational.

- **Observation + action — the older paradigm.** Raw-DOM walk + **CSS
  selectors**, no accessibility tree, no element refs, no content
  script / MutationObserver, no diffing, no framework-state reads, no
  multi-tab pool, no visual/SoM. This is the half that's behind
  browser-use / Nanobrowser / Playwright-MCP and is the actual overhaul.

**The single biggest gap:** observation is **raw-DOM + CSS-selector**,
SOTA is **a11y-tree + opaque element refs**. Everything else (diffing,
multi-tab, framework reads, visual fallback) is secondary to that one
paradigm shift.

**The good news:** the overhaul is narrower than the brief frames it,
and the highest-leverage piece (a11y tree) **reuses infrastructure that
already exists** — the `chrome.debugger` CDP pool. We are not greenfield.

**The hard constraint:** this layer's correctness is defined by behavior
on real, hostile, logged-in sites (Gmail, Linear, Stripe). That cannot
be verified headlessly or in this harness. Whatever we build, the bar is
a real-browser test loop the human runs. Plan accordingly.

---

## 1. What peerd has today (grounded)

| Capability | Today | Paradigm |
|---|---|---|
| Observation | `read_page`: raw DOM walk → `[TEXT]` (4 000-char cap) + `[INTERACTABLES]` (100-cap), each tagged with a **CSS selector** | raw-DOM |
| Targeting | CSS selectors (`#id` → `[data-testid]` → `[name]` → `[aria-label]` → `:nth-of-type`) | selector |
| Probing | `query_dom(selector)` → matches w/ role, label, **bbox**, selector | selector |
| Click/type | CSS selector, **synthetic** events (isTrusted=false), ISOLATED world | synthetic |
| Real keys | `page_keys` → **CDP** `Input.dispatchKeyEvent` (isTrusted=true) | CDP ✓ |
| Page code | `page_eval` (MAIN world) / `page_exec` (**CDP**, Trusted-Types bypass) | MAIN/CDP ✓ |
| Screenshot | `capture` → user only; **model never sees pixels**; no SoM | — |
| Multi-tab | one active tab + `@tab` one-shot inline; no pool | single |
| Diffing | none — re-walks whole DOM each call | none |
| Framework state | none | none |
| SPA routes | `tabs.onUpdated` polling; no `webNavigation` | polling |

**Defense (already strong):**
- Egress = **default-deny allowlist** (`safe-fetch.js`); agent `fetch`
  reaches only provider endpoints + user-added ones. (Caveat: `page_eval`
  runs in MAIN world and uses the *page's* fetch — intentional, gated by
  the origin/denylist check before the tool runs, but worth a conscious
  decision in the new design.)
- **Untrusted tagging is consistent** across every DOM tool via one
  `wrapUntrusted()` (`prompt-wrap.js`).
- **Denylist** gates tool origin + @tab inlining (banks/health/password
  managers seeded).
- Manifest already declares `debugger`, `scripting`, `tabs`,
  `activeTab`, `<all_urls>`. **Missing: `webNavigation`.**

**What's empty / net-new:** `extension/content/` is **empty** — there is
no content script, no MutationObserver, no DOM mirror. That's the
foundation the brief's best ideas (diffable snapshots, action-result
attribution) require, and it doesn't exist yet.

---

## 2. Where peerd is vs the brief, point by point

| Brief technique (§1, §7) | peerd today | Gap size |
|---|---|---|
| A11y tree as primary observation | ❌ raw DOM | **large — the core gap** |
| Visual fallback / Set-of-Marks | ❌ (model gets no pixels) | large |
| Hybrid grounding (a11y + vision) | ❌ | large |
| Element refs (`@e1`) over selectors | ❌ CSS selectors | **large** |
| Diffable snapshots | ❌ full re-fetch | medium |
| MutationObserver streaming | ❌ no content script | medium |
| Action-result attribution | ❌ | medium |
| Framework-state reads (MAIN world) | ⚠️ possible via page_eval, no builtin | small-medium |
| Multi-tab attention pool | ❌ single + @tab | medium |
| webNavigation SPA routes | ❌ polling | small |
| **Egress allowlist (trifecta)** | ✅ **default-deny** | **done** |
| **Untrusted DOM tagging** | ✅ **consistent** | **done** |
| **Sensitive-site denylist** | ✅ origin + @tab gated | mostly done |
| Real CDP keyboard | ✅ `page_keys` | done |
| Trusted-Types bypass | ✅ `page_exec` | done |
| Real logged-in session (the moat) | ✅ structurally | done |

Read that bottom block as the head start: the structural moat (§3) and
the security pitch (§6) are **already shipped**. The overhaul is the top
block — observation + action.

---

## 3. The overhaul, phased (verification-aware)

Principle: **additive, not rip-and-replace.** The selector tools work
and are the natural fallback when a11y is degraded (the CHI 2026 paper:
half the web). Add the a11y-tree-ref path *alongside* them; let the
agent prefer refs and fall back to selectors. Each phase ships
independently and is testable on its own.

### Phase 1 — a11y tree + element refs (the keystone)
The 80/20. Reuses the existing CDP pool.
- New observation via CDP `Accessibility.getFullAXTree` → serialize the
  semantic subset (role/name/state/value) → assign **opaque refs `@e<n>`**
  in a harness-owned registry mapping ref → `backendNodeId`.
- New tool (e.g. `read_page` gains an `axtree:true` mode, or a sibling
  `snapshot`) returning the ref-annotated tree, still inside
  `<untrusted_web_content>`.
- Ref → action: `click(@e1)` resolves ref → backendNodeId → CDP
  `DOM.resolveNode` + dispatch. No model-authored selectors.
- **Reuses:** `debugger-pool.js`, the untrusted wrapper, the gate
  pipeline. **Net-new:** AX serialization, the ref registry.
- **Cost:** the debugger banner now shows for *observation*, not just
  page_exec. Conscious tradeoff — surface it honestly in UI.
- **Test bar (human):** Gmail compose reads under ~10K tokens; pick a
  ref, click, observe.

### Phase 2 — content script + diffable snapshots
- First content script in `extension/content/`: maintains an a11y/DOM
  mirror + **MutationObserver**, streams compact deltas
  (`+button @e47 "Send"`, `~textbox @e12 value="…"`) to the SW.
- Re-baseline on navigation. Agent context grows with *actions*, not
  page size.
- **Action-result attribution:** capture the mutation window for
  ~500ms after a click and return it as the action's result.
- **MV3 reality:** content script dies on reload; SW holds the registry;
  re-baseline on attach. State shuttles through the SW, not SW memory
  alone (30s timeout).

### Phase 3 — multi-tab pool + SPA routes + framework reads
- Tab pool (default 5): one focused (full obs), others summary
  (URL/title/last-mutation). This is where the `@tab` primitive (the
  brief's subagent 04) becomes first-class.
- Add `webNavigation` permission + `onCommitted`/`onHistoryStateUpdated`
  for real SPA route detection.
- Opportunistic `readComponentState(@e<n>)` via MAIN-world injection when
  React/Vue/Svelte markers are sniffed at attach.

### Phase 4 — visual fallback (Set-of-Marks)
Deliberately last — it's 10–50× the tokens and needs a model-vision
path peerd doesn't have yet.
- `captureVisibleTab` → composite SoM boxes (bboxes come free from the AX
  nodes) in a canvas → send as an actual **image block** to the model.
- Requires: the provider path to send vision blocks (today `capture`
  strips pixels by design — this is a real change), and an opt-in
  "visual mode" per tab. Used only when a11y is degraded (canvas/p5.js).

---

## 4. Constraints I can't wave away

1. **I cannot verify DOM behavior.** No browser in this harness; can't
   run WebVoyager, can't drive Gmail/Linear. The brief's success
   criteria are all real-browser. So my deliverable ceiling is:
   **design + scaffolded, inspectable code + unit-testable pure pieces
   (AX serialization, ref registry, diff algorithm); the human runs the
   real-site loop.** Anything I claim "works" on a live site is unverified
   by construction — I'll mark it so, every time.
2. **No build step.** Content scripts are plain JS, no bundler.
3. **MV3 SW 30s timeout.** Long-lived observation lives in the content
   script / offscreen; durable state in `chrome.storage` + the SW
   registry, not SW memory.
4. **Debugger banner.** A11y-via-CDP shows the yellow banner during
   *observation*, not just page_exec. Either accept it broadly, or build
   a content-script a11y walk (less faithful than `getFullAXTree`) to
   avoid attaching for read-only observation. **A real decision.**
5. **Scope.** This is the brief's biggest single subagent. It is weeks,
   not a turn. Phase 1 alone is a meaty, multi-session piece.

---

## 5. Decisions for you (before code)

1. **Additive vs replace.** Recommend additive: a11y-ref path next to the
   selector tools, agent prefers refs, falls back to selectors on
   degraded a11y. (The brief says "refs only"; the CHI paper says half
   the web has broken a11y — keeping the selector fallback is the
   pragmatic hedge.)
2. **Banner posture.** A11y via CDP `getFullAXTree` (faithful, banner) vs
   a content-script a11y approximation (no banner, less faithful, more
   code). Recommend CDP for fidelity, banner surfaced honestly — but
   it's your call on the UX cost.
3. **Execution model.** Three options:
   a. **I design + scaffold, you test.** I write the real DESIGN.md
      (subagent 11's deliverable) + a Phase-1 prototype (AX serialization,
      ref registry, ref-based click) with the pure parts unit-tested; you
      run it on real sites and we iterate on your reports. ← my recommend.
   b. **Dedicated subagent-11 worktree effort**, like the original 10 —
      bigger, more autonomous, same can't-verify ceiling.
   c. **Design-only now** — I write DESIGN.md + DEV-NOTES skeleton, no
      code yet, you greenlight a phase.
4. **`page_eval` MAIN-world fetch** stays bypassing egress (intentional —
   it inherits the user's session) or gets a conscious new rule? Recommend
   keep, document it loudly as a known trifecta seam.

---

## 6. Bottom line

The brief is right that this layer decides whether peerd's strategy is
real. The grounded news is better than the brief assumes: **the hard,
defensible half (the trifecta defense + the real-session moat) is already
built and SOTA-aligned.** The overhaul is the observation/action half,
and its keystone — a11y tree + element refs — is an *additive* change
that reuses the CDP pool peerd already ships. Phase 1 is the 80/20 and
the right place to start. The binding constraint isn't architecture; it's
that correctness lives on real hostile sites, so the plan is built around
a human-run test loop, not headless claims.
