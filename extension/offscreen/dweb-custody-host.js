// @ts-check

const OPERATIONS = new Set(['export', 'prepare', 'adopt']);
const safeId = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length >= 3 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value);

/** @param {any} port @param {any} message */
const post = (port, message) => {
  try { port.postMessage(message); } catch { /* receipt remains for reconciliation */ }
};

/** @param {unknown} value @param {Set<object>} seen @returns {unknown} */
const canonicalValue = (value, seen) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('operation-args-invalid');
    seen.add(value);
    /** @type {unknown[]} */
    const result = value.map((entry) => canonicalValue(entry, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('operation-args-invalid');
    seen.add(value);
    /** @type {Record<string, unknown>} */
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const entry = /** @type {Record<string, unknown>} */ (value)[key];
      if (entry !== undefined) result[key] = canonicalValue(entry, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError('operation-args-invalid');
};

/** @param {unknown} value */
const canonicalJson = (value) => JSON.stringify(canonicalValue(value, new Set()));

const makeDefaultFingerprint = () => {
  const key = crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return async (/** @type {string} */ operation, /** @type {unknown} */ args) => {
    const encoded = new TextEncoder().encode(`${operation}\u0000${canonicalJson(args)}`);
    try {
      const digest = new Uint8Array(await crypto.subtle.sign('HMAC', await key, encoded));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    } finally {
      encoded.fill(0);
    }
  };
};

/**
 * @typedef {{
 *   operationId:string,
 *   operation:string,
 *   fingerprint:string,
 *   state:'pending'|'succeeded'|'failed',
 *   result?:any,
 *   error?:string,
 *   outcomeKnown?:boolean,
 *   phase?:'inspection'|'suspending'|'commit-dispatched'|'recovering',
 *   controller?:AbortController,
 *   timer?:ReturnType<typeof setTimeout>|null,
 * }} CustodyReceipt
 */

/**
 * @param {Object} deps
 * @param {(operation:'export'|'prepare'|'adopt', args:any, context:{operationId:string,signal:AbortSignal,deadline:number,setPhase:(phase:'inspection'|'suspending'|'commit-dispatched'|'recovering')=>void})=>Promise<any>} deps.runOperation
 * @param {()=>any} deps.readState
 * @param {string} [deps.authorityId]
 * @param {number} [deps.maxReceipts]
 * @param {number} [deps.operationTimeoutMs]
 * @param {(operation:string,args:any)=>Promise<string>} [deps.fingerprintOperation]
 * @param {(operationId:string)=>Promise<any>|any} [deps.recoverOperation]
 */
export const makeDwebCustodyHost = ({
  runOperation,
  readState,
  authorityId = crypto.randomUUID(),
  maxReceipts = 16,
  operationTimeoutMs = 45_000,
  fingerprintOperation = makeDefaultFingerprint(),
  recoverOperation = async () => { throw new Error('custody-recovery-unavailable'); },
}) => {
  if (typeof runOperation !== 'function' || typeof readState !== 'function'
      || typeof fingerprintOperation !== 'function' || typeof recoverOperation !== 'function'
      || !safeId(authorityId)
      || !Number.isInteger(maxReceipts) || maxReceipts < 4
      || !Number.isFinite(operationTimeoutMs) || operationTimeoutMs < 1) {
    throw new TypeError('dweb-custody-host-config-invalid');
  }
  /** @type {Map<string, CustodyReceipt>} */
  const receipts = new Map();

  const makeRoom = () => {
    if (receipts.size < maxReceipts) return true;
    // why: unknown outcomes are the evidence needed for safe reconciliation.
    // Known terminal results can be recomputed or replayed through the CAS.
    for (const [operationId, receipt] of receipts) {
      if (receipt.state === 'pending' || receipt.outcomeKnown === false) continue;
      receipts.delete(operationId);
      if (receipts.size < maxReceipts) return true;
    }
    return false;
  };

  /** @param {CustodyReceipt} receipt */
  const publicReceipt = (receipt) => receipt.state === 'succeeded'
    ? { operationId: receipt.operationId, state: 'succeeded', result: receipt.result }
    : receipt.state === 'failed'
      ? {
          operationId: receipt.operationId,
          state: 'failed',
          error: receipt.error ?? 'host-failed',
          outcomeKnown: receipt.outcomeKnown !== false,
          ...(receipt.phase ? { phase: receipt.phase } : {}),
        }
      : { operationId: receipt.operationId, state: 'pending' };

  /** @param {any} port @param {string} requestId @param {CustodyReceipt} receipt */
  const sendReceipt = (port, requestId, receipt) => {
    post(port, receipt.state === 'succeeded' ? {
      type: 'custody/response', requestId, operationId: receipt.operationId, authorityId,
      ok: true, result: receipt.result,
    } : {
      type: 'custody/response', requestId, operationId: receipt.operationId, authorityId,
      ok: false, error: receipt.error ?? 'host-failed',
      outcomeKnown: receipt.outcomeKnown !== false,
      ...(receipt.phase ? { phase: receipt.phase } : {}),
    });
  };

  /** @param {string} operation @param {string} fingerprint */
  const findReceipt = (operation, fingerprint) => {
    for (const receipt of receipts.values()) {
      if (receipt.operation === operation && receipt.fingerprint === fingerprint) return receipt;
    }
    return null;
  };

  /** @param {any} port @param {any} message */
  const status = async (port, message) => {
    if (!OPERATIONS.has(message.operation)) return;
    let fingerprint;
    try { fingerprint = await fingerprintOperation(message.operation, message.args ?? {}); }
    catch { fingerprint = ''; }
    const receipt = fingerprint ? findReceipt(message.operation, fingerprint) : null;
    post(port, {
      type: 'custody/status-response', requestId: message.requestId,
      operationId: message.operationId, authorityId,
      receipt: receipt ? publicReceipt(receipt) : { state: 'missing' },
      hostState: readState(),
    });
  };

  /** @param {any} port @param {any} message */
  const request = async (port, message) => {
    let fingerprint;
    try { fingerprint = await fingerprintOperation(message.operation, message.args ?? {}); }
    catch { fingerprint = ''; }
    if (!safeId(fingerprint)) {
      post(port, {
        type: 'custody/response', requestId: message.requestId,
        operationId: message.operationId, authorityId,
        ok: false, error: 'operation-args-invalid', outcomeKnown: true,
      });
      return;
    }
    const existing = receipts.get(message.operationId);
    if (existing) {
      if (existing.operation !== message.operation || existing.fingerprint !== fingerprint) {
        post(port, {
          type: 'custody/response', requestId: message.requestId,
          operationId: message.operationId, authorityId,
          ok: false, error: 'operation-id-conflict', outcomeKnown: true,
        });
      } else if (existing.state === 'pending') {
        post(port, {
          type: 'custody/response', requestId: message.requestId,
          operationId: message.operationId, authorityId,
          ok: false, error: 'operation-pending', outcomeKnown: false,
        });
      } else {
        sendReceipt(port, message.requestId, existing);
      }
      return;
    }
    if (!makeRoom()) {
      post(port, {
        type: 'custody/response', requestId: message.requestId,
        operationId: message.operationId, authorityId,
        ok: false, error: 'custody-receipts-full', outcomeKnown: true,
      });
      return;
    }

    const controller = new AbortController();
    /** @type {CustodyReceipt} */
    const receipt = {
      operationId: message.operationId,
      operation: message.operation,
      fingerprint,
      state: 'pending',
      phase: 'inspection',
      controller,
      timer: null,
    };
    receipts.set(message.operationId, receipt);
    const deadline = Date.now() + operationTimeoutMs;
    receipt.timer = setTimeout(() => {
      if (receipt.state !== 'pending') return;
      controller.abort(new Error('identity-custody-operation-timeout'));
      delete receipt.controller;
      receipt.state = 'failed';
      receipt.error = 'identity-custody-operation-timeout';
      receipt.outcomeKnown = receipt.operation !== 'adopt' || receipt.phase === 'inspection';
      receipt.timer = null;
      sendReceipt(port, message.requestId, receipt);
    }, operationTimeoutMs);

    // Do not put the running promise or its argument graph in the receipt. A
    // crypto implementation that ignores abort must not retain passphrases in
    // the reconciliation table or block unrelated later operations.
    void Promise.resolve().then(() => runOperation(message.operation, message.args ?? {}, {
      operationId: message.operationId, signal: controller.signal, deadline,
      setPhase: (phase) => {
        if (receipt.state === 'pending'
            && ['inspection', 'suspending', 'commit-dispatched', 'recovering'].includes(phase)) {
          receipt.phase = phase;
        }
      },
    })).then((result) => {
      const shouldRespond = receipt.state === 'pending';
      if (receipt.timer !== null) clearTimeout(receipt.timer);
      receipt.timer = null;
      delete receipt.controller;
      receipt.state = 'succeeded';
      receipt.result = result;
      delete receipt.error;
      delete receipt.outcomeKnown;
      if (shouldRespond) sendReceipt(port, message.requestId, receipt);
    }, (cause) => {
      const shouldRespond = receipt.state === 'pending';
      if (receipt.timer !== null) clearTimeout(receipt.timer);
      receipt.timer = null;
      delete receipt.controller;
      receipt.state = 'failed';
      receipt.error = typeof /** @type {{ code?:unknown }} */ (cause)?.code === 'string'
        ? /** @type {{ code:string }} */ (cause).code : 'host-failed';
      receipt.outcomeKnown = /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown !== false;
      if (shouldRespond) sendReceipt(port, message.requestId, receipt);
    });
  };

  /** @param {any} port @param {any} message */
  const recover = async (port, message) => {
    const receipt = receipts.get(message.operationId);
    let fingerprint = '';
    try { fingerprint = await fingerprintOperation(message.operation, message.args ?? {}); }
    catch { /* invalid below */ }
    if (receipt?.operation !== 'adopt' || receipt.state !== 'failed'
        || message.operation !== receipt.operation || fingerprint !== receipt.fingerprint
        || receipt.outcomeKnown !== false || receipt.phase === 'inspection') {
      post(port, {
        type: 'custody/recover-response', requestId: message.requestId,
        operationId: message.operationId, authorityId,
        ok: false, error: 'custody-recovery-invalid', outcomeKnown: true,
      });
      return;
    }
    try {
      const result = await recoverOperation(message.operationId);
      post(port, {
        type: 'custody/recover-response', requestId: message.requestId,
        operationId: message.operationId, authorityId, ok: true, result,
      });
    } catch {
      post(port, {
        type: 'custody/recover-response', requestId: message.requestId,
        operationId: message.operationId, authorityId,
        ok: false, error: 'custody-recovery-failed', outcomeKnown: false,
      });
    }
  };

  /** @param {any} port */
  const attach = (port) => {
    if (!port?.onMessage?.addListener || typeof port?.postMessage !== 'function') {
      throw new TypeError('dweb-custody-host-port-invalid');
    }
    port.onMessage.addListener((/** @type {any} */ message) => {
      if (message?.type === 'custody/ack' && safeId(message.operationId)) {
        const receipt = receipts.get(message.operationId);
        if (receipt?.state !== 'pending') receipts.delete(message.operationId);
        return;
      }
      if (message?.type === 'custody/status'
          && safeId(message.requestId) && safeId(message.operationId)) {
        void status(port, message);
        return;
      }
      if (message?.type === 'custody/recover'
          && safeId(message.requestId) && safeId(message.operationId)
          && OPERATIONS.has(message.operation)) {
        void recover(port, message);
        return;
      }
      if (message?.type === 'custody/request'
          && safeId(message.requestId) && safeId(message.operationId)
          && OPERATIONS.has(message.operation)) void request(port, message);
    });
    post(port, { type: 'custody/ready', authorityId });
  };

  return Object.freeze({ authorityId, attach });
};
