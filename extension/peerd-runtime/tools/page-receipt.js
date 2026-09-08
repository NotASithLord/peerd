// @ts-check

import { wrapUntrusted } from './prompt-wrap.js';
import { AUTH_WAITING_FOR_USER_CODE, AUTH_WAITING_FOR_USER_MESSAGE } from '../actor/auth-wait.js';
import {
  FORM_SUBMISSION_CODES,
  CROSS_ORIGIN_FORM_SUBMISSION_MESSAGE,
  formatBrowserTargetRefusal,
} from './browser-automation-policy.js';
import {
  normalizeBrowserChildPolicyNotices,
  withAsyncBrowserChildPolicyNotices,
  withBrowserChildPolicyNotices,
} from '../browser-authority/child-policy-result.js';

/** @param {any} structured */
const cleanupGuidance = (structured) => {
  const cleanup = structured?.cleanup;
  if (typeof cleanup !== 'string') return '';
  const subject = cleanup.startsWith('new_tab') ? 'The new tab' : 'The tab';
  if (cleanup.endsWith('_closed')) return `${subject} was closed.`;
  if (cleanup.endsWith('_close_failed')) {
    return `${subject} could not be closed, so browser automation remains stopped for it.`;
  }
  if (cleanup.endsWith('_reset_failed')) {
    return `${subject} could not be reset, so browser automation remains stopped for it.`;
  }
  if (cleanup.endsWith('_reset_blank')) return `${subject} was reset to a blank page.`;
  return cleanup.endsWith('_reset_verified_blank')
    ? `${subject} was reset to a verified blank page.` : '';
};

/** @param {any} receipt */
const loginFailureContent = (receipt) => {
  const error = typeof receipt?.error === 'string' ? receipt.error : '';
  const reason = receipt?.structured?.reason;
  if (error === 'stale_ref' || error.startsWith('stale_ref:')) {
    return 'The sign-in target is stale. Take a fresh page snapshot, then retry login with its new ref.';
  }
  if (error === 'login_target_not_found') {
    return 'Provide a fresh snapshot ref with a walk id, or a CSS selector for the sign-in element.';
  }
  if (error === 'no_target_tab' || error === 'login_target_gone') {
    return 'The sign-in tab is no longer available. Open or select it, take a fresh snapshot, and retry login.';
  }
  if (error === 'login_declined' && reason === 'confirmation_unavailable') {
    return 'No confirmation channel is available for a sign-in.';
  }
  if (error === 'login_declined' && reason === 'declined') {
    return 'The user declined the sign-in.';
  }
  if (error === 'plan_mode_refused' || error === 'login_permission_refused'
      || error === 'permission changed before browser action') {
    return 'Permission changed before the sign-in action could start.';
  }
  if (error === 'login_origin_changed') {
    return 'The page moved during confirmation. Take a fresh snapshot, then retry login.';
  }
  if (error === 'login_origin_authority_refused') {
    return 'The relying-site boundary could not be verified after confirmation. Retry login from a fresh page snapshot.';
  }
  if (error === 'login_excursion_authority_refused') {
    return 'The verified provider step could not be authorized. Finish signing in yourself in the open tab, or retry login from a fresh page snapshot.';
  }
  if (error === 'login_affordance_changed' || error.startsWith('login_affordance_changed:')) {
    return 'The sign-in element changed after approval. Take a fresh snapshot, then retry login.';
  }
  if (error === 'login_excursion_cleanup_unverified') {
    return 'peerd could not verify that the provider excursion was revoked. Browser automation remains stopped; do not retry until the tab returns to the relying site or a new sign-in attempt begins.';
  }
  return null;
};

/** @param {any} receipt */
const failureContent = (receipt) => {
  const structured = receipt?.structured;
  if (structured?.allowed === false && typeof structured.message === 'string'
      && typeof structured.correction === 'string') {
    const policy = formatBrowserTargetRefusal(
      structured,
      receipt.outcomeKind === 'effect-completed' || receipt.outcomeKind === 'host-lost',
    );
    const cleanup = cleanupGuidance(structured);
    return cleanup ? `${policy} ${cleanup}` : policy;
  }
  if (receipt?.error === AUTH_WAITING_FOR_USER_CODE) return AUTH_WAITING_FOR_USER_MESSAGE;
  if (receipt?.error === FORM_SUBMISSION_CODES.CROSS_ORIGIN) {
    return CROSS_ORIGIN_FORM_SUBMISSION_MESSAGE;
  }
  if (receipt?.error === 'view_screenshot_too_large') {
    return 'The captured image exceeds the safe transport size. Zoom out or use read_page, snapshot, or query_dom.';
  }
  if (receipt?.error === 'capture_screenshot_too_large') {
    return 'The screenshot exceeds the safe transport size. Reduce the window size or use read_page, snapshot, or view.';
  }
  if (structured?.phase === 'final_url_unavailable') {
    if (structured.target === 'new_tab') {
      return structured.neutralized
        ? 'peerd could not verify the opened page. The new tab was reset to a verified blank page.'
        : 'peerd could not verify the opened page or reset the new tab. Browser automation remains stopped for it.';
    }
    return structured.neutralized
      ? 'peerd could not verify the final page. The tab was reset to a verified blank page.'
      : 'peerd could not verify the final page or reset the tab. Browser automation remains stopped for it.';
  }
  if (structured && (receipt?.error === 'navigation_timeout'
      || String(receipt?.error ?? '').startsWith('navigation_failed:'))) {
    return fencePageReceipt({
      origin: structured.finalUrl ?? structured.requested,
      tool: 'navigate',
      body: JSON.stringify(structured),
    });
  }
  if (receipt?.error === 'login_unsupported'
      && typeof structured?.reason === 'string') return structured.reason;
  return loginFailureContent(receipt);
};

/**
 * Exact page effects return host receipts, never model-facing ToolResult
 * presentation. Preserve lifecycle/policy fields while promoting the bounded
 * host detail into the controller-owned content slot.
 *
 * @param {any} receipt
 */
const pageAuthorityFailure = (receipt) => {
  if (!receipt || receipt.ok !== false) return receipt;
  const { receipt: _receipt, ...failure } = receipt;
  const content = failureContent(receipt);
  return {
    ...failure,
    ...(content ? { content } : {}),
  };
};

/**
 * Child-window receipts are authority metadata; their model-facing wording is
 * deliberately added only after the controller tool has shaped its result.
 * @param {any} authorityResult
 * @param {any} semanticResult
 */
const finalizePageResult = (authorityResult, semanticResult) => {
  const current = normalizeBrowserChildPolicyNotices(
    authorityResult?.browserChildPolicyNotices,
  );
  const prior = normalizeBrowserChildPolicyNotices(
    authorityResult?.browserAsyncPolicyNotices,
  );
  return withAsyncBrowserChildPolicyNotices(
    withBrowserChildPolicyNotices(semanticResult, current),
    prior,
  );
};

/** @param {any} receipt */
const requirePageReceipt = (receipt) => {
  if (receipt?.ok === false) return pageAuthorityFailure(receipt);
  if (receipt?.ok !== true || !receipt.receipt || typeof receipt.receipt !== 'object') {
    return { ok: false, error: 'page_authority_receipt_invalid' };
  }
  return receipt.receipt;
};

/** @param {Promise<any>} pending @param {(receipt:any)=>any|Promise<any>} shape */
export const shapePageReceipt = async (pending, shape) => {
  const authority = await pending;
  const receipt = requirePageReceipt(authority);
  return finalizePageResult(
    authority,
    receipt?.ok === false ? receipt : await shape(receipt),
  );
};

/** @param {{origin?:string|null,tool:string,body:string}} input */
export const fencePageReceipt = ({ origin, tool, body }) => wrapUntrusted({
  origin: typeof origin === 'string' && origin ? origin : 'unknown',
  tool,
  body,
});
