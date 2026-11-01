// @ts-check
// The process contract the tab-hosted engine kinds (WebVM, Notebook, Pod, App)
// share in the service worker. Instance resolution is used by all four
// clients; the timed tab round-trip by the three whose instances answer over
// tab messages (WebVM, Notebook, Pod; App files live in the SW's own OPFS);
// the admission guards by the WebVM, Notebook and App authorities (the Pod
// policy carries its own pin in pod-tool-authority.js). What stays per kind is
// what an instance MEANS: its messages, error revival, self-heal, jobs, files
// and lifecycle rules.
//
// Pure of browser APIs: registries, queues and sends are injected, so the
// contract is behaviour-tested under Bun.

// ── Instance resolution ───────────────────────────────────────────────────
// Resolve which engine instance a call targets, for every tab-hosted kind.
//
// why one implementation: the WebVM, Notebook, Pod and App clients each wrote
// the same precedence (explicit id, then the session's current instance, then
// create one on demand or refuse) and the same per-session lane that keeps two
// concurrent first calls from creating two instances. Only data differed: the
// error to throw and the record a lazy create should make. Those arrive as
// config, so the precedence and the lane exist once.

/**
 * @typedef {{
 *   get: (id: string) => Promise<unknown>,
 *   getDefaultForSession: (sessionId: string) => Promise<string | null | undefined>,
 *   setDefaultForSession: (sessionId: string, id: string) => Promise<unknown>,
 *   create: (opts: any) => Promise<{ id: string }>,
 * }} InstanceRegistry
 */

/**
 * @typedef {Object} InstanceResolverConfig
 * @property {InstanceRegistry} registry
 * @property {{ enqueue: <T>(key: string, task: () => Promise<T>) => Promise<T> }} [queue]
 *   The client's keyed queue; implicit resolution runs on its `resolve:<sessionId>` lane.
 *   Required only for resolveQueued: a kind that never creates lazily has no
 *   create race to serialize.
 * @property {(id: string) => Error} notFound           an explicit id that has no record
 * @property {() => Error} missingTarget                 neither an id nor a session
 * @property {((sessionId: string) => Record<string, unknown>) | null} createOptions
 *   The registry.create options for a lazy default, or null when this kind never
 *   creates on demand (the call is refused with `missingDefault` instead).
 * @property {() => Error} [missingDefault]              no current instance and no lazy create
 */

/** The short chat suffix every kind uses in an auto-created instance's name.
 * @param {string} sessionId */
export const shortSessionSuffix = (sessionId) =>
  (sessionId.length > 6 ? sessionId.slice(-6) : sessionId);

/** @param {InstanceResolverConfig} config */
export const createEngineInstanceResolver = ({
  registry, queue, notFound, missingTarget, createOptions, missingDefault,
}) => {
  /** @param {string} id */
  const requireExisting = async (id) => {
    if (!await registry.get(id)) throw notFound(id);
    return id;
  };

  /**
   * Explicit id, else the session's current instance, else create one (or refuse
   * when this kind never creates lazily).
   * @param {{ sessionId?: string, id?: string }} [target] @returns {Promise<string>}
   */
  const resolve = async ({ sessionId, id } = {}) => {
    if (id) return requireExisting(id);
    if (!sessionId) throw missingTarget();
    const current = await registry.getDefaultForSession(sessionId);
    if (current) return current;
    if (!createOptions) throw (missingDefault ?? missingTarget)();
    const created = await registry.create(createOptions(sessionId));
    await registry.setDefaultForSession(sessionId, created.id);
    return created.id;
  };

  /**
   * Like resolve, but never creates. For reads, status and cancellation, where
   * an absent instance is the answer rather than something to make.
   * @param {{ sessionId?: string, id?: string }} [target] @param {() => Error} [missing]
   * @returns {Promise<string>}
   */
  const resolveExisting = async ({ sessionId, id } = {}, missing = missingDefault ?? missingTarget) => {
    if (id) return requireExisting(id);
    if (!sessionId) throw missingTarget();
    const current = await registry.getDefaultForSession(sessionId);
    if (!current) throw missing();
    return current;
  };

  /**
   * resolve() behind the session lane when the target is implicit. why only
   * then: an explicit id or a session-less lookup is a pure read with no create
   * race, so it must not queue behind another call's lazy create.
   * @param {{ sessionId?: string, id?: string }} [target] @returns {Promise<string>}
   */
  const resolveQueued = (target = {}) => {
    if (target.id || !target.sessionId) return resolve(target);
    if (!queue) return Promise.reject(new TypeError('resolveQueued needs the client keyed queue'));
    return queue.enqueue(`resolve:${target.sessionId}`, () => resolve(target));
  };

  return Object.freeze({ resolve, resolveExisting, resolveQueued });
};

// ── Tab round-trip ────────────────────────────────────────────────────────
// One timed round-trip to a tab-hosted engine instance.
//
// why one implementation: the WebVM, Notebook and Pod clients each raced their
// tab reply against a channel timeout with their own timer bookkeeping. The
// timeout here is the backstop for a page that stopped answering. It is not the
// engine's own per-run limit (that comes back as an ordinary error reply). Every
// client must clear the timer on both paths, or a settled call keeps the service
// worker's timer queue alive for the full window. What stays per kind is
// everything the reply MEANS: VM error revival and self-heal, the Notebook
// not-found signal, Pod job semantics, and each kind's abort message.

/**
 * Race one dispatched tab message against a channel timeout.
 * @template T
 * @param {() => Promise<T>} dispatch  sends the message and resolves with the raw reply
 * @param {{ timeoutMs: number, timeoutError: () => Error }} options
 * @returns {Promise<T>}
 */
export const raceTabReply = async (dispatch, { timeoutMs, timeoutError }) => {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<never>} */
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // why: a throwing factory must still settle the race, not strand it.
      try { reject(timeoutError()); } catch (cause) { reject(cause); }
    }, timeoutMs);
  });
  try {
    return await Promise.race([dispatch(), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

// ── Authority admission guards ────────────────────────────────────────────
// The admission guards every per-call engine authority applies before it
// touches an instance.
//
// why one implementation: the WebVM, Notebook and App authorities each wrote
// the same four checks: the operation must be the exact admitted one, a bound
// actor may only touch its own instance, a stopped run may not begin a
// mutation, and any refusal is an outcome-known, non-retryable mismatch.
// They differed only in the noun in the error text and the actor type that
// owns a binding. A guard written once cannot drift between kinds, which
// matters because these checks are the instance pin's last line in the
// service worker.

/**
 * The refusal every engine authority throws when a call does not match what
 * was admitted. Outcome-known and non-retryable: nothing was touched, and
 * retrying the same call cannot make it match.
 * @param {string} label  the kind's noun, e.g. 'VM'
 */
export const engineAuthorityMismatch = (label) =>
  Object.assign(new Error(`${label} authority mismatch`), {
    outcomeKnown: true, retryable: false,
  });

/**
 * @param {{
 *   label: string,
 *   actorType: string,
 *   binding: { operation: string },
 *   ctx: any,
 *   signal?: AbortSignal,
 * }} input
 */
export const createEngineAuthorityGuards = ({ label, actorType, binding, ctx, signal }) => {
  const mismatch = () => engineAuthorityMismatch(label);
  /** The instance this call is pinned to when an actor of this kind owns it; null otherwise. */
  const boundId = ctx?.actorType === actorType ? ctx.actorInstanceId : null;
  return Object.freeze({
    mismatch,
    boundId,
    /** @param {string} name */
    requireOperation: (name) => {
      if (binding.operation !== name) throw mismatch();
    },
    /** A bound actor may name only its own instance. @param {unknown} id */
    requireBound: (id) => {
      if (boundId && id !== boundId) throw mismatch();
    },
    /** Refuse to begin a mutation once the run has been stopped. */
    requireLive: () => {
      if (!signal?.aborted) return;
      throw Object.assign(new Error(`${label} operation stopped before mutation`), {
        outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
      });
    },
  });
};
