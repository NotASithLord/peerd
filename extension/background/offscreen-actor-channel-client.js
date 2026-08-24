// @ts-check
// Targeted Chrome transport for isolated actor runs.
//
// why not runtime.connect: Chrome permits one Port to have multiple receivers.
// The service worker instead finds the exact offscreen WindowClient and
// transfers one standard MessageChannel endpoint directly to that document.

// Kept local so the authority kernel does not link a constants-only module.
// The offscreen host imports the shared wire constants independently.
const ACTOR_CHANNEL_PROTOCOL = 1;
const ACTOR_CHANNEL_OFFER = 'peerd/actor-channel';

export { makeSemanticControllerClient } from './offscreen-controller-client.js';

export class ActorChannelError extends Error {
  /** @param {string} message @param {string} code @param {{ cause?: unknown }} [options] */
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'ActorChannelError';
    this.code = code;
  }
}

const abortedResult = () => ({
  ok: false, started: false, phase: 'startup', code: 'actor_run_aborted',
  error: 'actor run aborted', aborted: true, outcomeKnown: true,
});

/** A structured failure that is safe to retry because no actor work began. */
export const isKnownActorStartupFailure = (/** @type {any} */ value) => value?.started === false
  && value?.phase === 'startup' && value?.outcomeKnown === true;

/**
 * Fail closed when the exact offscreen recipient is absent or ambiguous.
 * @template {{ url?: string }} T
 * @param {T[]} candidates
 * @param {string} expectedUrl
 * @returns {T | null}
 */
export const selectExactActorHostClient = (
  candidates,
  expectedUrl,
) => {
  const exact = candidates.filter((client) => client.url === expectedUrl);
  return exact.length === 1 ? exact[0] : null;
};

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen
 * @param {() => Promise<{ postMessage: (message: any, transfer: Transferable[]) => void } | null>} deps.findOffscreenClient
 * @param {() => MessageChannel} [deps.createChannel]
 * @param {() => string} [deps.newChannelId]
 * @param {number} [deps.handshakeTimeoutMs]
 * @param {number} [deps.abortTimeoutMs]
 * @param {number} [deps.maxLoopEventsPerRun]
 * @param {number} [deps.maxEffectRelaysPerRun]
 * @param {(job: any) => number} [deps.runTimeoutMsFor]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const makeOffscreenActorChannelClient = ({
  ensureOffscreen,
  findOffscreenClient,
  createChannel = () => new MessageChannel(),
  newChannelId = () => crypto.randomUUID(),
  handshakeTimeoutMs = 10_000,
  abortTimeoutMs = 5_000,
  maxLoopEventsPerRun = 256,
  maxEffectRelaysPerRun = 228,
  runTimeoutMsFor = (job) => Number.isFinite(job?.budgetMs) && job.budgetMs > 0
    ? job.budgetMs + abortTimeoutMs
    : 30 * 60_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  /**
   * @param {any} job
   * @param {{ signal?: AbortSignal, lease:any,
   *   relay: (type: string, payload: any) => any|Promise<any> }} options
   */
  const run = async (job, { signal, lease, relay }) => {
    if (signal?.aborted) return abortedResult();
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)) return {
      ok: false, started: false, phase: 'startup', code: 'actor_lease_invalid',
      error: 'actor host lease is invalid', outcomeKnown: true,
    };
    try { await ensureOffscreen(); }
    catch (cause) {
      return {
        ok: false, started: false, phase: 'startup', code: 'actor_host_unavailable',
        error: `actor host unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        outcomeKnown: true,
      };
    }
    if (signal?.aborted) return abortedResult();
    const target = await findOffscreenClient().catch(() => null);
    if (!target) return {
      ok: false, started: false, phase: 'startup', code: 'actor_host_not_ready',
      error: 'actor host is not available', outcomeKnown: true,
    };

    const channelId = newChannelId();
    const { port1, port2 } = createChannel();
    /** @type {Map<string, Promise<any>>} */
    const relayReplies = new Map();
    const loopEventLimit = Number.isFinite(maxLoopEventsPerRun) && maxLoopEventsPerRun > 0
      ? Math.floor(maxLoopEventsPerRun) : 256;
    const effectRelayLimit = Number.isFinite(maxEffectRelaysPerRun) && maxEffectRelaysPerRun > 0
      ? Math.floor(maxEffectRelaysPerRun) : 228;
    let loopEvents = 0;
    let effectRelays = 0;
    let state = /** @type {'offered'|'ready'|'opened'|'accepted'|'committed'|'settled'} */ ('offered');
    let settle = (/** @type {any} */ _value) => {};
    let handshakeTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
    let abortTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
    let runTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

    const result = new Promise((resolve) => { settle = resolve; });
    const finish = (/** @type {any} */ value) => {
      if (state === 'settled') return;
      state = 'settled';
      if (handshakeTimer) clearTimeoutFn(handshakeTimer);
      if (abortTimer) clearTimeoutFn(abortTimer);
      if (runTimer) clearTimeoutFn(runTimer);
      signal?.removeEventListener('abort', onAbort);
      relayReplies.clear();
      try { port1.close(); } catch { /* already closed */ }
      settle(value);
    };
    const armHandshakeTimeout = (/** @type {string} */ phase) => {
      if (handshakeTimer) clearTimeoutFn(handshakeTimer);
      handshakeTimer = setTimeoutFn(() => finish({
        ok: false,
        started: state === 'committed',
        phase: state === 'committed' ? 'run' : 'startup',
        code: state === 'committed' ? 'actor_channel_lost' : `actor_channel_${phase}_timeout`,
        error: `actor channel ${phase} timed out`,
        outcomeKnown: state !== 'committed',
      }), handshakeTimeoutMs);
    };
    const post = (/** @type {Record<string, any>} */ message) => port1.postMessage({
      protocol: ACTOR_CHANNEL_PROTOCOL, channelId, ...message,
    });
    const onAbort = () => {
      if (state === 'settled') return;
      if (state !== 'committed') {
        try { post({ type: 'actor/abort' }); } catch { /* not started */ }
        finish(abortedResult());
        return;
      }
      try { post({ type: 'actor/abort' }); } catch { /* watchdog settles */ }
      abortTimer = setTimeoutFn(() => finish({
        ok: false, started: true, phase: 'run', code: 'actor_abort_unacknowledged',
        error: 'actor host did not acknowledge cancellation', aborted: true,
        outcomeKnown: false,
      }), abortTimeoutMs);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    port1.onmessage = (event) => {
      const message = event.data;
      if (!message || message.protocol !== ACTOR_CHANNEL_PROTOCOL
          || message.channelId !== channelId || state === 'settled') return;
      if (message.type === 'channel/ready' && state === 'offered') {
        state = 'ready';
        if (signal?.aborted) { onAbort(); return; }
        post({ type: 'actor/open', job });
        state = 'opened';
        armHandshakeTimeout('accept');
        return;
      }
      if (message.type === 'actor/accepted' && state === 'opened') {
        state = 'accepted';
        if (signal?.aborted) { onAbort(); return; }
        post({ type: 'actor/commit' });
        state = 'committed';
        if (handshakeTimer) { clearTimeoutFn(handshakeTimer); handshakeTimer = null; }
        runTimer = setTimeoutFn(() => {
          try { post({ type: 'actor/abort' }); } catch { /* host is gone */ }
          finish({
            ok: false, started: true, phase: 'run', code: 'actor_channel_run_timeout',
            error: 'actor channel exceeded its run budget', outcomeKnown: false,
          });
        }, Math.max(1, runTimeoutMsFor(job)));
        return;
      }
      if (message.type === 'actor/result' && state === 'committed') {
        finish(message.result ?? {
          ok: false, started: true, error: 'actor host returned no result', outcomeKnown: false,
        });
        return;
      }
      if (message.type !== 'actor/relay' || state !== 'committed'
          || typeof message.requestId !== 'string'
          || typeof message.relayType !== 'string') return;
      const readOnlyEvent = message.relayType === 'actor/loop-event';
      // A duplicate request shares the first dispatch promise. Even though the
      // MessageChannel is private, transport retries must never repeat a tool.
      let pending = relayReplies.get(message.requestId);
      if (!pending) {
        if (readOnlyEvent && loopEvents >= loopEventLimit) {
          try {
            post({
              type: 'actor/relay-response', requestId: message.requestId,
              result: { ok: true, coalesced: true },
            });
          } catch { /* run timeout owns settlement */ }
          return;
        }
        if (!readOnlyEvent && effectRelays >= effectRelayLimit) {
          try {
            post({
              type: 'actor/relay-response', requestId: message.requestId,
              result: {
                ok: false, code: 'actor_relay_limit',
                error: 'actor relay budget exhausted', outcomeKnown: true, performed: false,
              },
            });
          } catch { /* run timeout owns settlement */ }
          return;
        }
        if (readOnlyEvent) loopEvents += 1;
        else effectRelays += 1;
        pending = Promise.resolve(relay(message.relayType, message.payload ?? {}))
          .catch((cause) => {
            const detail = /** @type {{code?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
            const outcomeKnown = detail?.outcomeKnown === true;
            return {
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause),
              ...(typeof detail?.code === 'string' ? { code: detail.code } : {}),
              outcomeKnown,
              ...(outcomeKnown ? {} : { retryable: false }),
            };
          });
        relayReplies.set(message.requestId, pending);
      }
      pending.then((reply) => {
        if (readOnlyEvent && relayReplies.get(message.requestId) === pending) {
          relayReplies.delete(message.requestId);
        }
        if (state !== 'committed') return;
        try { post({ type: 'actor/relay-response', requestId: message.requestId, result: reply }); }
        catch { /* run timeout or restart owns settlement */ }
      });
    };
    port1.onmessageerror = () => finish({
      ok: false, started: state === 'committed',
      phase: state === 'committed' ? 'run' : 'startup',
      code: 'actor_channel_message_error', error: 'actor channel received an invalid message',
      outcomeKnown: state !== 'committed',
    });
    port1.addEventListener('close', () => finish({
      ok: false, started: state === 'committed',
      phase: state === 'committed' ? 'run' : 'startup',
      code: 'actor_channel_closed', error: 'actor channel closed before settlement',
      outcomeKnown: state !== 'committed',
    }), { once: true });
    try {
      target.postMessage({
        type: ACTOR_CHANNEL_OFFER, protocol: ACTOR_CHANNEL_PROTOCOL, channelId, lease,
      }, [port2]);
      port1.start();
      armHandshakeTimeout('ready');
    } catch (cause) {
      finish({
        ok: false, started: false, phase: 'startup', code: 'actor_channel_offer_failed',
        error: `actor channel could not be offered: ${cause instanceof Error ? cause.message : String(cause)}`,
        outcomeKnown: true,
      });
    }
    if (signal?.aborted) onAbort();
    return result;
  };

  return { run };
};
