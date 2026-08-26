# Handoff

## Executable Store-Chrome baseline

- Branch baseline: `1a4ec7a`.
- Packaged native service worker: 1,377,974 bytes from 521 staged inputs.
- The production root alone reaches about 933,854 bundled bytes across 416 inputs.
- The relevant baseline tests have 29 passes and three existing cold-graph failures; the packaged worker is above the same source and executable budgets those failures report.

## Bounded-checkpoint blocker

`kernel-production-runtime.js` is an aggregate owner, not a movable semantic unit. Its dominant child is `kernel-turn-live-factories.js`: it builds the service-worker tool gate/confirmation/audit context, browser and storage clients, vault-backed provider authority, actor relay custody, and event owners in one module. Moving that unit would either move privileged state into the sealed Worker or require a generic browser/storage dispatch bridge. Both violate the target boundary.

The sealed controller already owns the main agent loop and the `script/model-call` semantic path. That production operation returns through the exact `rich.script.admit` and `rich.model.call` effects, while model credentials and network authority remain in the service worker. Extending the same finite tool protocol only for `message_actor` does not remove executable bytes: actor tool dispatch still needs the original implementation and mixed factory graph.

A transfer-entry narrowing was measured and reverted because the actual package grew to 1,378,015 bytes and 522 inputs. The transfer graph remains reachable through the turn factory, and transfer import/export must retain plaintext vault custody in the service worker.

## Safe extraction order

1. Split tool execution by a concrete family, with compact policy descriptors in the service worker and full schemas plus semantic implementations in sealed Workers. The same prepare/effect/settle protocol must cover orchestrator and actor-relayed calls before deleting that family's service-worker implementations.
2. Split actor coordination from browser/session authority. Mailbox persistence, sender lineage, cancellation, and instance pins stay in the service worker; turn planning and result shaping move behind exact actor operations.
3. Rebuild the production owner from the reduced authority pieces. Engine registries, browser listeners, vault-backed transfer, network gates, confirmations, receipts, and replay custody remain local.
4. Delete `kernel-production-runtime.js` only after the package proves its graph is absent. Do not substitute the existing generic `feature.executable.<route>` callback; it executes the original route in the worker and is not extraction.

No compliant one-step root move exists before steps 1-2. The next implementation checkpoint should select one complete tool family and must show a reduction in the actual packaged worker before it is retained.

## T2 whole-root relocation blocker

T1 at `5625535` made the mixed owner visible but did not change the executable
graph. A fresh isolated Store-Chrome package measures 1,302,119 bytes from 526
staged inputs. The retained cold graph is 347,849 minified bytes.

The requested whole-root relocation has two hard live cycles:

1. `controller-turn-semantics.js` owns provider selection and imports the
   provider registry, but every cloud adapter still calls `getSecret()` before
   it shapes its authenticated request. Both the orchestrator bridge and the
   isolated-actor relay therefore execute `callModel` in the service worker.
   Moving the adapter graph now would either expose vault plaintext to the
   controller or proxy raw fetch, headers and credential names. Both are
   forbidden.
2. The controller hosts only `now` and `complete_goal`. Every other tool uses
   the `turn.tool.dispatch` compatibility lane, while isolated actors relay the
   same calls to `offscreen-actor-client.js`. That client builds the privileged
   tool context and invokes the service-worker dispatcher. The tool definitions
   collectively consume 69 context members spanning tabs, scripting, engine
   clients, repositories, confirmation, actor custody, alarms and persistence.
   Deleting the catalog from the service-worker graph before splitting those
   call sites would require a generic browser/storage proxy or would remove the
   only execution path.

The exact reachability chain is:

`kernel-production-runtime.js` → `kernel-rich-runtime.js` →
`kernel-turn-production-runtime.js` → `kernel-turn-live-factories.js` →
`controller-turn-semantics.js` → provider registry, tool catalog/definitions,
dispatcher and turn driver.

The smallest model authority interface that breaks the first cycle is a named
streaming egress domain:

- `openInference(providerId, nativeBody)` — the kernel resolves a fixed manifest
  entry, endpoint, credential class, vault binding, transport shape and limits;
- `readInferenceChunk(streamId)`;
- `cancelInference(streamId)`;
- `readModelInventory(providerId)`;
- `readModelContextWindow(providerId, modelId)`.

The controller supplies no URL, authentication header, credential name or
unrestricted fetch option. The kernel returns only status, an allowlisted header
projection and bounded response chunks. Provider adapters can then own request
shaping, retries and response parsing without receiving credential material.

The second cycle cannot be broken by one catch-all operation. It requires named
domain interfaces shared by orchestrator and actor executors: page automation,
engine instances, repositories, actor custody, confirmations/audit, schedules
and semantic persistence. Each method must represent a complete domain action
(for example, an owned-tab navigation or a confirmed memory write), not a raw
browser method, storage key or nested action selector. The old dispatch lane can
be deleted only in the same delivery that moves every remaining caller to those
interfaces; otherwise a second path remains.

Because both interfaces are prerequisites and neither deletes executable bytes
alone, implementing either as a preparation-only checkpoint would violate the
accepted deletion rule. The architectural choices are therefore: authorize one
combined relocation large enough to introduce both exact domains and delete the
two fallbacks in one retained checkpoint, or relax the no-preparation rule for
the model-egress seam. No safe smaller T2 exists under the current constraints.
