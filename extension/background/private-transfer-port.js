// @ts-check
// Dedicated options-page RPC for backup and restore requests.
//
// why a Port plus a static exclusivity test: runtime.sendMessage broadcasts the
// passphrase and import payload to every extension listener. The shipped source
// registers onConnect only in the service worker, so this named connection has
// one receiver and the exact options-page sender is verified before attachment.

const PRIVATE_TRANSFER_TYPES = new Set([
  'transfer/export', 'transfer/inspectImport', 'transfer/import',
]);

/**
 * @param {Object} deps
 * @param {Record<string, (message: any) => Promise<any>>} deps.handlers
 * @param {symbol} deps.authorization
 */
export const makePrivateTransferPort = ({ handlers, authorization }) => ({
  /** @param {import('webextension-polyfill').Runtime.Port} port */
  attach(port) {
    port.onMessage.addListener((/** @type {any} */ request) => {
      if (request?.type !== 'private-transfer/request'
          || typeof request.requestId !== 'string'
          || !request.message || typeof request.message !== 'object'
          || !PRIVATE_TRANSFER_TYPES.has(request.message.type)) return;
      const handler = handlers[request.message.type];
      if (typeof handler !== 'function') return;
      const respond = (/** @type {any} */ response) => {
        try { port.postMessage(response); } catch { /* page observes disconnect */ }
      };
      Promise.resolve(handler({
        ...request.message, privateTransferAuthorization: authorization,
      }))
        .then((reply) => respond({
          type: 'private-transfer/response', requestId: request.requestId,
          ok: true, reply,
        }))
        .catch((cause) => respond({
          type: 'private-transfer/response', requestId: request.requestId,
          ok: false,
          error: /** @type {{ message?: string }} */ (cause)?.message ?? 'transfer-failed',
        }));
    });
  },
});
