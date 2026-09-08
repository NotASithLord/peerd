// @ts-check

const functionAt = (/** @type {Record<string, any>} */ value, /** @type {string} */ key) => {
  if (typeof value?.[key] !== 'function') {
    throw new TypeError(`kernel-turn-runtime-${key}-invalid`);
  }
};

// why: goal custody needs one stable projection of its persisted checklist,
// but importing the growing todo semantic module would make this authority
// assembly scale with feature code again.
const formatGoalTodoBlock = (/** @type {unknown} */ value) => {
  if (!Array.isArray(value) || value.length === 0) return '';
  const todos = /** @type {Array<Record<string,any>>} */ (value);
  const next = todos.find((todo) => todo.status !== 'done') ?? null;
  const lines = todos.map((todo) => {
    const check = todo.status === 'done' ? '[x]' : '[ ]';
    const validation = todo.validation && todo.status !== 'done'
      ? ` (verify: ${todo.validation})` : '';
    const marker = next && todo.id === next.id ? '  ← next' : '';
    return `${check} ${todo.id}. ${todo.text}${validation}${marker}`;
  });
  const done = todos.filter((todo) => todo.status === 'done').length;
  return [`Plan (${done}/${todos.length} done):`, ...lines].join('\n');
};

/**
 * @param {Object} deps
 * @param {{runUserTurn:Function,renderSystemPrompt:Function,projectTurnTools:Function,
 *   planToolsCommand?:Function,withRun:Function}} deps.seams
 * @param {Record<string,any>} deps.turnDriverDeps
 * @param {Record<string,any>} deps.turnRouteDeps
 * @param {Record<string,any>} deps.sessionDeps
 * @param {Record<string,any>} deps.isolationDeps
 * @param {{
 *   kv:{get:Function,set:Function,delete:Function},
 *   beforeStart:(request:any)=>Promise<void>|void,
 *   hasUnresolvedSideEffects:(sessionId:string)=>Promise<boolean>,
 *   onEvent:(event:any)=>void,
 *   onRunEnd:(sessionId:string,info:any)=>void,
 *   bind:(runner:any)=>void,
 *   getTodoBlock?:(sessionId:string)=>Promise<string>,
 *   maxIterations?:number,
 * }} deps.goal
 * @param {()=>Promise<void>|void} deps.ensureReady
 * @param {{
 *   actorCount:()=>Promise<{activeActors:number}>|{activeActors:number},
 *   actorOverview:()=>Promise<{roots:any[]}>|{roots:any[]},
 * }} deps.actorProjection
 * @param {Record<string,any>} [deps.relays]
 * @param {()=>Promise<void>|void} [deps.onClose]
 * @param {(deps:Record<string,any>)=>Record<string,any>} deps.makeDriver
 * @param {(deps:Record<string,any>)=>Record<string,any>} deps.makeGoals
 * @param {number} deps.goalMaxIterations
 */
export const createKernelTurnRuntime = ({
  seams, turnDriverDeps, turnRouteDeps, sessionDeps, isolationDeps,
  goal, ensureReady, actorProjection, onClose = () => {},
  relays = {},
  makeDriver, makeGoals, goalMaxIterations,
}) => {
  if (!seams || !turnDriverDeps || !turnRouteDeps || !sessionDeps || !isolationDeps
      || !goal || !goal.kv || !actorProjection || typeof ensureReady !== 'function'
      || typeof makeDriver !== 'function' || typeof makeGoals !== 'function'
      || !Number.isSafeInteger(goalMaxIterations) || goalMaxIterations < 1) {
    throw new TypeError('kernel-turn-runtime-config-invalid');
  }
  for (const key of ['runUserTurn', 'renderSystemPrompt', 'projectTurnTools', 'withRun']) {
    functionAt(seams, key);
  }
  for (const key of ['beforeStart', 'hasUnresolvedSideEffects', 'onEvent', 'onRunEnd', 'bind']) {
    functionAt(goal, key);
  }
  for (const key of ['actorCount', 'actorOverview']) functionAt(actorProjection, key);
  /** @type {Record<string,any>|null} */
  let goalRunner = null;
  const driver = makeDriver({
    ...turnDriverDeps,
    runUserTurn: seams.runUserTurn,
    renderSystemPrompt: seams.renderSystemPrompt,
    projectToolDescriptors: seams.projectTurnTools,
    goalActiveFor: (/** @type {string} */ sessionId) => goalRunner?.isActive(sessionId) ?? false,
  });
  if (typeof driver?.runAgentTurn !== 'function'
      || typeof driver.maybeAutoResume !== 'function') {
    throw new TypeError('kernel-turn-driver-invalid');
  }
  const runAgentTurn = async (/** @type {any} */ args) => {
    await ensureReady();
    return driver.runAgentTurn(args);
  };
  goalRunner = makeGoals({
    runTurn: runAgentTurn,
    withRun: /** @type {(operation:()=>Promise<void>)=>Promise<void>} */ (seams.withRun),
    kv: /** @type {{
     *   get:(key:string)=>Promise<any>,
     *   set:(key:string,value:any)=>Promise<void>,
     *   delete:(key:string)=>Promise<void>,
     * }} */ (goal.kv),
    onEvent: goal.onEvent,
    onRunEnd: goal.onRunEnd,
    hasUnresolvedSideEffects: goal.hasUnresolvedSideEffects,
    getTodoBlock: goal.getTodoBlock ?? (async (/** @type {string} */ sessionId) =>
      formatGoalTodoBlock((await turnRouteDeps.sessions.get(sessionId))?.todos)),
    maxIterations: goal.maxIterations ?? goalMaxIterations,
  });
  if (!goalRunner || typeof goalRunner.start !== 'function'
      || typeof goalRunner.stop !== 'function' || typeof goalRunner.resume !== 'function') {
    throw new TypeError('kernel-goal-runner-invalid');
  }
  const goals = goalRunner;
  goal.bind(goals);
  const startGoalRun = async (/** @type {any} */ request) => {
    await goal.beforeStart(request);
    return goals.start(request);
  };
  const haltGoalRun = (/** @type {string} */ sessionId) => goals.stop(sessionId);
  let closed = false;

  return Object.freeze({
    turnDeps: Object.freeze({
      ...turnRouteDeps, runAgentTurn, startGoalRun, haltGoalRun,
    }),
    sessionDeps: Object.freeze({ ...sessionDeps, haltGoalRun }),
    isolationDeps: Object.freeze({ ...isolationDeps }),
    goalRunner: goals,
    maybeAutoResume: async (/** @type {string|null|undefined} */ sessionId) => {
      await ensureReady();
      return driver.maybeAutoResume(sessionId);
    },
    resumeGoalRuns: async () => {
      await ensureReady();
      return goals.resume();
    },
    actorCount: async () => {
      const value = await actorProjection.actorCount();
      if (!Number.isInteger(value?.activeActors) || value.activeActors < 0) {
        throw new TypeError('kernel-actor-count-invalid');
      }
      return { activeActors: value.activeActors };
    },
    actorOverview: async () => {
      const value = await actorProjection.actorOverview();
      if (!Array.isArray(value?.roots)) throw new TypeError('kernel-actor-overview-invalid');
      return { roots: value.roots };
    },
    relays: Object.freeze({ ...relays }),
    close: async () => {
      if (closed) return;
      closed = true;
      const active = goals.activeStates?.() ?? [];
      for (const state of active) {
        const sessionId = /** @type {{sessionId?:unknown}} */ (state).sessionId;
        if (typeof sessionId !== 'string') continue;
        turnRouteDeps.turnSlots?.stop?.(sessionId);
        await goals.stop(sessionId);
      }
      await onClose();
    },
  });
};
