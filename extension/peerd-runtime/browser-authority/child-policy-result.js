// @ts-check

/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */

/** @param {unknown} value */
export const normalizeBrowserChildPolicyNotices = (value) => (
  Array.isArray(value) ? value : value ? [value] : []
).filter((entry) => {
  const notice = /** @type {any} */ (entry);
  return notice && typeof notice === 'object'
    && [
      'protected_child_navigation', 'protected_child_request',
      'child_navigation_failed', 'child_navigation_unverified',
      'child_authority_unavailable',
    ].includes(notice.reason)
    && ['not_run', 'unverified'].includes(notice.outcome)
    && ['closed', 'left_blank', 'guarded', 'uncontained'].includes(notice.child)
    && typeof notice.retryable === 'boolean';
}).map((entry) => ({
  reason: entry.reason,
  outcome: entry.outcome,
  child: entry.child,
  retryable: entry.retryable,
}));

/**
 * @param {ToolResult} result
 * @param {Array<{reason:string,outcome:string,child:string,retryable:boolean}>} notices
 * @returns {ToolResult}
 */
export const withBrowserChildPolicyNotices = (result, notices) => {
  if (notices.length === 0) return result;
  const [notice] = notices;
  const policyFields = {
    browserPolicy: notice,
    ...(notices.length > 1 ? { browserPolicies: notices } : {}),
  };
  let content = typeof result.content === 'string' ? result.content : '';
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    content = JSON.stringify({ ...parsed, ...policyFields }, null, 2);
  } catch {
    const receipt = (
      /** @type {{reason:string,outcome:string,child:string,retryable:boolean}} */ entry,
      /** @type {number} */ index,
    ) => {
      const outcome = entry.outcome === 'not_run'
        ? entry.reason === 'protected_child_request'
          ? 'A protected child request did not run.'
          : 'A protected child navigation did not run.'
        : entry.reason === 'child_authority_unavailable'
          ? 'Child browser authority became unavailable.'
          : 'A child navigation was not verified.';
      const child = entry.child === 'closed'
        ? 'The child tab was closed.'
        : entry.child === 'left_blank'
          ? 'The child tab was left blank.'
          : entry.child === 'guarded'
            ? 'The child tab remained guarded.'
            : 'The browser did not confirm that the child tab was closed or blank.';
      const label = notices.length > 1
        ? `[HOST POLICY ${index + 1}/${notices.length}]` : '[HOST POLICY]';
      return `${label}\n${outcome} ${child} `
        + `No destination details or protected page content were exposed. ${entry.retryable ? 'Retry after browser control recovers.' : 'Do not retry automatically.'}\n`
        + `Receipt: ${JSON.stringify(entry)}`;
    };
    content = `${content}${content ? '\n\n' : ''}${notices.map(receipt).join('\n\n')}`;
  }
  return {
    ...result,
    content,
    structured: {
      ...(result.structured && typeof result.structured === 'object'
        ? result.structured : {}),
      ...policyFields,
    },
  };
};

/**
 * @param {ToolResult} result
 * @param {Array<{reason:string,outcome:string,child:string,retryable:boolean}>} notices
 * @returns {ToolResult}
 */
export const withAsyncBrowserChildPolicyNotices = (result, notices) => {
  if (notices.length === 0) return result;
  const asyncFields = {
    browserAsyncPolicyAttribution: 'prior_action', browserAsyncPolicies: notices,
  };
  let content = typeof result.content === 'string' ? result.content : '';
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    content = JSON.stringify({ ...parsed, ...asyncFields }, null, 2);
  } catch {
    content = `${content}${content ? '\n\n' : ''}[ASYNC HOST POLICY — PRIOR ACTION]\n`
      + 'A child-browser outcome from an earlier action arrived after that action settled. '
      + 'It is not an outcome of this tool call. No destination details were exposed.\n'
      + `Receipts: ${JSON.stringify(notices)}`;
  }
  return {
    ...result,
    content,
    structured: {
      ...(result.structured && typeof result.structured === 'object' ? result.structured : {}),
      ...asyncFields,
    },
  };
};
