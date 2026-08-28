// @ts-check

import browser from '/shared/browser-api.js';

/**
 * @param {{
 *   get: (key: string) => Promise<Record<string, any>>,
 *   set: (values: Record<string, any>) => Promise<void>,
 *   remove: (key: string) => Promise<void>,
 * }} area
 */
export const makeSessionCache = (area) => Object.freeze({
  /** @param {string} key */
  sessionGet: async (key) => {
    const result = await area.get(key);
    return result[key];
  },
  /** @param {string} key @param {any} value */
  sessionSet: (key, value) => area.set({ [key]: value }),
  /** @param {string} key */
  sessionDelete: (key) => area.remove(key),
});

const RECEIPTS = 'agentSendReceipts.v1';
const DAY = 86_400_000;
const object = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value);

/** Durable Class-E custody: accepted operations never replay after worker loss. */
export const makeAgentSendCustody = (/** @type {any} */ cache, now = Date.now) => {
  /** @type {Map<string,any>} */ const active = new Map();
  let tail = Promise.resolve();
  const validOperationId = (/** @type {unknown} */ id) =>
    typeof id === 'string' && /^[a-zA-Z0-9._:-]{16,128}$/.test(id);
  const issuedAt = (/** @type {string} */ id) => {
    const raw = /^send\.([0-9a-z]+)\./.exec(id)?.[1];
    if (!raw) return null;
    const value = Number.parseInt(raw, 36);
    return Number.isSafeInteger(value) && value > 0 ? value : NaN;
  };
  const operationWindowValid = (/** @type {string} */ id) => {
    const at = issuedAt(id); const clock = now();
    return at === null || Number.isFinite(at) && at >= clock - DAY && at <= clock + 300_000;
  };
  const digest = async (/** @type {string} */ value) => {
    if (!globalThis.crypto?.subtle) throw new Error('agent-send-digest-unavailable');
    const hash = await globalThis.crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(value),
    );
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const sendFingerprint = async (/** @type {any} */ input) => digest(JSON.stringify({
    text: input.text.trim(),
    attachments: await Promise.all((Array.isArray(input.attachments) ? input.attachments : [])
      .map(async (/** @type {any} */ item) => ({
        name: typeof item?.name === 'string' ? item.name : null,
        mediaType: typeof item?.mediaType === 'string' ? item.mediaType : null,
        size: Number.isFinite(item?.size) ? item.size : null,
        data: typeof item?.data === 'string' ? await digest(item.data) : null,
        text: typeof item?.text === 'string' ? await digest(item.text) : null,
      }))),
    // Presence is user intent: omitted means "pin foreground at admission";
    // explicit null means "no browser target". The resolved foreground id is
    // deliberately not fingerprinted, so a settled replay remains stable.
    activeTab: input.activeTabSpecified === true
      ? { specified: true, id: input.activeTabId ?? null }
      : { specified: false },
    goal: input.goal === true,
    sessionId: input.sessionId,
  }));
  const validReceipt = (/** @type {string} */ id, /** @type {any} */ receipt) => {
    const at = issuedAt(id);
    return object(receipt) && receipt.schema === 2
      && ['accepted', 'settled', 'unknown'].includes(receipt.status)
      && /^[0-9a-f]{64}$/.test(receipt.fingerprint)
      && (receipt.sessionId === null || typeof receipt.sessionId === 'string' && !!receipt.sessionId)
      && Number.isFinite(receipt.at) && Number.isFinite(receipt.issuedAt)
      && (receipt.status !== 'settled' || object(receipt.result))
      && (at === null || at === receipt.issuedAt);
  };
  const parse = (/** @type {any} */ receipts) => {
    if (receipts == null) return {};
    if (!object(receipts) || Object.entries(receipts).some(([id, value]) =>
      !validOperationId(id) || !validReceipt(id, value))) {
      throw new Error('agent-send-receipt-state-corrupt');
    }
    return /** @type {Record<string,any>} */ (receipts);
  };
  const read = async () => parse(await cache.sessionGet(RECEIPTS));
  const write = (/** @type {string} */ id, /** @type {any} */ value) => {
    if (typeof cache.sessionSet !== 'function') {
      return Promise.reject(new Error('agent-send-receipt-storage-unavailable'));
    }
    const operation = tail.then(async () => {
      const receipts = await read(); const clock = now();
      for (const key of Object.keys(receipts)) {
        const at = issuedAt(key);
        if (at !== null && clock - at > DAY) delete receipts[key];
      }
      if (!(id in receipts) && Object.keys(receipts).length >= 4096) {
        throw new Error('agent-send-receipt-capacity');
      }
      receipts[id] = { schema: 2, ...value, issuedAt: issuedAt(id) ?? clock, at: clock };
      await cache.sessionSet(RECEIPTS, receipts);
    });
    tail = operation.catch(() => {});
    return operation;
  };
  const unknownSend = (/** @type {string} */ operationId,
    error = 'agent-send-outcome-unknown') => ({
    ok: false, error, outcomeKnown: false, outcomeKind: 'unknown', retryable: false, operationId,
  });
  const conflict = (/** @type {string} */ operationId) => ({
    ok: false, error: 'agent-send-operation-id-conflict', outcomeKnown: true,
    retryable: false, operationId,
  });
  const prior = async (/** @type {string} */ id) => {
    try { return (await read())[id] ?? null; } catch { return undefined; }
  };
  const sendReceiptStatus = async (/** @type {string} */ id, /** @type {any} */ sessionId) => {
    if (!operationWindowValid(id)) return unknownSend(id, 'agent-send-operation-expired');
    const receipt = await prior(id);
    if (receipt === undefined) return unknownSend(id, 'agent-send-receipt-unavailable');
    if (receipt === null) return unknownSend(id, 'agent-send-not-observed');
    if (receipt.sessionId !== sessionId) return {
      ok: false, error: 'agent-send-session-mismatch', outcomeKnown: true,
      retryable: false, operationId: id,
    };
    return receipt.status === 'settled' ? { ...receipt.result, operationId: id, duplicate: true }
      : unknownSend(id);
  };
  const withSendReceipt = async (/** @type {string|null} */ id,
    /** @type {any} */ binding, /** @type {()=>Promise<any>} */ run) => {
    if (!id) return run();
    const current = active.get(id);
    if (current) return current.fingerprint === binding.fingerprint
      && current.sessionId === binding.sessionId ? current.task : conflict(id);
    const task = (async () => {
      const receipt = await prior(id);
      if (receipt === undefined) return unknownSend(id, 'agent-send-receipt-unavailable');
      if (receipt && (receipt.fingerprint !== binding.fingerprint
          || receipt.sessionId !== binding.sessionId)) return conflict(id);
      if (receipt?.status === 'settled') return { ...receipt.result, operationId: id, duplicate: true };
      if (receipt) return unknownSend(id);
      try { await write(id, { status: 'accepted', ...binding }); }
      catch { return unknownSend(id, 'agent-send-receipt-unavailable'); }
      let result;
      try { result = await run(); }
      catch {
        try { await write(id, { status: 'unknown', ...binding }); } catch {}
        return unknownSend(id);
      }
      const settlement = result?.__agentSendSettlement;
      const response = settlement ? result.response : result;
      if (settlement) {
        Promise.resolve(settlement).then(
          () => write(id, { status: 'settled', result: response, ...binding }),
          () => write(id, { status: 'unknown', ...binding }),
        ).catch(() => {});
        return { ...response, operationId: id };
      }
      try { await write(id, { status: 'settled', result, ...binding }); }
      catch { return unknownSend(id); }
      return { ...result, operationId: id };
    })();
    active.set(id, { ...binding, task });
    try { return await task; } finally { if (active.get(id)?.task === task) active.delete(id); }
  };
  return Object.freeze({ validOperationId, operationWindowValid, sendFingerprint,
    unknownSend, sendReceiptStatus, withSendReceipt });
};

/** @type {ReturnType<typeof makeSessionCache>|null} */
let defaultSession = null;
const realSession = () => {
  defaultSession ??= makeSessionCache(browser.storage.session);
  return defaultSession;
};

/** @param {string} key */
export const sessionGet = (key) => realSession().sessionGet(key);

/** @param {string} key @param {any} value */
export const sessionSet = (key, value) => realSession().sessionSet(key, value);

/** @param {string} key */
export const sessionDelete = (key) => realSession().sessionDelete(key);
