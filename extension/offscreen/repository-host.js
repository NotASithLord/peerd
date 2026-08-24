// @ts-check
// Operation-lazy repository owner. isomorphic-git and the OPFS adapter load in
// this document only after a repository request; they are absent from the MV3
// service-worker graph. Credentials never enter this realm: Smart-HTTP bytes
// go back to the authority kernel, which independently validates the bound
// remote and injects any token there.

import { createRepositoryService } from '/peerd-engine/repository.js';
import { createRepositoryAppFileService } from './repository-app-files.js';
import {
  REPOSITORY_CHANNEL_CANCEL,
  REPOSITORY_CHANNEL_RESULT,
  REPOSITORY_KERNEL_FETCH,
  REPOSITORY_KERNEL_FETCH_RESULT,
  decodeRepositoryRpcValue,
  encodeRepositoryRpcValue,
} from '/shared/repository-channel.js';
import {
  REPOSITORY_CHANNEL_MAX_BYTES,
  REPOSITORY_CHANNEL_PROTOCOL,
  parseRepositoryChannelOffer,
  repositoryChannelPayloadFits,
  repositoryMethodIsAppFile,
  repositoryMethodIsKnown,
  repositoryMethodIsMutating,
} from '/shared/feature-lease-protocol.js';
import { base64ToBytes, bytesToBase64 } from '/shared/cold-util.js';
/** @typedef {{abort:AbortController,close:()=>void}} ActiveCall */
/** @type {Map<string,ActiveCall>} */
const calls = new Map();
let hostDraining = false;

export const abortRepositoryHostCalls = () => {
  const active = [...calls.values()];
  if (active.length > 0) hostDraining = true;
  for (const call of active) {
    call.abort.abort('repository-host-retired');
    call.close();
  }
  return active.length;
};

const makeService = (/** @type {any} */ webFetch) =>
  Object.freeze({
    ...createRepositoryService({
      webFetch,
      // The kernel injects credentials after validating the exact remote/request.
      getSecret: async () => null,
    }),
    ...createRepositoryAppFileService(),
  });

/** @param {any} message @param {any} service @param {AbortSignal} signal */
const runRepositoryOperation = async (message, service, signal) => {
  const callId = typeof message?.callId === 'string' ? message.callId : '';
  const method = typeof message?.method === 'string' ? message.method : '';
  if (!callId || callId.length > 256 || !repositoryMethodIsKnown(method)) {
    return { ok: false, code: 'repository-call-invalid', error: 'invalid repository call', outcomeKnown: true };
  }
  const args = decodeRepositoryRpcValue(message.args);
  if (!Array.isArray(args)) {
    return { ok: false, code: 'repository-args-invalid', error: 'invalid repository arguments', outcomeKnown: true };
  }
  const operation = /** @type {(...args:any[])=>Promise<any>} */ (
    /** @type {Record<string, unknown>} */ (service)[method]);
  if (typeof operation !== 'function') {
    return { ok: false, code: 'repository-call-invalid', error: 'invalid repository call', outcomeKnown: true };
  }
  if (method === 'fetch' || method === 'push' || method === 'clone'
      || repositoryMethodIsAppFile(method)) {
    const last = args.at(-1);
    if (args.length >= 2 && last && typeof last === 'object' && !Array.isArray(last)) {
      last.signal = signal;
    } else args.push({ signal });
  }
  try {
    const result = await operation(...args);
    return { ok: true, result: encodeRepositoryRpcValue(result), outcomeKnown: true };
  } catch (cause) {
    return {
      ok: false,
      code: signal.aborted ? 'repository-call-aborted' : 'repository-call-failed',
      error: cause instanceof Error ? cause.message : String(cause),
      outcomeKnown: !repositoryMethodIsMutating(method),
    };
  }
};

const seenChannels = new Set();
/** @type {string[]} */ const seenOrder = [];
const rememberChannel = (/** @type {string} */ channelId) => {
  if (seenChannels.has(channelId)) return false;
  seenChannels.add(channelId);
  seenOrder.push(channelId);
  if (seenOrder.length > 1024) {
    const expired = seenOrder.shift();
    if (expired !== undefined) seenChannels.delete(expired);
  }
  return true;
};

/** Exact admitted ServiceWorker offer; sender and lease are checked by the cold supervisor.
 * @param {MessageEvent} event
 * @param {{
 *   createService?:(webFetch:any)=>any,
 *   ownsLease?:(lease:any)=>boolean,
 * }} [deps]
 */
export const acceptRepositoryOffer = (event, {
  createService = makeService,
  ownsLease = () => false,
} = {}) => {
  const offer = parseRepositoryChannelOffer(event.data);
  const port = event.ports?.length === 1 ? event.ports[0] : null;
  if (!offer || !port) {
    try { port?.close(); } catch { /* invalid */ }
    return false;
  }
  // The supervisor admits before the demand import. Recheck after that await so
  // a revoked lease cannot cross the module-load boundary.
  if (!ownsLease(offer.lease)) {
    try { port.postMessage({
      type: REPOSITORY_CHANNEL_RESULT,
      protocol: REPOSITORY_CHANNEL_PROTOCOL,
      channelId: offer.channelId,
      ok: false,
      code: 'repository-channel-lease-stale',
      error: 'repository channel lease is no longer active',
      outcomeKnown: true,
    }); } catch { /* invalid/closed */ }
    try { port.close(); } catch { /* invalid/closed */ }
    return false;
  }
  if (!rememberChannel(offer.channelId)) {
    try { port.close(); } catch { /* invalid */ }
    return false;
  }
  if (hostDraining) {
    try { port.postMessage({
      type: REPOSITORY_CHANNEL_RESULT,
      protocol: REPOSITORY_CHANNEL_PROTOCOL,
      channelId: offer.channelId,
      ok: false,
      code: 'repository-host-draining',
      error: 'repository host is reconciling a retired operation',
      outcomeKnown: true,
    }); } catch { /* invalid/closed */ }
    try { port.close(); } catch { /* invalid/closed */ }
    return false;
  }
  const controller = new AbortController();
  /** @type {Map<string,{resolve:(value:any)=>void,reject:(cause:unknown)=>void}>} */
  const fetches = new Map();
  let fetchSequence = 0;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    controller.abort('repository-channel-closed');
    for (const pending of fetches.values()) pending.reject(new Error('repository kernel fetch channel closed'));
    fetches.clear();
    try { port.close(); } catch { /* already closed */ }
  };
  /**
   * @param {string} url
   * @param {RequestInit} [init]
   * @param {{gitRemote?:{url:string,host:string}}} [context]
   */
  const channelFetch = async (url, init = {}, context = {}) => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const body = init.body == null ? null
      : init.body instanceof Uint8Array ? init.body
        : init.body instanceof ArrayBuffer ? new Uint8Array(init.body)
          : new Uint8Array(await new Response(init.body).arrayBuffer());
    if (body && body.byteLength > 32 * 1024 * 1024) throw new Error('Git request exceeds the transfer ceiling');
    const fetchId = `${offer.channelId}:fetch:${++fetchSequence}`;
    const result = await new Promise((resolve, reject) => {
      fetches.set(fetchId, { resolve, reject });
      try { port.postMessage({
        type: REPOSITORY_KERNEL_FETCH,
        protocol: REPOSITORY_CHANNEL_PROTOCOL,
        channelId: offer.channelId,
        fetchId,
        request: {
          remote: context.gitRemote?.url,
          url, method: init.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          bodyB64: body ? bytesToBase64(body) : null,
        },
      }); } catch (cause) {
        fetches.delete(fetchId);
        reject(cause);
      }
    });
    const reply = /** @type {any} */ (result);
    if (!reply?.ok) throw new Error(String(reply?.error ?? 'repository kernel fetch failed'));
    const response = new Response(
      typeof reply.bodyB64 === 'string'
        ? /** @type {BodyInit} */ (base64ToBytes(reply.bodyB64)) : null,
      { status: reply.status, statusText: reply.statusText, headers: reply.headers },
    );
    if (typeof reply.url === 'string') {
      try { Object.defineProperty(response, 'url', { value: reply.url }); } catch { /* cosmetic */ }
    }
    return response;
  };
  let service;
  try { service = createService(channelFetch); }
  catch (cause) {
    try { port.postMessage({
      type: REPOSITORY_CHANNEL_RESULT,
      protocol: REPOSITORY_CHANNEL_PROTOCOL,
      channelId: offer.channelId,
      ok: false,
      code: 'repository-host-create-failed',
      error: cause instanceof Error ? cause.message : String(cause),
      outcomeKnown: true,
    }); } catch { /* channel closed */ }
    finish();
    return false;
  }
  port.onmessage = (message) => {
    const data = message.data;
    if (data?.protocol !== REPOSITORY_CHANNEL_PROTOCOL || data?.channelId !== offer.channelId) return;
    if (data.type === REPOSITORY_CHANNEL_CANCEL) { finish(); return; }
    if (data.type !== REPOSITORY_KERNEL_FETCH_RESULT || typeof data.fetchId !== 'string') return;
    const pending = fetches.get(data.fetchId);
    if (!pending) return;
    fetches.delete(data.fetchId);
    if (data.ok === true) pending.resolve(data.result);
    else pending.reject(new Error(String(data.error ?? 'repository kernel fetch failed')));
  };
  port.onmessageerror = finish;
  port.addEventListener?.('close', finish, { once: true });
  port.start();
  const callId = offer.channelId;
  calls.set(callId, { abort: controller, close: finish });
  runRepositoryOperation({ callId, method: offer.method, args: offer.args }, service, controller.signal)
    .then((result) => {
      const reply = {
        type: REPOSITORY_CHANNEL_RESULT,
        protocol: REPOSITORY_CHANNEL_PROTOCOL,
        channelId: offer.channelId,
        ...result,
      };
      if (!settled && !repositoryChannelPayloadFits(reply, REPOSITORY_CHANNEL_MAX_BYTES)) {
        const overflow = {
          type: REPOSITORY_CHANNEL_RESULT,
          protocol: REPOSITORY_CHANNEL_PROTOCOL,
          channelId: offer.channelId,
          ok: false,
          code: 'repository-result-too-large',
          error: 'repository result exceeds the transfer ceiling',
          outcomeKnown: !repositoryMethodIsMutating(offer.method),
        };
        try { port.postMessage(overflow); } catch { /* channel closed */ }
        return;
      }
      if (!settled) {
        try { port.postMessage(reply); } catch { /* channel closed */ }
      }
    })
    .catch(() => {})
    .finally(() => {
      calls.delete(callId);
      if (calls.size === 0) hostDraining = false;
      finish();
    });
  return true;
};
