# peerd-provider

> The **`p`** (cyan) in the peerd wordmark — the model layer.
> Pluggable adapters that turn one internal message shape into the wire
> format each model API expects, stream the response back, meter the
> cost, and never leak your key. Part of
> [peerd](../../README.md); read the root README first for the whole
> picture, then [`ARCHITECTURE.md`](../../ARCHITECTURE.md) for how the
> five modules fit together.

**Status: 0.x — experimental beta.** Three adapters ship today
(Anthropic, OpenRouter, Ollama). The OpenAI adapter and native
in-browser WebGPU inference are not built yet; see
[TODO / backlog](#todo--backlog). The pricing table is a dated snapshot
and will drift against vendor price changes between releases.

---

## What it does

`peerd-provider` is the only place in the codebase that knows how to
talk to a model API. Everything above it (the agent loop, subagents,
the review subagent, goal mode) speaks one provider-agnostic message shape;
this module translates that shape to and from each vendor's wire format,
handles streaming, retries, prompt caching, extended thinking, and turns
token usage into a dollar figure for the cost meter.

It is a registry of adapters. Anthropic, OpenRouter, and Ollama
register themselves at module load; `callModel()` routes a request to
the named adapter and returns an async generator of normalized
`ProviderEvent`s. New providers are added by writing one adapter and
registering it; nothing else changes.

The agent's system prompt also lives here (`system-prompt.txt`, with a
dweb variant), since it is the text handed to whichever model runs.

## How it works today

### The three adapters

| Provider | Endpoint | Auth | Default model | Notes |
|---|---|---|---|---|
| **Anthropic** | `api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-dangerous-direct-browser-access` ack | `claude-sonnet-4-6` | Streaming `tool_use`, prompt caching, adaptive extended thinking |
| **OpenRouter** | `openrouter.ai/api/v1/chat/completions` | `Authorization: Bearer` | `openai/gpt-4o-mini` | OpenAI-compatible gateway to many vendors |
| **Ollama** | `localhost:11434` | none (keyless) | `qwen3:8b` | Fully local; live model inventory from `/api/tags` |

- **Anthropic** (`adapters/anthropic.js`) streams Server-Sent Events,
  carries three `cache_control` breakpoints (system, tools, last
  message), replays signed thinking blocks across turns, and retries
  429/500/503/529 with header-aware backoff
  (`retry-after`, then `anthropic-ratelimit-*-reset`, then exponential,
  clamped to 60s). Extended thinking is adaptive on 4.6+/Fable models
  (the model picks depth per request) and legacy `enabled + budget_tokens`
  on older ones.
- **OpenRouter** (`adapters/openrouter.js`) uses the OpenAI-compatible
  streaming format with `stream_options.include_usage` so token counts
  come back for the cost meter. Same retry ladder as Anthropic.
- **Ollama** (`adapters/ollama.js`) is keyless: no vault secret, no bill,
  nothing leaves the machine. It lists your pulled models live from
  `/api/tags`, uses a longer 120s connect timeout (cold model load off
  slow disk), and maps a refused connection to a "start it with
  `ollama serve`" error and a missing model to an `ollama pull <model>`
  hint. All local models price at $0.

### One internal shape, four translators

The `format/` layer is the seam that makes adapters cheap to add:

- `sse-parser.js` — a generic SSE reader (CRLF/LF, multi-line `data:`,
  UTF-8 multibyte boundaries).
- `to-anthropic.js` / `from-anthropic.js` — internal messages to and from
  Anthropic. Handles attachment blocks (images/PDFs as base64, stripped
  after first send with a metadata sentinel left behind), orphan
  `tool_use` repair, signed-thinking replay, and model-keyed thinking
  shape selection.
- `to-openai.js` / `from-openai.js` — internal messages to and from the
  OpenAI/chat-completions format, shared by both OpenRouter and Ollama
  (tool-call assembly by index, usage normalization, orphan `tool_call`
  repair).

Every adapter yields the same `ProviderEvent` union: text deltas,
reasoning deltas plus signed reasoning-stop, tool-use start/delta/stop,
usage, message-stop (with stop reason), error, and a rate-limit-pause
event the UI can surface as "retrying in Ns…".

### Resilience

`connect-timeout.js` guards the initial response headers with a timeout
(45s cloud, 120s Ollama) and clears it the moment headers arrive; the SSE
body then streams untimed. A network-level `TypeError` (connection drop
before headers) is retried up to three total attempts with a
500ms/1500ms backoff; mid-stream drops are marked `incomplete`, never
silently re-issued.

### Cost metering

`pricing.js` holds a dated rate table (USD per 1M tokens, four slots:
input / output / cache-read / cache-write) keyed by exact model id.
`costOf()` normalizes each provider's usage accounting into those four
counters and returns `{ cost, estimated }`, with `estimated: true` when
the model id isn't in the table and the provider isn't local ($0).
Per-session overrides let you patch a rate when a vendor changes prices
between peerd releases.

### Egress and key handling

The module never calls `fetch` directly. `safeFetch` and `getSecret`
are injected from `peerd-egress`: the provider endpoints are on a
hardcoded allowlist the model picker cannot override, and API keys are
read from the encrypted vault inside the service worker, used to build
the `Authorization` header, and never handed to any sandbox. See
[`peerd-egress`](../peerd-egress/README.md).

## Public API (`index.js`)

- **Registry / runtime:** `callModel(args)`, `listProviders()`,
  `listProviderModels(name, deps)`, `getProvider(name)`,
  `registerProvider(adapter)`, `unregisterProvider(name)`.
- **Adapters + defaults:** `anthropicAdapter` / `ANTHROPIC_DEFAULT_MODEL`,
  `openrouterAdapter` / `OPENROUTER_DEFAULT_MODEL`, `ollamaAdapter` /
  `OLLAMA_DEFAULT_MODEL`, plus `listOllamaModels()`.
- **Pricing:** `DEFAULT_PRICING`, `costOf()`, `resolvePricing()`,
  `hasPricing()`.
- **Ollama fit:** `OLLAMA_MODEL_TIERS`, `probeGpuCapability()`,
  `estimateUsableMemGB()`, `recommendOllamaModel()` (Settings recommends
  the largest model that fits your GPU/RAM).
- **Errors:** `ProviderError`, `ProviderKeyMissingError`,
  `ProviderHttpError`, `UnknownProviderError`, `OllamaNotRunningError`.

## Known limitations

- **No native OpenAI adapter.** `adapters/openai.js` does not exist;
  OpenRouter covers OpenAI models in the meantime. The wire-format
  translators it would need (`to/from-openai.js`) already ship.
- **No native in-browser inference.** Local WebGPU inference is deferred
  (see [`docs/LOCAL-INFERENCE.md`](../../docs/LOCAL-INFERENCE.md)).
  Ollama is the local-model path today.
- **The pricing table is a snapshot.** It is dated and hand-maintained;
  unknown models meter as `estimated`. Use the per-session override when
  a vendor's prices have moved.
- **No mid-stream resume.** Connection-drop retry only covers the
  pre-headers window; a drop mid-stream ends the turn as `incomplete`.
- **Manifest declares no hosts for unshipped adapters.** Per store
  policy, peerd never requests what the shipped version doesn't use.
  `<all_urls>` already covers HTTPS API hosts, and the Ollama loopback
  CSP entry is declared explicitly.

## TODO / backlog

These come from GitHub Issues and
[`docs/LOCAL-INFERENCE.md`](../../docs/LOCAL-INFERENCE.md); they are not
version-pinned.

- **OpenAI adapter** — a straightforward parallel to the Anthropic
  adapter (endpoint, bearer auth, the same retry/timeout machinery)
  reusing the existing OpenAI format layer.
- **Native local inference (`local-webgpu`) — DEFERRED.** Re-evaluated
  only when all hold: Ollama has proven the local-model demo (done),
  per-session tool-exposure manifests exist (done), and a ≤2 GB q4f16
  instruct model does reliable function calling over a trimmed tool set.
  Scope when built: Transformers.js, WebGPU-only, hosted in the
  offscreen doc, weights as SRI-pinned downloads (the Moonshine
  pattern); positioned as a "local quick mode", not the full agent loop.
- **Richer provider-error mapping** — surface vendor error codes beyond
  the current 1 KB body excerpt.

## See also

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — module organization.
- [`DESIGN.md`](../../DESIGN.md) — provider streaming, caching, and the
  thinking-replay details in the full design record.
- [`docs/LOCAL-INFERENCE.md`](../../docs/LOCAL-INFERENCE.md) — the
  deferred WebGPU-inference study.
- [`peerd-egress`](../peerd-egress/README.md) — where keys live and how
  egress is gated.
