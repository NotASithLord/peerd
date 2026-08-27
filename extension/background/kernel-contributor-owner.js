// @ts-check

import {
  CONTRIBUTOR_CHANNEL_CALL, CONTRIBUTOR_CHANNEL_OFFER,
  CONTRIBUTOR_ACTION_KINDS, CONTRIBUTOR_BROWSERS, CONTRIBUTOR_CHANNELS,
  CONTRIBUTOR_CLASSIFICATION_CODE_MAX, CONTRIBUTOR_FAILURES, CONTRIBUTOR_FALLBACKS,
  CONTRIBUTOR_OUTCOMES, CONTRIBUTOR_SURFACES,
  CONTRIBUTOR_CHANNEL_PROTOCOL, CONTRIBUTOR_CHANNEL_REPLY,
  CONTRIBUTOR_CHANNEL_RESULT, contributorPayloadFits, opaqueContributorToken,
  parseContributorOffer, validContributorToken,
} from '../shared/contributor-channel.js';

export const CONTRIBUTOR_PENDING_RECEIPTS_KEY = 'contributor_metrics.pending.v1';
export const CONTRIBUTOR_PENDING_MAX_RECEIPTS = 64;
const CONTRIBUTOR_RECORD_KEY = 'contributor_metrics.aggregate.v1';
export const CONTRIBUTOR_ACTIVE_CONSENT_KEY = 'contributor_metrics.active.v1';
const CONTRIBUTOR_STORAGE_DEADLINE_MS = 750;
const CONTRIBUTOR_MAX_TEXT = 200;
const CONTRIBUTOR_MAX_ACTIONS = 128;
const CONTRIBUTOR_MAX_COUNTER = 1_000_000_000;
const exactKeys = (/** @type {unknown} */ value, /** @type {string[]} */ keys) =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const boundedText = (/** @type {unknown} */ value, nullable = false) => nullable && value == null
  ? null : typeof value === 'string' && value.length > 0 && value.length <= CONTRIBUTOR_MAX_TEXT
    ? value : undefined;
const armFromRecord = (/** @type {any} */ record) => {
  if (!exactKeys(record, ['version', 'consent', 'aggregate']) || record.version !== 1
      || !exactKeys(record.consent, [
        'enabled', 'schemaVersion', 'disclosureVersion', 'generation',
      ]) || record.consent.enabled !== true || record.consent.schemaVersion !== 1
      || record.consent.disclosureVersion !== 1
      || boundedText(record.consent.generation) === undefined
      || !record.aggregate || typeof record.aggregate !== 'object'
      || Array.isArray(record.aggregate)) {
    return Object.freeze({ enabled: false, generation: null });
  }
  return Object.freeze({ enabled: true, generation: record.consent.generation });
};
const normalizeSettlementInput = (/** @type {any} */ value) => {
  const keys = [
    'version', 'consentGeneration', 'operationKey', 'feedbackContextKey', 'decision',
    'browser', 'extensionVersion', 'channel', 'providerCode', 'modelFamilyCode', 'durationMs',
    'tokens', 'outcome', 'failure', 'actions',
  ];
  if (!exactKeys(value, keys) || value.version !== 1
      || boundedText(value.consentGeneration) === undefined
      || boundedText(value.operationKey) === undefined
      || boundedText(value.feedbackContextKey, true) === undefined
      || !exactKeys(value.decision, ['requested', 'resolved', 'fallback'])
      || !CONTRIBUTOR_SURFACES.includes(value.decision.requested)
      || !CONTRIBUTOR_SURFACES.includes(value.decision.resolved)
      || !CONTRIBUTOR_FALLBACKS.includes(value.decision.fallback)
      || !CONTRIBUTOR_BROWSERS.includes(value.browser)
      || typeof value.extensionVersion !== 'string'
      || !/^0\.[0-9]{1,4}\.[0-9]{1,4}$/.test(value.extensionVersion)
      || !CONTRIBUTOR_CHANNELS.includes(value.channel)
      || !Number.isSafeInteger(value.providerCode) || value.providerCode < 0
      || value.providerCode > CONTRIBUTOR_CLASSIFICATION_CODE_MAX
      || !Number.isSafeInteger(value.modelFamilyCode) || value.modelFamilyCode < 0
      || value.modelFamilyCode > CONTRIBUTOR_CLASSIFICATION_CODE_MAX
      || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0
      || value.durationMs > CONTRIBUTOR_MAX_COUNTER
      || !Number.isSafeInteger(value.tokens) || value.tokens < 0
      || value.tokens > CONTRIBUTOR_MAX_COUNTER
      || !CONTRIBUTOR_OUTCOMES.includes(value.outcome)
      || !CONTRIBUTOR_FAILURES.includes(value.failure)
      || !Array.isArray(value.actions) || value.actions.length > CONTRIBUTOR_MAX_ACTIONS
      || value.actions.some((/** @type {unknown} */ action) =>
        !CONTRIBUTOR_ACTION_KINDS.includes(/** @type {any} */ (action)))) return null;
  return Object.freeze({
    version: 1,
    consentGeneration: value.consentGeneration,
    operationKey: value.operationKey, feedbackContextKey: value.feedbackContextKey,
    decision: Object.freeze({ ...value.decision }),
    browser: value.browser,
    extensionVersion: value.extensionVersion,
    channel: value.channel,
    providerCode: value.providerCode,
    modelFamilyCode: value.modelFamilyCode,
    durationMs: value.durationMs,
    tokens: value.tokens,
    outcome: value.outcome,
    failure: value.failure,
    actions: Object.freeze([...value.actions]),
  });
};
const normalizePendingReceipt = (/** @type {any} */ value) => {
  const keys = [
    'version', 'consentGeneration', 'operationToken', 'feedbackContextToken', 'decision',
    'browser', 'extensionVersion', 'channel', 'providerCode', 'modelFamilyCode', 'durationMs',
    'tokens', 'outcome', 'failure', 'actions', 'attempts',
  ];
  if (!exactKeys(value, keys) || value.version !== 1
      || boundedText(value.consentGeneration) === undefined
      || !validContributorToken(value.operationToken, 'operation')
      || !(value.feedbackContextToken == null
        || validContributorToken(value.feedbackContextToken, 'context'))
      || !exactKeys(value.decision, ['requested', 'resolved', 'fallback'])
      || !CONTRIBUTOR_SURFACES.includes(value.decision.requested)
      || !CONTRIBUTOR_SURFACES.includes(value.decision.resolved)
      || !CONTRIBUTOR_FALLBACKS.includes(value.decision.fallback)
      || !CONTRIBUTOR_BROWSERS.includes(value.browser)
      || typeof value.extensionVersion !== 'string'
      || !/^0\.[0-9]{1,4}\.[0-9]{1,4}$/.test(value.extensionVersion)
      || !CONTRIBUTOR_CHANNELS.includes(value.channel)
      || !Number.isSafeInteger(value.providerCode) || value.providerCode < 0
      || value.providerCode > CONTRIBUTOR_CLASSIFICATION_CODE_MAX
      || !Number.isSafeInteger(value.modelFamilyCode) || value.modelFamilyCode < 0
      || value.modelFamilyCode > CONTRIBUTOR_CLASSIFICATION_CODE_MAX
      || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0
      || value.durationMs > CONTRIBUTOR_MAX_COUNTER
      || !Number.isSafeInteger(value.tokens) || value.tokens < 0
      || value.tokens > CONTRIBUTOR_MAX_COUNTER
      || !CONTRIBUTOR_OUTCOMES.includes(value.outcome)
      || !CONTRIBUTOR_FAILURES.includes(value.failure)
      || !Array.isArray(value.actions) || value.actions.length > CONTRIBUTOR_MAX_ACTIONS
      || value.actions.some((/** @type {unknown} */ action) =>
        !CONTRIBUTOR_ACTION_KINDS.includes(/** @type {any} */ (action)))
      || !Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > 2) return null;
  return Object.freeze({ ...value, decision: Object.freeze({ ...value.decision }),
    actions: Object.freeze([...value.actions]) });
};
const normalizePendingRecord = (/** @type {any} */ value) => {
  if (value == null) return Object.freeze({ version: 1, receipts: Object.freeze([]) });
  if (!exactKeys(value, ['version', 'receipts']) || value.version !== 1
      || !Array.isArray(value.receipts)
      || value.receipts.length > CONTRIBUTOR_PENDING_MAX_RECEIPTS) return null;
  const receipts = value.receipts.map(normalizePendingReceipt);
  return receipts.every(Boolean)
    ? Object.freeze({ version: 1, receipts: Object.freeze(receipts) }) : null;
};

export const createPreviewContributorAuthority = (/** @type {any} */ {
  kv, storageDeadlineMs = CONTRIBUTOR_STORAGE_DEADLINE_MS,
}) => {
  if (!kv?.get || !kv?.set || !kv?.delete || !Number.isFinite(storageDeadlineMs)
      || storageDeadlineMs <= 0) {
    throw new TypeError('kernel-preview-contributor-config-invalid');
  }
  const storage = (/** @type {()=>Promise<any>} */ operation) => new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('contributor-storage-timeout'));
    }, storageDeadlineMs);
    Promise.resolve().then(operation).then((value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(value);
    }, (cause) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(cause);
    });
  });
  const get = (/** @type {string} */ key) => storage(() => kv.get(key));
  const set = (/** @type {string} */ key, /** @type {any} */ value) =>
    storage(() => kv.set(key, value));
  const remove = (/** @type {string} */ key) => storage(() => kv.delete(key));
  // why: browser storage has no cancellation primitive. Once revocation is
  // requested, an already-started late write must remain invisible even if
  // the bounded wrapper has returned before the underlying promise settles.
  let locallyRevoked = false;
  const activeGeneration = async () => {
    if (locallyRevoked) return null;
    const value = await get(CONTRIBUTOR_ACTIVE_CONSENT_KEY);
    return exactKeys(value, ['version', 'generation']) && value.version === 1
      && boundedText(value.generation) !== undefined ? value.generation : null;
  };
  const readActiveRecord = async () => {
    const generation = await activeGeneration();
    if (!generation) {
      await remove(CONTRIBUTOR_RECORD_KEY).catch(() => {});
      return null;
    }
    const record = await get(CONTRIBUTOR_RECORD_KEY);
    return armFromRecord(record).generation === generation ? record : null;
  };
  let tail = Promise.resolve();
  const effect = (/** @type {()=>Promise<any>} */ run) => {
    const task = tail.then(run, run);
    tail = task.then(() => {}, () => {});
    return task;
  };
  const routes = Object.freeze({
    read: 'contributor/status',
    'enable-read': 'contributor/enable',
    enable: 'contributor/enable',
    'disable-read': 'contributor/disable',
    clear: 'contributor/disable',
    'settlement-read': 'contributor/settlement',
    'settlement-record': 'contributor/settlement',
    'feedback-read': 'contributor/feedback',
    'feedback-record': 'contributor/feedback',
  });
  const handle = async (/** @type {string} */ op, /** @type {any} */ payload,
    /** @type {any} */ ctx) => {
    const kind = op.startsWith('semantic.contributor.') ? op.slice(21) : '';
    const route = routes[/** @type {keyof typeof routes} */ (kind)] ?? null;
    const surface = route === 'contributor/feedback' ? 'chat'
      : route === 'contributor/settlement' ? 'runtime'
        : 'options';
    const write = kind === 'enable' || kind === 'clear' || kind.endsWith('-record');
    if (!route || ctx?.authority?.target !== `semantic:${route}:${surface}`) return null;
    if (ctx.signal?.aborted || ctx.deadlineAt <= Date.now()) {
      return { ok: false, code: 'semantic-kernel-operation-expired', outcomeKnown: true };
    }
    const run = async () => {
      if (kind === 'read' || kind.endsWith('-read')) return readActiveRecord();
      if (kind === 'clear') {
        // why: this small marker is the revocation commit. Aggregate cleanup
        // may finish later, but no stale or late write can become observable.
        locallyRevoked = true;
        await remove(CONTRIBUTOR_ACTIVE_CONSENT_KEY);
        await remove(CONTRIBUTOR_RECORD_KEY).catch(() => {});
        return { ok: true };
      }
      if (kind.endsWith('-record')) {
        const current = await readActiveRecord();
        const expected = payload?.expected ?? null;
        const value = payload?.value;
        const exactRecordShape = value && typeof value === 'object' && !Array.isArray(value)
          && Object.keys(value).sort().join('\0') === ['aggregate', 'consent', 'version'].join('\0');
        const unchangedConsent = JSON.stringify(current?.consent ?? null)
          === JSON.stringify(value?.consent ?? null);
        if (JSON.stringify(current ?? null) !== JSON.stringify(expected)
            || !exactRecordShape || value.version !== 1 || !unchangedConsent
            || current?.consent?.enabled !== true) {
          return { ok: false, error: 'contributor-state-changed' };
        }
        await set(CONTRIBUTOR_RECORD_KEY, value);
        return { ok: true };
      }
      const current = await readActiveRecord();
      if (JSON.stringify(current ?? null) !== JSON.stringify(payload?.expected ?? null)) {
        return { ok: false, error: 'contributor-state-changed' };
      }
      const value = { version: 1,
        consent: { enabled: true, schemaVersion: 1, disclosureVersion: 1,
          generation: crypto.randomUUID() },
        aggregate: { version: 1, rows: {}, dedupe: [], contexts: {}, contextOrder: [],
          feedback: {}, feedbackOrder: [] } };
      await set(CONTRIBUTOR_RECORD_KEY, value);
      await set(CONTRIBUTOR_ACTIVE_CONSENT_KEY, {
        version: 1, generation: value.consent.generation,
      });
      locallyRevoked = false;
      return { ok: true, value };
    };
    try {
      const value = write ? await effect(run) : await run();
      return { ok: true, outcomeKnown: true, value };
    } catch {
      return { ok: false, code: 'semantic-contributor-operation-failed',
        outcomeKnown: !write };
    }
  };
  const arm = async () => {
    await tail;
    return armFromRecord(await readActiveRecord());
  };
  const pending = () => effect(async () => {
    const armSnapshot = armFromRecord(await readActiveRecord());
    const record = normalizePendingRecord(await get(CONTRIBUTOR_PENDING_RECEIPTS_KEY));
    if (!record) {
      await remove(CONTRIBUTOR_PENDING_RECEIPTS_KEY);
      return [];
    }
    const active = armSnapshot.enabled === true
      ? record.receipts.filter((/** @type {any} */ receipt) =>
        receipt.consentGeneration === armSnapshot.generation) : [];
    if (active.length !== record.receipts.length) {
      if (active.length === 0) await remove(CONTRIBUTOR_PENDING_RECEIPTS_KEY);
      else await set(CONTRIBUTOR_PENDING_RECEIPTS_KEY, { version: 1, receipts: active });
    }
    return active;
  });
  const appendPending = (/** @type {any} */ input) => effect(async () => {
    const settlement = normalizeSettlementInput(input);
    if (!settlement) return { ok: false, code: 'contributor-pending-receipt-invalid' };
    const armSnapshot = armFromRecord(await readActiveRecord());
    if (armSnapshot.enabled !== true || armSnapshot.generation !== settlement.consentGeneration) {
      return { ok: true, queued: false, reason: 'disabled' };
    }
    // why: the durable outbox must never contain a raw run/session/tool identifier.
    const operationToken = await opaqueContributorToken(
      'operation', settlement.consentGeneration, settlement.operationKey,
    );
    const feedbackContextToken = settlement.feedbackContextKey == null ? null
      : await opaqueContributorToken(
        'context', settlement.consentGeneration, settlement.feedbackContextKey,
      );
    const {
      operationKey: _operationKey, feedbackContextKey: _feedbackContextKey, ...durableFacts
    } = settlement;
    const receipt = normalizePendingReceipt({
      ...durableFacts, operationToken, feedbackContextToken, attempts: 0,
    });
    if (!receipt) return { ok: false, code: 'contributor-pending-receipt-invalid' };
    let current = normalizePendingRecord(await get(CONTRIBUTOR_PENDING_RECEIPTS_KEY));
    if (!current) {
      await remove(CONTRIBUTOR_PENDING_RECEIPTS_KEY);
      current = Object.freeze({ version: 1, receipts: Object.freeze([]) });
    }
    const existing = current.receipts.find((/** @type {any} */ item) =>
      item.operationToken === receipt.operationToken);
    if (existing) return { ok: true, queued: false, reason: 'duplicate' };
    if (current.receipts.length >= CONTRIBUTOR_PENDING_MAX_RECEIPTS) {
      return { ok: false, code: 'contributor-pending-receipts-full' };
    }
    await set(CONTRIBUTOR_PENDING_RECEIPTS_KEY, {
      version: 1, receipts: [...current.receipts, receipt],
    });
    return { ok: true, queued: true };
  });
  const removePending = (/** @type {string} */ operationToken) => effect(async () => {
    const current = normalizePendingRecord(await get(CONTRIBUTOR_PENDING_RECEIPTS_KEY));
    if (!current) throw new Error('contributor-pending-record-invalid');
    const receipts = current.receipts.filter((/** @type {any} */ item) =>
      item.operationToken !== operationToken);
    if (receipts.length === current.receipts.length) return false;
    if (receipts.length === 0) await remove(CONTRIBUTOR_PENDING_RECEIPTS_KEY);
    else await set(CONTRIBUTOR_PENDING_RECEIPTS_KEY, { version: 1, receipts });
    return true;
  });
  const notePendingFailure = (/** @type {string} */ operationToken) => effect(async () => {
    const current = normalizePendingRecord(await get(CONTRIBUTOR_PENDING_RECEIPTS_KEY));
    if (!current) throw new Error('contributor-pending-record-invalid');
    const index = current.receipts.findIndex((/** @type {any} */ receipt) =>
      receipt.operationToken === operationToken);
    if (index < 0) return { found: false, dropped: false };
    const receipt = current.receipts[index];
    if (receipt.attempts >= 1) {
      const receipts = current.receipts.filter((/** @type {any} */ _receipt,
        /** @type {number} */ receiptIndex) => receiptIndex !== index);
      if (receipts.length === 0) await remove(CONTRIBUTOR_PENDING_RECEIPTS_KEY);
      else await set(CONTRIBUTOR_PENDING_RECEIPTS_KEY, { version: 1, receipts });
      return { found: true, dropped: true };
    }
    const receipts = [...current.receipts];
    receipts[index] = { ...receipt, attempts: receipt.attempts + 1 };
    await set(CONTRIBUTOR_PENDING_RECEIPTS_KEY, { version: 1, receipts });
    return { found: true, dropped: false };
  });
  const clearPending = () => effect(() => remove(CONTRIBUTOR_PENDING_RECEIPTS_KEY));
  return Object.freeze({
    handle, arm, pending, appendPending, removePending, notePendingFailure, clearPending,
  });
};

export const createPreviewContributorRoutes = (/** @type {any} */ {
  kv, optionsUi, sidepanelUi, homeUi, validateFeedback, offscreenUrl, featureHost,
  dispatchSemanticRoute = null,
  scheduleDrain = (/** @type {()=>void} */ operation) => queueMicrotask(operation),
  channelDeadlineMs = 15_000,
  storageDeadlineMs = CONTRIBUTOR_STORAGE_DEADLINE_MS,
}) => {
  if (![optionsUi, sidepanelUi, homeUi, validateFeedback].every(
    (value) => typeof value === 'function') || typeof scheduleDrain !== 'function'
      || dispatchSemanticRoute !== null && typeof dispatchSemanticRoute !== 'function'
      || dispatchSemanticRoute === null && typeof offscreenUrl !== 'string'
      || !Number.isFinite(channelDeadlineMs)
      || channelDeadlineMs <= 0
      || !Number.isFinite(storageDeadlineMs) || storageDeadlineMs <= 0
      || dispatchSemanticRoute === null
        && typeof featureHost?.runtime?.runWithLease !== 'function') {
    throw new TypeError('kernel-preview-contributor-routes-invalid');
  }
  const authority = createPreviewContributorAuthority({ kv, storageDeadlineMs });
  let mutationTail = Promise.resolve();
  const mutate = (/** @type {()=>Promise<any>} */ operation) => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const allowed = Object.freeze({
    'contributor/status': Object.freeze({ 'semantic.contributor.read': 1 }),
    'contributor/enable': Object.freeze({
      'semantic.contributor.enable-read': 2, 'semantic.contributor.enable': 1,
    }),
    'contributor/disable': Object.freeze({
      'semantic.contributor.clear': 1, 'semantic.contributor.disable-read': 1,
    }),
    'contributor/settlement': Object.freeze({
      'semantic.contributor.settlement-read': 1,
      'semantic.contributor.settlement-record': 1,
    }),
    'contributor/feedback': Object.freeze({
      'semantic.contributor.feedback-read': 1,
      'semantic.contributor.feedback-record': 1,
    }),
  });
  const dispatch = async (/** @type {string} */ route,
    /** @type {any} */ message) => {
    if (!Object.hasOwn(allowed, route)) {
      return { ok: false, code: 'contributor-channel-admission-denied', outcomeKnown: true };
    }
    let entered = false;
    const surface = route === 'contributor/feedback' ? 'chat'
      : route === 'contributor/settlement' ? 'runtime'
        : 'options';
    if (dispatchSemanticRoute) {
      const counts = new Map();
      let effectDispatched = false;
      const deadlineAt = Date.now() + channelDeadlineMs;
      const kernelCall = async (/** @type {string} */ operation,
        /** @type {unknown} */ payload) => {
        const limits = /** @type {any} */ (allowed)[route];
        const used = counts.get(operation) ?? 0;
        if (used >= (limits[operation] ?? 0) || !contributorPayloadFits(payload ?? {})) {
          return { ok: false, code: 'contributor-channel-admission-denied', outcomeKnown: true };
        }
        counts.set(operation, used + 1);
        if (operation === 'semantic.contributor.enable'
            || operation === 'semantic.contributor.clear'
            || operation.endsWith('-record')) effectDispatched = true;
        return authority.handle(operation, payload, {
          authority: { target: `semantic:${route}:${surface}` },
          signal: { aborted: false }, deadlineAt,
        });
      };
      return new Promise((resolve) => {
        let settled = false;
        const finish = (/** @type {any} */ value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); resolve(value);
        };
        const timer = setTimeout(() => finish({
          ok: false, code: 'contributor-channel-lost', outcomeKnown: !effectDispatched,
          ...(effectDispatched ? { outcomeKind: 'unknown', retryable: false } : {}),
        }), channelDeadlineMs);
        Promise.resolve().then(() => dispatchSemanticRoute(
          route, message, { kernelCall },
        )).then(
          finish, () => finish({ ok: false, code: 'contributor-channel-lost',
            outcomeKnown: !effectDispatched }),
        );
      });
    }
    const result = await featureHost.runtime.runWithLease('controller', async (/** @type {any} */ lease) => {
      entered = true;
      const clients = await /** @type {any} */ (globalThis).clients?.matchAll?.({
        type: 'window', includeUncontrolled: true,
      }) ?? [];
      const exact = clients.filter((/** @type {any} */ client) => client?.url === offscreenUrl);
      if (exact.length !== 1) {
        return { ok: false, code: 'contributor-channel-host-unavailable', outcomeKnown: true };
      }
      const channelId = crypto.randomUUID();
      const offer = {
        type: CONTRIBUTOR_CHANNEL_OFFER, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
        channelId, route, lease, message,
      };
      if (!parseContributorOffer(offer)) {
        return { ok: false, code: 'contributor-channel-offer-invalid', outcomeKnown: true };
      }
      const { port1, port2 } = new MessageChannel();
      return new Promise((resolve) => {
        const deadlineAt = Date.now() + channelDeadlineMs;
        const counts = new Map();
        let effectDispatched = false;
        let settled = false;
        const finish = (/** @type {any} */ value) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          try { port1.close(); } catch {}
          resolve(value);
        };
        const lost = () => finish({
          ok: false, code: 'contributor-channel-lost',
          outcomeKnown: !effectDispatched,
          ...(effectDispatched ? { outcomeKind: 'unknown', retryable: false } : {}),
        });
        const timer = setTimeout(lost, channelDeadlineMs);
        port1.onmessage = (event) => {
          const packet = event.data;
          if (packet?.protocol !== CONTRIBUTOR_CHANNEL_PROTOCOL
              || packet.channelId !== channelId) { lost(); return; }
          if (packet.type === CONTRIBUTOR_CHANNEL_RESULT) {
            if (!contributorPayloadFits(packet.result ?? {})) { lost(); return; }
            finish(packet.result ?? { ok: false, outcomeKnown: effectDispatched ? false : true });
            return;
          }
          if (packet.type !== CONTRIBUTOR_CHANNEL_CALL
              || typeof packet.requestId !== 'string' || packet.requestId.length > 128
              || typeof packet.operation !== 'string' || packet.operation.length > 128
              || !contributorPayloadFits(packet.payload ?? {})) {
            lost(); return;
          }
          const limits = /** @type {any} */ (allowed)[route];
          const used = counts.get(packet.operation) ?? 0;
          if (used >= (limits[packet.operation] ?? 0)) { lost(); return; }
          counts.set(packet.operation, used + 1);
          if (packet.operation === 'semantic.contributor.enable'
              || packet.operation === 'semantic.contributor.clear'
              || packet.operation.endsWith('-record')) effectDispatched = true;
          Promise.resolve(authority.handle(packet.operation, packet.payload, {
            authority: { target: `semantic:${route}:${surface}` },
            signal: { aborted: false }, deadlineAt,
          })).then((value) => {
            try { port1.postMessage({
              type: CONTRIBUTOR_CHANNEL_REPLY, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
              channelId, requestId: packet.requestId,
              result: value ?? { ok: false, outcomeKnown: true },
            }); } catch { lost(); }
          }, lost);
        };
        port1.onmessageerror = lost;
        port1.addEventListener?.('close', lost, { once: true });
        port1.start();
        try { exact[0].postMessage(offer, [port2]); } catch { lost(); }
      });
    }, { reason: 'preview-contributor-demand' });
    return entered ? result
      : { ok: false, code: 'contributor-channel-host-unavailable', outcomeKnown: true };
  };
  const optionsRoute = (/** @type {string} */ route) => (
    /** @type {any} */ message, /** @type {any} */ sender,
  ) => {
    if (message?.type !== route || !optionsUi(sender)) {
      return { ok: false, code: 'contributor-channel-admission-denied', outcomeKnown: true };
    }
    if (route === 'contributor/status') return dispatch(route, {});
    return mutate(async () => {
      const result = await dispatch(route, {});
      if (route === 'contributor/disable' && result?.ok === true) {
        // why: aggregate deletion is the revocation commit; cleanup is best-effort and
        // stale receipts are independently hidden and deleted by pending().
        await authority.clearPending().catch(() => {});
        requestDrain();
      }
      return result;
    });
  };
  let drainTail = Promise.resolve(/** @type {any} */ ({ ok: true, drained: 0 }));
  const drainPending = () => {
    const attempt = drainTail.then(async () => {
      let drained = 0;
      for (let index = 0; index < CONTRIBUTOR_PENDING_MAX_RECEIPTS; index += 1) {
        const receipt = (await authority.pending())[0];
        if (!receipt) return { ok: true, drained };
        const { attempts: _attempts, ...settlement } = receipt;
        const result = await mutate(() => dispatch('contributor/settlement', settlement));
        if (result?.ok !== true) {
          if (result?.outcomeKnown !== true) return { ...result, drained };
          const failure = await authority.notePendingFailure(receipt.operationToken);
          if (failure.dropped) { drained += 1; continue; }
          continue;
        }
        await authority.removePending(receipt.operationToken);
        drained += 1;
      }
      return (await authority.pending()).length === 0
        ? { ok: true, drained }
        : { ok: false, code: 'contributor-pending-drain-limit', drained };
    });
    const task = attempt.catch(() => ({
      ok: false, code: 'contributor-pending-drain-failed', drained: 0,
    }));
    drainTail = task;
    return task;
  };
  let drainScheduled = false;
  let drainAgain = false;
  const requestDrain = () => {
    if (drainScheduled) { drainAgain = true; return; }
    drainScheduled = true;
    let lastDrainOk = false;
    try {
      scheduleDrain(() => {
        void (async () => {
          let result;
          do {
            drainAgain = false;
            result = await drainPending();
            lastDrainOk = result?.ok === true;
          } while (lastDrainOk && drainAgain);
        })().finally(() => {
          const retry = lastDrainOk && drainAgain;
          drainScheduled = false;
          if (retry) requestDrain();
        });
      });
    } catch { drainScheduled = false; }
  };
  const routes = Object.freeze({
    'contributor/status': optionsRoute('contributor/status'),
    'contributor/enable': optionsRoute('contributor/enable'),
    'contributor/disable': optionsRoute('contributor/disable'),
    'contributor/feedback': async (/** @type {any} */ message = {},
      /** @type {any} */ sender = undefined) => {
      if (message?.type !== 'contributor/feedback'
          || !sidepanelUi(sender) && !homeUi(sender)) {
        return { ok: false, error: 'trusted-chat-sender-required', outcomeKnown: true };
      }
      if (!['worked', 'didnt_work'].includes(message.verdict)) {
        return { ok: false, error: 'invalid-feedback', outcomeKnown: true };
      }
      if (boundedText(message.sessionId) === undefined
          || boundedText(message.messageId) === undefined) {
        return { ok: false, error: 'invalid-feedback-target', outcomeKnown: true };
      }
      const guarded = await validateFeedback(message);
      if (guarded?.ok !== true || !Array.isArray(guarded.messages)) return guarded;
      const drained = await drainPending();
      if (drained?.ok !== true) {
        return { ok: false, error: 'Contributor Metrics settlement is still pending.',
          outcomeKnown: true, retryable: true };
      }
      return mutate(() => dispatch('contributor/feedback', {
        sessionId: message.sessionId, messageId: message.messageId,
        verdict: message.verdict, messages: guarded.messages,
      }));
    },
  });
  const owner = Object.freeze({
    routes,
    arm: () => authority.arm(),
    recordWebSettlement: async (/** @type {any} */ message) => {
      const result = await new Promise((resolve) => {
        let settled = false;
        const finish = (/** @type {any} */ value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); resolve(value);
        };
        const timer = setTimeout(() => finish({
          ok: false, code: 'contributor-settlement-timeout', outcomeKnown: false,
        }), storageDeadlineMs);
        authority.appendPending(message).then(finish, () => finish({
          ok: false, code: 'contributor-settlement-failed', outcomeKnown: false,
        }));
      });
      if (result?.ok === true && result.queued === true) requestDrain();
      return result;
    },
    drainPending,
    pending: () => authority.pending(),
  });
  requestDrain();
  return owner;
};
