// @ts-check

const PRIVATE_TRANSFER_TYPES = new Set([
  'transfer/export', 'transfer/inspectImport', 'transfer/import',
]);

const isOptionsClientUrl = (/** @type {string | undefined} */ candidate, /** @type {string} */ expected) => {
  try {
    const current = new URL(candidate ?? '');
    const target = new URL(expected);
    return current.origin === target.origin
      && current.pathname === target.pathname
      && current.search === target.search;
  } catch { return false; }
};

/**
 * @param {Object} deps
 * @param {Record<string, (message: any) => Promise<any>>} deps.handlers
 * @param {symbol} deps.authorization
 */
export const makePrivateTransferPort = ({ handlers, authorization }) => {
  /** @type {Set<MessagePort | import('webextension-polyfill').Runtime.Port>} */
  const activePorts = new Set();
  return {
    /** @param {MessagePort | import('webextension-polyfill').Runtime.Port} port */
    attach(port) {
      activePorts.add(port);
      if ('onDisconnect' in port) {
        port.onDisconnect.addListener(() => activePorts.delete(port));
      } else {
        port.addEventListener('close', () => activePorts.delete(port), { once: true });
      }
      const receive = (/** @type {any} */ request) => {
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
      };
      if ('onMessage' in port) port.onMessage.addListener(receive);
      else {
        port.onmessage = (event) => receive(event.data);
        port.start();
        port.postMessage({ type: 'private-transfer/ready' });
      }
    },
  };
};

/**
 * @param {Object} deps
 * @param {(sender: unknown) => boolean} deps.isOptionsSender
 * @param {() => Promise<Array<{ id?: string, url?: string, postMessage: (message: any, transfer: Transferable[]) => void }>>} deps.listWindowClients
 * @param {string} deps.optionsUrl
 * @param {(port: MessagePort) => void} deps.attach
 * @param {() => MessageChannel} [deps.createChannel]
 */
export const makePrivateTransferOpenRoute = ({
  isOptionsSender, listWindowClients, optionsUrl, attach,
  createChannel = () => new MessageChannel(),
}) => async (
  /** @type {{ requestId?: unknown }} */ message,
  /** @type {({ documentId?: unknown } & Record<string, unknown>) | null | undefined} */ sender,
) => {
  if (!isOptionsSender(sender)
      || typeof message.requestId !== 'string' || message.requestId.length === 0) {
    return { ok: false, error: 'private-transfer-channel-refused' };
  }
  const exact = (await listWindowClients())
    .filter((client) => isOptionsClientUrl(client.url, optionsUrl));
  const target = exact.length === 1 ? exact[0] : null;
  if (!target) return { ok: false, error: 'private-transfer-channel-target-missing' };
  const channel = createChannel();
  attach(channel.port1);
  try {
    target.postMessage({
      type: 'private-transfer/channel', requestId: message.requestId,
    }, [channel.port2]);
    return { ok: true };
  } catch {
    channel.port1.close();
    channel.port2.close();
    return { ok: false, error: 'private-transfer-channel-offer-failed' };
  }
};
