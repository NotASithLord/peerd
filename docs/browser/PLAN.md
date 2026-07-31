# peerd Browser — fork implementation plan

> Status: DESIGN — nothing here is built. This doc is the sketch for a
> peerd-branded Chromium distribution with peerd preinstalled. The build
> lives in its own repo (`peerd-browser`, to be created); this doc sits
> here because the extension-side work (a new channel) lands in THIS
> repo, and because this repo is where the plan was drawn up.
> Cost/pricing figures are a snapshot as of 2026-07 — reverify before
> committing spend.

---

## 1. Goal and principles

Ship a browser we can offer to non-technical users and companies:
Chromium, rebranded lightly, with peerd preinstalled and a handful of
policy/permission defaults that benefit it — and **nothing else**.

The principles that keep this maintainable:

- **Near-zero diff.** The fork's value is that it is NOT a fork in any
  meaningful sense: branding assets, an install manifest, a short patch
  series measured in tens of lines. Upstream lag is bounded by build
  automation, not by engineering. Every candidate browser-code change
  must justify itself against this budget; the default answer is no.
- **The extension stays the product.** All agent logic remains in the
  extension, updated on its own cadence through our self-hosted feeds
  (`update-feeds/`). The browser is a shell that installs and hosts it.
  peerd MUST keep working unmodified on stock Chrome and Firefox — the
  browser may *improve* reliability, but the extension never *depends*
  on fork-only behavior.
- **Security posture is conservative.** Every loosened default is
  attack surface on a binary marketed as the secure option. The diff
  stays small, public, and auditable — the size of the diff is itself
  part of the security story.
- **Security-respin SLA.** Chromium ships majors ~every 4 weeks and
  security respins ~weekly. The pipeline must go from upstream stable
  tag to signed, published release unattended (human approves, agent
  does the work), within days of a critical CVE. If the pipeline can't
  do it while the maintainer is on vacation, it isn't done.

## 2. Repo layout

New sibling repo **`peerd-browser`** (this repo stays the extension):

```
peerd-browser/
  patches/           # numbered git patches applied onto the upstream tag
  branding/          # icons, BRANDING file, installer strings, theme resources
  config/            # GN args per platform, initial preferences, policy defaults
  external/          # external-extension install manifest for peerd
  ci/                # workflows: watch, rebuild, sign, publish
  updater/           # Sparkle config (mac), updater config (win), repo defs (linux)
  docs/
```

Chromium source is never committed — each build checks out the pinned
upstream tag (from a snapshot volume, §6). The repo is patches +
assets + automation only, so its size and review surface stay trivial.

## 3. The diff budget — every change we make to the browser

### 3.1 Branding (assets only, no logic)

- `is_chrome_branded=false` stays (we cannot ship Google's branding,
  trademarks, or the "Chrome" name — this is mandatory, not a choice).
- Product name (working name: "peerd Browser" — see Open decisions),
  icons, installer/app names, About page. Chromium centralizes this in
  the `BRANDING` file + theme resource directories; it's an asset
  overlay, not a code patch.
- Brand rule applies (CLAUDE.md): monochrome surfaces, the five-color
  wordmark/orb as the only color carriers.

### 3.2 Preinstall peerd — as a policy-default force-install, not a component extension

Recommended mechanism: ship the browser with a **default-set
`ExtensionInstallForcelist`-equivalent policy** pointing at our
self-hosted CRX update feed (a `browser` channel feed alongside
`update-feeds/chrome-preview.xml`).

Why this mechanism over the alternatives:

- **Component extension** (baked into the binary): rejected — it ties
  peerd updates to browser releases, inverting the "extension updates
  on its own cadence" principle.
- **`--load-extension` / initial-preferences install**: rejected —
  fragile, user-removable in ways that strand them, and doesn't grant
  permissions cleanly.
- **Force-install via policy default**: installs silently on first run,
  **auto-grants all required permissions — including `debugger`** —
  updates from our feed independent of the browser binary, and is the
  exact mechanism enterprises already trust. Bonus: the same policy
  template, pointed at stock Chrome/Edge via MDM, is our zero-fork
  enterprise wedge (§8) — one artifact, two distributions.

This dissolves the store-Chrome CDP problem (`packaging/gen-manifest.ts`
`STORE_STRIPPED_PERMISSIONS`): the browser channel ships the full
manifest with `debugger` required, no store review in the loop.

### 3.3 Infobar / prompt suppression (the "banner" work)

Scoped to peerd's extension ID wherever possible:

- **The `chrome.debugger` infobar** ("peerd is debugging this
  browser"): suppressed for peerd's ID only. Upstream already carries
  `--silent-debugger-extension-api`; prefer defaulting that behavior
  for our ID via a ~5-line patch over carrying a flag in the launcher.
- **Default-browser prompt** and first-run bubbles: disabled via
  initial preferences / policy defaults (no code patch).
- NOT suppressed: permission prompts for mic/camera/etc., safe-browsing
  interstitials, or anything user-protective. Suppression budget covers
  peerd-related friction only.

### 3.4 Service-worker lifetime exception (the one behavioral patch)

A small patch to the extensions ProcessManager: the MV3
service-worker idle-suspend does not apply to peerd's extension ID
(equivalently: a permanent keepalive for that ID).

- why: the MV3 SW lifecycle is the single biggest reliability tax on
  long agent runs; the extension's keepalive trick works but is a
  workaround. In our own binary the workaround becomes a guarantee.
- Constraints: **the extension keeps its keepalive machinery** — it
  must stay correct on stock Chrome. This patch is belt-and-braces,
  never a dependency. Patch stays ID-scoped so no other extension's
  behavior changes.
- Chrome has precedent knobs here (enterprise policies extending SW
  lifetime for port connections); if upstream policy surface can
  express "never suspend this ID" without a patch, prefer the policy.

### 3.5 Policy/preference defaults (no code)

- Side panel: peerd pinned/opened by default on first run.
- Any future browser-channel defaults flow through the same initial
  preferences + policy template — resist the urge to patch code for
  what a preference can express.

Explicitly OUT of scope for v1: custom new-tab page, omnibox
integration, sync replacement, any UI surgery. Each would blow the
diff budget for marginal value.

## 4. Extension-side work (THIS repo): the `browser` channel

The channel machinery already exists (`manifests/*.json` patches +
`packaging/default-settings.mjs` → generated `manifest.json` /
`channel-config.js`). Add a third config channel:

- **`manifests/browser.patch.json`** — full permission set including
  `debugger` (required), self-hosted update URL for the browser feed,
  browser-channel naming/CSP.
- **`packaging/default-settings.mjs`** — `browser` values per key.
  Starting posture: `advancedAutomationEnabled` default ON (CDP is
  the automation path in our own binary). Everything else starts from
  the **store** column, not preview — the browser audience is
  non-technical; preview's relaxed-friction defaults are for technical
  users. Safety floor stays channel-invariant per the file's stated
  principle.
- **dweb: OFF at launch** (store posture, module pruned). The browser
  channel targets normal users and companies; research-grade p2p is
  preview's job. Revisit deliberately later.
- **`update-feeds/`** — a browser-channel CRX feed, generated by the
  existing `packaging/gen-update-feeds.ts` path, hosted alongside the
  preview feeds.
- Packaging/preflight/CI extend to the new channel (the existing
  2×2 channel/browser matrix grows a row; `packaging/preflight.ts` is
  the source of truth for gates).

Inference plan (bundled metered credits for non-technical users) is a
LATER, extension-side feature — a provider adapter + account/billing
service — and deliberately not part of the fork work. The browser only
determines its default. BYOK and local (Ollama) remain first-class on
every channel; the security architecture is identical across all three
inference paths — only the model endpoint moves.

## 5. Phases

**Phase 0 — pipeline proof (no product changes).** Build UNMODIFIED
Chromium from a stable tag; sign + notarize + package on all three
platforms; publish to a private bucket. Exit: green unattended runs on
two consecutive upstream stable releases. This de-risks everything
that follows and is where the real setup grind lives (realistic: 2–6
focused weeks).

**Phase 1 — the distribution.** Branding overlay, force-install of
peerd from the browser feed, infobar/first-run suppression, installers
+ auto-update channels (mac/win/linux). Extension-side `browser`
channel lands in this repo in parallel. Exit: a stranger installs the
browser, peerd is there with full permissions, updates flow for both
binary and extension.

**Phase 2 — the reliability patch.** SW-lifetime exception + side-panel
default + `--silent-debugger-extension-api`-for-peerd. Exit: a
multi-hour goal-mode run survives with zero SW-restart events in the
browser build, while the same extension build still passes the stock-
Chrome e2e suite.

**Phase 3 — release engineering hardening.** Upstream watcher
(chromiumdash release API) → agent rebases patches → build → sign →
staged publish, human approval gate only. Security-respin SLA
measured and documented. Widevine decision executed (Open decisions).

**Phase 4 — go-to-market surface.** Enterprise policy template for
stock-Chrome (the no-fork wedge), download site, and (separately
scoped) the inference plan.

## 6. Build & release infrastructure

Per the 2026-07 cost analysis (reverify prices before committing):

- **Orchestrator:** GitHub Actions in `peerd-browser`, same as this
  repo's CI.
- **Linux + Windows builders:** ephemeral runners (RunsOn-style
  spot VMs in our own cloud account, or a managed provider like
  Ubicloud) — Chromium officially supports cross-compiling the
  Windows target from Linux. Booted per job, terminated after.
- **Cache strategy (what makes ephemeral work):**
  - compile cache: `sccache`/siso remote cache in object storage
    (R2/S3) — any fresh VM builds warm;
  - source checkout: per-release volume snapshot; builds boot from
    the snapshot and `gclient sync` incrementally instead of
    refetching ~100GB+.
- **macOS builder:** one Mac mini (owned, registered as a self-hosted
  runner; doubles as the real-hardware test machine). Fallback:
  GitHub's hosted macOS XL per release.
- **Signing:** Azure Artifact Signing (Windows, ~$10/mo tier), Apple
  Developer + notarization (mac), GPG-signed apt/rpm repos (linux).
- **Updates & distribution:** Cloudflare R2 (zero egress) for
  installers + update feeds; Sparkle (mac), minimal Omaha-style
  updater (win), distro repos (linux).
- **Versioning:** track upstream **stable**; browser version =
  upstream Chromium version + our build suffix, so the embedded
  Chromium version is always legible.
- Budget envelope (2026-07 snapshot): ~$2k one-time (Mac + setup),
  ~$25–50/mo compute+storage at weekly cadence, ~$220/yr
  signing/memberships.

## 7. Open decisions

1. **Widevine path** — sign the (no-fee) MLA with Google, or fetch the
   CDM at runtime via the component updater (the Vivaldi pattern, no
   redistribution). Runtime-fetch is the lighter start; MLA is the
   cleaner end state. Needs deciding in Phase 1 (DRM-less browsers
   read as broken to exactly our target audience).
2. **Name & trademark** — "peerd Browser" vs a distinct name.
   Chromium's BSD license is fine; Google's trademarks are not ours to
   use. Also check collision space (unrelated "Polarity"/"Polar"
   browsers exist).
3. **Chrome Sync replacement** — Google cut sync API access for forks
   (2021). Launch answer: no sync, framed with the privacy story. A
   peerd-native encrypted profile transfer already exists in the
   runtime (`transfer`); whether it grows into cross-device sync is a
   product question, not a fork question.
4. **Safe Browsing** — keys/quota for forks need investigation; a
   browser marketed on security should not silently lack it.
5. **SW patch vs upstream policy** — if an existing enterprise policy
   can express the §3.4 lifetime exception, drop the patch (§1: the
   default answer to browser-code changes is no).
6. **Browser-channel dweb timing** — off at launch (§4); the criterion
   for turning it on is a deliberate decision, not drift.

## 8. The no-fork enterprise wedge (do this regardless)

Everything §3.2 buys — force-install, silent `debugger` grant, pinned
side panel — is expressible TODAY as a managed-policy template against
stock Chrome/Edge, deployed through the MDM enterprises already run.
Ship that template as its own small artifact (Phase 4, but cheap to
prototype anytime): it validates enterprise demand before the fork
exists, and de-risks the fork into "the same config, productized for
people without an IT department."
