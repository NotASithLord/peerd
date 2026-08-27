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
export const CONTRIBUTOR_PENDING_RECEIPT_PREFIX = 'contributor_metrics.receipt.v2.';
export const CONTRIBUTOR_PENDING_DROP_PREFIX = 'contributor_metrics.receipt_drop.v2.';
const CONTRIBUTOR_RECORD_KEY = 'contributor_metrics.aggregate.v1';
export const CONTRIBUTOR_ACTIVE_CONSENT_KEY = 'contributor_metrics.active.v1';
export const CONTRIBUTOR_STATE_PREFIX = 'contributor_metrics.state.v2.';
const CONTRIBUTOR_STORAGE_DEADLINE_MS = 750;
const CONTRIBUTOR_MAX_STATE_SNAPSHOTS = 128;
const CONTRIBUTOR_REVISION_SCALE = 1024;
const CONTRIBUTOR_MAX_REVISION = 8_000_000_000_000_000;
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
    'tokens', 'outcome', 'failure', 'actions', 'attempts', 'sequence',
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
      || !Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > 2
      || !Number.isSafeInteger(value.sequence) || value.sequence <= 0
      || value.sequence > CONTRIBUTOR_MAX_REVISION) return null;
  return Object.freeze({ ...value, decision: Object.freeze({ ...value.decision }),
    actions: Object.freeze([...value.actions]) });
};
export const createPreviewContributorAuthority = (/** @type {any} */ {
  kv, storageDeadlineMs = CONTRIBUTOR_STORAGE_DEADLINE_MS,
  now = () => Date.now(), makeId = () => crypto.randomUUID(),
}) => {
  if (!kv?.get || !kv?.set || !kv?.delete || !kv?.list
      || !Number.isFinite(storageDeadlineMs) || storageDeadlineMs <= 0
      || typeof now !== 'function' || typeof makeId !== 'function') {
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
  const list = (/** @type {string} */ prefix) => storage(() => kv.list(prefix));
  // why: browser storage has no cancellation primitive. Once revocation is
  // requested, an already-started late write must remain invisible even if
  // the bounded wrapper has returned before the underlying promise settles.
  let locallyRevoked = false;
  let lastIssuedRevision = 0;
  const stateSnapshot = (/** @type {unknown} */ value) => {
    const candidate = /** @type {any} */ (value);
    if (!exactKeys(candidate, ['version', 'revision', 'state', 'record', 'committed'])
        || candidate.version !== 2 || !Number.isSafeInteger(candidate.revision)
        || candidate.revision <= 0 || candidate.revision > CONTRIBUTOR_MAX_REVISION
        || typeof candidate.committed !== 'boolean'
        || !['active', 'revoked'].includes(candidate.state)
        || candidate.state === 'revoked' && candidate.record !== null
        || candidate.state === 'active' && armFromRecord(candidate.record).enabled !== true) {
      return null;
    }
    return Object.freeze({ ...candidate });
  };
  const readLatestState = async () => {
    const entries = await list(CONTRIBUTOR_STATE_PREFIX);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)
        || Object.keys(entries).length > CONTRIBUTOR_MAX_STATE_SNAPSHOTS) {
      throw new Error('contributor-state-snapshots-invalid');
    }
    /** @type {{key:string,value:any}|null} */ let latest = null;
    for (const [key, value] of Object.entries(entries)) {
      if (!key.startsWith(CONTRIBUTOR_STATE_PREFIX)) continue;
      const normalized = stateSnapshot(value);
      if (!normalized) throw new Error('contributor-state-snapshot-invalid');
      // why: a proposal is durable before its commit write can begin. A
      // successor observes every proposal's ceiling, while a first-write
      // timeout can land late only as an inert uncommitted proposal.
      lastIssuedRevision = Math.max(lastIssuedRevision, normalized.revision);
      if (normalized.committed && (!latest || normalized.revision > latest.value.revision
          || normalized.revision === latest.value.revision && key > latest.key)) {
        latest = { key, value: normalized };
      }
    }
    return latest;
  };
  const observeRevisionCeiling = async () => {
    const entries = await list(CONTRIBUTOR_STATE_PREFIX);
    for (const value of Object.values(entries ?? {})) {
      const revision = /** @type {any} */ (value)?.revision;
      if (Number.isSafeInteger(revision) && revision > 0
          && revision <= CONTRIBUTOR_MAX_REVISION) {
        lastIssuedRevision = Math.max(lastIssuedRevision, revision);
      }
    }
  };
  const legacyRecord = async () => {
    const marker = await get(CONTRIBUTOR_ACTIVE_CONSENT_KEY);
    if (!exactKeys(marker, ['version', 'generation']) || marker.version !== 1
        || boundedText(marker.generation) === undefined) return null;
    const record = await get(CONTRIBUTOR_RECORD_KEY);
    return armFromRecord(record).generation === marker.generation ? record : null;
  };
  const readActiveRecord = async () => {
    if (locallyRevoked) return null;
    const latest = await readLatestState();
    if (latest) return latest.value.state === 'active' ? latest.value.record : null;
    return legacyRecord();
  };
  const issueRevision = () => {
    const wall = Math.max(1, Math.floor(Number(now()))) * CONTRIBUTOR_REVISION_SCALE;
    const revision = Math.max(lastIssuedRevision + 1, wall);
    if (!Number.isSafeInteger(revision) || revision > CONTRIBUTOR_MAX_REVISION) {
      throw new Error('contributor-revision-invalid');
    }
    lastIssuedRevision = revision;
    return revision;
  };
  const cleanupBefore = async (/** @type {number} */ revision,
    /** @type {string} */ currentKey) => {
    const entries = await list(CONTRIBUTOR_STATE_PREFIX);
    await Promise.all(Object.entries(entries ?? {}).flatMap(([key, value]) => {
      const normalized = stateSnapshot(value);
      return key !== currentKey && (!normalized || normalized.revision < revision)
        ? [remove(key).catch(() => {})] : [];
    }));
    await Promise.all([
      remove(CONTRIBUTOR_RECORD_KEY).catch(() => {}),
      remove(CONTRIBUTOR_ACTIVE_CONSENT_KEY).catch(() => {}),
    ]);
  };
  const writeState = async (/** @type {any|null} */ record) => {
    const revision = issueRevision();
    const key = `${CONTRIBUTOR_STATE_PREFIX}${String(revision).padStart(16, '0')}-${makeId()}`;
    const proposal = Object.freeze({
      version: 2, revision, state: record ? 'active' : 'revoked', record,
      committed: false,
    });
    await set(key, proposal);
    const value = Object.freeze({ ...proposal, committed: true });
    await set(key, value);
    // why: every key is generation-unique and cleanup only targets older
    // revisions. A timed-out write/delete may finish late, but it can neither
    // replace nor delete a later acknowledged generation.
    void cleanupBefore(revision, key).catch(() => {});
    return value;
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
        // why: an append-only revocation snapshot is the commit. Old aggregate
        // cleanup may finish later without sharing a key with a future consent.
        locallyRevoked = true;
        // why: commit the fail-closed marker before any cleanup or recovery
        // read. If the clock moved backwards across a restart, observe the
        // durable ceiling afterward and synchronously append one newer marker
        // before acknowledging the user's revocation.
        const marker = await writeState(null);
        await observeRevisionCeiling();
        if (lastIssuedRevision > marker.revision) await writeState(null);
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
        await writeState(value);
        return { ok: true };
      }
      const current = await readActiveRecord();
      if (JSON.stringify(current ?? null) !== JSON.stringify(payload?.expected ?? null)) {
        return { ok: false, error: 'contributor-state-changed' };
      }
      const value = payload?.value;
      const nextArm = armFromRecord(value);
      if (nextArm.enabled !== true
          || nextArm.generation === armFromRecord(current).generation) {
        return { ok: false, error: 'contributor-state-changed' };
      }
      await readLatestState();
      await writeState(value);
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
  const pendingEntries = async () => {
    const receiptEntries = await list(CONTRIBUTOR_PENDING_RECEIPT_PREFIX);
    if (!receiptEntries || typeof receiptEntries !== 'object' || Array.isArray(receiptEntries)
        || Object.keys(receiptEntries).length > CONTRIBUTOR_PENDING_MAX_RECEIPTS) {
      throw new Error('contributor-pending-record-invalid');
    }
    const receipts = Object.entries(receiptEntries).map(([key, value]) => {
      const receipt = normalizePendingReceipt(value);
      return receipt && key === `${CONTRIBUTOR_PENDING_RECEIPT_PREFIX}${receipt.operationToken}`
        ? receipt : null;
    });
    if (receipts.some((receipt) => !receipt)) {
      throw new Error('contributor-pending-record-invalid');
    }
    const normalized = /** @type {any[]} */ (receipts);
    for (const receipt of normalized) {
      lastIssuedRevision = Math.max(lastIssuedRevision, receipt.sequence);
    }
    return normalized.sort((left, right) => left.sequence - right.sequence
      || left.operationToken.localeCompare(right.operationToken));
  };
  const pendingDrops = async () => {
    const entries = await list(CONTRIBUTOR_PENDING_DROP_PREFIX);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)
        || Object.keys(entries).length > CONTRIBUTOR_PENDING_MAX_RECEIPTS) {
      throw new Error('contributor-pending-drops-invalid');
    }
    const tokens = Object.entries(entries).map(([key, value]) => {
      const token = value?.operationToken;
      return exactKeys(value, ['version', 'operationToken']) && value.version === 1
        && validContributorToken(token, 'operation')
        && key === `${CONTRIBUTOR_PENDING_DROP_PREFIX}${token}` ? token : null;
    });
    if (tokens.some((token) => !token)) throw new Error('contributor-pending-drops-invalid');
    return /** @type {string[]} */ (tokens);
  };
  const pending = () => effect(async () => {
    const activeRecord = await readActiveRecord();
    const armSnapshot = armFromRecord(activeRecord);
    const [receipts, dropTokens] = await Promise.all([pendingEntries(), pendingDrops()]);
    const dropped = new Set(dropTokens);
    const settled = new Set(Array.isArray(activeRecord?.aggregate?.dedupe)
      ? activeRecord.aggregate.dedupe : []);
    const active = armSnapshot.enabled === true
      ? receipts.filter((/** @type {any} */ receipt) =>
        receipt.consentGeneration === armSnapshot.generation
          && !settled.has(receipt.operationToken)
          && !dropped.has(receipt.operationToken)) : [];
    const keep = new Set(active.map((receipt) => receipt.operationToken));
    await Promise.all(receipts.flatMap((receipt) => !keep.has(receipt.operationToken)
      ? [remove(`${CONTRIBUTOR_PENDING_RECEIPT_PREFIX}${receipt.operationToken}`).catch(() => {})]
      : []));
    await remove(CONTRIBUTOR_PENDING_RECEIPTS_KEY).catch(() => {});
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
    const [current, dropTokens] = await Promise.all([pendingEntries(), pendingDrops()]);
    if (current.some((/** @type {any} */ item) => item.operationToken === operationToken)
        || dropTokens.includes(operationToken)) {
      return { ok: true, queued: false, reason: 'duplicate' };
    }
    if (current.length + dropTokens.length >= CONTRIBUTOR_PENDING_MAX_RECEIPTS) {
      return { ok: false, code: 'contributor-pending-receipts-full' };
    }
    const receipt = normalizePendingReceipt({
      ...durableFacts, operationToken, feedbackContextToken,
      attempts: 0, sequence: issueRevision(),
    });
    if (!receipt) return { ok: false, code: 'contributor-pending-receipt-invalid' };
    await set(`${CONTRIBUTOR_PENDING_RECEIPT_PREFIX}${receipt.operationToken}`, receipt);
    return { ok: true, queued: true };
  });
  const removePending = (/** @type {string} */ operationToken) => effect(async () => {
    if (!validContributorToken(operationToken, 'operation')) return false;
    const key = `${CONTRIBUTOR_PENDING_RECEIPT_PREFIX}${operationToken}`;
    const current = normalizePendingReceipt(await get(key));
    if (!current) return false;
    await remove(key);
    return true;
  });
  const notePendingFailure = (/** @type {string} */ operationToken) => effect(async () => {
    if (!validContributorToken(operationToken, 'operation')) {
      return { found: false, dropped: false };
    }
    const key = `${CONTRIBUTOR_PENDING_RECEIPT_PREFIX}${operationToken}`;
    const dropKey = `${CONTRIBUTOR_PENDING_DROP_PREFIX}${operationToken}`;
    const dropped = await get(dropKey);
    if (exactKeys(dropped, ['version', 'operationToken']) && dropped.version === 1
        && dropped.operationToken === operationToken) {
      return { found: true, dropped: true };
    }
    const receipt = normalizePendingReceipt(await get(key));
    if (!receipt) return { found: false, dropped: false };
    if (receipt.attempts >= 1) {
      // why: the durable drop marker is committed before receipt cleanup. A
      // timed-out earlier attempt write can resurrect the receipt key, but it
      // remains permanently invisible and therefore cannot poison FIFO.
      await set(dropKey, { version: 1, operationToken });
      await remove(key).catch(() => {});
      return { found: true, dropped: true };
    }
    await set(key, { ...receipt, attempts: receipt.attempts + 1 });
    return { found: true, dropped: false };
  });
  const clearPending = () => effect(async () => {
    const [entries, drops] = await Promise.all([
      list(CONTRIBUTOR_PENDING_RECEIPT_PREFIX), list(CONTRIBUTOR_PENDING_DROP_PREFIX),
    ]);
    await Promise.all([...Object.keys(entries ?? {}), ...Object.keys(drops ?? {})]
      .map((key) => remove(key).catch(() => {})));
    await remove(CONTRIBUTOR_PENDING_RECEIPTS_KEY).catch(() => {});
  });
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
      'semantic.contributor.enable-read': 1, 'semantic.contributor.enable': 1,
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
        // why: the revocation generation is already committed. Physical
        // cleanup is best-effort and stale receipts are independently hidden.
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
        const { attempts: _attempts, sequence: _sequence, ...settlement } = receipt;
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
