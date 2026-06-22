# Subagent design intent

> Recorded during the conversation that built the engine arc, before
> implementation. Settled decisions — not a debate.

## The claim

**Subagents are an orchestration primitive in `peerd-runtime`, not a
fourth engine kind.** Sessions are the right data shape. A subagent
is just a session with parentage.

## Async by default (DESIGN-11)

`spawn_subagent` is **non-blocking by default**: the tool returns a handle
immediately, the parent turn ends, the child runs fire-and-forget in the
live SW, and on completion its result re-enters the PARENT session as a
single coalesced **synthetic wake turn** (`runUserTurn({ synthetic: true })`)
pushed via `turnSlots.runWhenIdle` — so it never aborts the parent's live
turn (DECISIONS #20). The wake framing is trusted; the child's result is
`wrapUntrusted`. `sync:true` keeps the blocking path (return the result
in-turn) for "I need it to answer THIS turn"; the do/get/check runner (the
`subagent/spawn` route) stays synchronous regardless. In-session only — a
child lost to SW death is reported `interrupted` on the next drain; the
durable variant (survive a browser restart) is the DESIGN-08 appendix in
`specs/FEATURE-SCHEDULED-TASKS.md`.
Per-parent cap: 4 outstanding (`subagent_tasks` to peek, `subagent_cancel`
to drop one). Full design: `specs/DESIGN-11-async-subagents.md`.

## Why a subagent isn't an engine kind

The engine kinds (WebVM, Notebook, App, and the headless `js_run`
worker) answer **"where does this code run?"** — they're environments. A
subagent doesn't pick an environment; a subagent commands them. Making
subagents *another* engine kind would mean either duplicating environment
plumbing for no reason or admitting it's an orchestration concept
misfiled.

A subagent is **"who is reasoning about the next step?"** That's the
agent loop. That's the *r* letter (peerd-runtime), not the *e* letter
(peerd-engine).

## Data model

Two fields added to the existing Session record (no new shape):

```ts
parentSessionId?: string                // who spawned this; null for top-level
kind:             'chat' | 'subagent'   // default 'chat'
task?:            string                // spawning prompt; subagents only
depth:            number                // 0 for top-level
```

`/chats` filters to `kind === 'chat'`. Subagent sessions are
inspectable but don't clutter the chat list. They're discovered
through their parent's transcript: the parent's `spawn_subagent`
tool card expands inline to render the child's full transcript,
indented. Recursive.

## Isolation is a SESSION boundary, not a RESOURCE boundary

A subagent is a pure function — task text in, result text out — and its
session is isolated: it does NOT inherit the parent's *current* VM / tab /
sandbox (the per-session MRU defaults). That is the only isolation.

It is NOT a sandbox around the world's resources. The VM registry, tab
tracker, JS-sandbox and App catalogs are all **global, addressable by
id from any session** (`vmRegistry.get(id)` / `list()` by name resolve
cross-session; there's no owner check). So the agent-as-a-function shape
extends to resources: a child told "create a VM and run X" creates one in
the global catalog and **returns its handle** ("…done — it's `vm-abc`")
just like any return value. The parent (or a later child) then targets
`vm-abc` by id — full visibility, no shared mutable state, no leakage.

Practical rule for the orchestrator: pass a child the ids it should act
on; have it return any handle it creates. Don't assume a child sees the
parent's "current" anything.

## The two surfaces

One engine, two call sites:

| Surface | Caller | Shape | Use case |
|---|---|---|---|
| `spawn_subagent` tool | the model, in chat | one tool call per subtask, one after another (each a visible chip) | the model decomposing / parallelizing **its own** work |
| `peerd.runAgent({task, tools})` | code inside an App or Notebook the agent **built** | a function call from within an artifact | letting a built artifact **embed its own agent** (e.g. a chat box) |

These are NOT interchangeable, and `peerd.runAgent` is NOT an
orchestration shortcut for the model. The model parallelizes its own
work through the `spawn_subagent` tool — which is **async by default**
(non-blocking; the result arrives on a later turn) and fans out by
emitting several calls in one message, or `sync: true` to fan out N
reasoners and compare them this turn. Each renders as a chip, so the
user sees the delegation. `runAgent` exists so that an app or Notebook
the agent builds *for the user* can call a model from inside itself —
that's the whole point of it. Do NOT write sandbox code that
`Promise.all`s `runAgent` to fan out the agent's own tasks; that's what
`spawn_subagent` is for, and concurrency is no excuse — `spawn_subagent`
is already concurrent.

**It buys no isolation, either.** `runAgent` from a sandbox does not run
the spawned agent in that sandbox's realm: the request is relayed to the
SW (`subagent/spawn`) and the agent loop runs there, same heap as any
subagent, with only the result string posted back into the worker. So
"fan out via a sandbox" gives the children zero extra heap isolation over
`spawn_subagent` — it just hides the delegation. (The realm boundary is
for untrusted *code*, not reasoning loops: a subagent that needs to run
risky code calls `js_run`/a Notebook, and the *code* gets the isolate.)

Both route through the same orchestrator. Same audit, same gates,
same trust inheritance.

## Guardrails (non-optional)

1. **maxDepth** — default 5. `parent.depth + 1 > maxDepth` → refuse.
2. **Tool narrowing** — by default, subagent inherits parent's tools
   MINUS `spawn_subagent`. Opt-in `allowRecursion: true` to keep it.
   Caller can pass explicit `tools: [...]` subset.
3. **Trust mode inheritance** — subagent runs through the same six
   gates with parent's trust mode. No escalation.
4. **Audit** — every subagent action audits with `parentSessionId`
   + `depth`.
5. **Step + token cap** — `maxSteps` (default 20) and
   `maxOutputTokens` (default 4096) per spawn.

## Specifically NOT to do

- A new "subagent" engine kind alongside VM/Sandbox/App.
- A `subagent-tab/` page.
- Top-level subagent chats cluttering the chat list.
- A separate "detached worker" kind for ephemeral compute (the JS
  Sandbox already is one — if persistence is wrong, fix Sandbox).
- Using `peerd.runAgent` to fan out the model's OWN work (a scratch
  sandbox that `Promise.all`s runs). The model parallelizes by emitting
  multiple `spawn_subagent` tool calls; `runAgent` is only for apps the
  agent builds that embed an agent inside themselves.

## Example use cases

Model-driven (chat → subagent):

> User: research these three libraries and compare them
> Model: spawns three `spawn_subagent` calls, gets three structured
>        reports back, synthesizes a comparison.

Artifact-embedded (an App the agent BUILT → `peerd.runAgent`):

```js
// script.js of a "research assistant" App the agent built for the user.
// The artifact itself is agentic: its chat box calls a model per message.
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { result } = await peerd.runAgent({
    task: input.value,
    tools: ['web_search', 'read_article'],
    maxSteps: 10,
  });
  renderReply(result);
});
```

The agent shipped an app that can reason on its own. That's the
agent-as-a-function shape — a real piece of peerd's identity going
forward, and the ONLY thing `peerd.runAgent` is for. When the model
needs to parallelize *its own* work, it spawns `spawn_subagent` tool
calls in the chat instead.
