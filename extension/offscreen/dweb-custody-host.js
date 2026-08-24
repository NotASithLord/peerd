// @ts-check
// Receipt-owning endpoint for the private dweb custody Port. The offscreen
// module can outlive an MV3 service worker, so receipts live here and let a
// successor/reconnected client ask what happened before it retries.

const OPERATIONS = new Set(['export', 'adopt', 'suspend', 'resume', 'reset']);
const safeId = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length >= 3 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value);

/** @param {any} port @param {any} message */
const post = (port, message) => {
  try { port.postMessage(message); } catch { /* receipt remains for reconciliation */ }
};

/**
 * @param {Object} deps
 * @param {(operation:'export'|'adopt'|'suspend'|'resume'|'reset', args:any)=>Promise<any>} deps.runOperation
 * @param {()=>any} deps.readState
 * @param {string} [deps.authorityId]
 * @param {number} [deps.maxReceipts]
 */
export const makeDwebCustodyHost = ({
  runOperation, readState, authorityId = crypto.randomUUID(), maxReceipts = 16,
}) => {
  if (typeof runOperation !== 'function' || typeof readState !== 'function'
      || !safeId(authorityId) || !Number.isInteger(maxReceipts) || maxReceipts < 4) {
    throw new TypeError('dweb-custody-host-config-invalid');
  }
  /** @type {Map<string, { operation:string, state:'pending'|'succeeded'|'failed', result?:any, error?:string, promise:Promise<any> }>} */
  const receipts = new Map();

  const prune = () => {
    if (receipts.size <= maxReceipts) return;
    for (const [operationId, receipt] of receipts) {
      if (receipt.state === 'pending') continue;
      receipts.delete(operationId);
      if (receipts.size <= maxReceipts) return;
    }
  };

  /** @param {any} port @param {string} requestId @param {string} operationId @param {any} receipt */
  const sendReceipt = (port, requestId, operationId, receipt) => {
    post(port, receipt.state === 'succeeded' ? {
      type: 'custody/response', requestId, operationId, authorityId,
      ok: true, result: receipt.result,
    } : {
      type: 'custody/response', requestId, operationId, authorityId,
      ok: false, error: receipt.error ?? 'host-failed',
    });
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
        const receipt = receipts.get(message.operationId);
        post(port, {
          type: 'custody/status-response', requestId: message.requestId,
          operationId: message.operationId, authorityId,
          receipt: !receipt ? { state: 'missing' }
            : receipt.state === 'succeeded' ? { state: 'succeeded', result: receipt.result }
            : receipt.state === 'failed' ? { state: 'failed', error: receipt.error ?? 'host-failed' }
            : { state: 'pending' },
          hostState: readState(),
        });
        return;
      }
      if (message?.type !== 'custody/request'
          || !safeId(message.requestId) || !safeId(message.operationId)
          || !OPERATIONS.has(message.operation)) return;
      const existing = receipts.get(message.operationId);
      if (existing) {
        if (existing.operation !== message.operation) {
          post(port, {
            type: 'custody/response', requestId: message.requestId,
            operationId: message.operationId, authorityId,
            ok: false, error: 'operation-id-conflict',
          });
          return;
        }
        existing.promise.then((receipt) => {
          sendReceipt(port, message.requestId, message.operationId, receipt);
        });
        return;
      }

      /** @type {any} */
      const receipt = {
        operation: message.operation, state: 'pending', promise: Promise.resolve(),
      };
      const run = Promise.resolve()
        .then(() => {
          // A replacement offscreen authority has no predecessor receipt. Read
          // the live lease posture before retrying: a completed suspension is
          // already the requested result, while another owner must stay closed.
          const state = readState();
          if (message.operation === 'suspend') {
            const owner = state?.suspensionOwner;
            if (owner === message.args?.leaseId && !state?.stopping && !state?.pending) {
              return { suspended: true };
            }
            if (owner !== null && owner !== message.args?.leaseId) {
              throw new Error('lease-conflict');
            }
          }
          return runOperation(message.operation, message.args ?? {});
        })
        .then((result) => {
          receipt.state = 'succeeded';
          receipt.result = result;
          prune();
          return receipt;
        }, (cause) => {
          receipt.state = 'failed';
          receipt.error = /** @type {{ code?:string, message?:string }} */ (cause)?.code
            ?? /** @type {{ message?:string }} */ (cause)?.message ?? 'host-failed';
          prune();
          return receipt;
        });
      receipt.promise = run;
      receipts.set(message.operationId, receipt);
      run.then((settled) => {
        sendReceipt(port, message.requestId, message.operationId, settled);
      });
    });
    post(port, { type: 'custody/ready', authorityId });
  };

  return Object.freeze({ authorityId, attach });
};
