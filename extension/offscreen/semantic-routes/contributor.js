// @ts-check
// Preview Contributor Metrics are formatted in the sealed host. The kernel
// exposes one read-only record and retains every storage/mutation capability.

import {
  contributorFeedbackTargets, contributorModelFamilyFromCode,
  contributorProviderFromCode, makeContributorStore,
} from '/peerd-runtime/controller-contributor.js';
import {
  CONTRIBUTOR_CHANNEL_CALL, contributorPayloadFits,
  CONTRIBUTOR_CHANNEL_PROTOCOL,
  CONTRIBUTOR_CHANNEL_REPLY, CONTRIBUTOR_CHANNEL_RESULT,
  parseContributorOffer,
} from '/shared/contributor-channel.js';

/** @param {string} route @param {any} _message
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options */
export const dispatchContributorSemanticRoute = async (route, _message, options) => {
  if (![
    'contributor/status', 'contributor/enable', 'contributor/disable',
    'contributor/settlement', 'contributor/feedback',
  ].includes(route)
      || typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'semantic-contributor-route-refused', outcomeKnown: true };
  }
  const kernelCall = options.kernelCall;
  const message = _message && typeof _message === 'object' && !Array.isArray(_message)
    ? _message : {};
  const recordStore = (/** @type {string} */ readOperation,
    /** @type {string} */ writeOperation) => {
    /** @type {any} */ let expected = null;
    /** @type {any} */ let failure = null;
    let writeRequested = false;
    const unwrap = (/** @type {any} */ result) => {
      if (result?.ok === true) return result.value;
      failure = result ?? { outcomeKnown: false };
      throw new Error('contributor-kernel-operation-failed');
    };
    return {
      store: makeContributorStore({ kv: {
        get: async () => {
          expected = unwrap(await kernelCall(readOperation, {})) ?? null;
          return expected;
        },
        set: async (_key, value) => {
          writeRequested = true;
          const action = unwrap(await kernelCall(writeOperation, { expected, value }));
          if (action?.ok !== true) {
            failure = { outcomeKnown: true };
            throw new Error('contributor-state-changed');
          }
          expected = value;
        },
        delete: async () => { throw new Error('contributor-record-delete-refused'); },
      } }),
      failure: () => failure ?? { outcomeKnown: !writeRequested },
    };
  };
  if (route === 'contributor/settlement') {
    const keys = [
      'version', 'consentGeneration', 'operationToken', 'feedbackContextToken', 'decision',
      'browser', 'extensionVersion', 'channel', 'providerCode', 'modelFamilyCode',
      'durationMs', 'tokens', 'outcome', 'failure', 'actions',
    ];
    if (Object.keys(message).sort().join('\0') !== keys.sort().join('\0')
        || message.version !== 1 || !message.decision || !Array.isArray(message.actions)) {
      return { ok: false, error: 'invalid-contributor-settlement', outcomeKnown: true };
    }
    const mutation = recordStore(
      'semantic.contributor.settlement-read', 'semantic.contributor.settlement-record',
    );
    try {
      const provider = contributorProviderFromCode(message.providerCode);
      const model = contributorModelFamilyFromCode(message.modelFamilyCode);
      if (!provider || !model) {
        return { ok: false, error: 'invalid-contributor-settlement', outcomeKnown: true,
          retryable: false };
      }
      const actions = message.actions.map((/** @type {any} */ action) => ({
          feature: 'web_actor_surface', ...message.decision,
          browser: message.browser, extensionVersion: message.extensionVersion,
          channel: message.channel, provider, model,
          action,
        }));
      const recorded = await mutation.store.recordWebSettlement({
        consentGeneration: message.consentGeneration,
        operationToken: message.operationToken,
        feedbackContextToken: message.feedbackContextToken,
        turn: {
          feature: 'web_actor_surface', ...message.decision,
          browser: message.browser, extensionVersion: message.extensionVersion,
          channel: message.channel, provider, model,
          outcome: message.outcome, failure: message.failure,
          durationMs: message.durationMs, tokens: message.tokens,
        },
        actions,
      });
      return { ok: true, recorded };
    } catch {
      const known = mutation.failure()?.outcomeKnown === true;
      return { ok: false, error: 'Contributor Metrics settlement could not be recorded.',
        outcomeKnown: known, retryable: known };
    }
  }
  if (route === 'contributor/feedback') {
    const keys = ['sessionId', 'messageId', 'verdict', 'messages'];
    if (Object.keys(message).sort().join('\0') !== keys.sort().join('\0')
        || typeof message.sessionId !== 'string' || typeof message.messageId !== 'string'
        || !['worked', 'didnt_work'].includes(message.verdict)
        || !Array.isArray(message.messages)) {
      return { ok: false, error: 'invalid-feedback-target', outcomeKnown: true };
    }
    const target = contributorFeedbackTargets(message.messages).get(message.messageId);
    if (!target) return { ok: false, error: 'invalid-feedback-target', outcomeKnown: true };
    const mutation = recordStore(
      'semantic.contributor.feedback-read', 'semantic.contributor.feedback-record',
    );
    try {
      const result = await mutation.store.recordFeedback({
        selectionKey: `${message.sessionId}:${target.humanMessageId}`,
        verdict: message.verdict,
        candidateContextKeys: target.toolUseIds.map((toolUseId) =>
          `${message.sessionId}:${toolUseId}`),
      });
      return { ok: true, ...result };
    } catch {
      const known = mutation.failure()?.outcomeKnown === true;
      return { ok: false, error: 'Contributor Metrics feedback could not be recorded.',
        outcomeKnown: known, retryable: known };
    }
  }
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
      if (operation.length > 128 || !contributorPayloadFits(payload ?? {})) {
        resolve({ ok: false, outcomeKnown: true }); return;
      }
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
        || packet.channelId !== offer.channelId || typeof packet.requestId !== 'string'
        || packet.requestId.length > 128
        || !contributorPayloadFits(packet.result ?? {})) {
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
  dispatchContributorSemanticRoute(offer.route, offer.message ?? {}, { kernelCall }).then(
    (result) => {
      if (!contributorPayloadFits(result ?? {})) {
        finish(); return;
      }
      try { port.postMessage({
        type: CONTRIBUTOR_CHANNEL_RESULT, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
        channelId: offer.channelId, result,
      }); } catch {}
      finish();
    }, finish,
  );
  return true;
};
