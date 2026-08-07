# Remote module imports through audited egress

Remote module imports are a package policy, not a worker capability.
`REMOTE_MODULE_IMPORTS_ENABLED` is generated with the channel configuration.
Preview packages enable it. Store and web packages disable it.

## Supported imports

Notebook and Script entry code can use literal static imports and re-exports.
Relative files, `peerd:std`, `peerd:wasi`, and `peerd:toolbox/<name>` resolve
through the host. Preview also accepts literal static HTTP and HTTPS imports.

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

## Remaining trust work

The headless Script host marks remote module use as egress and fences its
result. The visible Notebook host still needs to carry equivalent provenance
into `js_notebook` output. The broader policy for executing code that was
fetched as ordinary data is tracked separately.

## Authoritative sources

- `packaging/gen-channel-config.ts` defines the channel grant.
- `extension/peerd-engine/module-import-policy.js` parses and classifies import
  syntax.
- `extension/peerd-engine/module-resolver.js` enforces policy and builds static
  module graphs.
- `extension/engine-tabs/notebook-tab/notebook-tab.js` and
  `extension/offscreen/job-runner.js` wire the browser hosts.
- `packaging/verify-store-artifact.ts`, the packaged page check, and the
  resolver tests verify the released behavior.
