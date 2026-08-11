// @ts-check
// Options-side half of the backup/restore transport. Chrome receives a
// targeted MessageChannel. Firefox uses an exact-sender background Port.

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
 * @param {(requestId: string) => void|Promise<void>} [deps.requestChannel]
 * @param {() => import('webextension-polyfill').Runtime.Port} [deps.connect]
 * @param {() => string} [deps.newRequestId]
 * @param {number} [deps.timeoutMs]
 */
export const makePrivateTransferClient = ({
  requestChannel, connect, newRequestId = () => crypto.randomUUID(), timeoutMs = 60_000,
}) => {
  /** @type {MessagePort | import('webextension-polyfill').Runtime.Port | null} */
  let port = null;
  /** @type {{ requestId: string, resolve: (port: MessagePort) => void, reject: (reason: any) => void, timer: ReturnType<typeof setTimeout> } | null} */
  let channelRequest = null;
  /** @type {Promise<MessagePort> | null} */
  let channelPromise = null;
  /** @type {Map<string, { resolve: (value: any) => void, reject: (reason: any) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map();

  const rejectPending = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new PrivateTransferPortError('backup connection closed', 'port-disconnected'));
    }
    pending.clear();
  };

  /** @param {MessagePort | import('webextension-polyfill').Runtime.Port} active */
  const dropPort = (active) => {
    if (port !== active) return;
    port = null;
    channelPromise = null;
    try {
      if ('disconnect' in active) active.disconnect();
      else active.close();
    } catch { /* already closed */ }
    rejectPending();
  };

  /** @param {any} response */
  const handleResponse = (response) => {
    if (response?.type === 'private-transfer/ready' && port && channelRequest) {
      const request = channelRequest;
      clearTimeout(request.timer);
      channelRequest = null;
      request.resolve(/** @type {MessagePort} */ (port));
      channelPromise = Promise.resolve(/** @type {MessagePort} */ (port));
      return;
    }
    if (response?.type !== 'private-transfer/response'
        || typeof response.requestId !== 'string') return;
    const entry = pending.get(response.requestId);
    if (!entry) return;
    const active = port;
    pending.delete(response.requestId);
    clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response.reply);
    else entry.reject(new PrivateTransferPortError(
      typeof response.error === 'string' ? response.error : 'backup request failed',
      'request-failed',
    ));
    // Backup operations are infrequent. Retire an idle channel after each
    // response so the next click never inherits a peer lost to an SW restart.
    if (active && pending.size === 0) dropPort(active);
  };

  const ensurePort = async () => {
    if (port && (!requestChannel || !channelRequest)) return port;
    if (!requestChannel) {
      if (!connect) throw new PrivateTransferPortError(
        'backup connection is unavailable', 'channel-unavailable',
      );
      const next = connect();
      port = next;
      next.onMessage.addListener(handleResponse);
      next.onDisconnect.addListener(() => dropPort(next));
      return next;
    }
    if (!channelPromise) {
      const requestId = newRequestId();
      channelPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (channelRequest?.requestId === requestId) channelRequest = null;
          reject(new PrivateTransferPortError('backup connection timed out', 'channel-timeout'));
        }, timeoutMs);
        channelRequest = {
          requestId,
          resolve: /** @type {(port: MessagePort) => void} */ (resolve),
          reject, timer,
        };
      });
      Promise.resolve(requestChannel(requestId)).catch((cause) => {
        const request = channelRequest;
        if (request?.requestId !== requestId) return;
        clearTimeout(request.timer);
        channelRequest = null;
        request.reject(new PrivateTransferPortError(
          cause instanceof Error ? cause.message : 'backup connection could not be requested',
          'channel-request-failed',
        ));
      });
    }
    try { return await channelPromise; }
    finally { if (!port) channelPromise = null; }
  };

  /** @param {string} requestId @param {MessagePort} next */
  const acceptChannel = (requestId, next) => {
    const request = channelRequest;
    if (!request || request.requestId !== requestId || port) {
      try { next.close(); } catch { /* unsolicited channel */ }
      return false;
    }
    port = next;
    next.onmessage = (event) => handleResponse(event.data);
    next.onmessageerror = () => {
      dropPort(next);
    };
    next.addEventListener('close', () => dropPort(next), { once: true });
    next.start();
    return true;
  };

  /** @param {{ type: string } & Record<string, any>} message */
  const call = async (message) => {
    const active = await ensurePort();
    const requestId = newRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        dropPort(active);
        reject(new PrivateTransferPortError('backup request timed out', 'timeout'));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try {
        active.postMessage({ type: 'private-transfer/request', requestId, message });
      } catch (cause) {
        pending.delete(requestId);
        clearTimeout(timer);
        dropPort(active);
        reject(new PrivateTransferPortError(
          /** @type {{ message?: string }} */ (cause)?.message ?? 'backup request could not be sent',
          'post-failed',
        ));
      }
    });
  };

  return { call, acceptChannel };
};
