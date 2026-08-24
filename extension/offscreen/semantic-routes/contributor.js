// @ts-check
// Preview Contributor Metrics are formatted in the sealed host. The kernel
// exposes one read-only record and retains every storage/mutation capability.

import { makeContributorStore } from '/peerd-runtime/observability/contributor-store.js';
import {
  CONTRIBUTOR_CHANNEL_CALL, CONTRIBUTOR_CHANNEL_PROTOCOL,
  CONTRIBUTOR_CHANNEL_REPLY, CONTRIBUTOR_CHANNEL_RESULT,
  parseContributorOffer,
} from '/shared/contributor-channel.js';

/** @param {string} route @param {any} _message
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options */
export const dispatchContributorSemanticRoute = async (route, _message, options) => {
  if (!['contributor/status', 'contributor/enable', 'contributor/disable'].includes(route)
      || typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'semantic-contributor-route-refused', outcomeKnown: true };
  }
  const kernelCall = options.kernelCall;
  if (route === 'contributor/status') {
    const result = await kernelCall('semantic.contributor.read', {});
    if (result?.ok !== true) return {
      ok: false, error: 'Contributor Metrics status is temporarily unavailable.',
      outcomeKnown: true, retryable: true,
    };
    const store = makeContributorStore({ kv: {
      get: async () => result.value ?? null,
      set: async () => { throw new Error('contributor-status-read-only'); },
      delete: async () => { throw new Error('contributor-status-read-only'); },
    } });
    return { ok: true, status: await store.status() };
  }
  const readOperation = route === 'contributor/status' ? 'semantic.contributor.read'
    : `semantic.contributor.${route.slice('contributor/'.length)}-read`;
  /** @type {any} */ let expected = null;
  /** @type {any} */ let failure = null;
  const unwrap = (/** @type {any} */ result) => {
    if (result?.ok === true) return result.value;
    failure = result ?? { outcomeKnown: false };
    throw new Error('contributor-kernel-operation-failed');
  };
  const store = makeContributorStore({
    kv: {
      get: async () => {
        expected = unwrap(await kernelCall(readOperation, {})) ?? null;
        return expected;
      },
      set: async () => {
        const action = unwrap(await kernelCall('semantic.contributor.enable', { expected }));
        if (action?.ok !== true) {
          failure = { outcomeKnown: true };
          throw new Error('contributor-state-changed');
        }
      },
      delete: async () => {
        const action = unwrap(await kernelCall('semantic.contributor.clear', {}));
        if (action?.ok !== true) throw new Error('contributor-clear-failed');
      },
    },
  });
  try {
    const status = route === 'contributor/enable'
      ? await store.enable() : await store.disableAndClear();
    return { ok: true, status };
  } catch {
    const known = failure?.outcomeKnown === true;
    return {
      ok: false,
      error: known ? 'Contributor Metrics could not be updated.'
        : 'The Contributor Metrics update outcome could not be confirmed.',
      outcomeKnown: known,
      retryable: known,
    };
  }
};

/** Exact contributor channel admitted by the cold offscreen supervisor. */
export const acceptContributorOffer = (
  /** @type {any} */ event,
  /** @type {{ownsLease?:(lease:any)=>boolean}} */ { ownsLease = () => false } = {},
) => {
  const offer = parseContributorOffer(event?.data);
  const port = event?.ports?.[0];
  if (!offer || event?.ports?.length !== 1 || !port || !ownsLease(offer.lease)) {
    try { port?.close(); } catch {}
    return false;
  }
  let nextRequest = 0;
  const pending = new Map();
  const finish = () => {
    for (const item of pending.values()) item.resolve({ ok: false, outcomeKnown: false });
    pending.clear();
    try { port.close(); } catch {}
  };
  const kernelCall = (/** @type {string} */ operation, /** @type {unknown} */ payload) =>
    new Promise((resolve) => {
      const requestId = `c${++nextRequest}`;
      pending.set(requestId, { resolve });
      try { port.postMessage({
        type: CONTRIBUTOR_CHANNEL_CALL, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
        channelId: offer.channelId, requestId, operation, payload,
      }); } catch { finish(); }
    });
  port.onmessage = (/** @type {MessageEvent} */ messageEvent) => {
    const packet = messageEvent.data;
    if (packet?.type !== CONTRIBUTOR_CHANNEL_REPLY
        || packet.protocol !== CONTRIBUTOR_CHANNEL_PROTOCOL
        || packet.channelId !== offer.channelId || typeof packet.requestId !== 'string') {
      finish(); return;
    }
    const item = pending.get(packet.requestId);
    if (!item) { finish(); return; }
    pending.delete(packet.requestId);
    item.resolve(packet.result);
  };
  port.onmessageerror = finish;
  port.addEventListener?.('close', finish, { once: true });
  port.start();
  dispatchContributorSemanticRoute(offer.route, {}, { kernelCall }).then(
    (result) => {
      try { port.postMessage({
        type: CONTRIBUTOR_CHANNEL_RESULT, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
        channelId: offer.channelId, result,
      }); } catch {}
      finish();
    }, finish,
  );
  return true;
};
