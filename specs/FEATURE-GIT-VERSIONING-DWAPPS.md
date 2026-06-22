# FEATURE — Git-backed versioning for Apps & dwapps (isomorphic-git)

> **Status:** SPEC — design/RFC, not yet built. Proposes vendoring
> [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) as the
> **version-history substrate** for peerd-generated Apps (CORE, store channel)
> and the **verifiable update stream** for dwapps (dweb, preview).
>
> **Read first:** `specs/FEATURE-APP-PERSISTENCE-DWAPPS.md` (the unified
> persistence/bundle model this lands on), `docs/distributed/PROPAGATION.md`
> ("App identity & versioning" — `dwapp_id`/`version_id`/signed-`head`),
> `extension/peerd-runtime/edit/snapshot-store.js` (today's "git object model in
> miniature"), `extension/shared/bundle/*` (the content-addressed bundle),
> `docs/DECISIONS.md` #25 (sandbox = isolate, tab = host), D-7 (CRDTs are
> app-layer), D-8 (app signing is domain-separated).
>
> **Modules:** the local repo + fs adapter + history/diff/revert = **CORE**
> (`shared/git` + `peerd-engine`, ships in the store channel, no
> `peerd-distributed` import). Release-as-signed-`head` + update propagation =
> **dweb** (`peerd-distributed`, preview-only behind the boundary seam). This is
> the **same core/dweb seam** `shared/bundle` (core) ↔ `content/*` (dweb signing)
> already runs on — git slots in beside it, it does not cross it.

---

## 0. The one-sentence thesis

peerd already content-addresses immutable snapshots (`shared/bundle`, SHA-256),
already chains them per turn (`snapshot-store.js`, "git in miniature"), and
already has a dwapp versioning RFC (stable `dwapp_id` + per-version `version_id`
+ a signed, no-downgrade `head` carrying a bare `seq`). **What's missing is
verifiable *history*: a parent link between versions, a diff, a changelog.**
isomorphic-git is exactly that missing layer — and it can be added *underneath*
the existing model without changing a single wire format, because git's SHA-1
object graph stays **local** and only peerd's existing SHA-256 manifest + Ed25519
signature ever cross a peer boundary.

This doc's job is to make that addition *complement* the settled decisions, not
relitigate them.

---

### 0.1 Two horizons this unlocks (owner framing, 2026-06-17)

The bet pays off at two very different scales, and the design serves **both**
from one substrate:

- **Near horizon — local dev ergonomics, no container.** Branches, diffs, and
  rollbacks for an App's OPFS files **without spinning up a CheerpX WebVM** just
  to run `git`. A real repo in the browser is grams, not the gigabytes of a
  Linux disk — the agent (and the user) get version control on every
  peerd-generated App for free, offline, in the store channel. This alone earns
  the dependency.
- **Far horizon — a p2p "GitHub."** The same local history, projected onto the
  dweb as a signed, content-addressed, no-downgrade release chain (§6), is the
  seed of a **serverless GitHub**: repos that live as dwapps, clone/pull over the
  mesh, and carry verifiable authorship — no central forge, no server. The
  curation layer (`list`/subscribe, PROTOCOL §7) is already the "follow / star /
  feed" graph such an app would render over.

The architecture below is sized so the near horizon ships cleanly on its own and
the far horizon is *additive* (the §6 dweb layer), never a rewrite of the core.

---

## 1. Why this is worth a vendored dependency (and the honest cost)

**What the agent and user get for Apps (core):**
- Real per-turn **history** with messages, not an opaque undo stack.
- Real **diffs** (`git diff <a> <b>`) — review's `diffSince` becomes a true
  three-dot diff instead of a hand-rolled before/after map.
- Real **rollback** — the "future rollback affordance" `checkpoint.js` already
  anticipates becomes `git checkout` / `git revert`, with a chain to walk.
- **Branches** — the agent can spike a risky refactor on a branch and throw it
  away, or keep two variants of an App.

**What dwapps get (dweb):**
- A **changelog**: commit subjects since the last release become the
  "what changed" the Library's "update available" badge can't show today.
- A **verifiable version chain**: each signed `head` amendment links to its
  predecessor (`prev = previous version_id`), so an installer can verify the
  publisher's release lineage, not just trust a monotonic integer.
- A standard, exportable format (a real `.git`), and a credible future path to
  GitHub/GitLab interop — *if* the CORS problem (§7) is ever worth solving.

**The honest cost — stated up front, decided in §11:**
- A vendored JS library of non-trivial size enters the **store** build (local
  versioning ships in the store channel). Mitigations in §4.4.
- isomorphic-git is **SHA-1-only** for object IDs. We confine SHA-1 to local
  authoring history; it is **never** the cross-peer integrity primitive (§6).
- It **overlaps** `snapshot-store.js`, which is purpose-built and lighter. We
  supersede it for Apps and keep it (for now) for Notebooks (§5.4) — a real
  rewire of a working feature, not a greenfield add.
- isomorphic-git is **MIT**, not Apache-2.0; the vendoring policy needs an
  explicit license exception (§4.4, §11-D6).

If after §11 the cost outweighs the win, the fallback is "extend the miniature"
— `snapshot-store.js` already has parent-linked content-addressed checkpoints;
adding a diff and a `prev`-chained published head is a smaller change. This spec
recommends git, but names the off-ramp.

---

## 2. The unified versioning model (the load-bearing statement)

State it once. There are **three identifiers**, at three layers, and they never
collapse into one:

| Identifier | Hash | Scope | Crosses the wire? | Owner |
|---|---|---|---|---|
| **git OID** | SHA-1 | one commit/tree/blob, **local only** | **No** | isomorphic-git, in OPFS |
| **`version_id`** | SHA-256 | one released snapshot bundle (`= manifestHash`) | **Yes** (the `peerd://` address) | `shared/bundle` (unchanged) |
| **`dwapp_id`** | SHA-256 | the app's stable identity `= H(publisher_did ‖ slug)` | **Yes** | `peerd-distributed/apps` (unchanged) |

And the **mapping** — this is the whole design:

```
   git working tree  (dir = peerd-apps/<id>/)         ← what packBundle reads
   git object store  (gitdir = peerd-app-git/<id>/)   ← history; NOT in the bundle
        │  git commit (per turn / per save) — message = changelog line
        ▼
   a RELEASE = git tree at commit C
        │  git archive(C) → packBundle({entry,files}) → buildManifest(...)
        ▼
   version_id = manifestHash  (SHA-256, the peerd:// address)   [shared/bundle, today]
        │  stored in app_content IDB (FEATURE-APP-PERSISTENCE §3.D)
        ▼
   DWAPP_META.head = sign({ version_id, content_addr, size, seq, prev, ts })   [dweb]
        │  prev = previous release's version_id  ← NEW, the verifiable-history link
        ▼
   the signed head CHAIN is the publisher's release history (no SHA-1 on the wire)
```

The key insight: **the git DAG is the local truth; the signed `head` chain is the
public, verifiable projection of it.** Git gives the author branches, merges, and
a hundred WIP commits; the public sees only the releases the author chose to
sign, linked into a chain. SHA-1's weakness can corrupt at most the author's own
local history (a self-DoS); it can never forge a release for an installer,
because every release is anchored by a SHA-256 manifest the publisher signs.

> **This is additive to PROPAGATION.md, not a rewrite.** That doc's `head`
> already carries `version_id`, `content_addr`, `size`, `seq`, `ts`, `sig`. We
> add **one optional field — `prev`** — and a derived **changelog** (commit
> subjects since the last release, carried by-reference or capped-inline). The
> no-downgrade `seq` rule (`library.js`), the `(publisher, slug)` identity, the
> popularity=availability eviction — all unchanged.

---

## 3. Architecture & the module boundary

Git slots onto the **exact seam** that already separates persistence (core) from
sharing (dweb).

```
CORE (store + preview) ───────────────────────────────────────────────────────
  vendor/isomorphic-git/          self-contained ESM + http/web client (vendored)
  shared/git/
    ├── fs-opfs.js                isomorphic-git fs adapter over peerd-engine/opfs.js
    ├── repo.js                   init / commit / log / diff / checkout helpers (pure-ish, IO injected)
    └── archive.js                git tree @ commit → { entry, files }  → feeds shared/bundle
  peerd-engine/
    └── (App save hook)           commit on app_create/app_update/debounced write; release = export.js

DWEB (preview only, behind loadDweb / DWEB_ENABLED) ───────────────────────────
  peerd-distributed/apps/
    ├── release.js                pack release → sign head amendment (D-8 domain sep) → publish
    └── (library.js, propagation) head.prev + changelog; "update available"; pull new snapshot
```

**Rules this respects (non-negotiable):**
- `shared/git` **must not import** `peerd-distributed` — exactly like
  `shared/bundle`. The dweb consumes it, never the reverse. The store package
  prunes the dweb module and the core git layer keeps working (local history,
  diff, rollback — all identity-free, all offline).
- isomorphic-git is vendored under `vendor/` with a `SOURCE.txt` (the cheerpx /
  mithril / xterm pattern), **no npm runtime**, loaded as a `'self'` ES module
  under MV3 CSP (`script-src 'self'`; it is plain JS, so no `wasm-unsafe-eval`
  needed).
- The sandboxed dwapp iframe **never** gets a git capability. Versioning is a
  *trusted-side* operation on the app's files — driven by the agent / SW / the
  app-tab parent, the same trust posture by which `bridge.js` reads an app's own
  files via `readAppFiles()` (the trusted parent), never the iframe. The frozen
  bridge surface (§`bridge.js`) does **not** grow a `git` op. (§6.4)

### 3.1 Where git runs (MV3 placement)

OPFS is origin-scoped and shared across every extension context (SW, offscreen,
tabs), so *where* git executes is a performance/lifetime choice, not a
correctness one. Recommendation:

- **The offscreen document hosts the git engine** (`offscreen/git-runner.js`),
  co-tenant with the headless `js_run` worker and the dweb mesh. why: (1) the
  vendored bundle loads **once** and stays warm, instead of cold-loading on every
  SW wake (the SW dies at 30s idle — DECISIONS #7/#14); (2) git ops are
  IO-bound OPFS work that suits a long-lived host; (3) it keeps the SW thin
  (orchestrator only), matching "imperative shell." The SW calls via the existing
  RPC port; the app-tab page calls via the same SW route.
- **Single-writer discipline.** Commits happen at a **turn boundary or an
  explicit save**, never concurrently with the tab's live editor. This is already
  how `checkpoint.capture` runs (post-turn, SW-driven); we keep the seam.
  isomorphic-git bundles `async-lock`; we additionally serialize per-`<id>` repo
  ops through one queue (mirrors `peerd-engine/command-queue.js`).

### 3.2 `dir` vs `gitdir` — the detail that keeps releases clean

isomorphic-git takes **separate** `dir` (working tree) and `gitdir` (object
store) parameters. We use that:

- `dir = peerd-apps/<id>/` — the live files the editor, `composeApp`, and
  `buildAppExport` already read. **Unchanged.**
- `gitdir = peerd-app-git/<id>/` — a *sibling* OPFS subtree holding the commit
  history.

why separate: if `.git` lived inside `peerd-apps/<id>/`, `packBundle` would sweep
the entire object database into every release bundle (bloat, and a leak of full
authoring history into a shared snapshot). Keeping `gitdir` a sibling means **a
release is exactly the working tree, and history stays home** unless the author
explicitly chooses deep-history transfer (§6.3, deferred). Deleting an App nukes
both subtrees (`opfs.nuke` on each root).

---

## 4. Vendoring isomorphic-git (the concrete integration)

### 4.1 What we vendor, and what we write ourselves

| Piece | Source | Notes |
|---|---|---|
| `isomorphic-git` core | the published **self-contained** ESM build | one file, no bare-specifier imports; deps (`pako`, `sha.js`, `async-lock`, …) are bundled in. Loadable as a `'self'` module — confirmed by its `<script src=".../isomorphic-git">` UMD usage and single-import ESM. |
| `isomorphic-git/http/web` | the published web http client | small, `fetch`-based; we **wrap** it (or replace it) so all traffic rides `safeFetch` (§4.3). |
| **fs adapter** | **we write it** (`shared/git/fs-opfs.js`) | NOT LightningFS — peerd's files already live in OPFS; a second IDB-backed fs would duplicate the store. |

> **Pin & verify before committing the spec to code.** Record the exact version
> and the SHA-256 of the entry file in `vendor/isomorphic-git/SOURCE.txt`
> (cheerpx pattern), with a `scripts/vendor-isomorphic-git.sh` reproducible
> fetch. Verify the published `index.js` is genuinely self-contained (no
> `import … from 'pako'`) at vendor time — the build is, but the gate must prove
> it, since a future upstream change to bare-specifier imports would silently
> break under MV3 (no resolver). Measure the minified size and put it in §11-D5.

### 4.2 The OPFS fs adapter (`shared/git/fs-opfs.js`)

isomorphic-git needs a Node-`fs`-shaped object. If it exposes an enumerable
`promises` property, the library uses **only** the promisified methods — so we
implement the promise API and skip `pify`. Required methods (8) + optional (3):

```
required: readFile, writeFile, unlink, readdir, mkdir, rmdir, stat, lstat
optional: readlink, symlink (only for repos with symlinks — Apps have none),
          chmod (unused; isomorphic-git rewrites the file to change mode)
```

`peerd-engine/opfs.js` already gives `read`/`write`/`delete`/`list`/`nuke` over a
rooted path; the adapter is a thin shim that adds the directory + stat semantics
git needs:

- **`stat`/`lstat`** → from the OPFS `File` (`size`, `lastModified` → `mtimeMs`)
  and entry kind (`getFileHandle` vs `getDirectoryHandle`) → return
  `{ type:'file'|'dir', mode, size, mtimeMs, ino, … , isFile(), isDirectory(),
  isSymbolicLink() }`. `mode` is synthesized (`0o100644` files, `0o040000`
  dirs) — OPFS has no POSIX modes, and git only needs the exec bit, which Apps
  don't use.
- **`readFile`** → bytes by default, `utf8` string when `{encoding:'utf8'}`
  (git reads loose objects as bytes, config/refs as text).
- **`mkdir`/`rmdir`/`readdir`/`unlink`** → straight OPFS directory-handle ops.
- **No symlinks** → `lstat` never reports `isSymbolicLink()`; `readlink`/`symlink`
  omitted. why fine: a no-symlink fs is explicitly supported, and a peerd App
  bundle is plain files (the loader already rejects path traversal).
- **Errors** must look like Node's: a missing path throws `{ code:'ENOENT' }`,
  an existing dir `{ code:'EEXIST' }` — isomorphic-git branches on `err.code`.

This adapter is **pure browser API over OPFS** and ships in core (no dweb, no
identity). It is the single riskiest piece to get right; it gets its own Bun-
shimmed + in-browser test suite (§10).

### 4.3 The http adapter (and why it's mostly moot for v1)

For *remote* git (clone/fetch/push to a server), isomorphic-git calls an
injected `http.request({url, method, headers, body})` returning
`{url, method, headers, body, statusCode, statusMessage}`. We route it through
**`safeFetch`** (`peerd-egress/fetch/`) so every git byte obeys the egress
allowlist + SSRF guard + audit — the existing chokepoint, no new egress path.

**But:** browsers enforce same-origin, and **GitHub does not send CORS headers**
for the git smart-HTTP endpoints. isomorphic-git's own docs say cloning/pushing
"must be done through a proxy" (the sponsored `cors.isomorphic-git.org`). peerd
ships **no third-party proxy** (privacy-first, no telemetry, reversibility) — so
**external git hosting is OUT OF SCOPE for v1** and, if ever added, is hard-gated
(§7). The http adapter is built and wired so the capability *exists* and is
auditable, but the **on-thesis path is git-over-dweb** (§6), where transport is
WebRTC + the content layer, not HTTP, and CORS never enters.

### 4.4 Size, license, CSP

- **CSP:** plain JS, loaded as `'self'`. No external script origin, no `blob:`,
  no `wasm-unsafe-eval`. No manifest change (§`MIGRATION.md §2` parity).
- **License:** isomorphic-git is **MIT**; bundled deps are MIT/ISC-family. The
  repo's "Apache-2.0 only" vendoring rule needs an **explicit MIT exception**
  recorded in `SOURCE.txt` + `DECISIONS.md` (MIT is Apache-2.0-compatible for
  redistribution; this is a policy ack, not a legal blocker). (§11-D6)
- **Store weight:** the §3.D SQLite-WASM call declined a ~1 MB payload partly on
  store-review weight; isomorphic-git is smaller and is JS not WASM, but it is
  **not free**. Mitigation: load it **only** in the offscreen git-runner (lazy,
  on first version op), never in the SW/sidepanel hot path; measure and record
  the exact size (§11-D5). If the size proves unacceptable for store, the
  fallback is to keep git **preview-only** and ship the miniature in store —
  but that splits the versioning UX across channels, so it's the lesser option.

---

## 5. The local layer (CORE — Apps, ships in the store channel)

### 5.1 Lifecycle: a repo per App, a commit per turn

- **On `app_create`:** `git.init({ dir, gitdir })`, write files, initial commit
  (`"create <name>"`). The App now has history from byte one.
- **On `app_update` / debounced `app_write_file` / a file-modifying turn:**
  commit the working tree. Commit **message** = the turn's intent (the agent's
  one-line summary, or the tool lineage the dispatcher already attaches), so the
  log reads like a changelog, not `"update"×40`.
- **Author identity for local commits:** a fixed, non-identifying author
  (`peerd <agent@local>`), NOT the dweb did. why: local commits must work with
  the dweb pruned and the vault locked; commit authorship is not a trust claim.
  The dweb identity signs *releases* (the `head` amendment), never commits (§6.1).
- **Reconcile with persistence §3.D:** the released **snapshot bundle** lives in
  the `app_content` IDB store (keyed by `contentHash` = `version_id`); the
  **commit history** lives in the OPFS `gitdir`. Two stores, two jobs — exactly
  the §3.D "live files = OPFS, saved bundle = IDB" split, extended: *history =
  OPFS gitdir, released snapshots = IDB app_content.*

### 5.2 Review's `diffSince` → real git diff

`edit/checkpoint.js` `diffSince` today materializes a checkpoint and hand-builds
`{path, status, before, after}`. With git it becomes
`git.walk`/`git.diff` between two commits (or commit↔worktree), which is more
correct (rename detection, binary-aware) and what the review subagent
(`request_review`) consumes via `review/diff.js fromCheckpointDiff`. **The seam
is unchanged** — `diffSince({scope, ref})` keeps its shape; only the
implementation swaps. `ref` becomes a commit OID instead of a `cp_…` id.

### 5.3 Rollback becomes real

The "future rollback affordance" `checkpoint.js` documents lands as
`git checkout <oid> -- .` (restore working tree) or `git revert` (new commit
undoing one). Surfaced as an agent tool + a Library affordance (§5.5). Because
the working tree is the live OPFS the tab reads, a rollback is immediately
visible on the App's next open (or a live reload if the tab is open).

### 5.4 Disposition of `snapshot-store.js` (the "git in miniature")

That store's own header says it is the "Git object model in miniature … NOT a
mythical local git repo." This spec proposes the real repo for **Apps**:

- **Apps:** git **supersedes** the miniature. The per-turn `checkpoint.capture`
  call site (SW, post-turn) calls `git.commit` instead; `diffSince`→git diff;
  rollback→git checkout. The `peerd-checkpoints` IDB DB is no longer written for
  App scopes.
- **Notebooks / JS sandboxes:** **keep the miniature for now.** They version too
  (`snapshot-store` is scope-generic), but a Notebook is fresh-run by design
  (DECISIONS #24) and not a share/version target yet, so the smaller-blast-radius
  call is to leave them on the miniature and migrate only if Notebook history
  becomes a feature. (§11-D2)
- Pre-release ⇒ **no migration** of existing checkpoints (the §3.D / DECISIONS
  #17 no-compat rule): App scopes simply start a fresh git history.

### 5.5 Agent tools & Library UI

New, thin tool defs (mirror the existing `app-*` family in
`peerd-runtime/tools/defs/`), all read-or-confirm-gated:

- `app_history { appId? }` → recent commits `{ oid, message, ts, files }`
  (read; runner-safe).
- `app_diff { appId?, from?, to? }` → unified diff between two commits or
  commit↔worktree (read).
- `app_revert { appId?, to }` → restore the tree at a commit (a **new** commit,
  never destructive); **confirm-gated** (a side-effecting write, so Plan refuses
  it — `decideAction`).
- (optional, §11-D3) `app_commit { appId?, message }` and `app_branch` for
  explicit author control; default behavior is auto-commit-per-turn so the agent
  need not manage git at all.

Library UI (the §3 persistence-spec Library view): an App card gains a **History**
panel — the commit list (message + time), a diff viewer between any two, and a
**Restore** button (= `app_revert`). For dwapps, the same panel doubles as the
**changelog** source (§6.2).

> **A note on `code-style-note.js`.** The injected-page ES5 exemption and the
> Notebook/App code-style reminder are unaffected — git versions the files
> byte-for-byte; it has no opinion on their contents.

---

## 6. The dweb layer (PREVIEW — dwapps)

This is where git "perfectly complements" PROPAGATION.md. Everything here is
behind `loadDweb()` / `DWEB_ENABLED` / `settings.dwebEnabled`; the store package
prunes it and the §10 CI check verifies zero dweb traces.

### 6.1 A release = sign a `head` amendment over a snapshot

When a publisher chooses to release (the Library's **Share / Publish update**
action, or the bridge's `publish-app`):

1. Pick the commit to release (default: `HEAD` of the working line).
2. `archive.js`: git tree @ commit → `{ entry, files }` → `packBundle` →
   `buildManifest` → **`version_id = manifestHash`** (SHA-256). This is
   *byte-identical* to today's `buildAppExport` / `.peerd` path — the dweb
   address of a release is the existing content hash, no re-encode.
3. Build the amendment and **sign it with the vault-seeded persistent identity**
   (`createPersistentIdentity`), domain-separated per **D-8**
   (`"peerd/app/v1" ‖ … ‖ bytes`):

```
head = sign_publisher({
  version_id,                 // SHA-256 of THIS release's manifest
  content_addr,               // peerd://<publisher>/<version_id>
  size,
  seq,                        // monotonic, no-downgrade (library.js, unchanged)
  prev,                       // ← NEW: previous release's version_id (or null for the first)
  changelog_ref?,             // ← NEW: content_addr of a small changelog blob (commit subjects
                              //   since `prev`), OR a capped inline string ≤ the 4 KB card ceiling
  ts,
})
```

`seq`, `version_id`, `content_addr`, `size`, `ts`, `sig` are PROPAGATION's
existing fields. **`prev` and `changelog_ref` are the only additions**, and both
are optional/forward-compatible (PROTOCOL §10: additive fields). Signing is
**share-time only** (FEATURE-APP-PERSISTENCE §4 decision): local save/commit
stays unsigned and identity-free.

### 6.2 Verifiable history & changelog (the actual win)

- **The chain:** an installer holding `head(seq=N)` can verify `prev` points at
  `version_id(seq=N-1)`, and (if it fetched the older head) that *that* head was
  signed by the same publisher with `seq=N-1`. The signed `head` chain **is** the
  release history — verifiable peer-to-peer, no SHA-1, no packfiles.
- **The changelog:** commit **subjects** between two releases (a `git log
  prev..HEAD --format=%s`) become the "what changed" text. Carried by-reference
  (a tiny `data`-type content bundle = `changelog_ref`) so the 4 KB metadata card
  stays small (PROPAGATION's hard cap), or capped-inline for one-liners. The
  Library's existing "update available" badge gains a real changelog popover.
- **No-downgrade preserved:** `library.js` already rejects `seq ≤ held seq`. Git
  changes nothing here — it just gives the version *behind* each `seq` a
  human-readable shape.

### 6.3 What crosses the wire in v1: the **snapshot**, not the `.git`

v1 transfers the **released snapshot bundle** (the existing chunked, SHA-256,
publisher-signed `content/*` path — already built). It does **NOT** transfer git
packfiles. Consequences, all intended:

- **No SHA-1 on the wire** (§6.5). The installer gets verified files + the signed
  head chain; they get *release* history (the chain of `version_id`s +
  changelogs), not the publisher's every-WIP-commit DAG.
- An installer who wants to **fork/modify** an installed dwapp gets a fresh local
  git history seeded from the received snapshot (one initial commit
  `"fork of <uri>"`), under a **new `dwapp_id`** = `H(forker_did ‖ slug)`. Fork
  semantics fall out of the identity rule (PROPAGATION) for free; the original's
  history is the publisher's, not the forker's.
- **Deep-history transfer** (a true `git clone` of a dwapp's full DAG) is a
  **later** option (§9), built only if there's demand: wrap a packfile in a
  signed SHA-256 manifest and verify OIDs against it (the SHA-256 manifest, not
  SHA-1, remains the trust anchor). Deferred deliberately — the snapshot path
  reuses 100% of the built content layer.

### 6.4 The bridge stays frozen — git is NOT a dwapp capability

`apps/bridge.js` is explicitly "FROZEN for Phase 1 — growing it is a security
event." Git does **not** add an op. why: the in-iframe dwapp is untrusted
opaque-origin code; handing it git would let a compromised app rewrite its own
"published" history or read arbitrary OPFS. Instead:

- **`publish-app`** (existing) already reads the app's files from the **trusted
  parent** (`readAppFiles()`), not the iframe. The release pipeline (§6.1) hangs
  off that same trusted read — the parent archives the current tree and signs the
  head. The iframe just *requests* a publish; it never drives git.
- **`install-app`** (existing, confirm-gated **every time**) is unchanged; on
  install we additionally seed the new App's local git history from the verified
  snapshot (§6.3), trusted-side.

So the dwapp API surface is **unchanged**; git rides entirely on the trusted
side. This is the same posture by which the bridge never exposes raw `sign()`.

### 6.5 Security summary (the trust boundary)

| Concern | Resolution |
|---|---|
| SHA-1 collisions | Confined to **local** authoring history. Never the cross-peer integrity primitive. Worst case = self-corruption of one's own repo (a local DoS), never a forged install. |
| What anchors a release | The **SHA-256 manifest** + **Ed25519 publisher signature** on the `head` — unchanged from today. |
| Rollback attack | `seq` no-downgrade (`library.js`) is untouched; `prev` adds *verifiability*, not a new downgrade path. |
| Untrusted dwapp code | Never gets git; releases are trusted-side, the frozen bridge is unchanged (§6.4). |
| Peer-authored bytes | Still wrapped `<untrusted_peer>` before any model context (ARCHITECTURE §7); git operates on *files*, downstream of that wrapping. |
| Egress | Remote git (if ever) rides `safeFetch` + audit; v1 git-over-dweb adds no HTTP egress at all. |

---

## 7. External git remotes (GitHub/GitLab) — explicitly deferred

Cloning a public repo into an App, or pushing an App to GitHub, is a *natural*
ask and isomorphic-git supports it — but:

- **CORS blocks it from the browser** without a proxy, and peerd ships none
  (privacy/no-telemetry/reversibility). A third-party CORS proxy sees every byte
  and URL — antithetical to the project.
- **Therefore v1 does not ship external remotes.** If demanded later, the only
  acceptable shapes are: (a) an **egress-gated, user-configured self-hosted
  cors-proxy** (the user owns it), routed through `safeFetch` + a new bootstrap-
  style allowlist grant + audit; or (b) read-only clone of hosts that *do* send
  CORS (rare). Both are a deliberate, confirm-gated, documented capability — not
  a default. (§11-D4)

The http adapter (§4.3) is built so this is a *wiring* decision later, not a
re-architecture.

---

## 8. How this complements each prior decision (the reconciliation table)

| Prior decision | Where | This spec's relationship |
|---|---|---|
| Content-addressed bundle = the saved/share/export artifact | FEATURE-APP-PERSISTENCE §1 | **Unchanged.** A release archives the git tree → the *same* `packBundle`/`buildManifest`. `version_id` = `manifestHash`, as today. |
| `app_content` IDB store keyed by `contentHash` | §3.D | **Reused** as the home of released snapshots; git `gitdir` (OPFS) is the *separate* history home. |
| `dwapp_id = H(publisher‖slug)` vs `version_id = bundle hash` | PROPAGATION | **Unchanged.** Git adds neither; it lives *beneath* `version_id`. |
| Signed, no-downgrade `head` with `seq` | PROPAGATION / `library.js` | **Extended additively:** `prev` + `changelog_ref`. `seq` rule untouched. |
| Sign at **share-time**, local save unsigned | FEATURE-APP-PERSISTENCE §4 | **Honored.** Commits are unsigned/identity-free; only the release `head` is signed (vault-seeded, D-8). |
| D-7: CRDTs are app-layer, platform ships opaque bytes | distributed ARCHITECTURE | **Honored.** Git versions *files at rest*; it is not a live-collab CRDT. A doc-collab dwapp still brings its own CRDT. |
| D-8: app signing is domain-separated | distributed ARCHITECTURE | **Honored.** The `head` signature uses the D-8 domain tag. |
| #25: sandbox = isolate, tab = host | DECISIONS | **Honored.** Git changes neither the App runtime nor the tab; it versions the App's OPFS files out-of-band. |
| #17: pre-release, no back-compat | DECISIONS | **Honored.** No checkpoint migration; App scopes start fresh git histories. |
| `snapshot-store.js` = "git in miniature, NOT a real repo" | edit/ | **Superseded for Apps**, kept for Notebooks (§5.4). The real repo is the deliberate upgrade of the miniature. |
| Egress chokepoint = `safeFetch` | egress | **Honored.** Any future remote git rides it; v1 dweb git adds no HTTP. |
| Brand/UI rules, no build step, `index.js` public API | CLAUDE.md | **Honored.** `shared/git/index.js` is the only surface; vendored lib in `vendor/`; no bundler. |

---

## 9. What we deliberately do NOT build (now)

- **External remote git (GitHub clone/push)** — CORS + no-proxy (§7). Deferred,
  egress-gated if ever.
- **Deep-history transfer over the dweb** (packfiles / `git clone` of a dwapp's
  full DAG) — v1 ships the snapshot + signed head chain (§6.3). Later, wrapped in
  a SHA-256 manifest.
- **Git for VMs** — VM disks are GBs in per-VM IDB block devices; the shareable
  unit stays the `vm-recipe` (FEATURE-APP-PERSISTENCE §2). Not a git target.
- **Git for Notebooks** — stay on the miniature for now (§5.4).
- **Merge/PR workflows between dwapps** — branches exist locally; cross-peer
  merge is a curation-layer feature, not v1.
- **Exposing git to the sandboxed dwapp iframe** — never (§6.4).
- **A second hashing scheme on the wire** — SHA-256 manifests remain the only
  cross-peer integrity anchor; git's SHA-1 stays local (§6.5).

---

## 10. Testing & gates

- **Bun (`tests/`, pure logic):** the OPFS fs adapter against a fake-OPFS shim;
  `archive.js` (git tree → `{entry,files}`) round-trips to the *same*
  `manifestHash` as `buildAppExport` (the dwapp-address invariant — the key
  test); `repo.js` init/commit/log/diff/checkout on a tiny in-memory tree;
  `prev`-chain verification logic.
- **In-browser (`tests/runner.html`, headless via CDP):** real OPFS lifecycle —
  init a repo, commit across a simulated SW restart, diff, revert, confirm the
  working tree the tab reads matches; Library History panel renders; an App's
  release `version_id` equals its `.peerd` export hash.
- **Boundary:** ESLint `no-restricted-imports` — `shared/git` must not import the
  dweb; the **dweb-trace CI check** must still find zero dweb traces in the store
  package (git is core, the *release/head* layer is dweb-pruned).
- **Vendoring gate:** `SOURCE.txt` present, entry-file SHA-256 recorded,
  self-containment asserted (no bare-specifier imports), size logged.
- **Drift / typecheck / ESLint / `bun run gen:dev`** — the standard preflight.

---

## 11. Open decisions (confirm on review)

- **D1 — Adopt isomorphic-git, or extend the miniature?** *(Recommend: adopt.)*
  Real diffs/branches/log + commit-message changelogs are exactly what the dwapp
  update UX needs, and a standard format buys future interop. The off-ramp
  (extend `snapshot-store.js` with a diff + a `prev`-chained head) is named in §1
  if size/cost (D5) says no.
- **D2 — Notebooks: migrate to git or keep the miniature?** *(Recommend: keep the
  miniature for now; migrate only if Notebook history becomes a feature.)* (§5.4)
- **D3 — Auto-commit-per-turn only, or also expose `app_commit`/`app_branch`?**
  *(Recommend: auto by default; add explicit tools only if the agent needs
  author control.)* (§5.5)
- **D4 — External remotes: never, or egress-gated-later?** *(Recommend:
  out-of-scope v1; if ever, user-owned self-hosted proxy + grant + audit.)* (§7)
- **D5 — Store-build weight.** Measure the vendored minified size; confirm
  acceptable for the store channel, else fall back to preview-only git + store
  miniature (the lesser option, splits UX across channels). (§4.4)
- **D6 — MIT license exception** to the "Apache-2.0 only" vendoring rule —
  record in `SOURCE.txt` + `DECISIONS.md`. *(Recommend: grant; MIT is
  redistribution-compatible.)* (§4.4)
- **D7 — `prev` + `changelog_ref` additions to `head`** — confirm these are the
  *only* wire additions and that `changelog_ref` is by-reference (not inline) to
  respect the 4 KB card cap. (§6.1–6.2)

---

## 12. Build checklist (ordered; core first, dweb rides the worktree merge)

### Phase A — vendor + the fs adapter (CORE foundation)
- [ ] `vendor/isomorphic-git/` + `SOURCE.txt` + `scripts/vendor-isomorphic-git.sh`
      (pin version, record entry SHA-256, assert self-containment, log size).
- [ ] `shared/git/fs-opfs.js` — the OPFS fs adapter (promise API, ENOENT/EEXIST,
      synthesized stat). Bun + in-browser tests (§10).
- [ ] `shared/git/repo.js` + `archive.js` — init/commit/log/diff/checkout +
      tree→`{entry,files}`. Test the `manifestHash`-equivalence invariant.
- [ ] `shared/git/index.js` — the only public surface.

### Phase B — wire Apps to git (CORE; lands with / after FEATURE-APP-PERSISTENCE §3.D)
- [ ] `offscreen/git-runner.js` + SW RPC route; per-`<id>` op queue.
- [ ] App save hook: commit on `app_create`/`app_update`/debounced write; message
      from turn intent. Release path = `archive` → `buildAppExport` → `app_content`.
- [ ] Repoint review's `diffSince` to git diff (seam unchanged).
- [ ] `app_history` / `app_diff` / `app_revert` tool defs (+ optional
      `app_commit`/`app_branch` per D3).
- [ ] Library **History** panel (commit list, diff viewer, Restore).
- [ ] Stop writing `peerd-checkpoints` for App scopes (Notebooks keep it — D2).

### Phase C — dweb release/version stream (PREVIEW; after the dweb worktree merge)
- [ ] `peerd-distributed/apps/release.js` — archive HEAD → sign `head` (D-8) with
      `prev` + `changelog_ref`; publish via the existing metadata plane.
- [ ] `library.js` / propagation: surface `prev` chain + changelog;
      "update available" → changelog popover; pull-new-snapshot reuses `content/*`.
- [ ] Install seeds a fresh local git history from the verified snapshot; fork →
      new `dwapp_id` (§6.3).
- [ ] The bridge is **unchanged** (§6.4) — assert no new op in tests.

### Phase D — (deferred) external remotes / deep-history
- [ ] Only on demand and per D4/§6.3 — not v1.

### Gates (before calling a phase done)
- [ ] `bun test ./tests`, `bun run typecheck`, ESLint (incl. boundary),
      `bun run gen:dev` drift, in-browser CDP suite, **dweb-trace store check**
      all green.

**Effort (rough):** Phase A ~1 week (the fs adapter is the risk) · Phase B
~1 week · Phase C ~3–5 days riding the dweb merge · Phase D deferred.
