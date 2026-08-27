// @ts-check

// A page-code job and its owning actor Worker share the offscreen document but
// not a heap. This host-only rendezvous lets the child job reuse the actor's
// one controller executor. The opaque token is never posted into either
// untrusted program realm and is retired with the outer page_code execution.

/** @type {Map<string, {worker:Worker,parentExecutionId:string,next:number,pending:Map<string,(value:any)=>void>}>} */
const owners = new Map();

/** @param {Worker} worker @param {string} parentExecutionId */
export const registerPageProgramSemanticOwner = (worker, parentExecutionId) => {
  if (!worker || typeof worker.postMessage !== 'function'
      || typeof parentExecutionId !== 'string' || !parentExecutionId) {
    throw new TypeError('page program semantic owner is invalid');
  }
  const token = crypto.randomUUID();
  owners.set(token, { worker, parentExecutionId, next: 0, pending: new Map() });
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
  const rid = `page-semantic-${++owner.next}`;
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

const RESPONSE_TYPES = new Set([
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
