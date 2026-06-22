# FEATURE — Browser-runner model: configuration, per-provider defaults, and a local WebGPU runner

> **Status:** SPEC, build-ready. **Reframed (2026-06-14):** the **browser-
> runner** (the disposable subagent behind `do`/`get`/`check`) is the
> primary target for local inference — **not** the main agent. The runner
> is a narrow, high-frequency, latency-sensitive, security-contained job:
> the ideal fit for a small fast on-device model. This supersedes this
> doc's earlier "main-agent quick mode" framing (now demoted to §6).
>
> **Parent:** `docs/LOCAL-INFERENCE.md` (engine = Transformers.js / ORT,
> WebGPU-only; host = offscreen doc; weights = SRI-pinned OPFS; "local
> quick mode," not the full agent loop). Those decisions are **inherited**.
>
> **Module placement:** `peerd-provider/` (runner-model resolution +
> per-provider defaults + the `local-webgpu` adapter) → `peerd-runtime/
> runner` + `tools/defs/{do,get,check}.js` (consume the resolved model) →
> `peerd-runtime/<inference>/` in the offscreen doc (the WebGPU engine).
> No sixth `peerd-*` module.

> **STATUS (2026-06-21) — SHIPPED.** The core feature is live: Gemma-4-E2B
> on-device WebGPU behind an **opt-in download**, hosted in the offscreen
> doc (`offscreen/local-model.js`) and exposed via the `local-webgpu`
> adapter (`peerd-provider/adapters/local-webgpu.js`). Broader model
> support is **staged** (one resident model today). The §2.4 structured
> `{ mode, id }` runner-model selector is **still open** — `runnerModel`
> stays a bare string + resolver for now.

---

## Build log

**2026-06-17 — M0 eval A/B harness scaffolded (the §3.1 decision gate).**

`extension/eval/` now runs the WHOLE task suite under two runner models
back-to-back and scores them head-to-head. A new "Run A/B" control takes runner
config A + B (a model id to pin, or the literal `local`), pins each via
`settings/update runnerModel`, runs the suite under each (`runSuite()` extracted
from `runAll`), then renders passRate / avg-latency / runner-tokens / $-per-task
side by side + the per-task pass diff (reusing `score.js` `compare` →
`regressions` = A-passed/B-failed). It restores the user's `runnerModel` after.
`local` resolves the on-device rung (clears the pin → `resolveRunnerModel`
step 2); it queries a `local-model/status` route **M1 will add** (until then a
`B=local` run aborts with a clear "download it first"). So the gate is runnable
NOW — validate it with two cloud ids (e.g. `claude-haiku-4-5` vs
`claude-sonnet-4-6`) — and flips to the real local-vs-Haiku measurement the
moment M1 lands. **Next: M1** (offscreen Transformers.js/ORT engine +
`local-webgpu` adapter + Settings download card) so `local` becomes available.

**2026-06-18 (owner) — Deliverable A core landed; B scope refined.**

*Shipped:* the page-reader (do/get/check) runner now has a real per-provider
default instead of silently inheriting the chat model. Every adapter carries a
`defaultRunnerModel` (Anthropic `claude-haiku-4-5`, OpenRouter
`anthropic/claude-haiku-4.5`, Ollama = its chat model), surfaced through
`listProviders()`. A pure, Bun-tested `resolveRunnerModel({ settings, provider,
localRunner })` (`peerd-provider/runner-model.js`) resolves **pin → local
WebGPU → provider default → inherit**; the SW resolves it once per
tool-context build into `ctx.runnerModel`, which `get`/`check` consume. The
Settings "Page-reader model" field now shows the real default as its
placeholder (e.g. `claude-haiku-4-5`) — "blank" is honest, it no longer reads
"inherit chat model". This closes the §2.1 gap (the misleading-default + raw
text box), **minus** the structured `{ mode, id }` selector of §2.4, which
stays a bare-string-plus-resolver for now (a custom id still works; the
auto/local/main/custom dropdown is deferred until B's local rung is live).

*The local-WebGPU rung is pre-wired but dormant:* `resolveRunnerModel` already
accepts `localRunner` and ranks it above the provider default — so once the
adapter exists, "use the local runner" needs no new resolution logic.

*Refined B scope (owner):* when the local WebGPU model (**Gemma**, via
**Transformers.js / ORT-Web**, per `docs/LOCAL-INFERENCE.md` — the engine the
parent study already chose, and what the `webml-community` HF demos run) is
**downloaded, it becomes the page-reader runner default automatically**
(`resolveRunnerModel` step 2, no per-provider key needed). It is **also offered
as a main-chat model option**, but is **NOT auto-defaulted** there — the main
agent stays cloud/BYOK by default (the small-model-over-40-tools failure mode
of §1/§5 still holds; the user opts in per chat if they want it). Onboarding
mirrors **voice**: a Settings download card, SRI-pinned weights, IDB/OPFS
cache, capability gate (`navigator.gpu` + `shader-f16`), engine resident in the
offscreen doc. Everything else in §3 (offscreen `infer/*` engine, vendoring,
OOM/fallback, M0 eval gate) stands.

---

## 0. Two deliverables, separable and ordered

| | Deliverable | Needs WebGPU? | Effort |
|---|---|---|---|
| **A** | **Runner-model configuration + per-provider defaults.** Make the runner model properly configurable, with a sensible fast default for *every* provider, resolved against whatever provider is active. | No — ship now. | ~2–3 days |
| **B** | **Local WebGPU runner.** An on-device small model as the runner endpoint, gated on an eval parity test. Plugs into A as one more runner choice. | Yes. | M0 gate + ~2–3 wks |

**A is worth doing now regardless of B** — it fixes a real shipped gap
(below) and it is the exact seam B plugs into: once the `local-webgpu`
provider exists, "use the local runner" is just another value A resolves.

---

## 1. Why the runner is the right target for local inference

The runner sidesteps both things that make *main-agent* local inference hard:

- **Narrow job, not 40 tools.** The runner has ~9 DOM tools
  (`DO_TOOLSET`/`READ_TOOLSET`), one goal, one tab, no memory, no
  spawning. Its decision is "given this a11y snapshot + goal, emit the
  next click/type/scroll/navigate" — the constrained indexed-DOM-action
  task small models *can* do. The "tool selection over 40 tools" failure
  mode that sinks small models on the main loop barely applies here.
- **Small prefill, not huge.** Main-agent prefill is system prompt + 40
  tool schemas + memory (the WebGPU TTFT killer). The runner's prefill is
  just its system prompt + one a11y snapshot — and after step 1 it can
  observe **diffs** (`watch_changes`), keeping per-step prefill tiny.
- **Highest-frequency model call in the system** → biggest win on
  **latency, cost, privacy**. Every `do`/`get`/`check` runs the runner up
  to `DO_MAX_STEPS=30` steps; going local removes the network round-trip
  on every step, costs $0, and keeps the (already-quarantined) untrusted
  DOM content fully on-device for inference.
- **Security already contains a weaker model.** The runner has no memory,
  no egress, no powerful tools; a dumber local model can misclick but
  can't exfiltrate or escalate. The blast radius is already bounded.
- **Pre-wired:** the runner is **model-agnostic** ("only the endpoint
  differs"), the `runnerModel` seam already exists, and the eval harness
  already scores do/get/check. This is config + an adapter, not new arch.

The one real bar: **action-selection reliability must match Haiku** — a
wrong `"done"` on a half-mutated page is the failure mode the whole
do/get/check thesis rests on. That bar is measurable cheaply (§3, M0).

---

## 2. Deliverable A — runner-model configuration + per-provider defaults

### 2.1 Current state (the gap, precisely)

A `runnerModel` setting **already exists** but is half-built:
- `shared/channel-config.js` defaults `runnerModel: ""`.
- Options → providers (`options/sections/providers.js`) exposes it as a
  **raw free-text model-id box**.
- `tools/defs/get.js` / `check.js` (and `do` via `runRunner`) read
  `ctx.settings?.runnerModel || undefined` and pass it as the runner's
  model; **`""` means "inherit the main session model."**

Three problems:
1. **Default is "inherit main."** Out of the box the runner runs on your
   *main* model — as slow and as expensive as the main agent — exactly the
   opposite of the "fast cheap runner" intent. You only get a fast runner
   if you happen to hand-type a model id.
2. **Raw text field.** You must know the exact provider-specific id.
3. **No per-provider resolution.** It's one global string. Type
   `claude-haiku-4-5` and it breaks the instant the active provider is
   OpenRouter (needs `anthropic/claude-haiku-4.5`) or local (needs its own
   id). There is no notion of "the right fast model for whatever provider
   is wired."

### 2.2 Per-provider runner defaults

Add a **`defaultRunnerModel`** field to the adapter shape in
`peerd-provider/registry.js` (alongside the existing `defaultModel`). Every
provider we ship or add MUST set one — a fast, cheap model reachable with
that provider's own credentials:

| Provider | `defaultRunnerModel` |
|---|---|
| `anthropic` | `claude-haiku-4-5` (latest Haiku) |
| `openrouter` | `anthropic/claude-haiku-4.5` (Haiku via OpenRouter) |
| `local-webgpu` *(Deliverable B)* | the resident on-device runner model |
| *(future)* `openai` | the small/fast tier (a mini model) |

> Today this is "not a huge deal" (Anthropic + OpenRouter both serve
> Haiku), but making `defaultRunnerModel` a **required field on every
> adapter** is the rule that keeps it correct as providers are added — no
> provider ships without a runner default.

### 2.3 Resolution order (pure, Bun-testable)

A pure `resolveRunnerModel({ settings, activeProvider, localRunner })`,
first match wins:

1. **Explicit user pin**, if set *and* reachable with the active
   provider's credentials → use it.
2. **Local WebGPU runner**, if enabled and available (WebGPU present +
   model resident) → use it. Provider-independent (keyless, on-device), so
   this works no matter what the main provider is. *(Deliverable B; until
   then this rung is absent.)*
3. **`activeProvider.defaultRunnerModel`** — the per-provider fast default
   (§2.2). This is the new effective default and directly answers "what if
   Anthropic isn't wired and OpenRouter is" — it resolves to Haiku-via-
   OpenRouter automatically.
4. **Inherit the main session model** — last-resort fallback (always
   works; slower/pricier). Only hit if a provider somehow has no runner
   default.

### 2.4 Settings UI

Replace the free-text box with a small selector (Options → providers, or
Advanced):

- **Auto — fast model for the current provider** *(new default)* → resolves
  via §2.3 step 3.
- **Local (WebGPU)** → step 2; shown/enabled only when available *(B)*.
- **Same as main model** → step 4 (the old `""` behavior, kept for users
  who want it).
- **Custom…** → a model-id field (the old behavior, for power users) →
  step 1.

Persist as a small structured setting (e.g. `runnerModel: { mode:
'auto'|'local'|'main'|'custom', id?: string }`) rather than a bare string;
keep reading a legacy bare-string `runnerModel` as `custom` for back-compat
(the field already exists, so migrate it).

### 2.5 Wiring

- Adapter shape: add `defaultRunnerModel` (required) to each adapter +
  registry typedef; the in-browser/registry tests assert every registered
  adapter has one.
- `resolveRunnerModel` lives in `peerd-provider` (pure); the SW builds the
  tool context with the resolved id so `do`/`get`/`check` get it via
  `ctx` — i.e. `get.js`/`check.js`/`runRunner({ model })` consume the
  resolved value instead of the raw `ctx.settings.runnerModel`.
- The SW settings handler (`service-worker.js`, the existing
  `patch.runnerModel` path) accepts the new structured shape.

---

## 3. Deliverable B — local WebGPU runner

### 3.1 M0 — the gate (the decisive, cheap experiment)

`extension/eval/` **already** runs do/get/check (WebVoyager-style) tasks
and measures **pass-rate, duration, and separable runner cost**. So the
gate is already instrumented:

- A/B the **local-WebGPU runner** against the **Haiku runner** on the real
  eval suite, on target hardware (M-series).
- **Decision:** ship local-runner-by-default only if pass-rate holds
  within tolerance of Haiku **and** wall-clock per do/get/check is ≤ Haiku
  (the latency win). If pass-rate drops, either go bigger model, adopt the
  constrained output format (§3.3), or keep Haiku and stop.

This is a far narrower, more achievable gate than "agent loop over 40
tools," and it's a few days of work against existing infrastructure.

### 3.2 Memory / resourcing (so the biggest model that fits, runs fast)

- **Request the adapter's MAX limits at `requestDevice()`.** The existing
  `probeGpuCapability()` *reads* `adapter.limits` but the default device is
  conservative — pass `requiredLimits` set to the adapter maxima
  (`maxBufferSize`, `maxStorageBufferBindingSize`, …) and require the
  `'shader-f16'` feature. Hand that maxed device to ORT-Web. The #1 free
  headroom lever.
- **Host in the offscreen document**, never the SW (the SW idles out;
  COEP/COOP + `wasm-unsafe-eval` are already in place per the parent doc).
  Keep the model **resident** so do/get/check don't pay a reload.
- **q4f16** weights; **SRI-pinned, OPFS-cached, shard-streamed** into GPU
  buffers (generalize `voice/model-store.js`) to avoid the 2× load spike.
- **OOM guard:** an OOM in the offscreen doc takes the SW keepalive with
  it — wrap load/generate, on OOM report legibly, tear down, re-create the
  offscreen doc + keepalive, and **fall back to the per-provider runner
  default** (§2.3 step 3). Never leave a dead bridge.

### 3.3 Runner-specific levers (you control both ends)

- **Constrained output format for the local runner.** Small models are far
  more reliable at a fixed schema than at general tool-use — have the
  *local* runner emit a tight browser-use-style action
  (`{ action, ref, text }`) instead of full tool-calls. The cloud-Haiku
  runner keeps tool-use; the `systemPromptOverride` + adapter split makes
  this a clean per-endpoint difference.
- **Feed a11y diffs, not full re-snapshots.** Per-step prefill (the
  runner's real latency cost) stays small if after step 1 the runner sees
  the change/diff rather than the whole tree — the runner prompt already
  steers toward observing diffs; make sure the local path honors it.
- **Specialization (future moat):** the job is narrow enough that a small
  model *fine-tuned* on DOM-action traces (WebVoyager/Mind2Web/browser-use
  are open) could match a general 8B while being faster. Not needed for
  v1 — start with a good small instruct model + the constrained format.

### 3.4 Wiring

- **`local-webgpu` adapter** (`peerd-provider/adapters/local-webgpu.js`):
  `registerProvider`, `keyless: true`, a `defaultRunnerModel` = the
  resident model (§2.2), zero-cost pricing entry; an **async-generator RPC
  shim** re-yielding `ProviderEvent`s from the offscreen host (the
  `voice/*` message routing is the template). `getSecret`/`safeFetch`
  accepted and ignored; synthetic `usage`.
- **Offscreen engine** (`peerd-runtime/<inference>/`): `infer/init` (load),
  `infer/generate` (stream `infer/delta`/`done`/`error`), `infer/teardown`.
- **Capability gate** (`navigator.gpu` + `shader-f16`, modeled on
  `voice/engine-picker.js`): when unavailable, `resolveRunnerModel` simply
  skips step 2 and uses the per-provider default — graceful, automatic.
- **Vendoring:** `scripts/vendor-transformers.sh` (Transformers.js + ORT
  WASM, SOURCE.txt + SHA-256s). Gate the ~25 MB ORT WASM behind the
  feature flag / non-store channel if it strains review (like dweb).

### 3.5 Phasing

| Milestone | Scope | Effort |
|---|---|---|
| **M0** | Eval A/B local-runner vs Haiku (pass-rate + latency) on target HW. Decision gate. | ~3–5 days |
| **M1** | Offscreen engine + `infer/*` + max-limits device helper + OPFS shard-stream store + `local-webgpu` adapter; resident, q4f16, constrained output format. | ~1.5–2 wks |
| **M2** | `resolveRunnerModel` step 2 wired (local-when-available) + Settings "Local (WebGPU)" option + capability gate + OOM/fallback. | ~3–5 days |
| **M3** | Diff-prefill tuning, eval hardening, store-posture flag. | ~3–5 days |

M0 gates the rest. (Deliverable A is independent of all of this.)

---

## 4. Removal — rip out the Ollama adapter ~~[REVERSED]~~

> **REVERSED (2026-06-21).** The removal below was **NOT carried out** —
> the owner decision to rip out Ollama was reversed. **Ollama is
> retained.** Both adapters ship side by side:
> `peerd-provider/adapters/ollama.js` (local daemon, keyless BYOK) AND
> `peerd-provider/adapters/local-webgpu.js` (on-device WebGPU, no daemon).
> The two local paths are complementary, not exclusive. Everything in §4
> below is **superseded** — kept for history only; do **not** execute the
> delete/edit checklist.

Owner decision (2026-06-14): Ollama is removed from peerd. It's a native
daemon outside the browser that the user installs and runs — it breaks the
zero-install / browser-native thesis and forces a `localhost` CSP +
loopback-allowlist exception. The browser-runner's local path is **the
WebGPU runner (Deliverable B)**; cloud BYOK (Anthropic / OpenRouter Haiku
via Deliverable A) is the default and the fallback.

### 4.1 Sequencing

Rip Ollama out as its own small PR **now** — it's independent of A and B,
and removes the CSP/allowlist exceptions immediately. Interim local-
inference gap is acceptable (0.x beta; runner uses cloud Haiku via A until
B lands). This also voids the parent doc's re-trigger condition #1 ("Ollama
shipped and proved the demo").

### 4.2 PRESERVE before deleting

- **`probeGpuCapability()`** — lives in `peerd-provider/ollama-recommend.js`
  and B depends on it (§3.2). **Extract it** to a shared module (e.g.
  `peerd-provider/capability.js`) before deleting that file; keep its tests
  (repointed). Delete only `OLLAMA_MODEL_TIERS` + `recommendOllamaModel`.
- **The OpenAI-format layer** (`peerd-provider/format/{to-openai,
  from-openai}.js`) is **shared with OpenRouter** — do NOT delete; only
  strip Ollama-specific branches, if any.

### 4.3 Delete / edit checklist (verified touchpoints)

Provider module:
- **Delete** `peerd-provider/adapters/ollama.js`.
- **Delete** `peerd-provider/ollama-recommend.js` *after* extracting
  `probeGpuCapability` (§4.2).
- `peerd-provider/registry.js` — remove the `ollamaAdapter` import + its
  `adapters.set(...)`.
- `peerd-provider/index.js` — remove Ollama exports.
- `peerd-provider/pricing.js` — remove the `$0` Ollama pricing entry.
- `peerd-provider/errors.js` — remove the "daemon not running → `ollama
  serve`" mapping.
- `peerd-provider/format/from-anthropic.js` — remove any Ollama branch
  (keep shared logic).

Egress + manifests (removes the thesis impurity):
- `peerd-egress/fetch/allowlist.js` — remove `http://localhost:11434` and
  `http://127.0.0.1:11434`.
- `peerd-egress/fetch/safe-fetch.js` — remove the Ollama-loopback comment.
- `peerd-egress/fetch/web-fetch.js` — remove the Ollama reference.
- `manifests/base.json`, `manifests/preview.patch.json`,
  `manifests/dev.patch.json` — remove `http://localhost:11434` from
  `connect-src`; then **`bun run gen:dev`** (regenerates
  `extension/manifest.json` — never hand-edit; CI drift-checks).

UI + chassis:
- `extension/options/options.js`, `options/sections/providers.js`,
  `options/sections/behavior.js` — remove the Ollama provider config + the
  GPU-recommend card (repurpose the card for `recommendLocalModel` when B
  lands).
- `extension/sidepanel/components/chat-view.js`, `input-bar.js` — remove
  Ollama model-picker / keyless-indicator branches.
- `extension/background/service-worker.js` — remove any Ollama wiring.

Tests:
- **Delete** `tests/unit/peerd-provider/ollama-adapter.test.js`.
- `tests/unit/peerd-provider/ollama-recommend.test.js` — repoint the
  `probeGpuCapability` tests at the new shared module; drop the picker
  tests.
- `tests/unit/peerd-egress/safe-fetch.test.js` — drop the `localhost:11434`
  allowlist assertions.
- `tests/unit/sidepanel/attachments.test.js` — remove the Ollama ref.
- `extension/tests/index.js` — remove Ollama test registration.

Docs (prose — update, not blocking):
- `CLAUDE.md`, `ARCHITECTURE.md`, `ARCHITECTURE-CHANGES.md`, `DESIGN.md`,
  `README.md`, `STATUS.md`, `TODO.md`, `docs/DECISIONS.md`
  (record the removal), `docs/store/OPEN-DECISIONS.md`,
  `docs/DO-GET-CHECK-DEV-NOTES.md`.
- `docs/LOCAL-INFERENCE.md` — strike re-trigger #1 (Ollama prerequisite)
  and the "Ollama covers the fully-local demo" rationale.

### 4.4 Gates after removal

`bun run gen:dev` (manifest drift), `bun test ./tests`, `bun run
typecheck`, ESLint, and the in-browser CDP suite all green. Confirm the
provider picker, CostChip, and a cloud turn still work with Ollama gone.

---

## 5. Out of scope / inherited

- **Main-agent local "quick mode"** (chat + page summarize on a trimmed
  6-tool manifest) — the original framing of this doc — is **demoted to a
  later, secondary target.** The runner is the better first WebGPU bet;
  the main agent stays cloud/BYOK. Revisit quick-mode after the runner
  ships and small-model quality improves.
- **Not** the full 40-tool agent loop on local.
- **Not** web-llm (runtime executable WASM = store landmine); **not** a
  WASM CPU fallback (2–5 tok/s).
- **Not** waiting on WebNN — slots in as an extra ORT backend at GA with no
  rework; model capability is the gate, backend second.

---

## 6. Open questions

1. **Local action-selection parity (M0).** The whole bet. Verify a small
   q4f16 model + constrained format matches Haiku on the eval before M1.
2. **ORT-Web device injection.** Confirm ORT-Web accepts a pre-created
   WebGPU device with our `requiredLimits` (vs creating its own default).
3. **`deviceMemory` clamp.** Chrome clamps to ≤8; lean on `maxBufferSize`
   (the probe already does) — it tracks unified memory on Apple Silicon.
4. **`runnerModel` migration.** Migrate the legacy bare-string setting to
   the structured `{ mode, id }` shape (treat existing strings as
   `custom`). One-time, no compat code beyond the read shim (0.x rule).
5. **Cross-provider runner.** Should an advanced user be able to run the
   runner on a *different cloud provider* than the main session (needs that
   provider's creds)? The local-webgpu case is provider-independent and
   handled; defer general cross-provider until asked.
