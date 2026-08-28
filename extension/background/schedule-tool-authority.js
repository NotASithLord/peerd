// @ts-check

import { controllerOperationAllowedInPermissionMode } from '/shared/controller-kernel-quota.js';

const mismatch = () => Object.assign(new Error('schedule authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {unknown} cause */
const knownFailure = (cause) => {
  if (cause && typeof cause === 'object') {
    Object.assign(cause, { outcomeKnown: true });
    return cause;
  }
  return Object.assign(new Error(String(cause)), { outcomeKnown: true });
};

/** @param {unknown} left @param {unknown} right */
const sameClone = (left, right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
};

/** @param {{operation:string,args:any,ctx:any,signal?:AbortSignal}} input */
export const createScheduleToolAuthority = ({ operation, args = {}, ctx, signal }) => {
  const requireOperation = (/** @type {string} */ expected) => {
    if (operation !== expected) throw mismatch();
  };
  const aborted = () => signal?.aborted === true || ctx?.abortSignal?.aborted === true;
  const permissionAllows = async () => {
    const permission = typeof ctx?.readAuthorityPermission === 'function'
      ? await ctx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
      : ctx?.permission;
    return controllerOperationAllowedInPermissionMode(operation, permission?.mode, args);
  };
  return Object.freeze({
    readRoutines: () => {
      requireOperation('turn.schedule.read-routines');
      if (typeof ctx?.scheduleList !== 'function') throw mismatch();
      return ctx.scheduleList() ?? [];
    },
    armConfirmedRoutine: async (/** @type {any} */ request) => {
      requireOperation('turn.schedule.arm-confirmed-routine');
      const expected = {
        prompt: args.prompt,
        every: args.every,
        dailyAt: args.dailyAt,
        mode: args.mode,
      };
      const validCadence = (typeof request?.every === 'string'
        && request.every.length >= 1 && request.every.length <= 128)
        !== (typeof request?.dailyAt === 'string'
          && request.dailyAt.length >= 1 && request.dailyAt.length <= 128);
      if (!sameClone(request, expected)
          || typeof request?.prompt !== 'string'
          || request.prompt.length < 1 || request.prompt.length > 16_384
          || !validCadence
          || (request.mode !== undefined && request.mode !== 'turn' && request.mode !== 'goal')
          || typeof ctx?.scheduleAdd !== 'function') {
        throw mismatch();
      }
      if (!await permissionAllows()) return {
        ok: false, code: 'plan_mode_refused',
        error: 'plan mode is read-only for this authority operation', retryable: false,
        outcomeKind: 'pre-effect-failure',
      };
      if (aborted()) return {
        ok: false, error: 'schedule_aborted',
        content: 'The routine was not armed because the run was stopped.',
        retryable: false,
      };
      // why: scheduling is unattended execution. This named authority operation
      // owns its one confirmation regardless of the ordinary action preference.
      if (typeof ctx?.confirm !== 'function') return {
        ok: false,
        error: 'confirmation_unavailable',
        content: 'The routine was not armed because confirmation is unavailable.',
        outcomeKind: 'pre-effect-failure', retryable: false,
      };
      {
        const cadence = request.every
          ? `every ${String(request.every).trim()}`
          : `daily at ${String(request.dailyAt).trim()}`;
        const runMode = request.mode === 'turn' ? 'a single turn' : 'an autonomous run';
        let answer;
        try {
          answer = await ctx.confirm({
            tool: 'schedule_create',
            sideEffect: 'write',
            kind: 'schedule_arm',
            origins: [],
            summary: `Schedule a background routine (${cadence}, ${runMode})? It will run unattended, even with the panel closed:\n"${String(request.prompt).trim()}"`,
            sessionId: ctx?.session?.sessionId ?? null,
          }, signal ?? ctx.abortSignal);
        } catch (cause) {
          // why: confirmation precedes the routine mutation, so its failure is
          // known not to have armed anything.
          throw knownFailure(cause);
        }
        if (aborted()) return {
          ok: false, error: 'schedule_aborted',
          content: 'The routine was not armed because the run was stopped.',
          retryable: false,
        };
        if (answer !== 'yes_once' && answer !== 'yes_session' && answer !== true) {
          return {
            ok: false, error: 'declined', content: 'User declined to arm the routine.',
            retryable: false,
          };
        }
      }
      if (!await permissionAllows()) return {
        ok: false, code: 'plan_mode_refused',
        error: 'plan mode became read-only before the routine was armed', retryable: false,
        outcomeKind: 'pre-effect-failure',
      };
      if (aborted()) return {
        ok: false, error: 'schedule_aborted',
        content: 'The routine was not armed because the run was stopped.',
        retryable: false,
      };
      return ctx.scheduleAdd(request);
    },
    cancelRoutine: (/** @type {string} */ id) => {
      requireOperation('turn.schedule.cancel-routine');
      if (id !== args.id || typeof id !== 'string' || id.length < 1 || id.length > 512
          || typeof ctx?.scheduleRemove !== 'function') throw mismatch();
      return ctx.scheduleRemove(id);
    },
  });
};

export const bindScheduleToolAuthority = (/** @type {any} */ _state, /** @type {any} */ input) =>
  createScheduleToolAuthority({
    ...input,
    args: structuredClone(input.args),
  });
