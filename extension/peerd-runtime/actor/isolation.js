// @ts-check
// Browser-neutral actor isolation capability. This is the single policy value
// shared by prompt/tool exposure, dispatch, state snapshots, and the UI.

export const ACTOR_ISOLATION_HOST_OFFSCREEN = 'offscreen-document-worker';
export const ACTOR_ISOLATION_HOST_BACKGROUND = 'background-page-worker';

export const ACTOR_ISOLATION_TEMPORARY_USER_FAILURE = 'The actor request was not run because its isolated worker was temporarily unavailable. When actor work is ready, retry the request. (actor_isolation_temporarily_unavailable)';
export const ACTOR_ISOLATION_UNSUPPORTED_USER_FAILURE = 'The actor request was not run because this browser cannot provide the required isolated worker. (actor_isolation_unavailable)';

export const ACTOR_ISOLATION_UNAVAILABLE_TOOLS = Object.freeze(new Set([
  'message_actor',
  'actor_create',
  'request_review',
]));

/**
 * @typedef {'available'|'unsupported'|'temporarily_unavailable'} ActorIsolationStatus
 * @typedef {'offscreen-document-worker'|'background-page-worker'|null} ActorIsolationHost
 * @typedef {{ status: ActorIsolationStatus, host: ActorIsolationHost, reason: string|null, retryable: boolean }} ActorIsolationCapability
 */

/**
 * Resolve the host this browser can actually provide. Browser names are not
 * consulted: capability detection keeps forks and future engines honest.
 * @param {{ offscreenWorker: boolean, backgroundPageWorker: boolean }} support
 * @returns {ActorIsolationCapability}
 */
export const actorIsolationCapability = ({ offscreenWorker, backgroundPageWorker }) => {
  if (offscreenWorker) {
    return { status: 'available', host: ACTOR_ISOLATION_HOST_OFFSCREEN, reason: null, retryable: false };
  }
  if (backgroundPageWorker) {
    return { status: 'available', host: ACTOR_ISOLATION_HOST_BACKGROUND, reason: null, retryable: false };
  }
  return {
    status: 'unsupported',
    host: null,
    reason: 'This browser cannot create the dedicated worker required for actor isolation.',
    retryable: false,
  };
};

/** @param {ActorIsolationCapability} capability */
export const actorIsolationAvailable = (capability) => capability?.status === 'available' && capability.host !== null;

/**
 * Keep one turn's model contract coherent while still failing closed if a
 * healthy boundary breaks after the turn starts.
 * @param {ActorIsolationCapability|null} atTurnStart
 * @param {ActorIsolationCapability|null} live
 */
export const actorIsolationForTurn = (atTurnStart, live) =>
  atTurnStart && !actorIsolationAvailable(atTurnStart) ? atTurnStart : live;

/**
 * Turn a host failure into visible, retryable state without changing the host
 * identity. A successful later probe restores the original available value.
 * @param {ActorIsolationCapability} capability
 * @param {unknown} error
 * @returns {ActorIsolationCapability}
 */
export const actorIsolationTemporarilyUnavailable = (capability, error) => ({
  status: 'temporarily_unavailable',
  host: capability?.host ?? null,
  reason: /** @type {{ message?: string }} */ (error)?.message ?? String(error || 'The actor worker host did not start.'),
  retryable: true,
});

/**
 * Stable fail-closed result. Callers that already resolved or minted an actor
 * binding must say so instead of claiming the target was untouched.
 * @param {ActorIsolationCapability} capability
 * @param {{ targetRead?: boolean, targetChanged?: boolean }} [effects]
 */
export const actorIsolationRefusal = (capability, effects = {}) => ({
  ok: false,
  code: capability?.status === 'temporarily_unavailable'
    ? 'actor_isolation_temporarily_unavailable'
    : 'actor_isolation_unavailable',
  error: capability?.status === 'temporarily_unavailable'
    ? 'Actors were not run because the isolated worker is temporarily unavailable. Do not retry automatically. Use the Try again control in peerd first.'
    : 'Actors were not run because this browser cannot provide the required isolated worker.',
  performed: false,
  targetRead: effects.targetRead === true,
  targetChanged: effects.targetChanged === true,
  retryable: capability?.retryable === true,
});

/**
 * Refuse a spawned/review actor before its parent session is read or a child
 * session is created. This is the central backstop for non-tool callers too.
 * @param {ActorIsolationCapability} capability
 * @param {number} [parentDepth]
 */
export const actorIsolationSpawnRefusal = (capability, parentDepth = 0) => {
  const refusal = actorIsolationRefusal(capability);
  return {
    result: refusal.error,
    sessionId: null,
    toolCalls: 0,
    durationMs: 0,
    depth: (Number.isFinite(parentDepth) ? parentDepth : 0) + 1,
    refused: /** @type {true} */ (true),
  };
};

/**
 * Hide actor-creating tools when their required execution boundary is absent.
 * Inventory tools may remain visible so the model can still explain what exists.
 * @template {{ name?: string }} T
 * @param {T[]} descriptors
 * @param {ActorIsolationCapability} capability
 * @returns {T[]}
 */
export const filterByActorIsolation = (descriptors, capability) => actorIsolationAvailable(capability)
  ? descriptors
  : descriptors.filter((descriptor) => !ACTOR_ISOLATION_UNAVAILABLE_TOOLS.has(String(descriptor?.name ?? '')));

/**
 * The model-facing backstop for a turn whose static base prompt still explains
 * actors. Tool exposure is the authority wall; this block makes the UX honest.
 * @param {ActorIsolationCapability} capability
 */
export const actorIsolationPromptBlock = (capability) => {
  if (actorIsolationAvailable(capability)) return '';
  const recovery = capability?.retryable
    ? 'The user must restore actor execution with the Try again control in peerd.'
    : 'This browser cannot provide actor execution.';
  return `<actor_execution status="${capability.status}">Actor requests will not run in this turn. Do not plan, create, message, or review through actors. Do not open or resolve an actor target. Do not retry automatically or promise later delivery. ${recovery}</actor_execution>`;
};
