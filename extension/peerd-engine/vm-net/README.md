# peerd-engine/vm-net

Pure cores for the WebVM's **HTTP-native** networking. The VM has no sockets;
all networking rides one host-side chokepoint (`vm-tab.js`) that turns a stdout
sentinel into a denylist-gated `webFetch`. These modules are the testable logic
behind that bridge — no CheerpX, no DataDevice, no `fetch` IO (all injected),
so they run under `bun test ./tests/peerd-engine/vm-net`.

| File | What |
|---|---|
| `http-bridge.js` | The VM↔host wire codec: two markers (GET fast path + rich `___PEERD_REQ___` request), the line-oriented base64 blob format, and the streaming-scanner helpers. |
| `git-archive.js` | Snapshot-clone planner: parse a clone URL, build archive-download candidates per host, default-branch probes, host-side auth header shapes. |
| `npm-resolver.js` | Semver satisfier + transitive runtime-dep planning over the npm registry. |
| `pip-resolver.js` | PyPI wheel selection (pure-python first) + `Requires-Dist` transitive planning. |
| `http-cache.js` | Cache policy (what's cacheable, keying, ETag/Last-Modified revalidation, freshness). |
| `socket-stubs.js` | The unsupported-command list + the peerd error each prints; generates the bash stubs. |

The IO shells that consume these live in `vm-tab.js` (host bridge + bash
wrappers) and the `sw/web-fetch` handler. See
[`docs/engine/VM-NETWORKING.md`](../../../docs/engine/VM-NETWORKING.md) for the
full model and limits.

**Conventions:** pure functions, IO injected, no imports of browser/CheerpX
APIs — that's what keeps them bun-testable and is why the package-manager and
git logic lives here rather than in untested bash.
