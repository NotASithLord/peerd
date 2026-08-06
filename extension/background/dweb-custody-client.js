// @ts-check
// Targeted service-worker client for portable-identity custody operations.
//
// why a Port: runtime.sendMessage broadcasts its request to every extension
// page. These calls carry the permanent identity seed and backup passphrase,
// so they must travel only over the exact offscreen document's verified port.

export class DwebCustodyPortError extends Error {
  /** @param {string} message @param {string} code @param {{ cause?: unknown }} [options] */
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'DwebCustodyPortError';
    this.code = code;
  }
}

/**
 * Cache only a successful boot reset. A timed-out or disconnected attempt is
 * cleared so the next caller can retry on the reconnected custody port.
 * @param {{ enabled: boolean, hostAvailable: boolean, reset: () => Promise<void> }} deps
 */
export const makeRetryableCustodyReset = ({ enabled, hostAvailable, reset }) => {
  let complete = false;
  /** @type {Promise<void> | null} */
  let inFlight = null;
  const ensure = async () => {
    if (!enabled || !hostAvailable) return;
    if (complete) return;
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(reset)
        .then(() => { complete = true; })
        .finally(() => { inFlight = null; });
    }
    await inFlight;
  };
  return { ensure };
};

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen
 * @param {(operation: 'get'|'set', args: any) => Promise<any>} deps.handleSecretRequest
 * @param {number} [deps.timeoutMs]
 * @param {() => string} [deps.newRequestId]
 */
export const makeDwebCustodyClient = ({
  ensureOffscreen, handleSecretRequest, timeoutMs = 60_000,
  newRequestId = () => crypto.randomUUID(),
}) => {
  /** @type {import('webextension-polyfill').Runtime.Port | null} */
  let activePort = null;
  /** @type {Set<() => void>} */
  const connectedWaiters = new Set();
  /** @type {Map<string, { resolve: (value: any) => void, reject: (reason: any) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map();

  /** @param {string} code @param {string} message */
  const rejectPending = (code, message) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new DwebCustodyPortError(message, code));
    }
    pending.clear();
  };

  /**
   * Attach only after the service worker has verified `port.sender` with
   * isOffscreenSender. The client deliberately does not duplicate that browser-
   * owned provenance check with payload data.
   * @param {import('webextension-polyfill').Runtime.Port} port
   */
  const attach = (port) => {
    if (activePort && activePort !== port) {
      rejectPending('port-replaced', 'the identity custody host reconnected');
      try { activePort.disconnect(); } catch { /* already disconnected */ }
    }
    activePort = port;
    for (const resolve of connectedWaiters) resolve();
    connectedWaiters.clear();

    port.onMessage.addListener((/** @type {any} */ message) => {
      if (message?.type === 'custody/response' && typeof message.requestId === 'string') {
        const entry = pending.get(message.requestId);
        if (!entry) return;
        pending.delete(message.requestId);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new DwebCustodyPortError(
          'identity custody operation failed',
          typeof message.error === 'string' ? message.error : 'host-failed',
        ));
        return;
      }
      if (message?.type !== 'custody/secret-request'
          || typeof message.requestId !== 'string'
          || !['get', 'set'].includes(message.operation)) return;
      /** @param {any} response */
      const respond = (response) => {
        if (activePort !== port) return;
        try { port.postMessage(response); } catch { /* caller observes disconnect */ }
      };
      Promise.resolve(handleSecretRequest(message.operation, message.args ?? {}))
        .then((result) => respond({
            type: 'custody/secret-response', requestId: message.requestId,
            ok: true, result,
          }))
        .catch((cause) => respond({
            type: 'custody/secret-response', requestId: message.requestId,
            ok: false,
            error: /** @type {{ code?: string, message?: string }} */ (cause)?.code
              ?? /** @type {{ message?: string }} */ (cause)?.message ?? 'secret-host-failed',
          }));
    });
    port.onDisconnect.addListener(() => {
      if (activePort !== port) return;
      activePort = null;
      rejectPending('port-disconnected', 'the identity custody host disconnected');
    });
  };

  const waitForPort = async () => {
    if (activePort) return activePort;
    await ensureOffscreen();
    if (activePort) return activePort;
    await new Promise((resolve, reject) => {
      const connected = () => {
        clearTimeout(timer);
        connectedWaiters.delete(connected);
        resolve(undefined);
      };
      connectedWaiters.add(connected);
      const timer = setTimeout(() => {
        connectedWaiters.delete(connected);
        reject(new DwebCustodyPortError(
          'identity custody host did not connect', 'port-timeout',
        ));
      }, timeoutMs);
    });
    if (!activePort) throw new DwebCustodyPortError(
      'identity custody host disconnected before use', 'port-disconnected',
    );
    return activePort;
  };

  /** @param {'export'|'adopt'|'suspend'|'resume'|'reset'} operation @param {any} [args] */
  const call = async (operation, args = {}) => {
    const port = await waitForPort();
    if (activePort !== port) throw new DwebCustodyPortError(
      'identity custody host disconnected before use', 'port-disconnected',
    );
    const requestId = newRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new DwebCustodyPortError(
          `identity custody ${operation} timed out`, 'operation-timeout',
        ));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try {
        port.postMessage({ type: 'custody/request', requestId, operation, args });
      } catch (cause) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(new DwebCustodyPortError(
          `identity custody ${operation} could not be sent`, 'post-failed', { cause },
        ));
      }
    });
  };

  return { attach, call };
};
