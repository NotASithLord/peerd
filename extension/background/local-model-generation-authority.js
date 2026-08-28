// @ts-check
// Exact service-worker custody for one resident local-model generation. The
// controller supplies model input, but cannot address the offscreen host,
// choose a lease, or retain a generation after its owning grant is retired.

import {
  LOCAL_MODEL_CHANNEL_CANCEL, LOCAL_MODEL_CHANNEL_CHUNK,
  LOCAL_MODEL_CHANNEL_OFFER, LOCAL_MODEL_CHANNEL_PROTOCOL,
  LOCAL_MODEL_CHANNEL_RESULT, parseLocalModelChannelOffer,
} from '../shared/feature-lease-protocol.js';

const MAX_TOKEN_CHARS = 64 * 1024;
const MAX_STREAM_CHARS = 8 * 1024 * 1024;

const localFailure = (/** @type {string} */ code, /** @type {unknown} */ cause = code) =>
  Object.assign(new Error(cause instanceof Error ? cause.message : String(cause)), {
    code, outcomeKnown: true,
  });

/**
 * @param {Object} deps
 * @param {{runtime:{runWithLease:(scope:string,operation:(lease:any)=>Promise<any>,options:any)=>Promise<any>}}} deps.featureHost
 * @param {string} deps.offscreenUrl
 * @param {{matchAll:(options:any)=>Promise<any[]>}} [deps.clientsApi]
 * @param {()=>string} [deps.newId]
 */
export const createLocalModelGenerationAuthority = ({
  featureHost, offscreenUrl,
  clientsApi = /** @type {any} */ (globalThis).clients,
  newId = () => crypto.randomUUID(),
}) => {
  if (typeof featureHost?.runtime?.runWithLease !== 'function'
      || typeof offscreenUrl !== 'string' || !offscreenUrl
      || typeof clientsApi?.matchAll !== 'function') {
    throw new TypeError('local-model-generation-authority-config-invalid');
  }
  /** @type {Map<string,any>} */
  const streams = new Map();
  /** @type {WeakSet<object>} */
  const retiredOwners = new WeakSet();

  const finish = (/** @type {any} */ stream, /** @type {Error|null} */ error = null) => {
    if (stream.done) return;
    stream.done = true;
    stream.error = error;
    while (stream.waiters.length > 0) stream.waiters.shift()?.();
  };
  const retire = (/** @type {string} */ streamId) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    streams.delete(streamId);
    stream.signal?.removeEventListener('abort', stream.abort);
    try { stream.port?.close(); } catch {}
  };

  /** @param {any} request @param {object} owner @param {AbortSignal|undefined} signal */
  const open = async (request, owner, signal) => {
    const streamId = newId();
    if (retiredOwners.has(owner) || signal?.aborted) {
      throw localFailure('local-model-generation-aborted');
    }
    if (streams.has(streamId)) throw localFailure('local-model-stream-collision');
    /** @type {{owner:object,port:MessagePort|null,channelId:string|null,queue:string[],
     * waiters:Array<()=>void>,done:boolean,error:Error|null,chars:number,dispatched:boolean,
     * signal?:AbortSignal,abort?:()=>void}} */
    const stream = {
      owner, port: null, queue: [], waiters: [], done: false, error: null,
      channelId: null, chars: 0, dispatched: false,
      signal,
    };
    /** @type {(value:any)=>void} */ let settleReady = () => {};
    const ready = new Promise((resolve) => { settleReady = resolve; });
    stream.abort = () => {
      const error = localFailure('local-model-generation-aborted');
      if (stream.channelId) {
        try { stream.port?.postMessage({
          type: LOCAL_MODEL_CHANNEL_CANCEL,
          protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
          channelId: stream.channelId,
        }); } catch {}
      }
      settleReady({ ok: false, error });
      finish(stream, error);
    };
    signal?.addEventListener('abort', stream.abort, { once: true });
    streams.set(streamId, stream);
    const run = featureHost.runtime.runWithLease('model-host', async (lease) => {
      const matches = (await clientsApi.matchAll({ type: 'window', includeUncontrolled: true }))
        .filter((client) => client?.url === offscreenUrl);
      if (streams.get(streamId) !== stream || stream.done
          || retiredOwners.has(owner) || signal?.aborted) {
        throw localFailure('local-model-generation-aborted');
      }
      if (matches.length !== 1) throw localFailure(
        'local-model-host-unavailable', 'local model host unavailable',
      );
      const channelId = newId();
      stream.channelId = channelId;
      const offer = {
        type: LOCAL_MODEL_CHANNEL_OFFER,
        protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
        channelId,
        method: 'generate',
        args: request,
        lease,
      };
      if (!parseLocalModelChannelOffer(offer)) {
        throw localFailure('local-model-generation-invalid');
      }
      const { port1, port2 } = new MessageChannel();
      stream.port = port1;
      const completed = new Promise((resolve, reject) => {
        port1.onmessage = (event) => {
          const value = event.data;
          if (value?.protocol !== LOCAL_MODEL_CHANNEL_PROTOCOL
              || value.channelId !== channelId) return;
          if (value.type === LOCAL_MODEL_CHANNEL_CHUNK) {
            if (typeof value.token !== 'string' || value.token.length > MAX_TOKEN_CHARS
                || stream.chars + value.token.length > MAX_STREAM_CHARS) {
              reject(localFailure('local-model-response-limit-exceeded'));
              return;
            }
            stream.chars += value.token.length;
            stream.queue.push(value.token);
            stream.waiters.shift()?.();
            return;
          }
          if (value.type !== LOCAL_MODEL_CHANNEL_RESULT || typeof value.ok !== 'boolean') return;
          if (value.started === true && value.ok === true) {
            if (streams.get(streamId) !== stream || stream.done
                || retiredOwners.has(owner) || signal?.aborted) {
              reject(localFailure('local-model-generation-aborted'));
              return;
            }
            stream.dispatched = true;
            settleReady({ ok: true });
            return;
          }
          if (value.done !== true) return;
          if (value.ok === true) resolve(null);
          else reject(localFailure('local-model-generation-failed', value.error));
        };
        port1.onmessageerror = () => reject(localFailure('local-model-reply-invalid'));
        port1.start();
        try { matches[0].postMessage(offer, [port2]); }
        catch (cause) { reject(localFailure('local-model-dispatch-failed', cause)); }
      });
      return completed;
    }, { reason: 'local-model-generation' });
    run.then(
      () => { settleReady({ ok: true }); finish(stream); },
      (cause) => {
        const error = /** @type {Error} */ (cause instanceof Error
          ? cause : localFailure('local-model-generation-failed', cause));
        settleReady({ ok: false, error });
        finish(stream, error);
      },
    );
    const opened = await ready;
    if (opened?.ok !== true) {
      signal?.removeEventListener('abort', stream.abort);
      retire(streamId);
      throw opened?.error ?? localFailure('local-model-generation-failed');
    }
    if (streams.get(streamId) !== stream || stream.done
        || retiredOwners.has(owner) || signal?.aborted) {
      stream.abort();
      retire(streamId);
      throw localFailure('local-model-generation-aborted');
    }
    return streamId;
  };

  const read = async (/** @type {string} */ streamId, /** @type {object} */ owner) => {
    const stream = streams.get(streamId);
    if (!stream || stream.owner !== owner) throw localFailure('local-model-stream-invalid');
    while (stream.queue.length === 0 && !stream.done) {
      await new Promise((resolve) => stream.waiters.push(resolve));
    }
    if (stream.queue.length > 0) return { done: false, token: stream.queue.shift() };
    const error = stream.error;
    retire(streamId);
    if (error) throw error;
    return { done: true };
  };

  const cancel = async (/** @type {string} */ streamId, /** @type {object} */ owner) => {
    const stream = streams.get(streamId);
    if (!stream || stream.owner !== owner) throw localFailure('local-model-stream-invalid');
    stream.abort?.();
    retire(streamId);
  };

  return Object.freeze({
    open,
    read,
    cancel,
    closeOwner: async (/** @type {object} */ owner) => {
      retiredOwners.add(owner);
      for (const [streamId, stream] of streams) {
        if (stream.owner !== owner) continue;
        stream.abort?.();
        retire(streamId);
      }
    },
    activeStreams: () => streams.size,
  });
};
