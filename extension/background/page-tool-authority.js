// @ts-check

import { openTabTool } from './page-authority/open-tab.js';
import { readPageTool } from './page-authority/read-page.js';
import { snapshotTool } from './page-authority/snapshot.js';
import { readStateTool } from './page-authority/read-state.js';
import { watchChangesTool } from './page-authority/watch-changes.js';
import { queryDomTool } from './page-authority/query-dom.js';
import { navigateTool } from './page-authority/navigate.js';
import { typeTool } from './page-authority/type.js';
import { clickTool } from './page-authority/click.js';
import { loginTool } from './page-authority/login.js';
import { captureTool } from './page-authority/capture.js';
import { viewTool } from './page-authority/view.js';
import {
  browserDocumentIdentity,
  classifyUgcUrl,
  describeToolActivity,
  displayOrigin,
  inspectTabToolCall,
  normalizeBrowserChildPolicyNotices,
  resolveTargetTab,
  withAsyncBrowserChildPolicyNotices,
  withBrowserChildPolicyNotices,
} from '/peerd-runtime/browser-authority.js';
import { controllerOperationAllowedInPermissionMode } from '/shared/controller-kernel-quota.js';

const PAGE_PROGRAM_CAPS = Object.freeze({
  page: true, egress: false, subagent: false, opfs: false,
});

const mismatch = () => Object.assign(new Error('page authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

const PAGE_ACTIONS = Object.freeze({
  'turn.page.click': { label: 'Clicking', summary: 'Click the selected control' },
  'turn.page.fill': { label: 'Typing', summary: 'Enter text in the selected field' },
});

// why: activity is user-visible coordination for every page operation, while
// PAGE_ACTIONS is the much narrower mutation/confirmation boundary. Combining
// the two would accidentally make reads and Plan-safe navigation Act-only.
const PAGE_ACTIVITY_TOOLS = Object.freeze({
  'turn.page.open-tab': 'open_tab',
  'turn.page.read': 'read_page',
  'turn.page.snapshot': 'snapshot',
  'turn.page.read-state': 'read_state',
  'turn.page.watch-changes': 'watch_changes',
  'turn.page.query-dom': 'query_dom',
  'turn.page.navigate': 'navigate',
  'turn.page.fill': 'type',
  'turn.page.click': 'click',
  'turn.page.login': 'login',
  'turn.page.capture-foreground': 'screenshot',
  'turn.page.capture-owned': 'view',
  'turn.page.run-program': 'page_code',
});

// why: browser-session traffic bypasses safeFetch, so the semantic default
// hook cannot be the only exfiltration floor. Exact page operations repeat the
// pure inspection over their final bound args at the host dispatch edge.
const PAGE_EGRESS_TOOL_NAMES = Object.freeze({
  'turn.page.open-tab': 'open_tab',
  'turn.page.navigate': 'navigate',
  'turn.page.fill': 'type',
  'turn.page.click': 'click',
  'turn.page.login': 'login',
});

const CHILD_CAPABLE_OPERATIONS = Object.freeze(new Set([
  'turn.page.click', 'turn.page.fill', 'turn.page.run-program',
]));

const approved = (/** @type {unknown} */ answer) => answer === true
  || answer === 'yes_once' || answer === 'yes_session';

const sameDocument = (/** @type {any} */ left, /** @type {any} */ right) =>
  left?.origin === right?.origin && left?.href === right?.href
  && left?.documentId === right?.documentId && left?.timeOrigin === right?.timeOrigin;

/** @param {{binding:any,ctx:any,signal?:AbortSignal,pageProgramSemanticToken?:string}} input */
export const createPageToolAuthority = ({
  binding, ctx, signal, pageProgramSemanticToken,
}) => {
  const rawArgs = binding.args ?? {};
  const boundWebActor = ctx?.actorType === 'web' && ctx?.backing === 'tab';
  if (ctx?.actorType === 'web' && ctx?.backing !== 'tab') throw mismatch();
  const ownedTabId = Number.isInteger(ctx?.activeTab?.id) ? ctx.activeTab.id : null;
  if (boundWebActor && ownedTabId === null
      && (!['turn.page.navigate', 'turn.page.run-program'].includes(binding.operation)
        || rawArgs.tabId !== undefined)) throw mismatch();
  if (boundWebActor && ownedTabId !== null
      && rawArgs.tabId !== undefined && rawArgs.tabId !== ownedTabId) throw mismatch();
  const args = Object.freeze(boundWebActor && ownedTabId !== null
    ? { ...rawArgs, tabId: ownedTabId } : rawArgs);
  const abortSignal = signal ?? ctx?.abortSignal;
  const stopped = () => abortSignal?.aborted === true;
  const stoppedResult = () => ({
    ok: false, code: 'page_action_aborted', error: 'page action was stopped',
    outcomeKind: 'pre-effect-failure', retryable: false,
  });
  const pageMutationPermissionRefusal = async (
    /** @type {string} */ operation = binding.operation,
  ) => {
    if (stopped()) return stoppedResult();
    const permission = typeof ctx?.readAuthorityPermission === 'function'
      ? await ctx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
      : ctx?.permission;
    if (stopped()) return stoppedResult();
    return controllerOperationAllowedInPermissionMode(operation, permission?.mode, args)
      ? null : {
      ok: false, code: 'plan_mode_refused',
      error: 'permission changed before browser action',
      outcomeKind: 'pre-effect-failure', retryable: false,
    };
  };
  const preflightAction = async (/** @type {string} */ operation) => {
    const action = PAGE_ACTIONS[/** @type {keyof typeof PAGE_ACTIONS} */ (operation)];
    if (!action) return { tab: null, document: null };
    const tab = await resolveTargetTab(args, ctx);
    if (stopped()) return { refuse: stoppedResult() };
    if (!tab?.id || boundWebActor && tab.id !== ownedTabId) return {
      refuse: {
        ok: false, code: 'page_target_unavailable', error: 'page target is unavailable',
        outcomeKind: 'pre-effect-failure', retryable: false,
      },
    };
    const document = browserDocumentIdentity(tab);
    const permission = typeof ctx?.readAuthorityPermission === 'function'
      ? await ctx.readAuthorityPermission().catch(() => ({ mode: 'plan', confirmActions: true }))
      : ctx?.permission;
    if (permission?.mode !== 'act') return {
      refuse: {
        ok: false, code: 'plan_mode_refused',
        error: 'permission changed before browser action',
        outcomeKind: 'pre-effect-failure', retryable: false,
      },
    };
    const ugc = classifyUgcUrl(document.href);
    const needsConfirmation = permission?.confirmActions !== false || ugc.zone === 'ugc';
    if (needsConfirmation) {
      if (typeof ctx?.confirm !== 'function') return {
        ugcRuleId: ugc.zone === 'ugc' ? ugc.ruleId : undefined,
        refuse: {
          ok: false, code: 'confirmation_unavailable', error: 'confirmation unavailable',
          outcomeKind: 'pre-effect-failure', retryable: false,
        },
      };
      const answer = await ctx.confirm({
        tool: 'browser_action', sideEffect: 'mutate_external',
        origins: [document.origin], sessionId: ctx?.session?.sessionId ?? null,
        summary: `${action.summary} on ${document.origin}.`,
        ...(ugc.zone === 'ugc' ? { ugcZone: ugc.ruleId } : {}),
        ...(ugc.zone === 'ugc' ? {
          note: 'This page can contain text written by other people. Confirm that this action reflects your intent.',
        } : {}),
      }, abortSignal).catch(() => false);
      if (!approved(answer)) return {
        ugcRuleId: ugc.zone === 'ugc' ? ugc.ruleId : undefined,
        refuse: {
          ok: false, code: 'declined', error: 'declined',
          outcomeKind: 'pre-effect-failure', retryable: false,
        },
      };
      if (stopped()) return {
        ugcRuleId: ugc.zone === 'ugc' ? ugc.ruleId : undefined,
        refuse: {
          ok: false, code: 'page_action_aborted', error: 'page action was stopped',
          outcomeKind: 'pre-effect-failure', retryable: false,
        },
      };
      const currentPermission = typeof ctx?.readAuthorityPermission === 'function'
        ? await ctx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
        : ctx?.permission;
      if (currentPermission?.mode !== 'act') return {
        ugcRuleId: ugc.zone === 'ugc' ? ugc.ruleId : undefined,
        refuse: {
          ok: false, code: 'plan_mode_refused',
          error: 'permission changed before browser action',
          outcomeKind: 'pre-effect-failure', retryable: false,
        },
      };
      const current = await resolveTargetTab(args, ctx);
      if (!current || !sameDocument(document, browserDocumentIdentity(current))) return {
        ugcRuleId: ugc.zone === 'ugc' ? ugc.ruleId : undefined,
        refuse: {
          ok: false, code: 'page_target_changed',
          error: 'page target changed while confirmation was open',
          outcomeKind: 'pre-effect-failure', retryable: false,
        },
      };
    }
    const permissionRefusal = await pageMutationPermissionRefusal(operation);
    if (permissionRefusal) return {
      ugcRuleId: ugc.zone === 'ugc' ? ugc.ruleId : undefined,
      refuse: permissionRefusal,
    };
    return {
      tab,
      document,
      ugcRuleId: ugc.zone === 'ugc' ? ugc.ruleId : undefined,
    };
  };
  const run = async (/** @type {string} */ operation, /** @type {{execute:Function}} */ handler) => {
    if (binding.operation !== operation || typeof handler?.execute !== 'function') throw mismatch();
    // why: credential ceremonies are forbidden for inbound turns before even
    // a browser target probe. The lower login handler repeats the rule, but
    // this outer authority edge ensures the defense is operational rather
    // than occurring after page reads and activity bookkeeping.
    if (operation === 'turn.page.login' && ctx?.inbound === true) return {
      ok: false, error: 'login_refused_inbound', performed: false,
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: true,
    };
    const preflight = await preflightAction(operation);
    if (preflight.refuse) return typeof preflight.ugcRuleId === 'string'
      ? {
          ...preflight.refuse,
          authorityPolicy: Object.freeze({ ugcZone: preflight.ugcRuleId }),
        }
      : preflight.refuse;
    if (stopped()) return stoppedResult();
    if (operation === 'turn.page.click' || operation === 'turn.page.fill') {
      const tab = preflight.tab ?? await resolveTargetTab(args, ctx);
      if (!tab?.id || boundWebActor && tab.id !== ownedTabId) throw mismatch();
      const arm = ctx?.armBrowserChildQuarantine;
      if (typeof arm !== 'function') {
        if (ctx?.browserChildQuarantineRequired === true) return {
          ok: false, code: 'browser-child-quarantine-unavailable',
          error: 'browser_child_quarantine_unavailable',
          outcomeKind: 'pre-effect-failure', retryable: true,
        };
      } else {
        const armed = await arm(tab.id);
        if (stopped()) return stoppedResult();
        if (armed?.ok !== true) return {
          ok: false, code: armed?.code ?? 'browser-child-quarantine-unavailable',
          error: armed?.error ?? 'browser_child_quarantine_unavailable',
          outcomeKind: 'pre-effect-failure', retryable: true,
        };
      }
    }
    const permissionRefusal = await pageMutationPermissionRefusal(operation);
    if (permissionRefusal) return permissionRefusal;
    let activityTab = preflight.tab;
    if (!activityTab && operation !== 'turn.page.open-tab') {
      activityTab = await resolveTargetTab(args, ctx).catch(() => null);
      if (stopped()) return stoppedResult();
    }
    const tabId = activityTab?.id
      ?? (Number.isInteger(args.tabId) ? args.tabId : ctx?.activeTab?.id);
    const activity = ctx?.onToolActivity;
    const activityTool = PAGE_ACTIVITY_TOOLS[
      /** @type {keyof typeof PAGE_ACTIVITY_TOOLS} */ (operation)
    ];
    if (typeof tabId === 'number' && activity?.begin) {
      const phrase = describeToolActivity(activityTool, args, { isTabTool: true });
      if (phrase) void Promise.resolve(activity.begin(
        tabId, phrase,
        displayOrigin(preflight.document?.origin ?? activityTab?.origin ?? ctx?.activeTab?.origin),
        { denylist: ctx?.denylist },
      )).catch(() => {});
    }
    const consumeChildNotices = typeof ctx?.consumeBrowserChildPolicyNotice === 'function'
      ? ctx.consumeBrowserChildPolicyNotice : null;
    const childCapable = CHILD_CAPABLE_OPERATIONS.has(operation)
      && typeof tabId === 'number' && consumeChildNotices !== null;
    const priorNotices = childCapable
      ? normalizeBrowserChildPolicyNotices(consumeChildNotices(tabId)) : [];
    try {
      if (stopped()) return stoppedResult();
      const egressTool = PAGE_EGRESS_TOOL_NAMES[
        /** @type {keyof typeof PAGE_EGRESS_TOOL_NAMES} */ (operation)
      ];
      if (egressTool) {
        const egress = inspectTabToolCall({
          name: egressTool,
          args,
          currentOrigin: preflight.document?.origin
            ?? activityTab?.origin ?? activityTab?.url ?? ctx?.activeTab?.origin
            ?? ctx?.activeTab?.url ?? null,
        });
        if (egress.action === 'block') return {
          ok: false,
          code: 'browser_egress_tripwire_refused',
          error: 'browser action refused by the host egress tripwire',
          outcomeKind: 'pre-effect-failure',
          retryable: false,
        };
      }
      let result = await handler.execute(args, {
        ...ctx, abortSignal,
        assertPageMutationPermission: () => pageMutationPermissionRefusal(operation),
        // why: bind only this exact page operation. A page program may
        // legitimately navigate and then invoke another nested operation on
        // the newly committed document; retaining the outer document on the
        // shared semantic call would make that canonical sequence fail.
        ...(preflight.document
          ? { authorityDocumentIdentity: preflight.document }
          : {}),
      });
      if (childCapable && consumeChildNotices) {
        const embedded = normalizeBrowserChildPolicyNotices(result?.browserChildPolicyNotices);
        let notices = normalizeBrowserChildPolicyNotices(consumeChildNotices(tabId));
        if (notices.length === 0 && embedded.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (typeof ctx?.waitForBrowserChildPolicyNotice === 'function') {
            await ctx.waitForBrowserChildPolicyNotice(tabId, 175);
          }
          notices = normalizeBrowserChildPolicyNotices(consumeChildNotices(tabId));
          if (notices.length === 0 && ctx?.hasPendingBrowserChildPolicy?.(tabId)) {
            await ctx.waitForBrowserChildPolicyNotice?.(tabId, 5_000, true);
            notices = normalizeBrowserChildPolicyNotices(consumeChildNotices(tabId));
          }
        }
        const { browserChildPolicyNotices: _hostOnly, ...visibleResult } = result ?? {};
        result = withBrowserChildPolicyNotices(visibleResult, [...embedded, ...notices]);
      }
      result = withAsyncBrowserChildPolicyNotices(result, priorNotices);
      if (typeof preflight.ugcRuleId !== 'string') return result;
      return {
        ...result,
        authorityPolicy: Object.freeze({ ugcZone: preflight.ugcRuleId }),
      };
    } finally {
      if (typeof tabId === 'number' && activity?.end) {
        void Promise.resolve(activity.end(tabId)).catch(() => {});
      }
    }
  };
  return Object.freeze({
    openProtectedBackgroundTab: () => run('turn.page.open-tab', openTabTool),
    readOwnedPage: () => run('turn.page.read', readPageTool),
    captureOwnedAccessibilityTree: () => run('turn.page.snapshot', snapshotTool),
    readOwnedFrameworkState: () => run('turn.page.read-state', readStateTool),
    drainOwnedDomChanges: () => run('turn.page.watch-changes', watchChangesTool),
    queryOwnedDom: () => run('turn.page.query-dom', queryDomTool),
    navigateOwnedTab: () => run('turn.page.navigate', navigateTool),
    fillOwnedTarget: () => run('turn.page.fill', typeTool),
    clickOwnedTarget: () => run('turn.page.click', clickTool),
    performConfirmedOwnedLogin: () => run('turn.page.login', loginTool),
    captureForegroundPixels: () => run('turn.page.capture-foreground', captureTool),
    captureOwnedTabPixels: () => run('turn.page.capture-owned', viewTool),
    runOwnedPageProgram: () => run('turn.page.run-program', { execute: async () => {
      if (binding.operation !== 'turn.page.run-program') throw mismatch();
      if (typeof args.code !== 'string' || args.code.length === 0) {
        return { ok: false, error: 'code_required' };
      }
      const client = ctx?.jsOffscreenClient;
      const ownerSessionId = ctx?.session?.sessionId;
      const runs = ctx?.scriptRuns;
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
          ...(pageProgramSemanticToken ? { pageProgramSemanticToken } : {}),
          signal: abortSignal,
        });
      } finally {
        runs.release(runId);
        if (onAbort && abortSignal) abortSignal.removeEventListener?.('abort', onAbort);
      }
    } }),
  });
};

export const bindPageToolAuthority = (/** @type {any} */ _state, /** @type {any} */ input) => {
  const envelope = structuredClone(input.args ?? {});
  const actorRelayed = Object.hasOwn(envelope, 'args');
  return createPageToolAuthority({
    ...input,
    pageProgramSemanticToken: input.pageProgramSemanticToken
      ?? (actorRelayed ? envelope.pageProgramSemanticToken : undefined),
    binding: Object.freeze({
      operation: input.operation,
      args: actorRelayed ? Object.freeze(envelope.args ?? {}) : Object.freeze(envelope),
    }),
  });
};
