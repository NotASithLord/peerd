# peerd messaging reference

> Internal working reference. Product and security claims defer to the current
> source, `CLAUDE.md`, `SECURITY.md`, and `docs/security/THREAT-MODEL.md`.
> Re-check those sources before publishing release-specific copy.

## Positioning spine

**Category:** The browser-native agent harness.

**Immediate promise:** Run general-purpose agents inside your own Chrome or
Firefox — no cloud browser or MCP connection required.

**Thesis:** Most agent systems treat the browser as another remote tool. peerd
treats the browser as the harness. That matters because the browser already
contains both sides of the agent problem: enormous capability and decades of
isolation designed for hostile content.

**Architectural contrast:** Remote harnesses outsource the browser and reach
back through a cloud session or tool connection. Local host harnesses can pose
the larger authority problem: the reasoning loop often runs with broad or
effectively full access to the shell, filesystem, credentials, and browser
sessions. peerd takes a third path—local to the user, but inside browser
boundaries rather than ambient host authority.

**Security posture:** Prompt injection is a containment problem, not a filtering
problem. Assume hostile content can influence reasoning; prevent that reasoning
from automatically inheriting credentials and broad authority.

**Capability posture:** The browser is the runtime, not just the target. Web
automation is one surface alongside adaptive site clients, code-first browser
work, local compute, Apps, persistent workspaces, memory, delegation, lifecycle
recovery, model choice, and preview P2P.

## Approved anchor lines

- The browser-native agent harness.
- The browser is both the capability surface and the security boundary.
- The web already solved the shape of this problem.
- Local does not have to mean ambient authority over the host.
- Assume the page wins the prompt injection.
- A mixture of actors, not one omnipotent agent.
- Capability is composed. Authority is not ambient.
- The browser is the runtime, not just the target.
- What if the browser wasn't another tool for the agent, but the harness itself?

Use a few per page. Do not turn them into a slogan wall.

## Product architecture

### peerd

The runtime, platform, and open-source project. Do not define peerd as an
extension; the Extension is its current primary distribution.

### Peerd Extension

Current distribution and launch CTA. It adds the peerd runtime to a browser the
user already has. Store links replace source/preview installation once they are
live. Until then, say exactly which install path is available.

### Future product architecture — internal only, embargoed

Keep the following names and roles here for continuity, but do not name, tease,
pre-position, or imply them in public copy. Move a product into public messaging
only when it has its own deliberate announcement brief.

#### Peerd Browser

A dedicated AI-native browser built around the peerd runtime. The durable split
for a future announcement is: the Extension brings peerd to the browser a user
already has; the Browser builds the browser around peerd. Do not offer a
download, imply availability, or invent capabilities before announcement.

#### Peerd Hub

Reserved consumer name for future discovery and distribution of Apps, games,
and other peerd artifacts. `dwapp` remains a technical term. Do not present a
marketplace before one exists or adopt crypto/Web3 aesthetics.

#### Peerd Professional

Reserved name for a future organizational offering. Do not invent pricing or
claim deployment, governance, identity, audit export, or support features are
available.

#### Peerd Inference

Reserved name for a possible optional managed-inference surface. The durable
rule is that the runtime remains useful with BYOK and supported local providers.
Prefer “no Peerd account or hosted agent backend is required” over “no backend
ever.”

## Claims and evidence

| Claim shape | Canonical evidence |
|---|---|
| Actor exposure, narrowing, and instance pins | `extension/peerd-runtime/tools/exposure.js`, `tools/gates.js` |
| Chrome Worker-heap isolation and Firefox fallback | `actor/actor-worker-core.js`, `background/offscreen-actor-client.js`, threat-model residual risks |
| Site clients | `extension/peerd-runtime/site-clients/`, `tools/defs/site-client-*.js` |
| Code-first page interaction | `tools/defs/page-code.js`, `actor/page-api.js`, channel defaults |
| Execution environments and Apps | `extension/peerd-engine/index.js`, `engine-tabs/`, repository service |
| Lifecycle and replay behavior | `extension/peerd-runtime/lifecycle/`, lifecycle tests |
| Provider/model availability | `extension/peerd-provider/registry.js` |
| Store/preview and browser differences | `packaging/gen-manifest.ts`, `packaging/default-settings.mjs` |
| P2P/A2A status | `extension/peerd-distributed/`, `actor/a2a-*.js`, channel config |
| Privacy and current data practices | `docs/store/PRIVACY.md`, reviewer notes, current package code |

Never copy a live inventory, count, timeout, cap, version, or browser gate into
durable marketing prose when the source can be linked instead.

## Security language

Say:

- peerd assumes hostile content can influence an actor.
- the architecture tries to contain what that reasoning can reach.
- provider credentials stay behind privileged brokers.
- actor tool calls are reconstructed and checked again at the privileged
  boundary.
- Chrome gives non-orchestrator loops dedicated keyless Worker heaps.
- the current Firefox fallback does not provide the same heap boundary.
- ambiguous non-idempotent outcomes are not automatically replayed.
- the threat model names residual risk and out-of-scope compromise.

Do not say:

- peerd solves prompt injection;
- secure AI, fully secure, unhackable, or keys can never be stolen;
- the browser solved security;
- every browser has identical isolation or compute support;
- no backend ever or no telemetry ever;
- every outbound byte goes only to the model provider;
- the audit log is tamper-proof.

Security copy should explain the boundary and link to the threat model. It
should not paraphrase the entire threat model or hide its browser differences.

## Voice

Write like a technically opinionated solo builder:

- precise, concise, and evidence-oriented;
- confident about architecture, modest about guarantees;
- specific about effects and failure modes;
- willing to name a conventional architectural tradeoff;
- sparse with first person, adjectives, and exclamation points.

Prefer:

> If a side effect may have landed before a worker died, peerd records the
> outcome as unknown instead of blindly retrying it.

Avoid:

> Revolutionary, enterprise-grade reliability for autonomous workflows.

## Content pillars

### Surprising capability demonstrations

Boot Linux in a tab, build an App, run a compiled WASI tool, operate a page with
code, reuse an adaptive site client, version a browser workspace with Git, or
show direct browser-to-browser A2A. Demonstrate one thing at a time.

### Security architecture

Use hostile-page scenarios to explain keyless actors, brokered credentials,
origin boundaries, egress gates, side-effect uncertainty, replay protection,
and why prompt text is not a boundary.

### Browser-native thesis

Explain why sessions and identity already live locally, why a cloud browser is
not the same environment, and why the browser is simultaneously an application
runtime and a mature hostile-content boundary.

### Building in public

Translate a technical decision or adversarial finding into the user-visible
tradeoff it changed. Be honest about browser limitations and unfinished work.

### Weird proofs

Use WebGPU software, games such as Charon, P2P distribution, and unusual Apps as
proof that the runtime is broader than web automation. Present them as demos or
technical proofs; never redefine peerd around the stunt.

## Marketing-agent loop

For each material product change:

1. What changed in behavior, not just code?
2. What does it mean for a user?
3. Which peerd thesis does it prove?
4. Is there a surprising technical fact?
5. Can the effect be demonstrated visually?
6. Which audience actually cares?
7. Is the right output a post, thread, demo, article, launch note, or nothing?
8. Draft one idea in the right format.
9. Require human approval before publishing until the loop has earned trust.

Do not turn the account into a commit feed.

## Examples: code change to meaning

**Weak:** Added lifecycle recovery.

**Useful:** What happens if your browser kills an agent immediately after it
clicks Send? “Failed” and “maybe sent” are different states. peerd records the
difference and will not blindly send it twice.

**Weak:** Implemented site-client persistence.

**Useful:** Why should an agent rediscover the same website every time? A peerd
web actor can derive an origin-scoped client, ask before saving it, and reuse the
programmatic interface on the next visit.

**Weak:** Added browser-native Git.

**Useful:** An App built inside your browser should have history like any other
software project. peerd now versions browser-local App and Notebook workspaces,
shows diffs, restores earlier states, and can attach a remote without exporting
the project first.

## Publication checklist

- The Extension is the primary action.
- No unannounced product is named, teased, or implied.
- Browser/channel claims match packaging and the threat model.
- Provider, tool, test, and artifact inventories point to their live source.
- Current privacy language is scoped to the current product contract; it does
  not promise that Peerd will never operate an optional service.
- Security copy links to the formal threat model and does not imply absolute
  protection.
- Metadata, README, homepage, docs, store copy, and reusable social previews use
  the same category and immediate promise.
- Every launch visual follows the monochrome surface + five-color wordmark rule.
