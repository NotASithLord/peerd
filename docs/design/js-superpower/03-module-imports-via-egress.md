# Remote module imports through audited egress

Remote module imports are a package policy, not a worker capability.
`REMOTE_MODULE_IMPORTS_ENABLED` is generated with the channel configuration.
Chrome and Firefox Preview packages enable it. Store and web packages disable it.

## Supported imports

Notebook and Script entry code can use literal static imports and re-exports.
Relative files, `peerd:std`, `peerd:wasi`, and `peerd:toolbox/<name>` resolve
through the host. Chrome and Firefox Preview also accept literal static HTTP
and HTTPS imports.

Dynamic imports, `peerd.self.import`, computed specifiers, import attributes,
other URL schemes, and extension-absolute paths are refused with a stable
policy error. Packaged MV3 workers cannot complete the dynamic blob-import
step, so the host rejects it before worker execution.

## Preview path

The resolver decodes the literal specifier, canonicalizes its URL, and fetches
source through `sw/web-fetch`. That route applies the denylist, private-network
checks, redirect checks, and audit. The resolver transforms the module's
static dependency graph and gives the worker host-owned blob URLs. Third-party
URLs never reach the worker's native loader.

Remote graphs have per-module size and per-run count limits. They use only the
run-local resolver cache. An optional `#sha256-<base64>` or base64url fragment
pins the fetched source. Invalid pins and hash mismatches fail closed.

A lane without egress does not receive the fetch dependency. Remote code is
therefore unavailable to page, site-client, and mesh-only jobs even in a
Preview package.

## Store and web path

The resolver checks the generated package policy before it calls a fetch
dependency. A false or missing grant returns
`remote_module_imports_unavailable` and makes no request. The check remains in
place even if a caller accidentally injects a fetch function.

`toolbox_write` validates module syntax and resolves local, builtin, and toolbox
imports before storage. For Preview remote imports, it checks specifier policy
and the direct graph-count limit without fetching third-party source. Remote
availability, source syntax, and transitive dependencies are runtime checks.

## Trust boundary

Both execution hosts mark the whole resolved graph as remote-derived when any
HTTPS module is present. The worker profile removes network, file, agent,
provider, browser, site, and dweb clients. Host relays refuse forged requests.
A remote module cannot import a local toolbox module. Returned values, logs,
and errors cross the untrusted-content fence before reaching the model.

Firefox uses the same resolver and policy, then links the authorized graph into
one strict worker script. A disposable packaged compiler Worker performs the
link and is terminated on Stop or deadline. The code Worker runs inside a
sandboxed, opaque-origin host with no extension APIs, no string compilation,
and `connect-src 'none'`. Store still refuses remote imports before fetching.
Preview enables them under the same compute-only profile as Chrome.

## Authoritative sources

- `packaging/gen-channel-config.ts` defines the channel grant.
- `extension/peerd-engine/module-import-policy.js` parses and classifies import
  syntax.
- `extension/peerd-engine/module-resolver.js` enforces policy and builds static
  module graphs.
- `extension/peerd-engine/single-module-linker.js` emits the Firefox worker
  entry without child module loads.
- `extension/engine-tabs/notebook-tab/notebook-tab.js` and
  `extension/offscreen/job-runner.js` wire the browser hosts.
- `packaging/verify-store-artifact.ts`, the packaged page check, and the
  resolver tests verify the released behavior.
