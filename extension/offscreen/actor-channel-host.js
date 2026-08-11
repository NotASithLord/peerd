// @ts-check
// Offscreen half of the targeted actor MessageChannel transport.

import { ACTOR_CHANNEL_PROTOCOL } from '/shared/actor-channel-protocol.js';

/**
 * @param {Object} deps
 * @param {MessagePort} deps.port
 * @param {string} deps.channelId
 * @param {(job: any, deps: { workerUrl: string, sendToSW: (type: string, payload: object) => Promise<any> }) => Promise<any>} deps.run
 * @param {(runId: string) => void} deps.abort
 * @param {string} deps.workerUrl
 */
export const bindActorChannel = ({ port, channelId, run, abort, workerUrl }) => {
  /** @type {Map<string, { resolve: (value: any) => void, reject: (reason: any) => void }>} */
  const pendingRelays = new Map();
  let job = /** @type {any} */ (null);
  let runId = '';
  let committed = false;
  let completed = false;
  let abortRequested = false;
  let relaySequence = 0;
  const post = (/** @type {Record<string, any>} */ message) => port.postMessage({
    protocol: ACTOR_CHANNEL_PROTOCOL, channelId, ...message,
  });
  const sendToSW = (/** @type {string} */ type, /** @type {object} */ payload) => new Promise((resolve, reject) => {
    if (!committed || completed) { reject(new Error('actor channel is not active')); return; }
    const requestId = `relay-${++relaySequence}`;
    pendingRelays.set(requestId, { resolve, reject });
    try { post({ type: 'actor/relay', requestId, relayType: type, payload }); }
    catch (cause) { pendingRelays.delete(requestId); reject(cause); }
  });
  port.onmessage = (event) => {
    const message = event.data;
    if (!message || message.protocol !== ACTOR_CHANNEL_PROTOCOL
        || message.channelId !== channelId || completed) return;
    if (message.type === 'actor/relay-response'
        && typeof message.requestId === 'string' && committed) {
      const pending = pendingRelays.get(message.requestId);
      if (!pending) return;
      pendingRelays.delete(message.requestId);
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'actor/abort') {
      abortRequested = true;
      if (runId) abort(runId);
      if (!committed) {
        completed = true;
        job = null;
        try { port.close(); } catch { /* already closed */ }
      }
      return;
    }
    if (message.type === 'actor/open' && !job && !committed && message.job) {
      job = message.job;
      runId = typeof job.runId === 'string' ? job.runId : '';
      post({ type: 'actor/accepted' });
      return;
    }
    if (message.type !== 'actor/commit' || !job || committed) return;
    committed = true;
    if (abortRequested && runId) abort(runId);
    run(job, { workerUrl, sendToSW })
      .then((result) => {
        completed = true;
        try { post({ type: 'actor/result', result }); } catch { /* SW restarted */ }
      })
      .catch((cause) => {
        completed = true;
        try {
          post({
            type: 'actor/result',
            result: {
              ok: false, started: true, outcomeKnown: false,
              error: cause instanceof Error ? cause.message : String(cause),
            },
          });
        } catch { /* SW restarted */ }
      })
      .finally(() => {
        for (const pending of pendingRelays.values()) {
          pending.reject(new Error('actor channel settled'));
        }
        pendingRelays.clear();
      });
  };
  port.onmessageerror = () => {
    if (runId && committed && !completed) abort(runId);
    for (const pending of pendingRelays.values()) pending.reject(new Error('actor channel message error'));
    pendingRelays.clear();
  };
  port.addEventListener('close', () => {
    if (runId && committed && !completed) abort(runId);
    for (const pending of pendingRelays.values()) pending.reject(new Error('actor channel closed'));
    pendingRelays.clear();
  }, { once: true });
  port.start();
  post({ type: 'channel/ready' });
};
