# Tool ergonomics designs

Most of this batch is implemented. The detailed files preserve the design
reasoning. They are not a current inventory or status page.

## Current source

| Design | Status | Source |
|---|---|---|
| [Prompt cache stability](01-prompt-cache-stability.md) | Implemented | `extension/peerd-runtime/loop/system-prompt.js` and provider formatters |
| [Failure legibility](02-failure-legibility.md) | Implemented | `extension/peerd-runtime/loop/agent-loop.js`, `extension/peerd-runtime/tools/dispatcher.js` |
| [Edit robustness](03-edit-robustness.md) | Implemented | `extension/peerd-runtime/edit/`, `extension/peerd-runtime/tools/defs/edit-file.js` |
| [Universal spill](04-universal-spill.md) | Partial | Script values and web results page through shared caches. Several engine, list, search, and skill results still use fixed caps. |
| [Tool error metrics](05-tool-error-metrics.md) | Implemented | `extension/eval/` |
| [Schema diet](06-schema-diet.md) | Implemented | tool definitions, skills, and once-per-session helpers |

The tests under `tests/peerd-runtime/` define the current behavior. Re-run the
eval harness for current measurements. Do not copy old counts or token totals
from the design documents into product guidance.
