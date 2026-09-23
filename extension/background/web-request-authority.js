// @ts-check

// Host-only closure binding, deliberately not a ToolContext callback or a
// request option. Actor capability projection preserves only the wrapped fetch.
/** @typedef {{
 * webFetch:(resource:any,init?:any)=>Promise<Response>,
 * captureRequestAuthority:()=>()=>boolean,
 * readPermission:()=>Promise<{mode:string}>,
 * reauthorize?:()=>Promise<boolean|void>,
 * }} RequestAuthorityDeps */
/** @param {{
 * withWebRequestAuthority:typeof import('../peerd-egress/fetch/web-fetch.js').withWebRequestAuthority,
 * needsWebWriteConfirm:(method:string)=>boolean,
 * }} boundary */
export const makeWebRequestAuthorityBinder = ({ withWebRequestAuthority, needsWebWriteConfirm }) =>
  (/** @type {RequestAuthorityDeps} */ { webFetch, captureRequestAuthority, readPermission, reauthorize }) =>
  (/** @type {any} */ resource, /** @type {any} */ init = {}) => {
    const current = captureRequestAuthority();
    const refuse = (/** @type {string} */ reason) => {
      throw Object.assign(new Error(reason), {
        performed: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
      });
    };
    const method = init.method ?? (resource instanceof Request ? resource.method : 'GET');
    return withWebRequestAuthority(webFetch, async () => {
      if (needsWebWriteConfirm(method) && (await readPermission()).mode !== 'act') refuse('plan_mode');
      // why: resolve the actual tab last; the synchronous epoch fence below
      // also catches permission changes during this final asynchronous proof.
      if (reauthorize && await reauthorize() === false) refuse('origin_authority_changed');
    }, () => { if (!current()) refuse('request_authority_changed'); })(resource, init);
  };
