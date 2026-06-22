# DESIGN-15 — local bridge: subscription transport (ACP) and the MCP question

> Status: DESIGN — and partly a THESIS DECISION, not just an
> implementation. Nothing here is implemented. Feature number 15.
> Two distinct asks are folded together here because users conflate them;
> this doc's first job is to pull them apart. Read DESIGN.md's provider
> section and `docs/LOCAL-INFERENCE.md` first.

## Two asks that look like one

**Ask A — ride a subscription (the field request).** From a user thread:
"is it possible for this model to use ACP on a local server to get access
to subscription codex/claude? … piggybacking on subscriptions instead of
using api would be great." The pain is real: BYOK pay-per-token is
expensive next to a flat Claude Pro/Max or ChatGPT subscription the user
already pays for. The same thread notes sonnet-in-peerd already
out-performs sonnet-in-the-Claude-app for tool-use tasks — so the model
quality is there; the *billing path* is the friction.

**Ask B — MCP-localhost / a constrained MCP bridge (the roadmap bullet).**
Let the agent reach local **tools** (a real filesystem, a local DB, a
native app) via an MCP client.

These are different layers. **A is a model transport** (how completions
arrive). **B is a tool surface** (what the agent can do). A slots cleanly
into peerd's existing provider architecture. B collides head-on with a
publicly-stated peerd thesis. Treat them separately.

---

## Ask A — subscription transport via a local bridge

### It fits the architecture (Ollama is the precedent)

peerd's provider layer is clean DI: an adapter is a frozen descriptor
(`name`, `label`, `defaultModel`, `vaultSecretName`, `call`, optional
`keyless`, optional `listModels`) whose `call` is an async generator
yielding the standard `ProviderEvent` union (`text-delta`,
`tool-use-start/delta/stop`, `usage`, `message-stop`, …). The **Ollama
adapter already talks to `http://localhost:11434`**, keyless, with
`http://localhost:11434` + `http://127.0.0.1:11434` in
`HARDCODED_ALLOWLIST` and the port declared in `connect-src` in
`manifests/base.json`. A subscription bridge is the same shape pointed at
a different local port.

The bridge itself is a **small local server the user runs** — exactly
like running `ollama serve`. It holds the subscription session (a logged-
in Claude Code / Codex CLI, or a thin shim) and exposes a streaming HTTP
endpoint on loopback. peerd never sees the subscription credentials; they
live in the user's local process. peerd stays "no backend, no peerd
cloud" — the server is the *user's*, on *their* machine, same trust
posture as Ollama. **This does not violate the no-hosted-gateway thesis.**

### The catch: "ACP" is an agent protocol, not a completion API

Worth being precise, because it changes the design. ACP (Zed's Agent
Client Protocol) is JSON-RPC between an *editor* and an *agent process*:
the agent runs its own loop on the far side and streams back results plus
*its own* tool-call requests. If peerd spoke raw ACP, peerd would be
delegating the agent loop to the external agent for that turn — and
peerd's six-gate dispatcher, denylist, and confirm prompts would **not
see** the intermediate tool calls the far-side agent makes. That guts the
security model. So:

- **Phase 1 (recommended): a completion-style local bridge.** The bridge
  exposes an **OpenAI-compatible** streaming endpoint (the format peerd's
  OpenRouter adapter already speaks) backed by the subscription. peerd
  treats it as a normal provider: it sends messages + tool schemas,
  receives text + `tool_use` deltas, and **executes every tool itself
  through the existing gates.** The far side is a *model*, not an agent.
  This is a near-clone of the OpenRouter adapter pointed at localhost +
  the Ollama adapter's localhost/keyless/`OllamaNotRunningError`
  ergonomics. Slots in with: one adapter file, one allowlist entry, one
  CSP port, and the providers UI auto-handles it (keyless descriptor).
- **Phase 2 (flagged, later, more invasive): true ACP delegation.** peerd
  hands a task to a far-side *agent* and renders its stream. This is a
  different product mode ("remote brain") with its own threat model — the
  local agent's tool calls bypass peerd's gates by definition. Preview
  channel only, off by default, and only after a written threat model.
  Do not build this to satisfy Ask A; Phase 1 satisfies Ask A.

### Honest caveats to put in front of the user

- **Terms of service.** Driving a Pro/Max or Plus subscription through a
  non-official client to power a *third* application may violate the
  provider's ToS and risk the account. This is the user's call, but the
  Settings UI for this provider must say so plainly — peerd should not
  quietly encourage an account ban. (`// why:` a one-line warning in the
  provider card, not buried in docs.)
- **It's still BYO-server.** The user runs and authenticates the bridge.
  peerd ships the adapter, not the subscription plumbing. Document the
  reference bridge in `docs/LOCAL-INFERENCE.md` (or a sibling
  `docs/LOCAL-BRIDGE.md`); do not vendor or bundle it.
- **Loopback only.** The adapter targets `127.0.0.1`/`localhost` on a
  fixed port, allowlisted exactly (the allowlist matches origins exactly,
  no wildcards). No LAN, no remote bridge — that would reintroduce the
  hosted-gateway the thesis rejects and an SSRF surface.

### Implementation sketch (Phase 1)

1. `extension/peerd-provider/adapters/local-bridge.js` — descriptor
   `{ name:'local-bridge', label:'Local subscription bridge', keyless:true,
   vaultSecretName:null, call: callLocalBridge, listModels }`. `call`
   reuses the OpenAI-compatible streaming mapper (factor the shared bits
   out of the OpenRouter adapter rather than copy-paste). Map a
   connection-refused `TypeError` to a typed `BridgeNotRunningError` with
   an actionable message, mirroring `OllamaNotRunningError`.
2. Register it in `peerd-provider/registry.js` alongside the others.
3. Add the loopback origin (e.g. `http://127.0.0.1:8765`) to
   `HARDCODED_ALLOWLIST` and to `connect-src` in `manifests/base.json`;
   regenerate (`bun run gen:dev`).
4. Settings: the providers section already renders keyless providers and
   has a "test" path that pings `listModels` — it picks this up with no
   new UI beyond the ToS warning line.
5. Bun tests for the stream mapper (values in / events out — no browser);
   reuse the OpenRouter adapter's test fixtures.

---

## Ask B — the MCP question (a thesis decision, surfaced honestly)

peerd **currently and publicly rejects MCP.** This is not an oversight to
quietly patch; it is written into the marketing site FAQ, ARCHITECTURE.md,
and multiple design docs:

> "Why doesn't peerd support MCP? MCP exists to bridge agents to tools
> they can't otherwise reach. peerd doesn't need that bridge. Tabs
> replace MCP for web browsing; scripting replaces MCP for shell;
> call_api replaces MCP for APIs. WebVM replaces MCP for shell. WebRTC
> replaces MCP for agent-to-agent comms. Shipping MCP would dilute the
> thesis and entangle a hosted gateway or sidecar." — peerd.ai FAQ

So adding MCP-localhost is a **product-thesis change**, and the owner
should make it as one. Three honest options:

### Option B0 — hold the line (status quo)

For the open web and shell, the thesis is *correct*: tabs + scripting +
`call_api` + WebVM genuinely cover what MCP-for-web/shell would add, with
zero sidecar. If the demand is really "reach websites/APIs/shell," the
answer is the native path, and MCP buys nothing but a dependency.

### Option B1 — a constrained, localhost-only MCP **client** (recommended IF we move)

The one place the thesis has a real hole: **local resources the browser
sandbox fundamentally cannot reach** — the user's *real* filesystem
(outside WebVM's virtual disk), a local Postgres, a native desktop app,
attached hardware. Tabs and WebVM can't touch those; that is precisely
the gap MCP was invented for. A *narrow* carve-out earns its place:

- **MCP client only, localhost stdio/HTTP servers only.** peerd connects
  to MCP servers the user explicitly installs and that run on their
  machine. No remote MCP, no hosted gateway — the thesis's actual red
  line ("entangle a hosted gateway or sidecar") stays intact.
- **Tools flow through the full six-gate dispatcher.** An MCP tool is
  registered like any other tool def; it passes persona/exposure/origin/
  confirmation/egress/audit. MCP does *not* get a side door around the
  gates — that is the whole point of routing it through the dispatcher.
- **Explicit per-server install, preview channel only.** Like remote
  skill install (`REMOTE_SKILL_INSTALL`), gate it behind a flag that is
  OFF for the store build. CI continues to verify the store package is
  MCP-free, same as the dweb-trace check.
- **The honest framing:** MCP-localhost is for what the browser *can't*
  do, never for what tabs already do. The FAQ answer would change from
  "no MCP" to "no *remote* MCP; localhost MCP only for resources the
  sandbox can't reach, all tools gated."

### Option B2 — full MCP (remote + local). Not recommended.

This is the thesis reversal in full, with the hosted-gateway entanglement
the project explicitly chose against. No.

### Recommendation

Ship **Ask A Phase 1** now (it's aligned, useful, and low-risk). Treat
**Ask B as a deliberate owner decision** — my recommendation is **B0 for
the web/shell story (hold), B1 only if and when a concrete "reach a local
resource the browser can't" need shows up**, behind a preview flag, all
tools gated, store build verified MCP-free. Do not bundle B into the
subscription-transport work; they only *sound* like one feature.

## Phasing

1. **Local subscription bridge adapter** (Ask A Phase 1). Adapter +
   allowlist + CSP + ToS warning + reference-bridge doc.
2. **(Decision gate.)** Owner decides on the MCP thesis. If "hold," update
   nothing and keep the FAQ. If "B1," write `docs/MCP-LOCALHOST.md` with
   the threat model first.
3. **Constrained localhost MCP client** (only if B1 chosen). Preview
   channel, flag-gated, dispatcher-routed, store-stripped + CI-verified.
4. **(Far future, flagged.)** True ACP agent delegation (Ask A Phase 2),
   own threat model, preview only.

## Security / invariants

- The bridge target is loopback-only, allowlisted exactly, declared in
  CSP. No LAN/remote target — that resurrects the hosted-gateway the
  thesis rejects.
- Phase-1 bridge tools are peerd's own tools through peerd's own gates;
  the far side is a *model*, never an agent that acts behind the gates.
- Subscription credentials never enter peerd; they live in the user's
  local bridge process. peerd holds no key for a keyless provider.
- Any MCP work routes every tool through the six-gate dispatcher + the
  denylist + audit, ships preview-only behind a flag, and is stripped +
  CI-verified-absent from the store build.
- The ToS risk of subscription piggybacking is the user's to take, but
  must be stated plainly in the provider UI — not hidden.

## Open questions

- Is there an existing OSS subscription→OpenAI-compatible bridge worth
  pointing users at (so peerd ships only the adapter), or does peerd need
  a reference bridge in `signaling-node/`-style sibling tooling? Survey
  before building.
- Does the store-channel ever want the subscription bridge? It's
  localhost + keyless like Ollama, which *does* ship to store — so
  probably yes, modulo the ToS-warning review. Confirm with store policy
  (`docs/store/OPEN-DECISIONS.md`).
- For B1, stdio vs localhost-HTTP MCP transport from an extension SW:
  stdio needs native messaging (a host manifest); HTTP needs only a CSP
  port. HTTP-only is the lighter, more thesis-consistent first cut.
