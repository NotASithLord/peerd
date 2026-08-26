// @ts-check

import { openTabTool } from './page-authority/open-tab.js';
import { readPageTool } from './page-authority/read-page.js';
import { snapshotTool } from './page-authority/snapshot.js';
import { readStateTool } from './page-authority/read-state.js';
import { watchChangesTool } from './page-authority/watch-changes.js';
import { queryDomTool } from './page-authority/query-dom.js';
import { pageEvalTool } from './page-authority/page-eval.js';
import { pageExecTool } from './page-authority/page-exec.js';
import { pageKeysTool } from './page-authority/page-keys.js';
import { navigateTool } from './page-authority/navigate.js';
import { typeTool } from './page-authority/type.js';
import { clickTool } from './page-authority/click.js';
import { loginTool } from './page-authority/login.js';
import { captureTool } from './page-authority/capture.js';
import { viewTool } from './page-authority/view.js';

const PAGE_PROGRAM_CAPS = Object.freeze({
  page: true, egress: false, subagent: false, opfs: false,
});

const mismatch = () => Object.assign(new Error('page authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {{call:any,ctx:any,signal?:AbortSignal}} input */
export const createPageToolAuthority = ({ call, ctx, signal }) => {
  const run = (/** @type {string} */ name, /** @type {{execute:Function}} */ handler) => {
    if (call?.name !== name || typeof handler?.execute !== 'function') throw mismatch();
    return handler.execute(call.args ?? {}, { ...ctx, abortSignal: signal ?? ctx?.abortSignal });
  };
  return Object.freeze({
    openProtectedBackgroundTab: () => run('open_tab', openTabTool),
    readOwnedPage: () => run('read_page', readPageTool),
    captureOwnedAccessibilityTree: () => run('snapshot', snapshotTool),
    readOwnedFrameworkState: () => run('read_state', readStateTool),
    drainOwnedDomChanges: () => run('watch_changes', watchChangesTool),
    queryOwnedDom: () => run('query_dom', queryDomTool),
    evaluateOwnedPageMainWorld: () => run('page_eval', pageEvalTool),
    evaluateOwnedPageDebugger: () => run('page_exec', pageExecTool),
    readTrustedKeysAvailability: () => run('page_keys', pageKeysTool),
    navigateOwnedTab: () => run('navigate', navigateTool),
    fillOwnedTarget: () => run('type', typeTool),
    clickOwnedTarget: () => run('click', clickTool),
    performConfirmedOwnedLogin: () => run('login', loginTool),
    captureForegroundPixels: () => run('capture', captureTool),
    captureOwnedTabPixels: () => run('view', viewTool),
    runOwnedPageProgram: async () => {
      if (call?.name !== 'page_code') throw mismatch();
      const args = call.args ?? {};
      if (typeof args.code !== 'string' || args.code.length === 0) {
        return { ok: false, error: 'code_required' };
      }
      const client = ctx?.jsOffscreenClient;
      const ownerSessionId = ctx?.session?.sessionId;
      const runs = ctx?.scriptRuns;
      const abortSignal = signal ?? ctx?.abortSignal;
      if (!client || typeof client.execHeadless !== 'function') {
        return { ok: false, error: 'page_code_unavailable' };
      }
      if (typeof ownerSessionId !== 'string' || !ownerSessionId) {
        return { ok: false, error: 'page_code_requires_actor_session' };
      }
      if (!runs) return { ok: false, error: 'page_code_run_registry_unavailable' };
      if (abortSignal?.aborted) {
        return { ok: false, error: 'page_code_aborted: the turn was stopped before the run started' };
      }
      const timeoutMs = Math.min(180_000, Math.max(1_000, Number(args.timeoutMs) || 60_000));
      const runId = runs.mintRunId(ownerSessionId);
      runs.register(runId, abortSignal, ownerSessionId, { page: true });
      /** @type {(()=>void)|undefined} */
      let onAbort;
      if (abortSignal && client.abortHeadless) {
        onAbort = () => { void client.abortHeadless(runId, ownerSessionId); };
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        return await client.execHeadless(args.code, {
          timeoutMs, caps: PAGE_PROGRAM_CAPS, ownerSessionId, runId,
          signal: abortSignal,
        });
      } finally {
        runs.release(runId);
        if (onAbort && abortSignal) abortSignal.removeEventListener?.('abort', onAbort);
      }
    },
  });
};
