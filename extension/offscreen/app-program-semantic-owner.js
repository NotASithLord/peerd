// @ts-check

// An app-code job and its owning actor Worker live in separate sealed heaps.
// This host-only rendezvous lets app.observe/app.act re-enter the one semantic
// executor that owns schemas, gates, hooks, and exact-operation lineage.

const MAX_OWNER_REQUESTS = 256;
const MAX_OWNER_IN_FLIGHT = 32;

/** @type {Map<string, {worker:Worker,parentExecutionId:string,requestNonce:string,next:number,total:number,pending:Map<string,(value:any)=>void>}>} */
const owners = new Map();

/** @param {Worker} worker @param {string} parentExecutionId */
export const registerAppProgramSemanticOwner = (worker, parentExecutionId) => {
  if (!worker || typeof worker.postMessage !== 'function'
      || typeof parentExecutionId !== 'string' || !parentExecutionId) {
    throw new TypeError('app program semantic owner is invalid');
  }
  const token = crypto.randomUUID();
  owners.set(token, {
    worker, parentExecutionId, requestNonce: crypto.randomUUID(),
    next: 0, total: 0, pending: new Map(),
  });
  return token;
};

/** @param {string} token */
export const releaseAppProgramSemanticOwner = (token) => {
  const owner = owners.get(token);
  if (!owner) return;
  owners.delete(token);
  for (const resolve of owner.pending.values()) resolve({
    ok: false,
    error: 'app program semantic owner closed before settlement',
    outcomeKnown: false,
    retryable: false,
  });
  owner.pending.clear();
};

const request = (
  /** @type {string} */ token,
  /** @type {'observe'|'act'} */ method,
  /** @type {Record<string,unknown>} */ args,
) => new Promise((resolve) => {
  const owner = owners.get(token);
  if (!owner) {
    resolve({
      ok: false, error: 'app program semantic owner is unavailable',
      outcomeKnown: true,
    });
    return;
  }
  if (owner.total >= MAX_OWNER_REQUESTS || owner.pending.size >= MAX_OWNER_IN_FLIGHT) {
    resolve({
      ok: false,
      code: owner.total >= MAX_OWNER_REQUESTS
        ? 'app_program_request_limit' : 'app_program_inflight_limit',
      error: owner.total >= MAX_OWNER_REQUESTS
        ? 'app program request budget exhausted'
        : 'app program has too many in-flight semantic requests',
      outcomeKnown: true, performed: false, retryable: false,
    });
    return;
  }
  owner.total += 1;
  // why: a response delayed past owner retirement cannot settle a successor's
  // same ordinal request. Keep this nonce separate from the host-only token.
  const rid = `app-semantic-${owner.requestNonce}-${++owner.next}`;
  owner.pending.set(rid, resolve);
  try {
    owner.worker.postMessage({
      type: `app-program-${method}-request`, rid, args,
      parentExecutionId: owner.parentExecutionId,
    });
  } catch {
    owner.pending.delete(rid);
    resolve({
      ok: false, error: 'app program semantic relay failed',
      outcomeKnown: false, retryable: false,
    });
  }
});

/** @param {string} token */
export const observeAppProgram = (token) => request(token, 'observe', {});

/** @param {string} token @param {Record<string,unknown>} args */
export const actAppProgram = (token, args) => request(token, 'act', args);

/** @param {string} token @param {unknown} value */
export const settleAppProgramSemanticResponse = (token, value) => {
  const message = value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string,any>} */ (value) : null;
  if (!message || !['app-program-observe-response', 'app-program-act-response']
    .includes(message.type)) return false;
  const owner = owners.get(token);
  const resolve = owner?.pending.get(message.rid);
  if (!owner || !resolve) return true;
  owner.pending.delete(message.rid);
  resolve(message.result);
  return true;
};
