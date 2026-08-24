// @ts-check
// Bounded page-to-kernel RPC. Extension pages must never remain busy forever
// because an MV3 worker, event page, or demand host disappeared mid-request.
// A page never replays an ambiguous effect; route-classified reads stay safe.

const READ_SEGMENT = /(?:^|\/)(?:get|list|read|status|info|heard|updates|overview|count|history|diff|options|total)$/;
const READ_TYPES = new Set([
  'app/get-meta', 'bootstrap/ready', 'commands/list', 'composer/files', 'composer/tabs',
  'export/artifact',
  'import/inspect', 'local-model/catalog', 'local-model/probe', 'memory/export',
  'memory/suggestions', 'openrouter/models', 'pod/get-meta', 'session/contextSnapshots',
  'session/debugBundle', 'session/get', 'state/get', 'surfaces/get',
  'transfer/inspectImport', 'vault/prfStatus', 'vm/get-meta',
]);
const LONG_EFFECT = new Set([
  'apps/import-git', 'export/artifact', 'import/apply',
  'apps/repository/commit', 'apps/repository/restore',
  'apps/repository/branch', 'apps/repository/checkout',
  'apps/repository/link', 'apps/repository/fetch', 'apps/repository/push',
]);

/** @param {string} type */
export const uiMessageIsRead = (type) => READ_SEGMENT.test(type) || READ_TYPES.has(type);

/**
 * @param {Object} deps
 * @param {{runtime:{sendMessage:(message:any)=>Promise<any>}}} deps.browser
 * @param {number} [deps.readTimeoutMs]
 * @param {number} [deps.effectTimeoutMs]
 * @param {number} [deps.longEffectTimeoutMs]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const makeUiRuntimeClient = ({
  browser,
  readTimeoutMs = 20_000,
  effectTimeoutMs = 45_000,
  longEffectTimeoutMs = 130_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  const positive = (/** @type {number} */ value) => Number.isFinite(value) && value > 0;
  if (!browser?.runtime?.sendMessage || !positive(readTimeoutMs)
      || !positive(effectTimeoutMs) || !positive(longEffectTimeoutMs)) {
    throw new TypeError('ui-runtime-client-options-invalid');
  }
  const send = (/** @type {{type:string}&Record<string,any>} */ message) => {
    if (!message || typeof message.type !== 'string') {
      return Promise.reject(new TypeError('ui-runtime-message-invalid'));
    }
    const read = uiMessageIsRead(message.type);
    const timeoutMs = LONG_EFFECT.has(message.type) ? longEffectTimeoutMs
      : read ? readTimeoutMs : effectTimeoutMs;
    const pending = Promise.resolve().then(() => browser.runtime.sendMessage(message));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (/** @type {(value:any)=>void} */ callback, /** @type {any} */ value) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        callback(value);
      };
      const timer = setTimeoutFn(() => finish(reject, Object.assign(
        new Error(read ? 'Peerd did not finish loading this view in time.'
          : 'Peerd could not confirm whether the requested change finished.'),
        {
          code: 'ui-runtime-timeout', outcomeKnown: read,
          ...(read ? {} : { outcomeKind: 'unknown', retryable: false }),
        },
      )), timeoutMs);
      pending.then(
        (value) => finish(resolve, value),
        (cause) => finish(reject, Object.assign(
          new Error(read ? 'Peerd is restarting. Retry this read.'
            : 'Peerd could not confirm whether the requested change finished.'),
          {
            code: 'ui-runtime-transport-lost', outcomeKnown: read,
            ...(read ? { retryable: true } : { outcomeKind: 'unknown', retryable: false }),
            cause,
          },
        )),
      );
    });
  };
  return Object.freeze({ send });
};

/**
 * Fold a UI effect receipt, then reconcile unknown custody with one read. The
 * effect is never replayed here.
 *
 * @param {Object} deps
 * @param {(message:any)=>Promise<any>} deps.send
 * @param {(message:any,reply:any)=>void} deps.fold
 * @param {()=>Promise<any>} deps.reconcile
 * @param {(message:any,reply:any)=>boolean} deps.afterReply
 */
export const makeReconciledUiSender = ({ send, fold, reconcile, afterReply }) =>
  async (/** @type {any} */ message) => {
    try {
      const reply = await send(message);
      fold(message, reply);
      if (afterReply(message, reply) || reply?.outcomeKnown === false) await reconcile();
      return reply;
    } catch (cause) {
      if (/** @type {{outcomeKnown?:unknown}} */ (cause)?.outcomeKnown === false) {
        try { await reconcile(); } catch { /* preserve the original custody error */ }
      }
      throw cause;
    }
  };

/** @param {Promise<unknown>} effect */
export const settleUiEffect = (effect) => { void effect.catch(() => {}); };

/** @param {(() => void) & {sync?: () => void}} redraw @param {{type?:string,streaming?:boolean}} message */
export const redrawForRuntimeMessage = (redraw, message) => {
  if (!/(?:\/|-)delta$/.test(message?.type ?? '') && typeof redraw.sync === 'function') {
    redraw.sync();
    return;
  }
  redraw();
};
