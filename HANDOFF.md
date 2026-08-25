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
