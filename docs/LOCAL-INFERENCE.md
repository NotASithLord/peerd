# Local in-browser inference (`local-webgpu`) — feasibility study & decision record

**Date:** 2026-06-12 · **Verdict: DEFER** (with explicit re-trigger
conditions and a concrete build plan below, so the next evaluation
starts from evidence, not memory).

This is the deep study behind the deferred
"local in-browser inference" entry (backlog). Ecosystem claims were verified
against current sources in June 2026 (links at the end).

---

## Why defer

1. **The agent loop is the wrong first workload.** peerd sends a ~4K-token
   system prompt + 45 tool schemas (realistically 10–15K tokens of
   prefill) and re-prefills every tool round-trip. Measured WebGPU
   prefill on ordinary consumer hardware is ~65 tok/s for 3B-class
   models (LlamaWeb, arXiv 2605.20706) — tens of seconds to minutes of
   time-to-first-token *per loop iteration*. And 1.7–4B instruct models
   choosing correctly among 45 tools is exactly where small models fail.
2. **The WASM fallback promised by the old roadmap line does not survive
   contact with benchmarks** — 2–5 tok/s on a 1.1B model (SitePoint
   measurement). WebGPU-only is the only honest scope, which fragments
   availability (Firefox: Windows since 141, macOS ARM since 145, Linux
   still pending in mid-2026).
3. **Tool use is immature in both candidate engines.** web-llm's
   `tools` support is officially WIP and documented against 7–8B
   Hermes-class models; Transformers.js templates tools into the prompt
   but leaves `<tool_call>` parsing to us.
4. **The native Ollama adapter (shipped separately) covers the
   "fully local" demo** with 8–30B models at native speed. The only
   marginal value of `local-webgpu` is *zero-install* local inference —
   and today that experience is a 1.33 GB download, WebGPU-or-nothing,
   then a sluggish agent that fumbles tools. Fails the "works well" bar.
5. **Store friction:** vendoring ONNX Runtime's threaded WASM adds
   ~25 MB to artifacts (~4× the current store zip) for a feature most
   users won't enable, on an extension that already carries `debugger`
   + `<all_urls>` scrutiny.

## Re-trigger conditions (UPDATED 2026-06-17 — two of three now MET)

1. **✅ MET.** The Ollama adapter shipped (2026-06-12) and proved the
   local-model demo.
2. **✅ MET — and the original framing was off-target.** A trimmed tool
   surface exists **two ways**: per-session `/tools` manifests shipped
   (`tools/manifests.js` + `manifest-command.js` + `session.toolManifest`,
   enforced in `gates.js`), AND — more importantly — the do/get/check
   **browser-runner already runs on a 4–9-tool allow-list by construction**
   (`runner/index.js`: `READ_TOOLSET` = 4 {snapshot, read_page, read_state,
   query_dom}; `DO_TOOLSET` = 9). We don't need to trim the *main* agent for
   a "quick mode" — the runner read-path is already at the ideal small-model
   surface.
3. **⬜ OPEN — the only real unknown, and it's empirical.** Does a ≤~3 GB
   instruct model do **reliable page-comprehension + function-calling over
   the runner's 4-tool READ set on real DOM**? New candidate:
   `onnx-community/gemma-4-E2B-it-ONNX` (q4f16, ~2–3 GB). The
   Fable-5-authored WebGPU kernels hit 255 tok/s *decode* — but the agentic
   loop's bottleneck is **prefill-per-round-trip**, which is gentle for the
   single-pass *read* path and brutal for the multi-step *action* loop.

   **Test it:** `docs/local-inference-bench/` benches Gemma-4-E2B vs Haiku
   on real runner read-prompts (load time, prefill TTFT, decode tok/s,
   output quality) — open it in a WebGPU browser and run both.

## Natural target (revised)

Not a main-agent "local quick mode" — the **do/get/check read-path**
(`get`/`check`), wired through the existing `runnerModel` setting. It's the
highest-volume model call, its tool surface is already 4, and a read is
usually a single prefill (no action loop), so WebGPU's prefill cost and a
2B model's reasoning are both at their most forgiving. The `do` *action*
loop stays on Haiku/the session model.

## Decided engine: Transformers.js (not web-llm)

| | Transformers.js v4.2 (ONNX Runtime Web) | web-llm 0.2.84 (MLC) |
|---|---|---|
| License | Apache-2.0 | Apache-2.0 |
| Engine vendor size | ~545 KB JS + 45 KB loader + **25 MB** threaded WASM | 6.26 MB bundle |
| Store/RHC posture | Models are pure-data `.onnx` → CWS-clean **if** ORT WASM is vendored locally (`env.backends.onnx.wasm.wasmPaths`; see CWS rejection in transformers.js #839) | Each model needs a compiled **executable** `.wasm` lib fetched from GitHub raw at runtime → remotely-hosted-code violation unless every lib is vendored |
| WebGPU / fallback | WebGPU experimental-but-working; WASM fallback exists (too slow for LLMs, fine for future small models) | WebGPU-native, fastest decode; **no fallback** |
| Streaming | `TextStreamer` token callbacks | OpenAI-style async generator |
| Tool use | Templates `tools` in; no tool-call parsing (build ~150–250 LOC ourselves) | Officially WIP; reliable only on 7–8B models |

web-llm's runtime executable-WASM distribution is a store-policy
landmine; Transformers.js matches the Moonshine supply-chain pattern
exactly. Decision: **Transformers.js, WebGPU-only.**

## Build plan (when triggered)

- **Vendoring** — new `scripts/vendor-transformers.sh` mirroring
  `vendor-moonshine.sh`: `vendor/transformers/transformers.min.js`,
  `ort-wasm-simd-threaded.jsep.mjs` + `.wasm` (25 MB), SOURCE.txt +
  SHA-256s; point `env.backends.onnx.wasm.wasmPaths` at the vendor dir.
- **Weights at runtime as data** — commit-pinned HF URLs, SHA-384 SRI
  via `scripts/compute-model-sri.sh`, IDB-cached: generalize
  `peerd-runtime/voice/model-store.js` into a shared SRI asset store
  (~150 LOC; it is already injected-deps style).
- **Host context** — the existing offscreen document (survives SW idle
  via the keepalive port; manifest COEP/COOP already give
  `crossOriginIsolated` for ORT threading; CSP already has
  `wasm-unsafe-eval`). The SW idling out is why the engine must NOT
  live there, despite Chrome 124+ allowing WebGPU in SWs.
- **Adapter** — `adapters/local-webgpu.js` is an async-generator RPC
  shim re-yielding `ProviderEvent`s streamed from the offscreen host
  (the voice message-routing pattern is the template). `getSecret`/
  `safeFetch` accepted and ignored; synthetic `usage` events; zero-cost
  pricing entry so the CostChip stays honest.
- **Capability gate** — `navigator.gpu` + shader-f16 probe, modeled on
  `voice/engine-picker.js`; degrade to "not available on this machine."
- Estimated new code: ~900–1,200 LOC + settings download card.

## Watch item: WebNN (asked 2026-06-12)

WebNN GA does **not** change this verdict — the deferral is driven by
model economics (tool accuracy of ≤4B models, 1.3 GB downloads,
prefill volume), which a faster/cooler backend doesn't touch. Status
at writing: W3C Candidate Recommendation (Jan 2026), Chrome Origin
Trial M147–149 only, NPU/GPU paths in preview behind Windows 11 24H2
flags, Android excluded, no Safari/Firefox — realistic GA is 2027.
What it DOES change, at GA: ONNX Runtime Web already ships a WebNN EP
(`deviceType: 'npu'`), so the Transformers.js/ORT stack chosen above
picks it up as an extra backend with zero architectural rework, and
NPU power efficiency makes the deferred **"local quick mode"** framing
stronger for always-on background tasks (auto-memory extraction,
page summarization) that should never spin a GPU or an API bill.
Re-evaluation order stays: model capability first, backend second.

## Risks recorded

Demo-quality (primary, drives the deferral) · 25 MB artifact growth &
store review friction · WebGPU fragmentation (Firefox Linux absent;
shader-f16 gaps force ≈2× downloads) · engine memory leaks / OOM on
8 GB machines killing the offscreen doc (and with it the SW keepalive) ·
re-vendoring treadmill on every onnxruntime-web bump · slight
`callModel` contract bends (synthetic usage, ignored egress params).

## Sources

web-llm repo + `src/config.ts` VRAM table · @mlc-ai/web-llm dist ·
transformers.js repo + dist + issue #839 (CWS rejection) ·
onnxruntime-web dist · Chrome remotely-hosted-code policy · Chrome 124
WebGPU-in-workers blog · HF TextStreamer + tool-template docs ·
Qwen3-1.7B-ONNX blob sizes (HF API) · LlamaWeb paper
(arXiv 2605.20706) · SitePoint WebGPU-vs-WASM benchmark · Mozilla gfx
blog (Firefox 141 WebGPU) · transformers.js-examples
(browser-extension sample).
