// @ts-check
// Options-side half of the sender-verified backup/restore Port.

export class PrivateTransferPortError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'PrivateTransferPortError';
    this.code = code;
  }
}

/**
 * @param {Object} deps
 * @param {() => import('webextension-polyfill').Runtime.Port} deps.connect
 * @param {() => string} [deps.newRequestId]
 * @param {number} [deps.timeoutMs]
 */
export const makePrivateTransferClient = ({
  connect, newRequestId = () => crypto.randomUUID(), timeoutMs = 60_000,
}) => {
  /** @type {import('webextension-polyfill').Runtime.Port | null} */
  let port = null;
  /** @type {Map<string, { resolve: (value: any) => void, reject: (reason: any) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map();

  const rejectPending = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new PrivateTransferPortError('backup connection closed', 'port-disconnected'));
    }
    pending.clear();
  };

  const ensurePort = () => {
    if (port) return port;
    const next = connect();
    port = next;
    next.onMessage.addListener((/** @type {any} */ response) => {
      if (response?.type !== 'private-transfer/response'
          || typeof response.requestId !== 'string') return;
      const entry = pending.get(response.requestId);
      if (!entry) return;
      pending.delete(response.requestId);
      clearTimeout(entry.timer);
      if (response.ok) entry.resolve(response.reply);
      else entry.reject(new PrivateTransferPortError(
        typeof response.error === 'string' ? response.error : 'backup request failed',
        'request-failed',
      ));
    });
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      port = null;
      rejectPending();
    });
    return next;
  };

  /** @param {{ type: string } & Record<string, any>} message */
  const call = (message) => {
    const active = ensurePort();
    const requestId = newRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new PrivateTransferPortError('backup request timed out', 'timeout'));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try {
        active.postMessage({ type: 'private-transfer/request', requestId, message });
      } catch (cause) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(new PrivateTransferPortError(
          /** @type {{ message?: string }} */ (cause)?.message ?? 'backup request could not be sent',
          'post-failed',
        ));
      }
    });
  };

  return { call };
};
