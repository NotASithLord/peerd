// @ts-check

// A page-code job and its owning actor Worker share the offscreen document but
// not a heap. This host-only rendezvous lets the child job reuse the actor's
// one controller executor. The opaque token is never posted into either
// untrusted program realm and is retired with the outer page_code execution.

const MAX_OWNER_REQUESTS = 256;
const MAX_OWNER_IN_FLIGHT = 32;

/** @type {Map<string, {worker:Worker,parentExecutionId:string,requestNonce:string,next:number,total:number,pending:Map<string,(value:any)=>void>}>} */
const owners = new Map();

/** @param {Worker} worker @param {string} parentExecutionId */
export const registerPageProgramSemanticOwner = (worker, parentExecutionId) => {
  if (!worker || typeof worker.postMessage !== 'function'
      || typeof parentExecutionId !== 'string' || !parentExecutionId) {
    throw new TypeError('page program semantic owner is invalid');
  }
  const token = crypto.randomUUID();
  owners.set(token, {
    worker, parentExecutionId, requestNonce: crypto.randomUUID(),
    next: 0, total: 0, pending: new Map(),
  });
  return token;
};

/** @param {string} token */
export const releasePageProgramSemanticOwner = (token) => {
  const owner = owners.get(token);
  if (!owner) return;
  owners.delete(token);
  for (const resolve of owner.pending.values()) resolve({
    ok: false,
    error: 'page program semantic owner closed before settlement',
    outcomeKnown: false,
    retryable: false,
  });
  owner.pending.clear();
};

const request = (
  /** @type {string} */ token,
  /** @type {string} */ type,
  /** @type {Record<string,unknown>} */ args,
) => new Promise((resolve) => {
  const owner = owners.get(token);
  if (!owner) {
    resolve({
      ok: false, error: 'page program semantic owner is unavailable',
      outcomeKnown: true,
    });
    return;
  }
  if (owner.total >= MAX_OWNER_REQUESTS || owner.pending.size >= MAX_OWNER_IN_FLIGHT) {
    resolve({
      ok: false,
      code: owner.total >= MAX_OWNER_REQUESTS
        ? 'page_program_request_limit' : 'page_program_inflight_limit',
      error: owner.total >= MAX_OWNER_REQUESTS
        ? 'page program request budget exhausted'
        : 'page program has too many in-flight semantic requests',
      outcomeKnown: true, performed: false, retryable: false,
    });
    return;
  }
  owner.total += 1;
  // why: a late response from a retired outer job must not settle the same
  // ordinal request in its successor. This nonce is distinct from the private
  // owner token, so the Worker learns no host rendezvous capability.
  const rid = `page-semantic-${owner.requestNonce}-${++owner.next}`;
  owner.pending.set(rid, resolve);
  try {
    owner.worker.postMessage({
      type, rid, args, parentExecutionId: owner.parentExecutionId,
    });
  } catch (cause) {
    owner.pending.delete(rid);
    resolve({
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      outcomeKnown: false,
      retryable: false,
    });
  }
});

/** @param {string} token @param {Record<string,unknown>} args */
export const fetchPageProgramResource = (token, args) =>
  request(token, 'page-program-fetch-request', args);

/** @param {string} token @param {Record<string,unknown>} args */
export const readPageProgramDocument = (token, args) =>
  request(token, 'page-program-read-document-request', args);

/** @param {string} token @param {Record<string,unknown>} args */
export const readPageProgramResult = (token, args) =>
  request(token, 'page-program-read-result-request', args);

/** @param {string} token @param {Record<string,unknown>} args */
export const readPageProgramSiteClient = (token, args) =>
  request(token, 'page-program-site-client-read-request', args);

/** @param {string} token @param {Record<string,unknown>} args */
export const writePageProgramSiteClient = (token, args) =>
  request(token, 'page-program-site-client-write-request', args);

/** @param {string} token @param {Record<string,unknown>} args */
export const capturePageProgramSite = (token, args) =>
  request(token, 'page-program-site-capture-request', args);

/** @param {string} token @param {Record<string,unknown>} args */
export const navigatePageProgram = (token, args) =>
  request(token, 'page-program-navigate-request', args);
/** @param {string} token @param {Record<string,unknown>} args */
export const clickPageProgram = (token, args) =>
  request(token, 'page-program-click-request', args);
/** @param {string} token @param {Record<string,unknown>} args */
export const fillPageProgram = (token, args) =>
  request(token, 'page-program-fill-request', args);
/** @param {string} token @param {Record<string,unknown>} args */
export const snapshotPageProgram = (token, args) =>
  request(token, 'page-program-snapshot-request', args);
/** @param {string} token @param {Record<string,unknown>} args */
export const readPageProgram = (token, args) =>
  request(token, 'page-program-read-request', args);
/** @param {string} token @param {Record<string,unknown>} args */
export const readStatePageProgram = (token, args) =>
  request(token, 'page-program-read-state-request', args);
/** @param {string} token @param {Record<string,unknown>} args */
export const watchChangesPageProgram = (token, args) =>
  request(token, 'page-program-watch-changes-request', args);
/** @param {string} token @param {Record<string,unknown>} args */
export const queryPageProgram = (token, args) =>
  request(token, 'page-program-query-request', args);
/** @param {string} token @param {Record<string,unknown>} args */
export const viewPageProgram = (token, args) =>
  request(token, 'page-program-view-request', args);
/** @param {string} token @param {Record<string,unknown>} args */
export const loginPageProgram = (token, args) =>
  request(token, 'page-program-login-request', args);

const RESPONSE_TYPES = new Set([
  'page-program-navigate-response',
  'page-program-click-response',
  'page-program-fill-response',
  'page-program-snapshot-response',
  'page-program-read-response',
  'page-program-read-state-response',
  'page-program-watch-changes-response',
  'page-program-query-response',
  'page-program-view-response',
  'page-program-login-response',
  'page-program-fetch-response',
  'page-program-read-document-response',
  'page-program-read-result-response',
  'page-program-site-client-read-response',
  'page-program-site-client-write-response',
  'page-program-site-capture-response',
]);

/** @param {string} token @param {unknown} value */
export const settlePageProgramSemanticResponse = (token, value) => {
  const message = value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string,any>} */ (value) : null;
  if (!message || !RESPONSE_TYPES.has(message.type)) return false;
  const owner = owners.get(token);
  const resolve = owner?.pending.get(message.rid);
  if (!owner || !resolve) return true;
  owner.pending.delete(message.rid);
  resolve(message.result);
  return true;
};
