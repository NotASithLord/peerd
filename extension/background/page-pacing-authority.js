// @ts-check

import { normalizeApiOrigin } from '../shared/api-origin.js';
import { resolveTargetTab } from '/peerd-runtime/browser-authority.js';
import {
  PACED_CEILING_CODE, PACED_STATE_UNAVAILABLE_CODE,
  pacedCeilingMessage, PACED_STATE_UNAVAILABLE_MESSAGE,
} from '/peerd-runtime/pacing-authority.js';

const PACED_OPERATIONS = new Set([
  'turn.page.open-tab', 'turn.page.navigate', 'turn.page.click',
  'turn.page.fill', 'turn.page.login', 'turn.page.run-program',
]);

/** @param {string|null} origin @param {string} [reason] */
export const pacingAuthorityRefusal = (origin, reason = 'ceiling') => {
  const unavailable = reason === 'unavailable';
  const code = unavailable ? PACED_STATE_UNAVAILABLE_CODE : PACED_CEILING_CODE;
  return {
    ok: false, code, error: code, endTurn: true, performed: false,
    content: unavailable ? PACED_STATE_UNAVAILABLE_MESSAGE
      : pacedCeilingMessage(origin ?? 'this site'),
    outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
  };
};

/** @param {{operation:string,args:any,ctx:any,signal?:AbortSignal}} input */
export const createPagePacingAuthority = ({ operation, args, ctx, signal }) => {
  const enabled = PACED_OPERATIONS.has(operation) && !!ctx?.pacing;
  const origin = async () => {
    if (!enabled || ctx.pacing.engaged?.() === false) return null;
    if (operation === 'turn.page.open-tab' || operation === 'turn.page.navigate') {
      return normalizeApiOrigin(args.url);
    }
    const tab = await resolveTargetTab(args, ctx);
    return normalizeApiOrigin(tab?.url);
  };
  return Object.freeze({
    peek: async () => {
      if (!enabled) return null;
      const target = await origin();
      const result = await ctx.pacing.peek(target, { isWrite: true });
      return ['handoff', 'unavailable'].includes(result.outcome)
        ? pacingAuthorityRefusal(target, result.outcome) : null;
    },
    reserve: async () => {
      // why: nested page.* calls get their own exact operation grants. Charging
      // the outer program too would double-count every browser interaction.
      if (!enabled || operation === 'turn.page.run-program') return null;
      const target = await origin();
      if (!target) return null;
      let result;
      try {
        result = await ctx.pacing.reserve(target, {
          isWrite: true, signal, onWait: ctx.onPacingWait,
        });
      } catch (cause) {
        if (signal?.aborted || /** @type {{name?:string}} */ (cause)?.name === 'AbortError') {
          throw new DOMException('Page action stopped', 'AbortError');
        }
        return pacingAuthorityRefusal(target, 'unavailable');
      }
      signal?.throwIfAborted();
      if (['handoff', 'unavailable'].includes(result.outcome)) {
        return pacingAuthorityRefusal(target, result.outcome);
      }
      // why: a reservation for the old document never licenses an action on
      // a different site reached while sleeping. Other page guards recheck
      // document identity and permission immediately before the actual effect.
      if (result.waitedMs > 0 && await origin() !== target) return pacingAuthorityRefusal(target);
      if (result.waitedMs > 0) void ctx.audit?.({ type: 'origin_paced', details: {
        origin: target, durationMs: Math.round(result.waitedMs), reason: result.reason ?? 'interval',
      } }).catch(() => {});
      return null;
    },
  });
};
