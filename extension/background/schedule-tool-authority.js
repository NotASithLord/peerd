// @ts-check

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

/** @param {{call:any,ctx:any,signal?:AbortSignal}} input */
export const createScheduleToolAuthority = ({ call, ctx, signal }) => {
  const args = call?.args ?? {};
  const requireTool = (/** @type {string} */ name) => {
    if (call?.name !== name) throw mismatch();
  };
  const aborted = () => signal?.aborted === true || ctx?.abortSignal?.aborted === true;
  return Object.freeze({
    readRoutines: () => {
      requireTool('schedule_list');
      if (typeof ctx?.scheduleList !== 'function') throw mismatch();
      return ctx.scheduleList() ?? [];
    },
    armConfirmedRoutine: async (/** @type {any} */ request) => {
      requireTool('schedule_create');
      const expected = {
        prompt: args.prompt,
        every: args.every,
        dailyAt: args.dailyAt,
        mode: args.mode,
      };
      if (!sameClone(request, expected) || typeof ctx?.scheduleAdd !== 'function') {
        throw mismatch();
      }
      if (aborted()) return {
        ok: false, error: 'schedule_aborted',
        content: 'The routine was not armed because the run was stopped.',
      };
      if (ctx?.permission?.confirmActions === false && typeof ctx?.confirm === 'function') {
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
        };
        if (answer !== 'yes_once' && answer !== 'yes_session' && answer !== true) {
          return {
            ok: false, error: 'declined', content: 'User declined to arm the routine.',
          };
        }
      }
      if (aborted()) return {
        ok: false, error: 'schedule_aborted',
        content: 'The routine was not armed because the run was stopped.',
      };
      return ctx.scheduleAdd(request);
    },
    cancelRoutine: (/** @type {string} */ id) => {
      requireTool('schedule_cancel');
      if (id !== args.id || typeof ctx?.scheduleRemove !== 'function') throw mismatch();
      return ctx.scheduleRemove(id);
    },
  });
};

export const bindScheduleToolAuthority = (/** @type {any} */ state, /** @type {any} */ input) =>
  state.authority ??= createScheduleToolAuthority(input);
