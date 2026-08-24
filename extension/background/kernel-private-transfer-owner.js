// @ts-check
import { makePrivateTransferOpenRoute, makePrivateTransferPort } from './private-transfer-port.js';

/** @param {Record<string,any>} deps */
export const createKernelPrivateTransferOwner = (deps) => {
  if (typeof deps.isOptionsSender !== 'function' || typeof deps.makeHandlers !== 'function') {
    throw new TypeError('kernel-private-transfer-owner-invalid');
  }
  const authorization = Symbol('kernel-private-transfer');
  const handlers = deps.makeHandlers(authorization);
  const privatePort = makePrivateTransferPort({ handlers, authorization });
  const attach = (/** @type {any} */ port, /** @type {any} */ context = {}) => {
    const sender = context.sender ?? port?.sender;
    if (!deps.isOptionsSender(sender)) {
      try { port?.disconnect?.(); } catch {}
      try { port?.close?.(); } catch {}
      return false;
    }
    privatePort.attach(port);
    return true;
  };
  const routes = typeof deps.listWindowClients === 'function' ? {
    'private-transfer/open': makePrivateTransferOpenRoute({
      isOptionsSender: deps.isOptionsSender,
      listWindowClients: deps.listWindowClients,
      optionsUrl: deps.optionsUrl,
      attach: (port) => privatePort.attach(port),
      ...(deps.createChannel ? { createChannel: deps.createChannel } : {}),
    }),
  } : {};
  return Object.freeze({ routes: Object.freeze(routes), attach });
};
