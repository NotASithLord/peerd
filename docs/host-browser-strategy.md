# Host browser strategy — headless peerd (AgentOS)

> **Status: DRAFT for ratification.** Companion to the AgentOS feasibility
> assessment (PR #129): that doc asks *whether* peerd can be a headless
> enterprise runner; this one decides *which browser hosts it*. Candidates:
> pinned stock Chromium, Firefox ESR, or our own minimal fork.
> **@NotASithLord's call** — nothing here is decided. The code stays the spec;
> every claim below points at the source that proves it.

## Verdict: pinned stock Chromium, wrapped in a peerd-owned supervisor

Three findings drive it, in order of force:

1. **The WebVM makes Chromium structural, not just incumbent.** The enterprise
   wedge includes WebVM / WASM environments for traditional workloads (owner
   direction, 2026-07-04). CheerpX is x86-on-WASM and needs
   `SharedArrayBuffer`, which extension pages get via the COOP/COEP header
   trick — Chromium honors it, Firefox does not (see the isolation comment in
   `packaging/gen-manifest.ts`: the WebVM is already non-functional on
   Firefox). No wrapper or parity work fixes a platform gap. Once WASM
   throughput is a first-class criterion, engine JIT quality is part of the
   requirement, not a tiebreaker.
2. **The headless boot path already exists on Chromium.** The CDP harness
   (`scripts/cdp/`) launches Chrome for Testing headless with the real
   extension loaded and provisions vault + key + settings zero-click — the
   feasibility doc's "proven, not theoretical" finding. Firefox would need a
   WebDriver-BiDi/Marionette equivalent: plumbing, not architecture, but paid
   before reaching the line Chromium is already past.
3. **The rest of the offscreen surface rides along.** `js_run` headless
   compute (`offscreen/job-runner.js`), PDF extraction, voice, and the dweb
   mesh all live in the offscreen document; Firefox lacks the API entirely
   (`CHROME_ONLY_PERMISSIONS` in `packaging/gen-manifest.ts` — "Firefox
   runtime parity is its own workstream").

## The wrapper is where the "our own fork" ambition belongs

The customization a fork would actually buy lives in a supervisor *around* a
stock pinned browser — a container image that owns:

- the pinned browser binary (hermetic per-version; qualified upgrades on our
  schedule),
- the managed-policy JSON (`storage.managed` — the feasibility doc's Wave 1
  provisioning floor),
- extension load + headless provisioning over the existing RPC surface,
- **cgroup caps on the browser process tree.**

That last point matters strategically: it partially lifts the feasibility
doc's permanent ceiling #2 (no enforceable CPU/RAM caps for extensions). Hard
caps are impossible *inside* the extension, but the headless deployment can
enforce them around the whole browser — one browser per seat/tenant, one
cgroup each. That is also a stronger tenant boundary than in-extension
`profileId` namespacing: isolation at the process tree, not the keyspace.
The wrapper is hundreds of lines we fully control, versus millions we would
rent by forking.

## Why not a fork

The "bare minimum browser" intuition assumes peerd needs a small slice of a
browser. It needs almost all of one: the web actor drives arbitrary real
sites (full web platform), CheerpX needs a top-tier WASM JIT + cross-origin
isolation, the dweb needs WebRTC, the sandboxes need OPFS / workers / opaque
origins, and the whole product rides the MV3 extensions subsystem — one of
the largest, most security-sensitive parts of Chromium. What a "minimal" fork
strips (UI chrome, sync) is not where maintenance cost lives; what it keeps
is. A fork inherits the upstream security cadence as a permanent rebase
treadmill — every serious Chromium fork is a multi-engineer standing
commitment — and inverts the security story: for enterprise buyers, "stock
pinned Chromium with upstream patches" beats "our own browser" every time.
Rejected barring a browser-security team we do not have.

## Why not an embedded engine (the SpiderMonkey question)

peerd never embeds a JS engine; the host browser provides it. The classic
embedder rationale for SpiderMonkey — ESR cadence, engine-level memory knobs,
interpreter portability — answers a question this architecture does not ask,
and its one relevant need (resource control) is met by cgroups in the
wrapper. If an out-of-browser peerd runtime is ever wanted, that is a
*runtime* choice (workerd / Bun / Deno / Node), not an engine embedding — and
a different bet than this one.

## Firefox ESR: a contingent second host, priced — not a rejected one

Discounting CDP is fair for *in-page automation* — the shipped default on
store-Chrome and Firefox alike is the `chrome.scripting` DOM-walk path
(`peerd-runtime/dom/walk-injected.js`), and only two tool behaviors are
genuinely CDP-only (`page_exec` on Trusted-Types pages, `page_keys` trusted
input — see the CDP posture in `CLAUDE.md`). ESR's one-qualified-base-per-year
is a genuine maintainability edge over requalifying Chromium every few weeks.

But the WebVM requirement is structural, so Firefox becomes viable only when
**both** hold: a design partner mandates Firefox, **and** their workload mix
does not need the WebVM. The price list, if triggered:

- an offscreen-document equivalent (Firefox MV3 event pages can host workers
  directly — tractable refactor, M),
- a BiDi/Marionette boot-and-provision harness (S/M),
- no WebVM (permanent, platform-level),
- synthetic-only page input on trusted-input-sensitive sites.

## Decisions for @NotASithLord

1. **Ratify Chromium-first + supervisor wrapper** as the headless host
   strategy (this doc's verdict).
2. **Pin-and-qualify cadence:** upgrades on our schedule means a bounded
   known-vuln window between qualifications. Acceptable? Document alongside
   the feasibility doc's fork #5 (resource-cap honesty) in the trust model.
3. **Firefox trigger condition** as stated above — agree, or drop Firefox
   from the headless story entirely.
4. **Distribution vehicle:** Chrome for Testing is for dev/CI; the shipped
   enterprise image pins a plain Chromium build (BSD, redistributable) or
   defers to customer-MDM-installed Chrome pinned via policy. Pick before the
   first enterprise artifact.

---

_DRAFT — pending ratification. Forward direction only; the code stays the spec._
