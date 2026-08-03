# Design 6 — `peerd:toolbox/<name>`: agent-authored reusable modules

## Problem

The agent has no way to write a general helper once and reuse it across
runs, sessions, and surfaces. Skills are markdown-only playbooks ("a skill
is a playbook, not a privilege grant"); hooks are user-authored; the one
shipped exception — DESIGN-19 site clients — proved the pattern for exactly
one domain (per-origin API modules): durable agent-written code + pinned
capability + treat-as-cache contract + patch tool. This design generalizes
that pattern into a small, named library of the agent's own utilities:
`import { dedupeRows } from 'peerd:toolbox/tables'`.

This is "skills with a code tier" WITHOUT touching the skills trust rule:
toolbox code never enters a prompt; it only ever executes inside the sealed
worker under the calling run's capability profile.

## Shape

### Storage — copy the site-client store discipline

New IDB DB `peerd-toolbox`, two-tier like `site-clients/store.js`:

- META (the dossier, listed cheaply): `{ name, description, exports:
  string[], createdAt, updatedAt, runCount, failCount }`.
- BODY: the module source, read only at resolution time.

Separate DB from skills AND from site clients, for the same structural
reason site clients got their own: a toolbox module must never be loadable
as a skill (prompt injection via self-authored code) and never be runnable
against an origin pin it wasn't written for. Names: `[a-z0-9-]{1,64}`,
flat namespace v1.

### Resolution — a builtins-shaped read, not a magic global

The resolver already supports builtins mapping bare specifiers
(`module-resolver.js` `builtins`) and host-injected `readFile`. Toolbox
rides the second path: specifiers matching `peerd:toolbox/<name>` are
resolved via a new injected dep `readToolboxModule(name)` →

- headless: `offscreen/job-runner.js` relays a `toolbox-request` to an SW
  route that reads the BODY store;
- notebook tab: same SW route via the tab's relay.

The fetched source is then transformed and blobbed EXACTLY like a local
OPFS module — meaning a toolbox module may itself import `peerd:std` or
other toolbox modules (cycle detection already exists in the resolver).
Explicit imports, visible and deletable — DECISIONS #21 spirit; no ambient
injection.

### Authoring tools

Three main-agent tools (the toolbox is the ORCHESTRATOR's asset, unlike
instance files — nothing here reads foreign bytes):

- `toolbox_write { name, description, code }` — create/update. Classifies
  as a workspace write (confirm under the same policy as other writes).
  Validated: size cap (reuse the `js_write_file` ceiling), name shape,
  parse check (the resolver's transform run against the body at write time
  so a syntax error fails the WRITE, not some future run).
- `toolbox_list` — metas only, fence-free (dossiers are agent-authored...
  see the fencing rule below for why this needs one nuance).
- `toolbox_delete { name }`.

No `toolbox_read` in v1: the agent re-reads its own module by importing it
in a `script` run or rewriting it wholesale; a read tool adds an exposure
row for marginal value. (Revisit alongside `edit_file` support if modules
grow past rewrite-wholesale size.)

### The trust contract (the danger-zone section)

Who wrote a toolbox module? The main agent — but possibly on a turn whose
context contained fenced web bytes. So the body is AGENT-authored but
UNTRUSTED-INFLUENCED in the worst case, same class as a site client. The
consequences, in order:

1. **Execution grants nothing.** A toolbox import runs under the CALLING
   run's caps — it can do exactly what the run's own inline code could do,
   nothing more. No per-module capability, ever; a "toolbox module with
   its own powers" would be a privilege store and is out of scope
   permanently.
2. **Never in a prompt.** Bodies are execute-only. `toolbox_list` surfaces
   dossiers (name/description/exports) — those ARE model-visible, were
   model-authored, and could have been influence-laundered; render the
   description field inside a fence in the list output. Cheap and closes
   the loop.
3. **Which lanes resolve it**: `script` and `js_notebook` only (the
   own-compute lanes — matching where `provider.call` goes in Design 5).
   `page_code` / `site_client_run` / `a2a_run` do NOT get toolbox
   resolution: their profiles promise "this code + the pinned capability
   and nothing else", and a stored module is a side-channel into that
   promise. Enforced at the host relay (refuse `toolbox-request` unless the
   job params carry the flag) and by not injecting the resolver dep.
4. **Treat as cache**: same contract as site clients — a module may be
   stale or wrong; the run that hits a failure rewrites it
   (`toolbox_write`) or inlines the logic. `runCount`/`failCount` on the
   meta feed the dossier so the agent can see rot.

### Sharing (explicitly out of scope)

A toolbox module is per-install (per-profile once Profiles land). Exporting
one over the dweb = shipping code to peers = the dwapp/store lane with its
force-confirms, not a toolbox feature. Do not blur them.

## Touch points

| File | Change |
|---|---|
| new `extension/peerd-runtime/toolbox/store.js` (+`core.js`) | two-tier store, injected IDB, validation (copy `site-clients/` layout) |
| new `extension/peerd-runtime/tools/defs/toolbox-write.js` / `-list.js` / `-delete.js` | the tools |
| `extension/peerd-runtime/tools/defs/index.js` | register |
| `extension/peerd-engine/module-resolver.js` | `readToolboxModule` dep + `peerd:toolbox/` branch |
| `extension/offscreen/job-runner.js` + `engine-tabs/notebook-tab/notebook-tab.js` | resolution relay, lane-gated |
| `extension/background/service-worker.js` | `toolbox/read` route; inject store into tool ctx |
| `extension/peerd-runtime/tools/defs/script.js` / `js-create.js` | one lore sentence: "helpers you'll want again → toolbox_write" |

## Tests

- **Bun**: store over fake-indexeddb; name/size/parse validation; resolver
  branch with a fake `readToolboxModule` (toolbox→std import, toolbox→
  toolbox cycle refusal); dossier fence rendering.
- **In-browser**: write→import→run round trip headless; lane refusal for a
  `page_code`-profiled job; delete removes resolution.

## Open questions

1. Land order: after Design 1 (shared "durable = fence-influenced"
   vocabulary) — agree?
2. Should `toolbox_write` require the async user confirm the first time per
   session (it persists executable code)? Proposed: yes — same posture as
   `site_client_write`, and it's one flag on the existing confirm plumbing.
3. Cap on module count (propose 64) — worth enforcing, or let the size caps
   carry it?
