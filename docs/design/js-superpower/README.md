# JavaScript execution designs

These files are the point-in-time designs for the JavaScript execution work.
Most of the batch is implemented. The code and tests are the current contract.

## Status

| Design | Status | Current source |
|---|---|---|
| [Workspace and result paging](01-script-workspace.md) | Implemented | `extension/peerd-runtime/tools/defs/script.js`, `extension/peerd-runtime/tools/run-cache.js` |
| [Web extraction and standard helpers](02-std-web-extract.md) | Implemented | `extension/offscreen/job-runner.js`, `extension/engine-tabs/notebook-tab/notebook-std.js` |
| [Remote imports through egress](03-module-imports-via-egress.md) | Preview only; Notebook output lacks the trust fence | `extension/peerd-engine/module-resolver.js` |
| [Code surface default](04-code-surface-default.md) | Not decided | `packaging/default-settings.mjs` and the eval harness |
| [Provider calls from scripts](05-provider-call.md) | Implemented | `extension/peerd-runtime/actor/provider-call-api.js` |
| [Reusable toolbox modules](06-toolbox.md) | Implemented | `extension/peerd-runtime/toolbox/` |
| [Execution loop cleanup](07-loop-polish.md) | Implemented | execution hosts, tool gates, and their tests |

The detailed documents preserve the reasoning at implementation time. They are
not a current feature guide and do not override source, generated settings, or
tests.
