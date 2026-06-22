# PACKAGING.md — the dual-distribution packaging system

peerd ships **two channels from one tree, one version, one release**:

| channel | name | distribution | dweb |
|---|---|---|---|
| `store` | peerd | Chrome Web Store + Firefox Add-ons (they sign) | **absent from the artifact** |
| `preview` | peerd preview | GitHub Releases, self-installed, signed, auto-updating — Chrome CRX self-install works on Linux/managed machines only; on macOS/Windows the recommended path is load-unpacked from the zip (field-verified: even a visible ExtensionInstallAllowlist policy doesn't unlock off-store CRX on an unmanaged Mac; README → Install) | included |

The extension itself still has **no build step** — dev is load-unpacked
from `extension/`. "Packaging" means: stage a copy of `extension/`,
prune per channel, generate two files, zip. Because there's no bundler,
the store/preview boundary is **structural, not tree-shaken**: the
store artifact simply does not contain `peerd-distributed/`.

```
bun run package -- --channel=store --browser=chrome   # one artifact
bun run package:all                                   # all four → artifacts/
bun run gen:dev                                     # regen dev manifest + channel-config
```

## The channel flag

`--channel` drives the decentralized web (dweb) toggle.
`packaging/gen-channel-config.ts` emits `extension/shared/channel-config.js`
with three literals: `CHANNEL`, `DWEB_ENABLED`, and `CHANNEL_DEFAULTS`.
The checked-in copy is the dev default (preview). Core code gates dweb
UI on `DWEB_ENABLED` and reads defaults from `CHANNEL_DEFAULTS` — never
from a runtime "which channel am I" probe, and the channel is never
exposed to the agent or to skills.

## The dweb boundary

Nothing outside `extension/peerd-distributed/` may reference that
module. Core programs against `shared/dweb-interface.js` (types +
stub) and obtains the live client via `loadDweb()` in
`shared/dweb-loader.js` — the ONE sanctioned reference, a dynamic
import gated on `DWEB_ENABLED`. Four enforcement layers:

1. **ESLint** `no-restricted-imports` — editor-time feedback.
2. **`bun run check:boundary`** — CI gate; also catches dynamic
   imports and path strings, which ESLint can't see.
3. **Pruning + loader swap** — store packages drop the module and replace
   the loader with `packaging/templates/dweb-loader.store.js`
   (a committed file, never a text transform).
4. **`packaging/verify-store-artifact.ts`** — unzips every store artifact
   and fails on any `peerd-distributed` string, a non-template loader,
   `update_url`/`key` in the manifest, or any identifier that exists
   only in dweb sources. Runs inside `package.ts`; don't skip it.

**Adding dwapp/dweb-only code:** put it in `peerd-distributed/`,
export through its `index.js`, widen the `DwebClient` interface
in `shared/dweb-interface.js` (stub + live), and keep every UI
surface behind `DWEB_ENABLED`. If a store user could ever see the
feature, it's not dweb-only — ship it to both channels.

## Manifest variants

`manifests/base.json` holds everything shared. `store|preview|dev
.patch.json` are deep-merge patch documents (objects merge, arrays and
scalars replace — no patch DSL). `packaging/gen-manifest.ts` merges,
injects the version from `package.json` (the single source of truth;
never hand-edit a manifest version), applies browser transforms
(Firefox: `background.scripts`, `sidebar_action`, gecko IDs; Chrome:
strips gecko keys), and for preview/chrome injects the public `key`
from `manifests/preview-chrome-key.pub`.

**Adding a permission:** needed by both channels → `base.json`. One
channel only → that channel's patch. Then `bun run gen:dev` and commit
the regenerated dev manifest.

## Channel-aware defaults

`packaging/default-settings.mjs` is the schema: each key maps to
`{ store, preview }` values; a key present for only one channel is
**absent** from the other build's `CHANNEL_DEFAULTS` entirely. The rule:
safety defaults stay strict on both channels; only friction defaults
relax on preview — and add a divergence only when it genuinely serves
the audience split. Stored values always win over defaults (Option A):
upgrades never silently change a touched setting; "Reset to defaults"
in the settings UI is how users adopt new ones.

**Adding a channel-conditional default:** add the key with both values
to `default-settings.mjs`, run `bun run gen:dev`, whitelist it in the
SW's `settings/update` route.

## Signing & keys

- `key.pem` (repo root, gitignored) signs the Chrome preview `.crx`
  (CRX3 via the `crx3` dev-dep). **Back it up offline** and mirror it
  into the `CRX_PRIVATE_KEY` GitHub secret — lose it and every preview
  install orphans. Its public half is committed
  (`manifests/preview-chrome-key.pub`) and locks the preview extension
  ID (`manifests/preview-chrome-extension-id.txt`).
- Firefox preview is signed by AMO (`web-ext sign`, channel unlisted)
  using the `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` secrets.
- Store artifacts are never signed locally — the stores sign.
- Local packaging without credentials skips signing with a `WARN … UNSIGNED`
  line; the release job greps for it and refuses to release.

## CI and releasing

`.github/workflows/package-and-release.yml`: every push/PR runs tests,
lint, the boundary check, a generated-file drift check, and the full
2×2 matrix. Pushing a tag `vX.Y.Z` (must equal `package.json` version)
additionally signs the preview artifacts, creates the GitHub Release
`peerd-preview-vX.Y.Z`, regenerates `update-feeds/`, attaches
everything, and commits the feeds back to main. Store zips are
submitted to Chrome Web Store / AMO **manually** after QA; store-review
lag behind the preview release is expected and fine.

## Releasing without Actions

Nothing in the release actually needs GitHub-hosted runners — releases
are plain API calls. When Actions can't start runners (billing outage,
offline), the same pipeline runs from a dev machine:

- `bun run preflight` — the CI gate locally (drift, lint, typecheck,
  boundary, tests; add `-- --matrix` to also package + verify all four
  artifacts).
  `scripts/install-hooks.sh` wires it as a pre-push hook.
- `bun run release` — the whole release job: preconditions (clean main,
  synced), preflight, signed `package:all` (refuses to release unsigned),
  feed regeneration + commit, atomic `main`+tag push, view-or-create the
  `peerd-preview-vX.Y.Z` release, site deploy (when `CLOUDFLARE_*` env is
  set), and a non-fatal live-feed cache-rollover check. `-- --dry-run`
  packages + verifies everything and stops before tagging (byte-for-byte
  side-effect-free — feed files are snapshot/restored).
  - **Re-runnable after a failure.** Every post-tag step is idempotent:
    the push is `--atomic` (main+tag together or neither), the release is
    view-or-create + `upload --clobber`, and a tag already pointing at
    HEAD is detected as a resume (done steps skip). If a step fails, fix
    the cause and re-run `bun run release`. `gh release view v<version>`
    shows current state.
  - **When Actions billing recovers**, a tag push also triggers CI's
    release job; it's idempotent the same way, so whichever of CI / the
    local script runs second is a no-op, not a duplicate-release error.
- `bun run feeds:check` — the monitor's logic, runnable from anywhere.

Caveat: while the repo is PRIVATE, release-asset URLs need GitHub auth,
so the update feeds and README install links won't resolve for users —
make the repo public (or host assets on peerd.ai) before real preview
distribution. The release script warns about this.

## Update feeds

Preview manifests point at `https://peerd.ai/updates/chrome-preview.xml`
and `…/firefox-preview.json`. `bun run feeds` regenerates them into
`update-feeds/` (release CI does this per tag); the peerd.ai site deploy
must serve that directory at `/updates/` with a short TTL (~5 min).
`update-feed-monitor.yml` probes daily and fails loudly if the live
feeds lag the latest release — a stale feed strands every preview user
silently.
