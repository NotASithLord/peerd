# FEATURE — Instance persistence, the App Library, and the dwapp substrate

> **Status:** PARTIAL — most of the unified model has LANDED; what's left
> is a short, named tail. The big pieces this doc set out to consolidate
> are shipped: **Phase-1 persistence** (instances survive restart),
> the **dwapp substrate** ("Step 2"), and the **App Library** front door.
> The doc is no longer "finalize before the dweb branch" — it's the record
> of what shipped plus the three remaining gaps below.
>
> **Shipped:**
> - **Phase-1 persistence.** Instances persist and survive restart via the
>   IDB catalog stores (`apps` / `notebooks` / `vms`, on `peerd` IDB —
>   moved off `chrome.storage.local` at schema v5/v6) + OPFS file trees
>   (`peerd-apps/<id>/`, `peerd-sandboxes/<id>/`) + per-VM IndexedDB block
>   devices (`peerd-vm-<id>`). See §0.
> - **The dwapp model ("Step 2").** `installAppBundle` / `createAppBridge`
>   / base-network `publishApp`/`fetchApp` / the `commons` dwapp all live
>   in `peerd-distributed/` (`apps/loader.js`, `apps/bridge.js`,
>   `base-network.js`).
> - **The App Library.** Landed as the home SPA's **Library view**
>   (`extension/home/library-section.js`, routed in `home/home.js` via
>   `activeView === 'library'`) — NOT the standalone side-panel page §3.A
>   originally drafted (that section predates DESIGN-12). Catalog metadata
>   only; Open/Delete/Export route through the SW's `appClient`.
>
> **Remaining gaps** (the only open work): **(B)** content-addressing
> on save, **(C)** a durable IDB content tier, **(D)** share-time signing
> identity for locally-saved apps. See the revised gap list at the end of §0.
>
> **Modules:** persistence + Library + content-addressing = **CORE**
> (`peerd-engine`, `home`/sidepanel, `peerd-egress/storage`,
> `shared/bundle`) — ships in the store channel, no `peerd-distributed`
> import. Signing + bridge + sharing = **dweb** (`peerd-distributed`,
> preview-only via the boundary seam) — **already built** (Phase 1, on
> main).

---

## 0. Reframe — what already exists (read this first)

The premise "apps/sandboxes/VMs are purely ephemeral" is **not accurate**;
correcting it changes the work:

- **Instances already persist and survive restart.** The three registries
  are backed by the `peerd` IndexedDB (`apps` / `notebooks` / `vms` catalog
  stores — moved off `chrome.storage.local` at schema v5/v6, idb.js) via
  `peerd-engine/registry-factory.js`; App/sandbox files live in OPFS
  (`peerd-apps/<id>/`, `peerd-sandboxes/<id>/`); VM disks live in **per-VM
  IndexedDB block devices** (`diskOverlayKey`, key `peerd-vm-<id>`,
  `vm-registry.js`). All of it survives SW restart and browser restart.
  `app_list`/`app_open`/`app_delete` already work for the **agent**.
- **The "saved app = content-addressed bundle" format already exists.**
  `extension/shared/bundle/` (`packBundle`/`unpackBundle`/`canonical`/
  `chunk`/`manifest`) is the shared primitive (DESIGN-10); the dweb's
  `content/*` are thin re-exports + the signing layer. `peerd-engine/
  export.js` (`buildAppExport`) already packs an App into the **same**
  manifest the dweb addresses (`type:'app'`, `mime:'application/peerd-app'`,
  `meta:{kind,name,tags}`), committing to a stable `peerd://<hash>`.
- **The persistence record already has the dwapp slot.** `AppRecord.dweb =
  {uri, publisher, hash, seed?}` exists; its presence is what flips an App
  into a dwapp and unlocks the app-tab bridge.
- **The dwapp model is already built (Phase 1, on main):**
  `installAppBundle` (verified bundle → engine App), `createAppBridge`
  (bridge v0), base-network `publishApp`/`fetchApp`, the `commons` dwapp.

**Gap (A) — the user-facing Library — has since SHIPPED**, but not as the
standalone side-panel page §3.A drafted: it landed as the **home SPA's
Library view** (`extension/home/library-section.js`, routed in `home/home.js`
under `activeView === 'library'`) when DESIGN-12 collapsed the surfaces.
Read §3.A as built-but-relocated; the data layer it describes is unchanged.

So the genuine **remaining** gaps are narrow: **(B)** the catalog record
isn't content-addressed on save (`AppRecord` carries no `contentHash`; a
hash is computed only at *export* time, in `buildAppExport`/`manifestHash`,
not on save); **(C)** the content store isn't durably backed (OPFS/IDB) —
the `app_content` IDB store is named only in the v5 schema-history comment
and is deliberately **not created yet** (idb.js: "added with its first
writer, not reserved empty"); **(D)** the signing-identity decision for
locally-saved apps is open; **(E)** small hygiene (dead `vm_state` store —
still declared, "no live writers"; `sizeBytes` read-but-never-set;
one-directional catalog↔OPFS binding).

> **Not-yet / needs re-justification (verified absent in `extension/` as of
> 2026-06-21):** `AppRecord.contentHash` and the durable `app_content`
> content tier do NOT exist in code — they are part of gaps (B)/(C) above,
> not shipped surface. `vm_state` exists as a store but is vestigial (no
> writers). `buildAppExport`'s `peerd://<hash>` is real but lives on the
> *export envelope*, not on the persisted record. Re-confirm these before
> citing them as available primitives.

---

## 1. The unified model (the load-bearing statement)

State it once, build to it everywhere:

1. **An instance = a catalog record (metadata) + a content store (bytes).**
   The record is the catalogable, queryable, listable entity; the bytes
   live in OPFS (App/JS) or per-VM IDB block devices (VM).

2. **An App's canonical saved form IS a content-addressed bundle** —
   `packBundle({entry, files})` under a `shared/bundle` manifest. This is
   *byte-identical* to the dweb transfer unit and the `.peerd` export. The
   content hash (`SHA-256(JCS(manifest sans sig))`) is the app's stable
   `peerd://` address, signed or not.

3. **A dwapp = an App whose record carries `dweb` meta and is granted the
   bridge.** Same sandboxed-iframe runtime, additive metadata. No new
   runtime, no fork.

4. **Persistence (step 1) and sharing (step 2) are the same artifact.**
   *Save* produces the bundle; *share* transfers that same (now-signed)
   bundle over WebRTC; *install-from-peer* verifies and writes that same
   bundle back into the same catalog. This is why persistence is
   load-bearing for the dweb — and why the format deliberately lives in
   `shared/bundle` (core), so the persistence layer never imports the dweb
   module and the boundary holds **for free**.

---

## 2. Scope across the three kinds

Persistence is global (they're all "a tab with content"), but the *depth*
differs by what's actually useful and shareable:

| Kind | Catalog | Content | This spec |
|---|---|---|---|
| **App** | ✅ exists | OPFS files | **Full first-class:** Library, content-addressing-on-save, the dwapp substrate. The must-have. |
| **JS Sandbox** | ✅ exists | OPFS files | **Library entry (lighter).** A sandbox bundle is `type:'sandbox'` (no `entry`) — already a manifest type. Persist-by-default; shareable as a bundle later. |
| **VM** | ✅ exists | per-VM IDB disk | **Library entry (reopen/rename/delete).** Disk already persists. **Full-disk sharing is OUT OF SCOPE** (GBs). The shareable unit is a **`vm-recipe`** bundle (base-image ref + setup script) — already a manifest type — captured later, not the disk. |

---

## 3. Step 1 — the genuine persistence work (CORE, ships in store channel)

### 3.A The Library (the user's front door) — the #1 gap

A new **Library** view in the side panel (sibling to Sessions / Scheduled):

- **Apps** section: a grid of cards — name, thumbnail, updated-at, a "dwapp"
  badge when `record.dweb` is present. Per-card: **Open, Rename, Duplicate,
  Delete, Export `.peerd`** (and, preview-only, **Share** — §4). A **New
  App** affordance.
- **Sandboxes / VMs** sections (or tabs): name, updated/last-used, Open /
  Rename / Delete. VMs also show size; no share.
- Backed by the existing `registry.snapshot()` + the app/js/vm clients —
  this is **mostly new UI over data that already persists.** Open re-spawns
  the tab (`app_open` path); delete removes the record + OPFS subtree (+ for
  VMs the per-VM IDB disk).

> The agent already manages apps via `app_list`/`app_open`/`app_delete`.
> The missing half is the **human** surface — that's what "I should have a
> way of seeing, opening, and deleting my apps" asks for.

### 3.B Catalog record enrichment

Add to `AppRecord` (and mirror for js/vm where sensible):
- **`contentHash`** — the `shared/bundle` manifest hash, computed on
  save/update (§3.C). Makes every saved app dweb-addressable and enables
  dedupe.
- **`sizeBytes`** — fix the read-but-never-set bug (`app_list` already
  reads it; `buildExtra` never sets it).
- **`thumbnail`** (optional) — a small snapshot captured from the app tab,
  for the Library grid. Nice-to-have.
- **`updatedAt`** — already present; drive Library sort.
- **`dweb`** — already present; populated by publish/install (§4).
- **`source`** — `'agent' | 'user' | 'peer'` for provenance (peer = arrived
  via install-from-peer).

### 3.C Content-addressing on save

On `app_create` / `app_update` / debounced `app_write_file`, compute the
manifest + hash via the **existing** `peerd-engine/export.js` path (which
already reuses `shared/bundle`), and cache `contentHash` in the record. No
new format, no new dependency — it's the `.peerd` pack minus writing a
file. Result: **every saved app is already a content-addressed bundle**,
so "share" later is just transfer, never a re-encode.

### 3.D Storage platform — IDB everything (DECIDED 2026-06-14)

**Decision (owner):** consolidate **all structured/database state onto
IndexedDB**, including the engine catalogs, which move off
`chrome.storage.local` into IDB stores. Pre-release ⇒ **no migration code**
(owner rule: no pre-release compat) — just repoint the registry-factory's
injected `storage` at IDB and drop the `apps.v1` / `jssandboxes.v1` /
`webvms.v1` keys.

Concretely, the single `peerd` IDB database holds: `sessions`, `audit_log`,
`tool_grants`, `agents_memory`, `vault`, `profiles` (today) **+ new**
`apps`, `sandboxes`, `vms` catalog stores **+** an `app_content` store (the
content-addressed manifest + chunked payload + thumbnail, keyed by
`contentHash`; this *is* the long-reserved snapshot tier — supersede the
unused `peerd-app-bodies` DB). Stores are added additively in `idb.js`
`onupgradeneeded`; the generic `put/get/getAll/del/count` helpers work
immediately. Drop the dead `vm_state` store while here (§3.E).

**Two things stay where they are — that's the right layer, not
inconsistency:**
- **App/sandbox live file trees stay in OPFS** (`peerd-apps/<id>/`,
  `peerd-sandboxes/<id>/`). OPFS is the *filesystem* layer the engine reads
  via `opfsHelpers` / the editor / the worker `peerd.self.readFile/writeFile`
  and `composeApp`. IDB is the *database/record* layer (metadata + the
  packed, addressable bundle). **Live files = OPFS; saved bundle + all
  records = IDB.**
- **CheerpX per-VM disks stay in their per-VM IDB block devices**
  (`peerd-vm-<id>`) — CheerpX owns that; already IDB.

The `app_content` store is the **convergence point (§5):** both the durable
home of a saved app's bundle *and* what the dweb's announce-set store reads
to serve it to peers across restarts.

> **Why IDB, not SQLite-WASM (platform call, recorded):** SQLite-WASM was
> considered for a single SQL substrate and **declined for now.** (1)
> *Consistency cuts the other way:* IDB is already mandatory — CheerpX VM
> disks are IDB block devices, and vault/sessions/audit are IDB — so SQLite
> would be a *second* system, not a unifying one. (2) *SW-context:* peerd's
> data layer runs in the **service worker**, where IndexedDB works
> directly; SQLite's fast path (OPFS-VFS) needs a dedicated Worker with
> SyncAccessHandles + cross-origin isolation and **cannot run in the SW**,
> forcing every read/write through an offscreen round-trip. (3) *Cost:* a
> ~1 MB+ vendored WASM payload (store-review weight) + the no-build/no-npm
> vendoring burden. (4) *Fit:* peerd's access patterns are get-by-id /
> list / cursor-by-time — IDB's sweet spot; there are no joins or ad-hoc
> queries today. **Revisit trigger:** if a real relational/query need
> appears — chiefly **full-text search** across sessions/memory/apps
> (SQLite FTS5 beats hand-rolled IDB indexing) or multi-table reporting —
> add SQLite-WASM-OPFS-VFS **in the offscreen doc as a query/search layer**,
> keeping IDB for blobs + VM disks. Don't adopt it preemptively.

### 3.E Hygiene (small, do alongside)

- **Remove the dead `vm_state` IDB store** (declared, zero writers) and fix
  the CLAUDE.md / comment claim that "the VM disk lives in OPFS" — it lives
  in **per-VM IndexedDB block devices** (`peerd-vm-<id>`).
- **OPFS-reconcile:** add a recovery path so a cleared catalog key can
  re-adopt orphaned `peerd-apps/<id>/` bytes (today the catalog→OPFS
  binding is one-directional; a lost index key orphans the files).
- Fix `sizeBytes` (3.B).

### 3.F Agent tools

`app_*` already exist and persist-by-default (create writes catalog +
OPFS). Keep that (nothing the agent makes is silently lost; delete to
discard). Additions: surface the enriched metadata in `app_list`; add
`app_export` (`.peerd`) if the agent should hand the user a file. The agent
can already see/open/delete — the gap was the human Library, not the tools.

**Effort:** Library UI ~1 week; enrichment + content-addressing + IDB
content tier ~3–5 days; hygiene ~1–2 days.

---

## 4. Step 2 — sharing + self-networking (DWEB, preview) — finalize the seams

Mostly **already built** in the dweb worktree (Phase 1). The persistence
design above is the prerequisite; here's how it feeds the dweb, and the one
real open decision.

- **`AppRecord.dweb` (exists)** is populated on publish/install. Its
  presence unlocks the app-tab bridge (`attachDwebBridge`).
- **Install-from-peer (`installAppBundle`, exists)** verifies a bundle
  (signature + every chunk) and writes it into the **same catalog** as a
  new App with `source:'peer'` + `dweb` meta. The persistence layer must
  accept peer-sourced bundles (size/file caps already enforced: ≤64 files,
  ≤2 MB, entry present, no path traversal).
- **The bridge (`createAppBridge` / bridge v0, exists, frozen surface)** is
  how an app does its own P2P networking: `join`/`publish`/`subscribe`/
  `history`/`presence`/`publish-app`/`install-app`/… Per-app permission
  grants (`dweb.grants.v1`), confirm-gated `join`, every grant/denial
  audited — **mirrors the egress model exactly.** Signing is
  domain-separated (D-8: `"peerd/app/v1" ‖ appHash ‖ bytes`) so a dwapp
  can't forge protocol records with the user's key. **This is how "the
  agent makes a P2P web game that embeds peer calls" works:** the agent
  authors an App that calls the bridge ops, and the record carries `dweb`
  meta. (A skill / system-prompt block teaches the bridge surface — see
  `SYSTEM-PROMPT-LESSONS.md` for how to add a gated capability block.)
- **The announce-set content store needs OPFS/IDB backing** to serve a
  saved app to peers across restarts — **this is §3.D.** Today it's
  in-memory; backing it with the §3.D IDB content tier is the documented
  next step and the literal convergence of persistence + sharing.
- **Discovery:** rooms now (`peerd://…#room=<code>`, rendezvous code, or
  serverless invite). A **dwapp store** (browse others' apps) is a *later
  dwapp built on this catalog + sharing*, gated on global discovery
  (DHT, Phase 3) — noted, not designed here.
- **Boundary discipline (unchanged):** all of step 2 lives behind
  `loadDweb()` / `shared/dweb-interface.js`, gated by `DWEB_ENABLED` **and**
  `settings.dwebEnabled`. The SW can't dynamic-import the module, so live
  dweb work runs **page-side** (`app-tab.js`); vault/identity/install go
  through scoped SW routes (`dweb/identity-get`, `dweb/app-install`,
  `dweb/audit`).

### The one real open decision — signing identity & timing

Locally-saved apps are **unsigned** today (`.peerd` v1: `publisher`/`sig`
absent by design; `verifyManifest` treats unsigned as "ok, no author").
Signing needs a stable identity. **Recommendation: sign at SHARE time, not
save time.**
- **Save (core, store channel):** content-addressed, **unsigned**. No
  identity needed; works with the dweb pruned. The hash is already stable.
- **Share (preview):** sign the manifest with the **vault-seeded persistent
  identity** (`createPersistentIdentity`, already in the worktree) at the
  moment of `publishApp`. Local save stays identity-free; signing is a
  deliberate, preview-only, share-time act.
- Cross-device stable identity (PRF-derived seed) is **Phase 3** — until
  then a re-saved app on another device gets a different `publisher`, which
  is acceptable (content hash is still stable; authorship just isn't
  portable yet).

---

## 5. The convergence (why this is the load-bearing piece)

The IDB content tier from **§3.D is simultaneously**:
1. the durable home of a saved app's content-addressed bundle (persistence,
   step 1, core), and
2. the announce-set store that serves that bundle to peers (sharing, step 2,
   dweb).

Persistence and sharing are **the same artifact in the same store**, addressed
by the same hash, packed by the same `shared/bundle` code. Get §3 right and
§4 is largely *wiring the already-built Phase-1 dwapp work onto it* —
which is exactly the "finalize before going further" you're after.

---

## 6. Decisions

1. ✅ **RESOLVED — Storage platform: IDB everything**, no migration
   (pre-release). SQLite-WASM considered and declined for now (revisit
   trigger recorded). (§3.D)
2. ✅ **RESOLVED — Save semantics: persist-by-default.** Every app the
   agent or user creates lands in the Library immediately; delete to
   discard. Nothing is silently lost. (§3.F)
3. **Signing timing** — sign at **share-time** *(recommended)*, local save
   stays unsigned/core. (§4) — confirm on review.
4. **Kind depth** — Library catalog for **all three** kinds *(recommended)*;
   apps full-featured, sandboxes/VMs lighter. (§2) — confirm on review.
5. **Thumbnails** — capture from the app tab *(nice-to-have)* vs none. —
   confirm on review.

---

## 7. What we deliberately do NOT build (now)

- Full-VM-disk sharing (GBs) — the shareable VM unit is a `vm-recipe`,
  later.
- A global dwapp store / DHT discovery — Phase 3; rooms are the boundary
  now (D-6, D-9).
- A platform CRDT — app-layer only (D-7); the doc-collab dwapp brings its
  own.
- Cross-device stable identity — Phase 3 (PRF-derived seed).
- Binary-asset inlining beyond the current `composeApp` v1 limit (packBundle
  stores bytes fine; rendering inlines text assets only today).
- Adopting SQLite-WASM preemptively — revisit only on a real FTS/relational
  need, added as an offscreen query layer over IDB (§3.D).

---

## 8. Build checklist

Ordered so each phase is independently shippable and the foundation lands
first. Step 1 is CORE (store + preview). Step 2 is dweb (preview), mostly
wiring the already-built Phase-1 work onto the foundation.

### Phase 1 — IDB storage consolidation (foundation)
- [ ] `peerd-egress/storage/idb.js`: bump `DB_VERSION 4 → 5`; in
      `onupgradeneeded` (additive) create stores `apps`, `sandboxes`, `vms`
      (`keyPath:'id'`) and `app_content` (`keyPath:'contentHash'`); **delete
      the dead `vm_state` store** and its wrong "disk lives in OPFS" comment.
- [ ] `extension/tests/mocks/idb.js`: add the new stores.
- [ ] `peerd-engine/registry-factory.js`: repoint the injected `storage`
      from the `chrome.storage.local` `kv` to per-kind IDB stores (one store
      per kind, record keyed by `id`). **No migration** — drop the old
      `apps.v1` / `jssandboxes.v1` / `webvms.v1` keys (pre-release).
- [ ] `background/service-worker.js`: update the three
      `create*Registry({storage})` wirings (≈ lines 1043–1073) to pass the
      IDB-backed storage.
- [ ] Retire `peerd-engine/app-store.js` (`peerd-app-bodies`) in favor of
      the `app_content` store.
- [ ] Tests: registry CRUD against IDB; round-trip survives a simulated SW
      restart.

### Phase 2 — catalog enrichment + content-addressing on save
- [ ] `peerd-engine/app-registry.js` `buildExtra`: add `contentHash`,
      **`sizeBytes`** (fix the read-but-never-set bug), `thumbnail?`,
      `source: 'agent'|'user'|'peer'` (keep `dweb?`, `updatedAt`).
- [ ] Save hook: on `app_create` / `app_update` / debounced
      `app_write_file`, build the manifest+hash via `peerd-engine/export.js`
      `buildAppExport` (reuses `shared/bundle`), write the bundle to
      `app_content`, cache `contentHash` + `sizeBytes` on the record.
- [ ] OPFS-reconcile: on catalog miss, adopt orphaned `peerd-apps/<id>/`
      bytes back into the catalog (close the one-directional binding).
- [ ] Tests (Bun): `contentHash` is stable for identical inputs and equals
      the `.peerd` export hash (the dweb-address invariant).

### Phase 3 — the Library UI (the user front door)
- [ ] New side-panel **Library** view (sibling to Sessions / Scheduled),
      sections **Apps / Sandboxes / VMs** (Mithril, monochrome + brand
      accent rules).
- [ ] App card: name, thumbnail, `updatedAt`, **dwapp badge** when
      `record.dweb` is set; actions **Open / Rename / Duplicate / Delete /
      Export `.peerd`** (+ **Share**, preview-only — §4).
- [ ] Sandbox/VM cards: name, last-used/size, **Open / Rename / Delete**
      (no share for VMs).
- [ ] Wire actions to the existing `app/js/vm` clients + registry snapshot
      (now IDB-backed); **persist-by-default** — a created app appears in the
      Library immediately; Delete removes record + OPFS subtree (+ per-VM IDB
      disk for VMs).
- [ ] In-browser tests (CDP): a created app shows in the Library, survives a
      reload, opens, and deletes cleanly.

### Phase 4 — agent tools polish
- [ ] `app_list` returns the enriched metadata; add `app_export` (`.peerd`)
      if the agent should hand the user a file. (`app_open`/`app_delete`/
      `app_search` already exist.)

### Gates (run before calling step 1 done)
- [ ] `bun test ./tests`, `bun run typecheck`, ESLint, `bun run gen:dev`
      drift check, and the in-browser CDP suite (IDB lifecycle + Library
      components) all green.

### Step 2 — dweb (preview): wiring checklist (separate PR, after merge of the dweb worktree)
- [ ] Populate `record.dweb = {uri,publisher,hash,seed?}` on publish/install;
      `installAppBundle` writes peer bundles with `source:'peer'`.
- [ ] Back the announce-set content store with the **`app_content` IDB
      store** (the §5 convergence) so saved apps serve to peers across
      restarts.
- [ ] Share-time signing via `createPersistentIdentity` (vault-seeded),
      domain-separated (D-8). Local save stays unsigned.
- [ ] App-tab `attachDwebBridge` unlocked by `record.dweb` presence;
      per-app grants in `dweb.grants.v1`, confirm-gated, audited.
- [ ] A **skill / system-prompt block teaching the bridge API** so the agent
      can author self-networking apps (cross-ref `SYSTEM-PROMPT-LESSONS.md`).

**Effort:** Phase 1 ~3–4 days · Phase 2 ~2–3 days · Phase 3 ~1 week ·
Phase 4 ~1 day. Step-2 wiring rides the dweb worktree merge.
