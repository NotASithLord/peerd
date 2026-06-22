# VERSIONING.md — peerd

> How peerd is versioned and released. Short version: **stay 0.x while
> the surface is still moving; the minor is the progress counter; the
> channel is an orthogonal axis you already ship.** Pair with
> `FEATURES.md` (what's shipped), GitHub Issues (the backlog), and
> `CHANGELOG.md` (the per-release record).

peerd is **0.x — experimental preview**. The version is a single source
of truth in `package.json`; `packaging/gen-manifest.ts` injects it into
every generated `manifest.json`. Never hand-edit a version in a manifest
(CI fails on drift).

---

## The scheme: `0.MINOR.PATCH` + channel

Four axes, three of which peerd already has.

### 1. Stability contract — stay `0.x`

The leading `0` is the honest signal that there is **no stability
promise yet** (the widely-recognized "ZeroVer" convention). Storage
formats may move, tool names may change, the agent surface is still
settling. This is the same posture Bun held pre-1.0 and the Nous
**Hermes** agent held through its first months (`0.1 → 0.8`).

`1.0` is a *deliberate, earned* signal — "the surface is stable, depend
on it." We spend it **once**, when the tool/storage/permission surface
stops breaking under us. Until then: 0.x. This file is the mechanism.

### 2. Progress counter — `MINOR` = milestone, `PATCH` = fixes

- **Bump MINOR for every feature epoch.** A new capability, a new tool, a
  new execution kind, a schema migration — anything a user would want to
  read the notes for. `0.1 → 0.2 → 0.3`. The minor *is* the progress
  story: `0.7` is visibly further along than `0.2`.
- **Bump PATCH for fixes and hardening only.** No new surface.

> why this split: Bun's versioning got criticized precisely because it
> smuggled features into patch releases (`1.0.1`, `1.0.2`), so nobody
> could read progress from the version. Don't do that — features move the
> minor, always. Hermes shipped `0.1 → 0.8` in two months doing exactly
> this, and it reads as momentum.

### 3. Channel — `store` / `preview` / `dev` (already shipped)

peerd already builds three channels (`packaging/`, `channel-config.js`).
They map 1:1 onto the best-run channel model out there — Zed's
`stable / preview / nightly`:

| peerd channel | Zed analog | Cadence | Contents |
|---|---|---|---|
| `store`   | stable  | slower, earned | what's been soaked in preview; no dweb |
| `preview` | preview | faster, ahead   | recent features, may revert; dweb on |
| `dev`     | nightly | head            | local dev loop |

The channel is **orthogonal** to the SemVer number: the same `0.4.0` can
ship to store and preview; preview just gets there first and carries more.

### 4. Build encoding — the 4th octet (store-legal)

Chrome **and** Firefox (AMO) require the manifest `version` to be a plain
dotted-integer string — **no `-rc`/`-preview` suffix is allowed there.**
So the pre-release information rides a **4th octet**:

- **store** ships the clean three-part version: `0.4.0`
- **preview / dev** append a monotonic build number: `0.4.0.137`

Chrome allows up to four integers and AMO accepts the four-part form, so
this keeps versions strictly ascending and store-valid. The *human-facing*
git tag / release name may still use a SemVer pre-release suffix
(`v0.4.0-preview.12`) — that's for people, not the manifest.

> The version flows from `package.json` → `gen-manifest.ts`. The 4th-octet
> build number for non-store channels is the one piece still to wire there
> (tracked; it needs the in-browser + store CI to validate). Until it's
> wired, all channels carry the plain three-part version.

---

## Named milestones

Each MINOR gets a short human name for the changelog header and the
launch narrative — borrowed from Hermes' date-stamped releases, but with
**SemVer primary, not CalVer**:

```
## [0.4.0] — 2026-07-xx · "the dweb"
```

> why not CalVer-primary (`v2026.6.5`): a date tells you *when* but hides
> *how much* changed, and it fights the store's ascending-version rule.
> SemVer-primary keeps progress legible; the date + name live in the
> changelog header for cadence and marketing.

---

## Release flow (per channel)

1. Land features on the dev branch; bump **MINOR** in `package.json` when
   the milestone is complete (PATCH for a fix-only release).
2. `bun run gen:dev` to regenerate manifests; CI verifies no drift.
3. Cut the **preview** build (4th-octet build number) — soak it.
4. Promote to **store** by shipping the clean three-part version once
   preview has held up. (Mirrors Zed: promotion drops the pre-release.)
5. Update `CHANGELOG.md` with the version, date, milestone name, and the
   Added/Changed/Fixed/Security sections.

---

## TL;DR

`0.MINOR.PATCH` — minor = milestone, patch = fix · 4th octet = preview/dev
build · `store/preview/dev` channels · stay 0.x until the surface
stabilizes, then spend 1.0 once. Aligns with Hermes on the
0.x-while-experimental instinct and rapid minor cadence; diverges by
keeping SemVer (not CalVer) as the primary key — cleaner for a
store-distributed extension, and more honest about *how much* shipped.
