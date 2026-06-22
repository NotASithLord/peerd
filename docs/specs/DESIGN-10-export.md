# DESIGN-10 — Artifact export: one bundle format under shares, publishing, and dwapps

Owner directive (2026-06-12): "carefully think through a basic export
feature for apps, vms, and sandboxes, that'll underpin so much from
manual shares over chat, to publishing via web services, and
eventually dwapps ofc."

## The one decision that matters

peerd-distributed already defines the right primitives (Phase 0, real
code): `packBundle({entry, files})` → canonical-JSON payload → 256KiB
chunks → a manifest `{v, type, mime, size, entry?, chunks:[{hash,
size}], created, publisher?, sig?}` whose canonical hash IS the
`peerd://` content address. **The export format is that same bundle,
serialized to a single file.** One format, three transports:

| transport            | mechanism                                   |
|----------------------|---------------------------------------------|
| manual share         | download `.peerd` file, send it anywhere     |
| web publishing       | upload manifest + chunks to any dumb host    |
| dwapps (Phase 2)     | `publish()` into the content store, announce |

A file exported today is already addressable tomorrow: its manifest
hash never changes. No second format, no migration.

## Boundary constraint (load-bearing)

Store packages PRUNE `peerd-distributed/` entirely (structural channel
boundary, PACKAGING.md), and the dweb-boundary gate forbids references
into it from outside. Export must work in store packages. Therefore the
pure bundle primitives (canonicalize, packBundle/unpackBundle,
chunkBytes/hashes, manifest build/hash/verify) MOVE to
`shared/bundle/` (plain pure JS, no identity, no transport), and
peerd-distributed imports them from there — the legal direction.
Signing stays distribution-side: identity (Ed25519/did:key) is the
dweb wedge, and Phase 0 identities are ephemeral — baking throwaway
DIDs into user files would be noise. **v1 exports are UNSIGNED**
(`publisher`/`sig` absent — the manifest shape already treats them as
optional); Phase 2's vault-seeded identity adds signing without a
format change. No compat shims needed anywhere: pre-release, DECISIONS
#17.

## The `.peerd` file envelope

```json
{
  "format": "peerd-bundle",
  "version": 1,
  "manifest": { ...exact distribution manifest shape, plus meta... },
  "chunks": ["<base64>", "..."]
}
```

Chunks ride in manifest order; the file is self-verifying (re-chunk →
hash → compare; manifest hash = identity). The manifest gains ONE
additive field: `meta` — a small object for artifact-kind specifics.
It is canonicalized and hashed like every other field.

## Payload per artifact kind

- **App** — `type:'app'`, mime `application/peerd-app` (the
  distribution default). `files` = the OPFS tree under
  `peerd-apps/<id>/`; `entry` = the AppRecord's entryFile;
  `meta` = `{ kind:'app', name, tags }`. Import → NEW AppRecord (fresh
  id, never overwrite) + OPFS write of the tree.
- **Notebook** — `type:'notebook'`, mime
  `application/peerd-notebook`. `files` = the OPFS tree under
  `peerd-notebooks/<id>/`; no
  entry; `meta` = `{ kind:'notebook', name }`. Import → new
  NotebookRecord + OPFS tree.
- **VM** — `type:'vm-recipe'`, mime `application/peerd-vm-recipe`.
  v1 deliberately does NOT export the block overlay (per-VM IDB block
  devices run 100s of MB–GBs; streaming/compression is its own
  design). The recipe carries `meta = { kind:'vm', name, image: {
  url, pin: { totalBytes, headSha256 } } }` — the TOFU image pin
  TRAVELS, so an import pins the base image BEFORE first boot:
  receiver integrity is strictly stronger than a fresh local VM.
  `files` reserved for a future `/setup.sh` seed. A faithful
  `vm-overlay` type is documented-deferred (ROADMAP backlog), not
  designed-by-accident here.

## Size + safety rails

- Export refuses payloads over 64 MB (everything is in-memory base64;
  apps/sandboxes are KBs–MBs in practice — the rail exists for the
  pathological case, with a clear error naming the limit).
- Import is inspect-then-apply (transfer.js precedent): parse +
  verify hashes + show `{kind, name, size, fileCount}` before any
  write. Imports always mint fresh ids. Malformed/oversized envelopes
  fail closed with typed errors.
- Apps/sandboxes execute in their existing sandboxed realms on the
  RECEIVING side — an imported bundle gets no authority a locally
  authored artifact wouldn't have. (The realm, not provenance, is the
  security boundary; signing later adds provenance, not authority.)

## Surfaces (v1)

- SW routes: `export/artifact {kind, id}` → `{ok, filename, envelope}`;
  `import/inspect {envelope}` → `{ok, summary}`; `import/apply
  {envelope}` → `{ok, kind, id}`.
- Export buttons in the three engine tab headers (app-tab / js-tab /
  vm-tab — next to the existing chrome, monochrome).
- Import lives on the options page's Export & import section
  (alongside the settings transfer UI, clearly separated: "Artifacts"
  vs "Settings & data").
- Filename: `<name>-<kind>.peerd` (sanitized).
- Agent-callable export/import tools: deferred until the format
  proves itself in manual use.
