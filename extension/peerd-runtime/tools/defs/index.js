// @ts-check
// Built-in tool registry — the V1 set.
//
// Each tool maps to one §02 primitive on the homepage. The five
// introspection tools together let the agent prove the architectural
// thesis from inside the chat: BYOK without leaking the key, encryption
// at rest, session inheritance, the always-on denylist floor, and
// auditability. /verify (V1.4 stub via system-prompt injection) walks
// the agent through all five in order.

import { inspectStorageTool }        from './inspect-storage.js';
import { inspectAuditLogTool }       from './inspect-audit-log.js';
import { inspectSessionAccessTool }  from './inspect-session-access.js';
import { inspectDenylistTool }       from './inspect-denylist.js';
import { inspectProviderConfigTool } from './inspect-provider-config.js';
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
import { listTabsTool }              from './list-tabs.js';
import { openTabTool }               from './open-tab.js';
import { vmBootTool }                 from './vm-boot.js';
import { vmImportTool }               from './vm-import.js';
import { vmWriteFileTool }           from './vm-write-file.js';
import { vmListTool }                 from './vm-list.js';
import { vmCreateTool }               from './vm-create.js';
import { vmDeleteTool }               from './vm-delete.js';
import { jsListTool }                 from './js-list.js';
import { jsCreateTool }               from './js-create.js';
import { jsNotebookTool }                 from './js-notebook.js';
import { jsRunTool }                  from './js-run.js';
import { jsWriteFileTool }            from './js-write-file.js';
import { jsReadFileTool }             from './js-read-file.js';
import { jsDeleteTool }               from './js-delete.js';
import { appListTool }                from './app-list.js';
import { appCreateTool }              from './app-create.js';
import { appUpdateTool }              from './app-update.js';
import { appOpenTool }                from './app-open.js';
import { appSearchTool }              from './app-search.js';
import { appDeleteTool }              from './app-delete.js';
import { appWriteFileTool }           from './app-write-file.js';
import { appReadFileTool }            from './app-read-file.js';
import { appListFilesTool }           from './app-list-files.js';
import { appDeleteFileTool }          from './app-delete-file.js';
import { editFileTool }               from './edit-file.js';
import { spawnSubagentTool }          from './spawn-subagent.js';
import { subagentTasksTool }          from './subagent-tasks.js';
import { subagentCancelTool }         from './subagent-cancel.js';
import { doTool }                      from './do.js';
import { getTool }                     from './get.js';
import { checkTool }                   from './check.js';
import { rememberTool }                from './remember.js';
import { readMemoryTool }              from './read-memory.js';
import { requestReviewTool }          from './request-review.js';
import { completeGoalTool }            from './complete-goal.js';
import { dwebShareTool }               from './dweb-share.js';
import { dwebDiscoverTool }            from './dweb-discover.js';
import { dwebInstallTool }             from './dweb-install.js';
import { dwebPeersTool }               from './dweb-peers.js';
import { dwebBlockTool }               from './dweb-block.js';
import { dwebDiscoveryTool }           from './dweb-discovery.js';
import { dwebGuideTool }               from './dweb-guide.js';

export {
  // inspect
  inspectStorageTool,
  inspectAuditLogTool,
  inspectSessionAccessTool,
  inspectDenylistTool,
  inspectProviderConfigTool,
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
  listTabsTool,
  openTabTool,
  // engine (WebVM)
  vmBootTool,
  vmImportTool,
  vmWriteFileTool,
  vmListTool,
  vmCreateTool,
  vmDeleteTool,
  // engine (Notebook)
  jsListTool,
  jsCreateTool,
  jsNotebookTool,
  jsRunTool,
  jsWriteFileTool,
  jsReadFileTool,
  jsDeleteTool,
  // engine (App)
  appListTool,
  appCreateTool,
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
  // subagent (orchestration over sessions)
  spawnSubagentTool,
  subagentTasksTool,
  subagentCancelTool,
  // high-level browser tools (do/get/check — runner layer over the DOM engine)
  doTool,
  getTool,
  checkTool,
  // memory (V1.5 — file-based AGENTS.md)
  rememberTool,
  readMemoryTool,
  requestReviewTool,
  // goal mode (Goal toggle — exposure-gated to active runs only)
  completeGoalTool,
  // dweb (network — preview only, exposure-gated off the store build)
  dwebShareTool,
  dwebDiscoverTool,
  dwebInstallTool,
  dwebPeersTool,
  dwebBlockTool,
  dwebDiscoveryTool,
  dwebGuideTool,
};

/**
 * Ordered list of V1 built-ins. The SW iterates this at boot to register
 * each tool.
 */
export const BUILTIN_TOOLS = Object.freeze([
  // inspect
  inspectProviderConfigTool,
  inspectStorageTool,
  inspectSessionAccessTool,
  inspectDenylistTool,
  inspectAuditLogTool,
  // sessions
  listTabsTool,
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
  // engine (WebVM)
  vmListTool,
  vmCreateTool,
  vmBootTool,
  vmImportTool,
  vmWriteFileTool,
  vmDeleteTool,
  // engine (Notebook)
  jsListTool,
  jsCreateTool,
  jsNotebookTool,
  jsRunTool,
  jsWriteFileTool,
  jsReadFileTool,
  jsDeleteTool,
  // engine (App)
  appListTool,
  appCreateTool,
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
  // subagent (orchestration over sessions)
  spawnSubagentTool,
  subagentTasksTool,
  subagentCancelTool,
  // high-level browser tools — the runner layer over the DOM engine. After the
  // exposure cutover these are the ONLY browser tools the MAIN agent sees.
  doTool,
  getTool,
  checkTool,
  // memory (V1.5 — file-based AGENTS.md)
  readMemoryTool,
  rememberTool,
  // review (clean-context read-only reviewer — feature 08)
  requestReviewTool,
  // goal mode (the Goal toggle — loop/goal-runner.js). Registered always but
  // exposure.js reveals it to the model ONLY while a goal run is active.
  completeGoalTool,
  // dweb (network publish/discover/install — preview only; exposure.js hides
  // these from the agent on the store build, where DWEB_ENABLED is false)
  dwebDiscoverTool,
  dwebShareTool,
  dwebInstallTool,
  dwebPeersTool,
  dwebBlockTool,
  dwebDiscoveryTool,
  dwebGuideTool,
]);
