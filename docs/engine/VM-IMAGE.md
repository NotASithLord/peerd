# Pre-baked WebVM image — scoping

> Status: SCOPING. Not built end-to-end yet. The scaffold at
> `scripts/build-vm-image.sh` (which fails fast by design — see §7) and the
> target Dockerfile it consumes (`build/vm-image/Dockerfile`, §2) now exist;
> neither has produced a booted image. The Dockerfile additionally bakes
> `nodejs`/`npm`/`unzip` so the HTTP-native network shims
> (`docs/engine/VM-NETWORKING.md`) have their offline-tail interpreters.
> Goal: a peerd-built Debian disk image with `python3`, `pip`,
> `pandas`, `requests`, `jq`, `curl`, `git`, `ripgrep` preinstalled,
> so `vm_boot("python3 -c 'import pandas'")` works without the agent
> spending minutes apt-getting inside an emulated 32-bit CPU.
>
> External facts below were verified against cheerpx.io docs, the
> leaningtech/webvm repo, and live curl probes on 2026-06-12; each is
> marked. CheerpX's docs are thin in places — unverifiable points are
> flagged as such rather than guessed.

## 1. Where the base image comes from today

`extension/vm-tab/vm-tab.js` hardcodes one module-level constant:

```js
const STOCK_DEBIAN_IMAGE = 'wss://disks.webvm.io/debian_large_20230522_5044875331.ext2';
const STOCK_DEBIAN_IMAGE_HTTP = STOCK_DEBIAN_IMAGE.replace(/^wss:\/\//, 'https://');
```

Boot (vm-tab.js `boot()`, step 4) prefers
`HttpBytesDevice.create(STOCK_DEBIAN_IMAGE_HTTP)` — an HTTP byte-range
block device whose downloaded base blocks get persistently cached in
the per-VM IDB overlay — and falls back to
`CloudDevice.create(STOCK_DEBIAN_IMAGE)` (Leaning Tech's wss://
streaming protocol, no persistent cache) if the HTTP device fails to
open. The per-VM writable layer is
`OverlayDevice.create(baseDev, IDBDevice.create(diskOverlayKey))`,
with `diskOverlayKey = peerd-vm-<vmId>` minted once per VM and
**immutable** (`peerd-engine/vm-registry.js`).

There is no per-VM image field anywhere: `VmRecord` is
`{ id, name, diskOverlayKey, ownerSessionId, pinned, createdAt,
lastUsedAt }`. Every VM boots the same stock image.

Two environment facts that shape everything below
(`manifests/base.json`):

- CSP: `connect-src 'self' https: wss://disks.webvm.io` — **any
  HTTPS image host is already allowed**; only a new wss:// host would
  need a manifest change. (A custom image has no wss path anyway —
  CloudDevice speaks to Leaning Tech's disk server, which we neither
  run nor can publish to. A custom image is HTTP-only, and its
  fallback story is "fail clearly", not "fall back to a different
  filesystem".)
- The vm-tab page is cross-origin isolated
  (`cross_origin_embedder_policy: require-corp`) — CheerpX needs
  SharedArrayBuffer. Under COEP:require-corp, cross-origin responses
  must be CORS-approved, so the image host MUST send
  `Access-Control-Allow-Origin` (`*` is fine — the extension origin
  differs per browser/install: `chrome-extension://…` /
  `moz-extension://…`).

## 2. How a CheerpX disk image is actually built (verified)

Per [cheerpx.io/docs/guides/custom-images](https://cheerpx.io/docs/guides/custom-images)
(fetched 2026-06-12):

- Host requirements: a **Linux** machine with `buildah` and
  `mkfs.ext2` (e2fsprogs). Rootless is fine (`buildah unshare`).
- The base image **must be 32-bit x86** (i386/i686) — CheerpX emulates
  x86-32. This is the single most consequence-laden constraint (§3).
- Flow: Dockerfile → OCI image → mounted container filesystem →
  `mkfs.ext2 -d` packs the tree into an ext2 image:

```sh
buildah build -f Dockerfile --dns=none --platform linux/i386 -t peerd-vm-image
buildah from --name peerd-vm-container peerd-vm-image
buildah unshare          # enter rootless mount namespace
mnt=$(buildah mount peerd-vm-container)
du -sh "$mnt"            # size the filesystem before allocating
mkfs.ext2 -b 4096 -d "$mnt" peerd-debian-py_<ver>.ext2 <SIZE>
buildah umount peerd-vm-container && exit
```

- Size: allocate somewhat more than `du -sh` reports;
  **CheerpX's documented maximum image size is 2 GB**.

The webvm repo's `Deploy` workflow
([leaningtech/webvm](https://github.com/leaningtech/webvm),
`.github/workflows/deploy.yml`) is an equivalent recipe using plain
Docker on a GitHub runner (`docker build --platform=i386`, then
`fallocate` + `mkfs.ext2 -r 0` + loop-mount + `docker cp -a`), with
`IMAGE_SIZE` defaulting to 750M and capped at 950M *by runner disk,
not by CheerpX*. It also splits the image into 128 KB chunks for
GitHub Pages — note that this chunked "split" loader is **WebVM
application code, not part of the CheerpX API peerd vendors**; our
`HttpBytesDevice.create(url)` takes exactly one URL to one file
(verified against the
[HttpBytesDevice reference](https://cheerpx.io/docs/reference/CheerpX.httpBytesDevice/create)).
So chunk-hosting is not an option for peerd without writing a custom
block device. It is rejected below on those grounds.

For reference, the stock `debian_large` ext2 published on webvm's
GitHub release weighs **2,000,000,000 bytes** (verified via ranged
curl: `content-range: bytes 0-1023/2000000000`) — i.e. the image
peerd streams today already sits at the 2 GB ceiling. A purpose-built
image should land far under it.

### The Dockerfile (target package set)

```dockerfile
FROM --platform=linux/i386 docker.io/i386/debian:bullseye
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      python3-pandas python3-requests \
      jq curl git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && apt-get clean
```

Load-bearing choice — **pandas/numpy/requests come from apt, not
pip**: PyPI stopped publishing 32-bit Linux wheels for
pandas/numpy long ago, so `pip install pandas` on i386 means a
source build (hours under emulation, likely OOM) or failure. Debian
still builds `python3-pandas`/`python3-numpy` for i386 through
bullseye/bookworm. `pip` itself is included for pure-Python packages,
which install fine. `bullseye` is the conservative default (the stock
image is buster-era and known-good under CheerpX); `bookworm` i386
also exists and buys newer pandas — try it second, after a bullseye
boot is proven.

Size expectation: webvm's `debian_mini` ships at 750M allocated; the
python3+pandas+numpy stack plus git/ripgrep adds roughly 300–500 MB of
installed payload. Plan for `IMAGE_SIZE` around **1300M–1500M**, set
from the actual `du -sh` plus ~20% slack, comfortably under the 2 GB
cap. (Free space inside the image matters less for peerd than for
WebVM: per-VM writes land in the IDB overlay, but ext2 still needs
headroom for inode/metadata churn.)

Open verification items for the first real build (do not skip):

- Confirm the stock image's login conventions (the stock debian_large
  drops into a non-root `user`; peerd's vm-tab runs
  `/bin/bash --login -i` against whatever the image provides). Match
  or document.
- Confirm peerd's egress wrappers install + verify on the custom image
  (vm-tab boot step 8 `installWrappers` greps `[verify]` lines — boot
  log must show `wrappers verified`).
- `--dns=none` (buildah flow) exists to keep build-time DNS state out
  of the image; the Docker-on-CI flow instead injects 8.8.8.8 at
  `docker run` time. Either way, check `/etc/resolv.conf` in the final
  tree — the VM has no real network (peerd-fetch marker protocol
  only), so a sane static file beats a leaked CI resolver.

## 3. Hosting: requirements, candidates, honest verdicts

What the serving origin must provide for `HttpBytesDevice` under
peerd's COEP-isolated vm-tab:

1. HTTPS (CSP `connect-src https:` covers it; plain http://localhost
   is blocked — see dev-loop note in §6).
2. **HTTP range requests** (`Accept-Ranges: bytes`, 206 responses) —
   the device reads blocks lazily; full-file downloads are not how it
   works.
3. **CORS**: `Access-Control-Allow-Origin: *` on every response,
   including 206s (COEP:require-corp, §1).
4. **Immutable, versioned URLs** — the bytes behind a URL must never
   change after publication (§4 explains why this is correctness, not
   just cache hygiene).
5. Stable, non-expiring URLs — the device holds the URL for the
   lifetime of a booted VM, and re-boots use it forever.

### Candidates

**peerd.ai (Cloudflare Pages) — NO.** Pages has a hard
**25 MiB per-file limit** (verified:
[developers.cloudflare.com/pages/platform/limits](https://developers.cloudflare.com/pages/platform/limits/)).
A ~1.4 GB ext2 cannot be a Pages asset, full stop. The WebVM-style
workaround (thousands of 128 KB chunks — ~11k files would even fit the
20k-file limit) requires the custom split-loader device peerd doesn't
have and shouldn't write (§2). Rejected.

**Cloudflare R2 behind a custom domain (e.g. `disks.peerd.ai`) —
RECOMMENDED.** Public bucket exposed via a custom domain on the
existing peerd.ai zone: zero egress fees, per-bucket CORS rules,
ranged GETs, and Cloudflare's cache in front (Smart Tiered Cache) so
hot blocks serve from edge
([public buckets docs](https://developers.cloudflare.com/r2/buckets/public-buckets/)).
The `r2.dev` subdomain is explicitly rate-limited and documented
dev-only — fine for a first boot test, not for release. Cost at this
scale is noise: ~1.4 GB × $0.015/GB-month ≈ **2¢/month** storage;
reads are Class B ops at fractions of a cent per million, and cached
edge hits don't even bill. One-time setup: create bucket, attach
custom domain, set a CORS rule (`GET`, origin `*`), upload with
`cache-control: public, max-age=31536000, immutable`.

**GitHub Releases — NO for serving (fine as build-artifact archive).**
Verified by live curl (2026-06-12) against webvm's own release asset:
the asset URL 302s from `github.com` (response carries **no
`Access-Control-Allow-Origin`** — a CORS-mode fetch dies at the
redirect hop) to `release-assets.githubusercontent.com`, which does
serve `206` + `accept-ranges: bytes` but through a **signed URL that
expires in ~1 hour** (`se=` param). Both properties independently
disqualify it as the origin a block device streams from for weeks.
Keep publishing the `.ext2` as a release asset for provenance and as
the canonical archive the R2 upload is made from — just never point
`HttpBytesDevice` at it. (This also explains why webvm itself fronts
its images with `disks.webvm.io` instead of raw releases.)

Side note from probing: `disks.webvm.io` answers plain curl ranged
GETs with 500 (likely bot-filtering or protocol specifics of Leaning
Tech's disk server), so the stock host couldn't be externally
re-verified — peerd's own boot traces are the evidence the HTTP path
works in-extension. Our own host must behave better than that under
`curl -r`, because that IS the §6 verification step.

## 4. Update & cache story — why image URLs must be immutable

How caching actually works today (this is the part that bites):

- CheerpX persistently caches downloaded base-image **blocks inside
  the per-VM IDB overlay device** (`diskOverlayKey`), interleaved with
  the VM's own writes. The cache is keyed by **block number within the
  device** — not by URL, not by content hash. CheerpX documents **no
  invalidation mechanism whatsoever** for a changed base image
  (checked: custom-images guide, device references; the OverlayDevice
  docs are silent on base-content change).
- vm-tab.js's own header comment states the operating rule we already
  rely on: the https:// and wss:// stock URLs are interchangeable only
  because they are **"identical bytes → identical ext2 block numbers,
  so existing per-VM overlays stay valid."**

Consequences, stated as rules:

1. **Never mutate the bytes behind a published image URL.** A VM whose
   overlay holds blocks 0–N of image v1 that suddenly streams v2 for
   block N+1 has a silently corrupted filesystem. Versioned filenames,
   uploaded once, `immutable` cache-control: e.g.
   `https://disks.peerd.ai/peerd-debian-py_20260612_<sizeBytes>.ext2`
   (same convention as the stock image's
   `debian_large_20230522_5044875331.ext2` — name, date, byte size).
2. **Never re-point an existing VM at a different image.** Image
   identity must be pinned per-VM at creation, exactly as immutable as
   `diskOverlayKey` — because the overlay IS a function of the image.
3. **"Updating" the image means new VMs, not upgraded VMs.** Ship
   v2 → new VMs boot v2; existing VMs keep v1 forever (their URL stays
   live — another reason for dirt-cheap immutable R2 objects). No
   in-place migration exists or should be promised.
4. The known inefficiency stands: base blocks cache **per-VM** (each
   overlay re-downloads/re-caches the same image blocks). That's the
   pre-existing `TODO(shared-base-cache)` in vm-tab.js
   ("Shared WebVM base-image cache") — unchanged by this work, just
   slightly more annoying with a bigger custom image.

### The versioned override, concretely

Smallest honest change set (NOT implemented here; scoping only):

- `vm-registry.js`: add optional `image: { url, label } | null` to
  `VmRecord`, set at `create()` time, **excluded from the `update()`
  patch allowlist** (immutable, rule 2). `null` ⇒ stock — existing
  records keep working with zero migration.
- `vm-tab.js`: read `record.image?.url`; when present use it for
  `HttpBytesDevice` and **fail the boot** if it can't open (no silent
  fallback to stock — wrong-base-against-overlay is corruption, rule
  2; the CloudDevice fallback remains stock-only).
- A default-image constant moves from vm-tab.js into config so
  `vm_create` / the UI can offer "stock Debian" vs
  "peerd Debian + Python <version>". Whether the peerd image becomes
  the *default* for new VMs is a product call to make after real boot
  + size telemetry, not in this doc.

No manifest change needed (CSP already allows `https:`, §1).

## 5. Build runbook (step by step)

Prerequisites: Linux x86_64 host (or CI runner) — **macOS cannot run
this flow** (no buildah userns / loop ext2); `buildah` (or Docker +
loop-mount variant), `e2fsprogs` (`mkfs.ext2`), ~3× the image size in
free disk, `wrangler` authenticated to the Cloudflare account for the
upload step.

1. Author/adjust the Dockerfile (§2). Keep it in-repo (proposed:
   `build/vm-image/Dockerfile`) so the image is reproducible from a
   commit.
2. Build the OCI image:
   `buildah build -f build/vm-image/Dockerfile --dns=none --platform linux/i386 -t peerd-vm-image`
3. `buildah from --name peerd-vm-container peerd-vm-image`, then
   inside `buildah unshare`: `mnt=$(buildah mount peerd-vm-container)`.
4. `du -sh "$mnt"` → pick SIZE = du + ~20% (cap: 2000M hard, aim
   ≤1500M).
5. `mkfs.ext2 -b 4096 -d "$mnt" peerd-debian-py_$(date +%Y%m%d).ext2 <SIZE>`
6. Clean up (`buildah umount` / `rm` / `rmi`), rename the file to the
   final convention with its byte size:
   `peerd-debian-py_<YYYYMMDD>_<bytes>.ext2`.
7. Record `sha256sum` next to the artifact; attach the .ext2 + sha to
   a GitHub release (archive/provenance only — §3).
8. Upload to R2 with immutable caching, e.g.
   `wrangler r2 object put peerd-disks/peerd-debian-py_<...>.ext2 --file <...> --cache-control "public, max-age=31536000, immutable"`
   (large files go via multipart; rclone is the fallback uploader).
   Ensure the bucket has the CORS rule and the `disks.peerd.ai` custom
   domain attached (one-time, §3).
9. Verify the origin from outside (this exact check, because GitHub
   failed it and disks.webvm.io can't be probed):

   ```sh
   curl -s -o /dev/null -D - -r 0-1023 \
     -H "Origin: chrome-extension://test" \
     https://disks.peerd.ai/peerd-debian-py_<...>.ext2
   # MUST show: HTTP 206, accept-ranges: bytes, content-range,
   #            access-control-allow-origin: *
   ```

10. Boot test in the extension (dev channel + the §4 override, or a
    temporary local edit of STOCK_DEBIAN_IMAGE_HTTP while testing):
    create a fresh VM (fresh overlay — never reuse one from another
    image), then `vm_boot` smoke suite:
    `uname -a`, `python3 -c 'import pandas, requests; print(pandas.__version__)'`,
    `jq --version`, `git --version`, `rg --version`, and confirm the
    boot log reaches `wrappers verified`.
11. Re-boot the same VM and confirm the IDB block cache works (second
    boot dramatically less network; boot card "Streaming" stage flies
    by).

`scripts/build-vm-image.sh` scaffolds steps 2–6 with fail-fast
prerequisite checks; it is a documented skeleton, not a finished tool
— see the banner in the script.

## 6. Dev-loop wrinkle worth knowing before testing locally

CSP `connect-src` permits `'self' https:` — so `http://localhost:8080`
is **blocked** for the vm-tab's image fetches. Local image testing
therefore needs an HTTPS local server with real range support
(python3's `http.server` does ranges *not at all*; use caddy or
`npx http-server` behind mkcert certs) — or skip local serving and
test straight off the R2 `r2.dev` dev URL, which is the path of least
resistance and exercises the real headers. Budget this into the first
build session rather than discovering it at 1am.

## 7. Scope summary

| Piece | Size | Risk | Blocked on |
|---|---|---|---|
| Dockerfile + first image build | small | i386 package set surprises (pandas via apt mitigates) | Linux build host |
| R2 bucket + disks.peerd.ai + CORS | small, one-time | none — standard CF setup on existing zone | CF account access |
| `VmRecord.image` + vm-tab override | small | correctness rule 2 must be enforced (immutability) | nothing |
| Boot + cache verification | medium | CheerpX undocumented edges (invalidation, bookworm compat) | image hosted |
| Build runbook automation (CI) | later | n/a | manual runbook proven first |

Total: a focused week including verification, dominated by the
build-and-boot iteration loop, not by code. The riskiest unknowns are
exactly the ones the runbook's verification steps exist to retire:
i386 package behavior under emulation, and the undocumented corners of
CheerpX's block cache.
