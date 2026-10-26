// @ts-check
// UI-only effect custody and presentation. Runtime transport stays separate so
// engine pages never pull notice/reconciliation policy into the authority cold graph.

import { uiMessageIsRead } from './ui-runtime-client.js';

const REPORT_SETTLED_EFFECT_FAILURE = Symbol('report-settled-effect-failure');

/** @param {ReadonlyArray<any>|undefined} notices @param {unknown} cause */
export const putUiEffectFailureNotice = (notices, cause) => [
  ...(notices ?? []).filter((notice) => notice?.action?.kind !== 'ui-effect-failure'),
  {
    id: Date.now() + Math.random(),
    text: /** @type {{outcomeKnown?:unknown}} */ (cause)?.outcomeKnown === false
      ? 'Peerd could not confirm whether that change finished. Review the current state before trying again.'
      : 'Peerd could not apply that change.',
    action: { kind: 'ui-effect-failure' },
  },
].slice(-3);

/**
 * Fold a UI effect receipt, then reconcile unknown custody with one read. The
 * effect is never replayed here.
 * @param {Object} deps
 * @param {(message:any)=>Promise<any>} deps.send
 * @param {(message:any,reply:any)=>void} deps.fold
 * @param {()=>Promise<any>} deps.reconcile
 * @param {(message:any,reply:any)=>boolean} deps.afterReply
 * @param {(message:any,failure:any)=>void} [deps.onEffectFailure]
 */
export const makeReconciledUiSender = ({
  send, fold, reconcile, afterReply, onEffectFailure,
}) => (/** @type {any} */ message) => {
  const read = uiMessageIsRead(message?.type ?? '');
  let reporting = false;
  let recorded = false;
  let reported = false;
  /** @type {any} */
  let failure;
  const report = () => {
    if (!reporting || !recorded || reported || !onEffectFailure) return;
    reported = true;
    try { onEffectFailure(message, failure); }
    catch (cause) { console.warn('[ui] effect failure notice failed', cause); }
  };
  const recordFailure = (/** @type {any} */ cause) => {
    recorded = true;
    failure = cause;
    report();
  };
  const pending = (async () => {
    let reply;
    try {
      reply = await send(message);
    } catch (cause) {
      if (!read) {
        // Reconcile once, never replay, and preserve the authority error.
        try { await reconcile(); } catch { /* preserve custody error */ }
        recordFailure(cause);
      }
      throw cause;
    }
    fold(message, reply);
    const failedEffect = !read && (reply?.ok === false || reply?.outcomeKnown === false);
    const refresh = afterReply(message, reply) || reply?.outcomeKnown === false;
    if (refresh) {
      try { await reconcile(); }
      catch (cause) {
        // A failed follow-up read cannot replace an outcome-unknown receipt.
        if (reply?.outcomeKnown !== false) throw cause;
      }
      finally { if (failedEffect) recordFailure(reply); }
    } else if (failedEffect) recordFailure(reply);
    return reply;
  })();
  if (!read && onEffectFailure) Object.defineProperty(pending, REPORT_SETTLED_EFFECT_FAILURE, {
    value: () => { reporting = true; report(); },
  });
  return pending;
};

/** @param {Promise<unknown>} effect */
export const settleUiEffect = (effect) => {
  /** @type {any} */ (effect)?.[REPORT_SETTLED_EFFECT_FAILURE]?.();
  void effect.catch(() => {});
};

/** @param {(() => void) & {sync?: () => void}} redraw @param {{type?:string,streaming?:boolean}} message */
export const redrawForRuntimeMessage = (redraw, message) => {
  if (!/(?:\/|-)delta$/.test(message?.type ?? '') && typeof redraw.sync === 'function') {
    redraw.sync();
    return;
  }
  redraw();
};

/**
 * why: each modal must keep keyboard attention, including expanded sections.
 * A closed menu can remove the opener. Do not restore focus to body.
 * @param {string} titleId
 * @param {() => void} onCancel
 * @param {{ returnFocus?: HTMLElement | null }} state
 */
export const confirmationDialogAttrs = (titleId, onCancel, state) => {
  /** @param {{ dom: Element }} vnode */
  const oncreate = ({ dom }) => {
    state.returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const dialog = /** @type {HTMLElement} */ (dom);
    const reject = /** @type {HTMLElement | null} */ (dialog.querySelector('[data-confirm-reject]'));
    (reject ?? dialog).focus();
  };
  /** @param {KeyboardEvent} event */
  const onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = /** @type {HTMLElement} */ (event.currentTarget);
    const controls = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter((control) => control.checkVisibility()));
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return {
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    tabindex: -1, oncreate, onkeydown,
    onremove: () => state.returnFocus?.focus(),
  };
};
