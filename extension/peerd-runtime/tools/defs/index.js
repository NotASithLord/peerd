// @ts-check
// Built-in tool registry — the V1 set.
//
// Each tool maps to one §02 primitive on the homepage. The five
// introspection tools together let the agent prove the architectural
// thesis from inside the chat: BYOK without leaking the key, encryption
// at rest, session inheritance, the always-on denylist floor, and
// auditability. /verify (V1.4 stub via system-prompt injection) walks
// the agent through all five in order.

import { inspectTool }               from './inspect.js';
import { readPageTool }              from './read-page.js';
import { snapshotTool }              from './snapshot.js';
import { readStateTool }             from './read-state.js';
import { watchChangesTool }          from './watch-changes.js';
import { queryDomTool }              from './query-dom.js';
import { pageEvalTool }              from './page-eval.js';
import { pageExecTool }              from './page-exec.js';
import { pageKeysTool }              from './page-keys.js';
import { clickTool }                 from './click.js';
import { typeTool }                  from './type.js';
import { navigateTool }              from './navigate.js';
import { readPdfTool }               from './read-pdf.js';
import { fetchUrlTool }              from './fetch-url.js';
import { readWebCacheTool }          from './read-web-cache.js';
import { siteClientRunTool }         from './site-client-run.js';
import { siteClientReadTool }        from './site-client-read.js';
import { siteClientWriteTool }       from './site-client-write.js';
import { siteCaptureTool }           from './site-capture.js';
import { actorListTool }             from './actor-list.js';
import { openTabTool }               from './open-tab.js';
import { vmBootTool }                 from './vm-boot.js';
import { vmImportTool }               from './vm-import.js';
import { vmWriteFileTool }           from './vm-write-file.js';
import { vmDeleteTool }               from './vm-delete.js';
import { sandboxCreateTool }          from './sandbox-create.js';
import { jsNotebookTool }                 from './js-notebook.js';
import { scriptTool }                  from './script.js';
import { pageCodeTool }               from './page-code.js';
import { jsWriteFileTool }            from './js-write-file.js';
import { jsReadFileTool }             from './js-read-file.js';
import { jsDeleteTool }               from './js-delete.js';
import { appUpdateTool }              from './app-update.js';
import { appOpenTool }                from './app-open.js';
import { appSearchTool }              from './app-search.js';
import { appDeleteTool }              from './app-delete.js';
import { appWriteFileTool }           from './app-write-file.js';
import { appReadFileTool }            from './app-read-file.js';
import { appListFilesTool }           from './app-list-files.js';
import { appDeleteFileTool }          from './app-delete-file.js';
import { editFileTool }               from './edit-file.js';
import { actorCreateTool }          from './actor-create.js';
import { actorTasksTool }          from './actor-tasks.js';
import { actorCancelTool }         from './actor-cancel.js';
import { messageActorTool }        from './message-actor.js';
import { rememberTool }                from './remember.js';
import { readMemoryTool }              from './read-memory.js';
import { requestReviewTool }          from './request-review.js';
import { completeGoalTool }            from './complete-goal.js';
import { scheduleCreateTool }          from './schedule-create.js';
import { scheduleListTool }            from './schedule-list.js';
import { scheduleCancelTool }          from './schedule-cancel.js';
import { todoInitTool, todoCheckTool, todoAddTool } from './todo.js';
import { dwebShareTool }               from './dweb-share.js';
import { dwebDiscoverTool }            from './dweb-discover.js';
import { dwebInstallTool }             from './dweb-install.js';
import { dwebPeersTool }               from './dweb-peers.js';
import { dwebBlockTool }               from './dweb-block.js';
import { dwebDiscoveryTool }           from './dweb-discovery.js';
import { dwebGuideTool }               from './dweb-guide.js';
import { a2aRunTool }                  from './a2a-run.js';

export {
  // inspect
  inspectTool,
  // DOM
  readPageTool,
  snapshotTool,
  readStateTool,
  watchChangesTool,
  queryDomTool,
  pageEvalTool,
  pageExecTool,
  pageKeysTool,
  clickTool,
  typeTool,
  navigateTool,
  readPdfTool,
  // sessions
  actorListTool,
  openTabTool,
  // site clients (DESIGN-19 — per-origin derived API clients; web-actor-only)
  siteClientRunTool,
  siteClientReadTool,
  siteClientWriteTool,
  siteCaptureTool,
  // engine (the one cross-kind create; per-kind ops below)
  sandboxCreateTool,
  // engine (WebVM)
  vmBootTool,
  vmImportTool,
  vmWriteFileTool,
  vmDeleteTool,
  // engine (Notebook)
  jsNotebookTool,
  scriptTool,
  pageCodeTool,
  jsWriteFileTool,
  jsReadFileTool,
  jsDeleteTool,
  // engine (App)
  appUpdateTool,
  appOpenTool,
  appSearchTool,
  appDeleteTool,
  appWriteFileTool,
  appReadFileTool,
  appListFilesTool,
  appDeleteFileTool,
  // edit (SEARCH/REPLACE — primary write path)
  editFileTool,
  // actor (orchestration over sessions)
  actorCreateTool,
  actorTasksTool,
  actorCancelTool,
  messageActorTool,
  // memory (V1.5 — file-based AGENTS.md)
  rememberTool,
  readMemoryTool,
  requestReviewTool,
  // goal mode (Goal toggle — exposure-gated to active runs only)
  completeGoalTool,
  // scheduling (background Routines — loop/scheduler.js)
  scheduleCreateTool,
  scheduleListTool,
  scheduleCancelTool,
  todoInitTool,
  todoCheckTool,
  todoAddTool,
  // dweb (network — preview only, exposure-gated off the store build)
  dwebShareTool,
  dwebDiscoverTool,
  dwebInstallTool,
  dwebPeersTool,
  dwebBlockTool,
  dwebDiscoveryTool,
  dwebGuideTool,
  a2aRunTool,
};

/**
 * Ordered list of V1 built-ins. The SW iterates this at boot to register
 * each tool.
 */
export const BUILTIN_TOOLS = Object.freeze([
  // inspect (one kind-discriminated tool: provider_config | storage |
  // session_access | denylist | audit_log)
  inspectTool,
  // sessions — actor_list is the single discovery surface (instances + open
  // tabs + API integrations) that collapsed vm_list/js_list/app_list/list_tabs/
  // list_integrations into one columnar result keyed by `type`.
  actorListTool,
  openTabTool,
  // DOM
  readPageTool,
  snapshotTool,
  readStateTool,
  watchChangesTool,
  queryDomTool,
  pageEvalTool,
  pageExecTool,
  pageKeysTool,
  navigateTool,
  typeTool,
  clickTool,
  readPdfTool,
  // the web actor's SESSIONLESS secure fetch (its non-render web mechanism).
  // Registered + hidden from main (actor-only, like the DOM tools); allowed
  // for kind:'web' in ACTOR_TYPE_TOOLS.web and keyless by construction.
  fetchUrlTool,
  // the web actor's CODE-REPL action surface (PR #119 A/B arm) — registered +
  // hidden from main; allowed ONLY for a code-surface web actor
  // (WEB_ACTOR_CODE_TOOLS in exposure.js).
  pageCodeTool,
  // fetch_url's spill-and-page read side — same exposure (web actor only; the
  // cache holds fetched page content).
  readWebCacheTool,
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
  // engine (WebVM)
  vmBootTool,
  vmImportTool,
  vmWriteFileTool,
  vmDeleteTool,
  // engine (Notebook)
  jsNotebookTool,
  scriptTool,
  jsWriteFileTool,
  jsReadFileTool,
  jsDeleteTool,
  // engine (App)
  appUpdateTool,
  appOpenTool,
  appSearchTool,
  appDeleteTool,
  appWriteFileTool,
  appReadFileTool,
  appListFilesTool,
  appDeleteFileTool,
  // edit (SEARCH/REPLACE — primary write path)
  editFileTool,
  // actor (orchestration over sessions)
  actorCreateTool,
  actorTasksTool,
  actorCancelTool,
  // actor (DESIGN-17 — message the agent that owns a tab-hosted instance).
  // Registered always; the exposure gate refuses it on an actor session, so a
  // actor can't recursively message another actor.
  messageActorTool,
  // memory (V1.5 — file-based AGENTS.md)
  readMemoryTool,
  rememberTool,
  // review (clean-context read-only reviewer — feature 08)
  requestReviewTool,
  // goal mode (the Goal toggle — loop/goal-runner.js). Registered always but
  // exposure.js reveals them to the model ONLY while a goal run is active.
  completeGoalTool,
  // scheduling — background Routines (loop/scheduler.js). Main-agent tools; not
  // exposure-gated, so the agent can set up / list / cancel standing tasks.
  scheduleCreateTool,
  scheduleListTool,
  scheduleCancelTool,
  todoInitTool,
  todoCheckTool,
  todoAddTool,
  // dweb (network publish/discover/install — preview only; exposure.js hides
  // these from the agent on the store build, where DWEB_ENABLED is false)
  dwebDiscoverTool,
  dwebShareTool,
  dwebInstallTool,
  dwebPeersTool,
  dwebBlockTool,
  dwebDiscoveryTool,
  dwebGuideTool,
  a2aRunTool,
]);
