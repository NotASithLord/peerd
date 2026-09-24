// @ts-check

import { uuidv7 } from '/shared/cold-util.js';

/** @typedef {import('/shared/tool-types.js').ConfirmPrompt} ConfirmPrompt */
/** @typedef {import('/shared/tool-types.js').ConfirmAnswer} ConfirmAnswer */
/** @typedef {{answer:ConfirmAnswer,cause:'answer'|'timeout'|'abort'|'stop',via:string|null,sessionId:string|null}} ConfirmOutcome */

/** @param {{
 * notifySidePanel:(prompt:ConfirmPrompt)=>void,
 * isChannelOpen?:()=>boolean,
 * timeoutMs?:number,
 * onPendingChange?:(pendingCount:number)=>void,
 * onSettled?:(id:string,prompt:ConfirmPrompt,outcome:ConfirmOutcome)=>void,
 * }} deps */
export const makeConfirmCoordinator = ({
  notifySidePanel,
  isChannelOpen = () => true,
  timeoutMs = 120_000,
  onPendingChange = () => {},
  onSettled = () => {},
}) => {
  /** @type {Map<string,{settle:(answer:ConfirmAnswer,cause?:ConfirmOutcome['cause'],via?:string|null)=>void,prompt:ConfirmPrompt}>} */
  const pending = new Map();
  /** @type {Map<string,ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  const notifyCount = () => { try { onPendingChange(pending.size); } catch {} };

  /** @param {string|null|undefined} ownerSessionId @returns {ConfirmPrompt|null} */
  const getPendingForOwner = (ownerSessionId) => {
    /** @type {ConfirmPrompt|null} */
    let last = null;
    for (const { prompt } of pending.values()) {
      if ((prompt.ownerSessionId ?? null) === (ownerSessionId ?? null)) last = prompt;
    }
    return last;
  };

  /** @param {{id?:unknown,ownerSessionId?:unknown,sessionId?:unknown,dispatchId?:unknown}} claim
   * @param {ConfirmAnswer} answer @param {string|null} [via] */
  const resolve = (claim, answer, via = null) => {
    if (!claim || typeof claim.id !== 'string') return false;
    if (answer !== 'yes_once' && answer !== 'yes_session' && answer !== 'no') return false;
    const entry = pending.get(claim.id);
    if (!entry) return false;
    /** @param {unknown} left @param {unknown} right */
    const same = (left, right) => (left ?? null) === (right ?? null);
    if (!same(claim.ownerSessionId, entry.prompt.ownerSessionId)
        || !same(claim.sessionId, entry.prompt.sessionId)
        || !same(claim.dispatchId, entry.prompt.dispatchId)) return false;
    entry.settle(answer, 'answer', via);
    return true;
  };

  /** @param {Omit<ConfirmPrompt,'id'>} promptInput @param {AbortSignal} [signal]
   * @returns {Promise<ConfirmAnswer>} */
  const confirm = (promptInput, signal) => new Promise((resolveAnswer) => {
    if (signal?.aborted || !isChannelOpen()) { resolveAnswer('no'); return; }
    const id = uuidv7();
    const prompt = { ...promptInput, id, raisedAt: Date.now() };
    /** @type {(()=>void)|undefined} */
    let onAbort;
    /** @param {ConfirmAnswer} answer @param {ConfirmOutcome['cause']} [cause]
     * @param {string|null} [via] */
    const settle = (answer, cause = 'stop', via = null) => {
      const timer = timers.get(id);
      if (timer) clearTimeout(timer);
      timers.delete(id);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (!pending.delete(id)) return;
      resolveAnswer(answer);
      notifyCount();
      try {
        onSettled(id, prompt, {
          answer,
          cause,
          via,
          sessionId: /** @type {{ownerSessionId?:string}} */ (prompt).ownerSessionId
            ?? prompt.sessionId ?? null,
        });
      } catch {}
      const next = getPendingForOwner(prompt.ownerSessionId);
      if (next) { try { notifySidePanel(next); } catch {} }
    };
    pending.set(id, { settle, prompt });
    timers.set(id, setTimeout(() => settle('no', 'timeout'), timeoutMs));
    if (signal) {
      onAbort = () => settle('no', 'abort');
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { settle('no', 'abort'); return; }
    }
    notifyCount();
    notifySidePanel(prompt);
  });

  const reset = () => {
    for (const { settle } of [...pending.values()]) settle('no', 'stop');
  };
  /** @param {string|null|undefined} sessionId */
  const declineSession = (sessionId) => {
    if (sessionId == null) return;
    for (const { settle, prompt } of [...pending.values()]) {
      if (prompt.sessionId === sessionId) settle('no', 'stop');
    }
  };

  return { confirm, resolve, reset, declineSession, getPendingForOwner };
};
