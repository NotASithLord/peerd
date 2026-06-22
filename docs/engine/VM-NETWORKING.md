# WebVM networking — HTTP-native, browser-pure

> How the CheerpX WebVM reaches the network, what works, what never will,
> and why. Implemented in `extension/peerd-engine/vm-net/` (pure cores),
> `extension/vm-tab/vm-tab.js` (host bridge + bash wrappers), and the
> `sw/web-fetch` handler in `background/service-worker.js`.

## The model: one chokepoint, HTTP only

The WebVM has **no sockets**. CheerpX *can* do networking, but only via
lwIP-over-Tailscale-over-WebSocket — an **out-of-browser dependency** (a
Tailscale account + relay/exit node) that breaks peerd's no-backend,
no-account ethos. We reject it.

Instead, every byte the VM fetches rides **one channel**: a sentinel line on
the VM's stdout that the host (`vm-tab.js`) turns into a denylist-gated
`webFetch` and answers by staging response files back through the DataDevice.
That makes the VM **HTTP(S)-native**: anything expressible as an HTTP request to
a non-denylisted, non-private host works; anything needing a raw socket does
not, and says so clearly.

This is a deliberate trade: you give up SSH, database wire protocols, and
arbitrary TCP/UDP, and in return you keep full sovereignty — no relay, no
third-party network, the same audited egress as the rest of peerd.

## What works

| Tool | Supported | Notes |
|---|---|---|
| `curl` | GET (fast, cached) + `-X`/`-H`/`-d`/`--json`/`-o`/`-O`/`-f`/`-w %{http_code}`/`-I` | Full methods + headers + body. Redirects are **not** followed (each hop would re-open the egress gates against an unchecked host). |
| `wget` | GET + `--header`/`--post-data`/`--post-file`/`--method` | |
| `git clone` | **snapshot** clone of any ref on github / gitlab (+ a best-effort github/gitlab-layout guess for self-hosted hosts) | Host-side archive download (`peerd://git-clone`) → unzip. Default branch is resolved via the host's API; `-b <ref>` pins a branch/tag/commit. **No `.git`, no history, no fetch/push** — see Limits. |
| `npm` / `yarn` / `pnpm` `add <pkg…>` | runtime dependency tree, resolved + downloaded host-side, extracted into `node_modules` (same npm registry for all three) | No install scripts, no native builds, no `package.json` auto-install (name packages explicitly). |
| `pip install <pkg…>` / `-r req.txt` | **pure-python** wheels (`py3-none-any`), transitive over `Requires-Dist` | No sdists / C-extension builds. For pandas/numpy etc. on 32-bit, bake them from `apt` into a custom image (below). |
| `gem install <name…>` | **pure-ruby** gems (platform `ruby`), transitive over runtime deps | No native-extension gems, no Bundler/Gemfile resolution. |
| arbitrary HTTP from code | yes | Anything that shells out to curl/wget, or a language HTTP client that you route through them. |

All of the above flow through the **same egress as the web tools**: the
denylist, the SSRF/private-network block, and the audit log apply to **every
method** — a `POST` from the VM is not a new exfiltration surface.

### Caching

Safe, idempotent GETs are cached host-side in IndexedDB (`vm_http_cache`), with
ETag / Last-Modified revalidation and `max-age` freshness. Re-cloning a repo or
re-installing the same wheels/tarballs hits warm bytes; re-runs work offline.
The cache is best-effort and disposable — clearing it only costs a re-fetch.

### Private repos (git auth)

Add a token under **Settings → Security → Git credentials** (host + a
repo-scoped PAT). It's stored in the vault (same encryption as your API keys, as
`git:<host>`), and the SW injects the right auth header (`Authorization: Bearer
…` for GitHub/Gitea, `PRIVATE-TOKEN` for GitLab) on clone + default-branch API
calls. **The token never enters the VM and is never shown to the agent** — it's
decrypted only in the SW at request time, **bound to its host** (canonicalizing
`api.github.com` → `github.com`), sent only over HTTPS, and `webFetch` refuses
redirects so it can't be carried off-host. With no token, clones are anonymous
(public repos still work). OAuth sign-in is planned; for now use a PAT.

## What never works (and now says so)

Raw TCP/UDP/ICMP is impossible in the browser sandbox without a relay. These
commands are replaced with shims that **exit non-zero with a clear `peerd:`
message** naming the HTTP-native alternative, instead of hanging or failing deep
in libc:

`ssh`, `scp`, `sftp`, `telnet`, `nc`/`netcat`, `ping`, `traceroute`, `dig`,
`nslookup`, `host`, `rsync`.

If you need one of these, the work belongs outside the sandbox (or, for
name-resolution, just `curl` the hostname directly — resolution happens
host-side).

**`apt`/`apt-get`/`aptitude`** can't reach Debian's repos either, but they're
handled more gently: only the network subcommands (`install`, `update`,
`upgrade`, …) are intercepted with a message pointing at the custom-image and
`pip`/`npm` paths; offline subcommands (`apt list`, `dpkg -l`) pass through to
the real binary. `add-apt-repository`/`apt-key` are full stubs.

## Self-documenting: the banner + `peerd-net`

Every VM prints a one-line banner when it boots — *"peerd WebVM · HTTP(S)-native
networking (curl/wget/git/npm/pip work; raw sockets don't). Run `peerd-net` for
details."* — and ships a **`peerd-net`** command that prints the full
capability matrix (what works, what doesn't, how to set up private-git auth,
how to raise the timeout, how to bake a custom image). The aim: a developer (or
the agent) never has to guess where the edges are.

## Limits, stated plainly

- **32-bit only.** CheerpX emulates i386. amd64-only toolchains (e.g. Bun) do
  not run. Node/Python from Debian i386 do.
- **git is a snapshot.** Archive-based clone gives you the tree of one ref, not
  `.git`/history/branches, and there's no `push`. Real smart-HTTP git (full
  history + push over HTTPS) is a documented follow-up — it needs an in-VM
  pkt-line client; the wire (POST + auth) is already in place for it.
- **No package.json / native builds.** The pkg shims pull runtime deps of named
  packages; they don't run install scripts or compile C extensions.
- **Request bodies are capped** (8 MB) — they ride one PTY line. Response bodies
  cap at 50 MB. Large uploads are a non-goal of the in-VM bridge.
- **Timeout** is `PEERD_HTTP_TIMEOUT` seconds (default 120); raise it in the VM
  for slow, large downloads.

## Going faster: a warm custom image

The most effective lever is provisioning, not networking: bake the toolchain
(and heavy 32-bit apt packages like pandas/numpy that can't come from pip) into
a custom Debian image so a fresh VM starts ready. See
[`build/vm-image/Dockerfile`](../../build/vm-image/Dockerfile) and
[`docs/engine/VM-IMAGE.md`](./VM-IMAGE.md) (built via
`scripts/build-vm-image.sh`). Then the bridge fetches only the delta.

## Where the code lives

- `extension/peerd-engine/vm-net/` — pure cores (bun-tested):
  `http-bridge.js` (wire codec), `git-archive.js`, `npm-resolver.js`,
  `pip-resolver.js`, `http-cache.js`, `socket-stubs.js`.
- `extension/vm-tab/vm-tab.js` — the host bridge: the stdout-marker scanner,
  the `serveVmHttp` dispatcher, the `peerd://` control ops (git/npm/pip
  orchestration), and the `WRAPPERS_BASH` the VM sources.
- `extension/background/service-worker.js` — `sw/web-fetch`: the cached,
  denylist-gated, git-auth-aware fetch the bridge calls.
