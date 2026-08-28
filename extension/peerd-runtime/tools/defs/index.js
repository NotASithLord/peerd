// @ts-check
// Controller-owned built-in tool definitions.
//
// Each tool maps to one §02 primitive on the homepage. The five
// introspection tools together let the agent prove the architectural
// thesis from inside the chat: BYOK without leaking the key, encryption
// at rest, session inheritance, the always-on denylist floor, and
// auditability. /verify (V1.4 stub via system-prompt injection) walks
// the agent through all five in order.

import { inspectTool }               from './inspect.js';
import { readDocTool }               from './read-doc.js';
import { fetchUrlTool }              from './fetch-url.js';
import { readResultTool }            from './read-result.js';
import { siteClientRunTool }         from './site-client-run.js';
import { siteClientReadTool }        from './site-client-read.js';
import { siteClientWriteTool }       from './site-client-write.js';
import { siteCaptureTool }           from './site-capture.js';
import { actorListTool }             from './actor-list.js';
import { sandboxCreateTool }          from './sandbox-create.js';
import { scriptTool }                  from './script.js';
import { editFileTool }               from './edit-file.js';
import { scheduleCreateTool }          from './schedule-create.js';
import { scheduleListTool }            from './schedule-list.js';
import { scheduleCancelTool }          from './schedule-cancel.js';
import { dwebShareTool }               from './dweb-share.js';
import { dwebDiscoverTool }            from './dweb-discover.js';
import { dwebInstallTool }             from './dweb-install.js';
import { dwebPeersTool }               from './dweb-peers.js';
import { dwebBlockTool }               from './dweb-block.js';
import { dwebDiscoveryTool }           from './dweb-discovery.js';
import { a2aRunTool }                  from './a2a-run.js';

export {
  // inspect
  inspectTool,
  readDocTool,
  // sessions
  actorListTool,
  // site clients (DESIGN-19 — per-origin derived API clients; web-actor-only)
  siteClientRunTool,
  siteClientReadTool,
  siteClientWriteTool,
  siteCaptureTool,
  // engine (the one cross-kind create; per-kind ops below)
  sandboxCreateTool,
  // engine (Notebook)
  scriptTool,
  readResultTool,
  // engine (Pod)
  // engine (App)
  // edit (SEARCH/REPLACE — primary write path)
  editFileTool,
  // scheduling (background Routines — loop/scheduler.js)
  scheduleCreateTool,
  scheduleListTool,
  scheduleCancelTool,
  // dweb (network — preview only, exposure-gated off the store build)
  dwebShareTool,
  dwebDiscoverTool,
  dwebInstallTool,
  dwebPeersTool,
  dwebBlockTool,
  dwebDiscoveryTool,
  a2aRunTool,
};

/**
 * Ordered semantic inventory for universal consumers and tests. The temporary
 * service-worker lane imports only tools/legacy-implementations.js so a moved
 * tool cannot remain executable through this broad catalog barrel.
 */
export const BUILTIN_TOOLS = Object.freeze([
  // inspect (one kind-discriminated tool: provider_config | storage |
  // session_access | denylist | audit_log)
  inspectTool,
  // sessions — actor_list is the single discovery surface (instances + open
  // tabs + API integrations) that collapsed vm_list/js_list/app_list/list_tabs/
  // list_integrations into one columnar result keyed by `type`.
  actorListTool,
  // read_doc: content-detected PDF/Office/OpenDocument/RTF/EPUB/CSV reading.
  // Registered + hidden from main; allowed for kind:'web'.
  readDocTool,
  // the web actor's SESSIONLESS secure fetch (its non-render web mechanism).
  // Registered + hidden from main (actor-only, like the DOM tools); allowed
  // for kind:'web' in ACTOR_TYPE_TOOLS.web and keyless by construction.
  fetchUrlTool,
  // One session-owned pager for oversized web, document, page, and script results.
  readResultTool,
  // site clients (DESIGN-19) — per-origin derived API clients. All web-actor-only
  // (hidden from main; allowed for kind:'web' in exposure.js). run executes the
  // stored client in the sealed worker under an origin-pinned fetch; read inspects
  // it; write persists it (confirm-gated); capture records traffic to derive it.
  siteClientRunTool,
  siteClientReadTool,
  siteClientWriteTool,
  siteCaptureTool,
  // engine — sandbox_create is the one cross-kind bootstrap (it folded
  // vm_create/js_create/app_create); the per-kind ops below are all
  // actor-only (ACTOR_ONLY_TOOLS) and reach the model via the actors.
  sandboxCreateTool,
  // engine (Notebook)
  scriptTool,
  // engine (Pod)
  // engine (App)
  // edit (SEARCH/REPLACE — primary write path)
  editFileTool,
  // goal mode (the Goal toggle — loop/goal-runner.js). Registered always but
  // exposure.js reveals them to the model ONLY while a goal run is active.
  // scheduling — background Routines (loop/scheduler.js). Main-agent tools; not
  // exposure-gated, so the agent can set up / list / cancel standing tasks.
  scheduleCreateTool,
  scheduleListTool,
  scheduleCancelTool,
  // dweb (network publish/discover/install — preview only; exposure.js hides
  // these from the agent on the store build, where DWEB_ENABLED is false)
  dwebDiscoverTool,
  dwebShareTool,
  dwebInstallTool,
  dwebPeersTool,
  dwebBlockTool,
  dwebDiscoveryTool,
  a2aRunTool,
]);
