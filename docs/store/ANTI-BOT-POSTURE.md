# Anti-bot detection posture — options spec (to be decided)

> Status: **OPEN — for decision.** This is a decision spec, not a shipped
> plan. It lays out how peerd should behave toward site anti-automation
> systems, with each option carrying a recommendation and a `DECISION:`
> line to fill in. Companion to `OPEN-DECISIONS.md` (§5 points here).

## Why this exists

A field report: when the web actor drove a professional-network site
faster than a human hand could, the site threw a velocity/CAPTCHA
challenge and temporarily walled the browser session — reverification did
not clear it quickly. We shipped a first mitigation (human-cadence action
pacing; see Option 0). This spec decides what, if anything, we do beyond
that — and, just as importantly, what we deliberately will **not** do.

The findings below come from a multi-source research pass; each claim was
independently fact-checked (majority-vote adversarial verification) before
landing here. Sources are listed at the end. This is a **fast-moving
domain** — specific detection percentages are 2023-2024 snapshots, one
well-known CDP-detection trap reportedly broke with a mid-2025 V8 change,
and AI-agent-targeted detection only shipped in 2025 — so treat exact
mechanics as a dated snapshot, not a constant.

---

## The one insight that reframes everything

peerd is not a headless bot. It drives the **user's own real, logged-in
browser** (BYOK, no backend, no proxies, user-initiated tasks). That means
most of what modern anti-bot stacks look for is **naturally clean for us**:

- **Browser/OS fingerprint** (canvas, WebGL, fonts, screen, TLS/JA3): a real
  consumer browser, internally consistent. Spoofed bots get caught precisely
  because their fingerprints are *inconsistent* — commercial "undetectable"
  bot traffic still evaded DataDome only ~52.9% and BotD ~44.6% of the time,
  i.e. roughly **half is caught anyway** [1]. Our consistency is an asset to
  *preserve*, not a problem to solve.
- **IP reputation**: the user's own residential IP, not a datacenter or proxy
  range. Clean by construction [5].
- **Session / cookies**: the user's real authenticated session. Nothing to fake.

So the two surfaces where peerd **is** exposed are narrow and specific:

1. **The automation-instrumentation footprint** — the CDP (`chrome.debugger`)
   channel on the **preview/dev build only**. CDP is the protocol under
   Puppeteer/Playwright/Selenium, so "is this browser CDP-instrumented?" is a
   generic, framework-independent automation tell, classically keyed on the
   `Runtime.enable` command [2]. The **store build already avoids this** — it
   is scripting-first, no CDP (per `OPEN-DECISIONS.md` §1). (Trade-off, not a
   free win: the store path dispatches synthetic DOM events with
   `isTrusted=false`, which is *also* a detectable signal and which some sites,
   including the trigger site, ignore for clicks — see Open Question A.)
2. **Behavioral cadence** — velocity and the rhythm of clicks/keystrokes/
   scrolls. This is the durable detection layer that fires **after** fingerprint
   and network checks pass, and it is exactly what tripped the trigger block.
   ML mouse/keystroke-dynamics classifiers reach ~96% against naive bots, and
   **even randomized delays leave statistical patterns** models pick up [8].
   Vendors now ship intent-based models that explicitly bucket "human-like but
   machine-driven" AI-agent traffic [8].

**Corollary:** our fixes should target (1) and (2) and **must not** disturb
our natural fingerprint/IP cleanliness. And pacing alone is harm-reduction,
never a guarantee.

---

## The reframe you can't engineer around: detection ≠ permission

Two orthogonal problems hide inside "avoid bot checks":

- **(A) Detection** — *can* we act without being flagged? Technical.
- **(B) Permission** — are we *allowed* to automate this site at all? Contractual/legal/policy.

For the trigger site specifically, (B) is dispositive and no amount of (A)
fixes it:

- Its User Agreement **categorically prohibits any browser extension/script/bot
  that scrapes, modifies, or automates activity** on the site — naming the exact
  actions an agent performs (add contacts, send messages, create/comment/like/
  share) — **with no carve-out for user-initiated automation or human-like
  cadence**. "Unauthorized" means unauthorized *by the site*, not by the user [11].
- These ToS provisions are **legally enforceable as breach of contract**, and
  the **logged-in account holder is the bound party** — the "it's my own account"
  framing gives *no* safe harbor (LinkedIn v. hiQ enforced UA anti-automation
  terms; Meta v. Bright Data read the terms as governing the account holder's
  "use") [19][20]. Enforcement is real and tightening (account restriction/
  suspension; 2026 extension ban waves) [11].
- **Chrome Web Store policy** independently forbids extensions that "facilitate
  unauthorized access... circumventing login restrictions," so shipping active
  evasion as a *feature* is a store-review risk on top of the ToS risk [16].

**Therefore:** better evasion does not make us compliant on a ToS-hostile site;
it just delays a ban and raises our own risk. "Which sites do we automate at
all, and how do we degrade when a site says no" is a **policy/consent decision**
(Options 2 and 6), not a detection-evasion problem.

---

## Proposed decisions (fill in the `DECISION:` lines)

| # | Option | Effective? | Durable? | Store-safe / ToS-safe? | Recommendation |
|---|--------|-----------|----------|------------------------|----------------|
| 0 | Human-cadence pacing (shipped/prototyped) | Partial | No (harm-reduction) | Yes | Keep; treat as floor, not fix |
| 1 | Challenge hand-back to user | High | Yes | Yes | **Build next** |
| 2 | Co-pilot / assist-only on guarded sites | High | Yes | Yes (sidesteps ToS) | **Adopt for hostile sites** |
| 3 | Minimize CDP footprint (trusted Input, no `Runtime.enable`) | Medium-High | Yes-ish | Yes | **Build** (preview build) |
| 4 | Richer human-like input dynamics | Low-Medium | No (arms race) | Yes | Incremental only |
| 5 | Prefer official APIs over DOM driving | High | Yes | Yes (sanctioned) | **Adopt as first choice** |
| 6 | Site-posture tiers / graceful "no" | High | Yes | Yes | **Adopt as policy** |
| 7 | Declared legitimate-agent trust lane (Web Bot Auth) | Unknown | Potentially | Yes (opt-in) | Track, don't build yet |
| — | Fingerprint/webdriver spoofing, proxies, CAPTCHA-solvers | ~50% caught | No | **No** — reject | **Do not pursue** |

---

## The options

### Option 0 — Human-cadence action pacing *(baseline; already prototyped)*

Jittered minimum interval between consecutive same-site interactions
(click/type/navigate/page_keys), first-action-free, reads never paced.
Implemented as a default pre-tool-use hook behind a `webActionPacingEnabled`
setting.

- **Effect:** Directly addresses the velocity signal that caused the trigger
  block. Jitter over a fixed delay matters — uniform timing is itself a tell [15].
- **Limit:** Behavioral classifiers still detect statistical regularity in
  jittered timing [8]. This is harm-reduction, **not** a durable defense.
- **DECISION:** Keep as the floor / default posture? (Recommended: yes.)

### Option 1 — Challenge hand-back to the user *(highest leverage)*

Detect a visible challenge (CAPTCHA / verification / velocity wall — DOM/URL
signatures for the major vendors), **pause** the actor, surface it in the side
panel, let the user solve it in their own session with one tap, then **resume**.

- **Why it wins:** A human-solved challenge passes 100%. Passive scorers
  (reCAPTCHA v3) return a 0.0-1.0 risk score and never present a puzzle — there
  is *nothing to solve* programmatically; you can only avoid depressing the
  score or hand off the downstream v2/Turnstile puzzle the site invokes [4].
  Turns an hour-long wall into a 5-second interruption.
- **Fit:** We already have the confirm round-trip (`ctx.confirm`) and actor
  pause/resume machinery — this is a detector + resume, not new infrastructure.
- **Open risk:** if passive scoring already depressed the session's trust score
  before any visible challenge, handing back the puzzle may not fully recover it
  (Open Question B).
- **DECISION:** Build? Which vendors' challenge signatures in v1?

### Option 2 — Co-pilot / assist-only on guarded sites

On sites that fight automation, the agent does the reading, planning, and
**drafting**, and hands the *sensitive* action to the user's real click ("found
the 5 people, drafted the messages — press send").

- **Why it wins twice:** (a) The input that trips detection is genuinely the
  user's (`isTrusted`, real cadence). (b) Assisting a human is not "automating
  the site," which is the clean answer to the **ToS** problem — the durable
  resolution for hostile sites, not just the detection one.
- **DECISION:** Adopt for the ToS-hostile tier (Option 6)? Is "assist-only" a
  per-site mode or a global fallback when a challenge/ToS flag is hit?

### Option 3 — Minimize the CDP footprint *(preview build)*

Today the debugger pool calls `Runtime.enable` on attach and clicks via
`Runtime.callFunctionOn` (`this.click()`). The sniffable part is the **Runtime
domain being enabled** [2]; newer anti-detect frameworks specifically avoid it.
The upgrade — **already flagged as a TODO in `clickBackendNode`** ("a real-event
upgrade: `DOM.getBoxModel` + `Input.dispatchMouseEvent` is a follow-up") — is to
click by dispatching a **real trusted mouse event at the element's coordinates**
via the Input domain, *without* enabling Runtime. Detach when idle.

- **Why it's good:** *More* human (a real pointer event, not a JS `.click()`)
  **and** it drops the specific fingerprint the preview build exposes. Genuine
  footprint reduction — **not** spoofing.
- **Scope note:** store build has no CDP at all, so this is a preview/dev
  improvement; it also informs Open Question A (is trusted-input-via-CDP net
  better or worse than synthetic-events-via-scripting?).
- **DECISION:** Build the Input-domain click/type path? Detach-when-idle policy?

### Option 4 — Richer human-like input dynamics

Beyond pacing: mouse-move paths into a target before clicking, per-keystroke
timing variance, short dwell before acting.

- **Reality check:** Incremental harm-reduction on the behavioral layer, but an
  **arms race** — GAN/diffusion-generated human-like input reduces but never
  eliminates detection [8]. Worth a little; not worth a lot.
- **DECISION:** How far, if at all? (Recommended: minimal — keystroke variance
  and pre-click dwell, stop there.)

### Option 5 — Prefer official APIs over driving the DOM

Where a site offers a sanctioned API, route through it (peerd already has the
API-actor / sessionless `fetch_url` origin substrate) instead of puppeteering
the page. Make "is there an API for this?" a step *before* "drive the page."

- **Why it wins:** Sanctioned, never bot-walled, no ToS violation. Strictly the
  best path where it exists.
- **DECISION:** Add an API-first preference to the web actor's planning? Curate
  a small map of sites → official API where known?

### Option 6 — Site-posture tiers / graceful "no"

Extend the existing denylist idea into a posture ladder:
**blocked** (banks/health/password managers — already denied) →
**assist-only** (ToS-hostile sites default to Option 2) →
**automate** (everything else, paced). Respect explicit rate/`robots`/challenge
signals as backoff triggers.

- **Why:** Human-cadence changes *detection* but not the *contractual* violation
  [11][19][20], so the honest control is a policy decision to not fully automate
  ToS-hostile sites.
- **DECISION:** Introduce the assist-only tier? Seed list (professional networks,
  etc.), and is it user-overridable with a risk-acknowledged confirm?

### Option 7 — Declared legitimate-agent trust lane *(track, don't build)*

Emerging standards (e.g. Web Bot Auth / agent trust management, referenced by at
least one major vendor) offer a **declared, cryptographically signed** identity
for legitimate agents — opting *in* rather than evading [8]. An undeclared
extension riding the user's session is exactly the "human-like but
machine-driven" bucket intent-detection targets [8].

- **DECISION:** Watch and revisit? (Recommended: monitor; no build yet — nascent,
  adoption unclear, and it's a different product posture.)

---

## Deliberately NOT pursuing (and why)

All four are documented **arms-race** moves, roughly half-caught today,
re-detected via cross-attribute inconsistency, and they are the documented
**threat-actor** toolkit — adopting any of them invites Chrome Web Store
rejection under the "unauthorized access" policy and legal/ToS exposure, while
chasing defenses our real-session model **already passes cleanly**.

- **Webdriver/CDP fingerprint masking, canvas/WebGL/TLS spoofing.** Catchable and
  *actively suspicious*: spoofed fingerprints leave inconsistencies real devices
  never have (9 of the top-10 highest-evasion "iPhone" resolutions don't exist on
  any real iPhone); baseline evasion is only ~52.9% / ~44.6% [1]. We'd be
  *degrading* our natural consistency — the opposite of the goal.
- **Residential proxy rotation.** We have no backend and no proxies; our real IP
  is already clean [5]. Proxies are the threat-actor pattern and pure store-risk.
- **Third-party CAPTCHA-solving services.** CAPTCHA-solving has eroded CAPTCHA
  effectiveness [10], but wiring a solving service in is the threat-actor pattern,
  a store-policy violation, and pointless when Option 1 (hand the puzzle to the
  human who's *right there*) is free and 100% reliable.

---

## Open questions (carried from the research; decide or spike)

- **A. Trusted-CDP vs synthetic-scripting — which is more detectable?** The store
  build avoids the CDP footprint but dispatches `isTrusted=false` synthetic
  events; the preview build has trusted input but the CDP instrumentation tell.
  Which net-loses more trust? (Bears directly on Option 3 and the store default.)
- **B. Does hand-back recover a depressed score?** Passive scorers (reCAPTCHA v3,
  DataDome) may flag a session *before* any visible challenge. Does solving the
  downstream puzzle restore trust, or is the session already burned? (Bears on
  Option 1's ceiling.)
- **C. Positive allowlist of ToS-safe targets?** Beyond the denylist, is there any
  major site whose Terms *explicitly permit* user-initiated automation of one's
  own account — enabling a "known-safe to automate" list, not only a denylist?
- **D. Web Bot Auth viability** for a user-authorized browser-native agent (Option 7).

## Honesty notes

- Three claims were **checked and did NOT survive** verification, and are
  therefore *not* relied on above: (1) a specific durability stat for
  fingerprint-inconsistency detectors; (2) the exact client-side `Error.stack`
  getter CDP-detection snippet (the classic `Runtime.enable` serialization trap
  reportedly broke with a ~mid-2025 V8 change — the *structural* CDP signal
  stands, the specific probe is in flux); (3) that CAPTCHA-solving services work
  by farming to human solvers. Where a killed claim had a confirmed weaker form
  (e.g. the ~50%-caught baseline), only the confirmed form is used.
- Several detection-capability claims cite **anti-bot vendors** (commercial
  incentive to overstate); the load-bearing cores are corroborated by
  independent/academic sources (arXiv 2406.07647; mouse-biometrics papers) and by
  the bypass-building community itself agreeing CDP underlies the major frameworks.
- Legal claims are **US-jurisdiction** (N.D. Cal.), rest on reputable secondary
  analyses of real rulings, and one (hiQ CFAA) came via a stipulated judgment —
  enforceability generalizes; exact reasoning is case- and jurisdiction-specific.

## Sources

1. FP-Inconsistent measurement study — arXiv 2406.07647 (ACM IMC 2025)
2. DataDome — the CDP signal & headless-Chrome detection
4. Google reCAPTCHA v3 docs (passive scoring)
5. Trend Micro — CAPTCHA-breaking services & residential proxies
8. DataDome — behavioral bot classification; mouse-biometrics literature (arXiv 2208.09061)
10. (as 5) CAPTCHA-solving erosion
11. LinkedIn Help a1340567 / a1341387; User Agreement §8.2 (extension automation ban)
15. Ethical scraping / rate-limiting — jittered vs uniform timing
16. Chrome Web Store program policies (unauthorized-access prohibition)
19. LinkedIn v. hiQ — UA anti-automation enforceable (breach of contract)
20. Meta v. Bright Data — terms govern the logged-in account holder
