# local-runner bench — Gemma-4-E2B (WebGPU) vs Haiku

A throwaway dev bench to answer the one open question in
[`../LOCAL-INFERENCE.md`](../LOCAL-INFERENCE.md): is a local 2B model
**good enough** (and fast enough) to back the do/get/check **read path**
(`get`/`check`), instead of Haiku?

It runs three realistic runner read-prompts (peerd-style pseudo-a11y page
snapshots + a read task) on **Gemma-4-E2B** locally via WebGPU, side by side
with **Haiku**, and reports prefill TTFT, decode tok/s, total latency, and the
raw outputs so you can eyeball correctness.

## Run it

WebGPU is required (Chrome/Edge), served from `localhost` or `https`:

```sh
cd docs/local-inference-bench
python3 -m http.server 8000
# open http://localhost:8000
```

1. Click **Load Gemma** — first run downloads ~2–3 GB (cached after).
2. (Optional) paste an Anthropic key to populate the Haiku column.
3. Click **Run** — first generation warms up (one-time WebGPU shader compile),
   then the three prompts run.

## Reading the result

- **Quality:** does Gemma's answer match Haiku's / the snapshot? This is the
  "good enough" call for the read path.
- **Latency:** local has no network hop but pays *prefill* on your GPU; Haiku
  pays the round-trip but prefills server-side. For single-pass reads this is a
  fair fight; for the multi-step `do` action loop it is not (prefill-per-step) —
  which is why only the read path is the candidate.

## NB

This bench loads `@huggingface/transformers` from a CDN — fine for a dev bench,
**not** how the shippable feature would work. Productionizing means vendoring
transformers.js + ONNX-Runtime WASM locally (CWS-clean) and hosting the model in
the offscreen doc like the Moonshine voice model. See `LOCAL-INFERENCE.md` →
"Natural target".
