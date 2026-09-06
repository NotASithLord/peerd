// @ts-check

// why: Promise fulfillment only proves that an exact authority RPC returned.
// Each named handler chooses the result contract that proves whether its own
// mutation/resource effect happened; ambiguous shapes remain unknown.
const rejected = (/** @type {unknown} */ cause) => {
  const detail = /** @type {{performed?:boolean,outcomeKnown?:boolean,outcomeKind?:unknown}} */ (cause);
  if (detail?.outcomeKnown === false || detail?.outcomeKind === 'host-lost'
      || detail?.outcomeKind === 'transport-lost') return 'unknown';
  if (detail?.performed === true || detail?.outcomeKind === 'effect-completed') return 'performed';
  return detail?.outcomeKnown === true || detail?.outcomeKind === 'pre-effect-failure'
    ? 'not-performed' : 'unknown';
};

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value !== null
  && typeof value === 'object' && !Array.isArray(value);

export const safeLifecycleDiagnostic = (/** @type {unknown} */ cause) => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240)
    || 'unknown lifecycle failure';
};

export const lifecycleRewrite = (/** @type {unknown} */ value) => {
  if (!isRecord(value) || typeof value.error !== 'string' || !isRecord(value.recovery)) {
    return null;
  }
  const state = value.recovery.state;
  if (typeof value.recovery.category !== 'string'
      || typeof state !== 'string'
      || !['failed', 'cancelled', 'interrupted', 'outcome_unknown'].includes(state)) return null;
  return Object.freeze({
    error: value.error.slice(0, 2_048),
    recovery: Object.freeze({ ...value.recovery }),
  });
};

export const lifecycleRecoveryAttribution = (/** @type {any} */ rewrite) => rewrite ? {
  recoveryCategory: typeof rewrite.recovery?.category === 'string'
    ? rewrite.recovery.category : 'unknown',
  recoveryState: typeof rewrite.recovery?.state === 'string'
    ? rewrite.recovery.state : 'unknown',
} : {};

export const recoveryCustody = (/** @type {any} */ rewrite) => ({
  outcomeKnown: rewrite?.recovery?.state !== 'outcome_unknown',
  retryable: false,
});

export const actorRecoveryCustody = (
  /** @type {any} */ rewrite,
  /** @type {Record<string, any>} */ source,
) => {
  const hasActorCustody = typeof source.actorCorrelationId === 'string'
    || typeof source.actorDeliveryId === 'string'
    || Array.isArray(source.actorDeliveryIds)
    || typeof source.actorTerminal === 'boolean'
    || typeof source.actorOutcomeKnown === 'boolean'
    || typeof source.actorPerformed === 'boolean'
    || typeof source.actorAborted === 'boolean';
  if (!hasActorCustody) return {};
  const actorDeliveryIds = Array.isArray(source.actorDeliveryIds)
    ? [...new Set(source.actorDeliveryIds.filter(
      (/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0))]
    : [];
  const identity = {
    ...(typeof source.actorCorrelationId === 'string'
      ? { actorCorrelationId: source.actorCorrelationId } : {}),
    ...(typeof source.actorDeliveryId === 'string'
      ? { actorDeliveryId: source.actorDeliveryId } : {}),
    ...(actorDeliveryIds.length > 0 ? { actorDeliveryIds } : {}),
  };
  switch (rewrite?.recovery?.state) {
  case 'outcome_unknown':
    return {
      ...identity, actorTerminal: true, actorOutcomeKnown: false,
      actorPerformed: true, actorAborted: false,
    };
  case 'interrupted':
    return {
      ...identity, actorTerminal: true, actorOutcomeKnown: true,
      actorPerformed: false, actorAborted: false,
    };
  case 'cancelled':
    return {
      ...identity, actorTerminal: true, actorOutcomeKnown: true,
      actorPerformed: false, actorAborted: true,
    };
  default:
    return identity;
  }
};

export const strongestLifecycleRewrite = (/** @type {any[]} */ entries) =>
  entries.find((entry) => entry.rewrite.recovery?.state === 'outcome_unknown')
  ?? entries.find((entry) => entry.rewrite.recovery?.state === 'interrupted')
  ?? entries.find((entry) => entry.rewrite.recovery?.state === 'cancelled')
  ?? entries[0]
  ?? null;

export const safeHostEffectFailure = (/** @type {unknown} */ value) => {
  const detail = /** @type {{code?:unknown,error?:unknown,message?:unknown,content?:unknown,structured?:unknown,endTurn?:unknown,outcomeKind?:unknown,retryable?:unknown}} */ (value);
  const code = typeof detail?.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(detail.code)
    ? detail.code : undefined;
  // Exact authorities may return a reviewed model-facing `error`. A thrown
  // Error.message is broker/library detail and never crosses the heap.
  const raw = typeof detail?.error === 'string' ? detail.error : '';
  const error = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240);
  const content = typeof detail?.content === 'string'
    ? detail.content.replace(/\u0000/g, '').slice(0, 2_048) : undefined;
  const structuredInput = detail?.structured && typeof detail.structured === 'object'
    && !Array.isArray(detail.structured)
    ? /** @type {Record<string,unknown>} */ (detail.structured) : null;
  const structuredFields = new Set([
    'code', 'reason', 'stage', 'outcome', 'retryable', 'neutralized', 'performed',
  ]);
  const structured = structuredInput
    ? Object.freeze(Object.fromEntries(Object.entries(structuredInput)
      .filter(([key, item]) => structuredFields.has(key)
        && (typeof item === 'string' || typeof item === 'boolean' || item === null))
      .slice(0, structuredFields.size)))
    : undefined;
  const retryable = typeof detail?.retryable === 'boolean' ? detail.retryable
    : typeof structured?.retryable === 'boolean' ? structured.retryable : true;
  return Object.freeze({
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
    ...(content ? { content } : {}),
    ...(structured && Object.keys(structured).length > 0 ? { structured } : {}),
    ...(detail?.endTurn === true ? { endTurn: true } : {}),
    ...(detail?.outcomeKind === 'pre-effect-failure'
      || detail?.outcomeKind === 'effect-completed'
      || detail?.outcomeKind === 'host-lost'
      || detail?.outcomeKind === 'transport-lost'
      ? { outcomeKind: detail.outcomeKind } : {}),
    retryable,
  });
};

export const safeHostPolicyAttribution = (/** @type {unknown} */ value) => {
  const authorityPolicy = /** @type {{authorityPolicy?:unknown}} */ (value)?.authorityPolicy;
  if (!authorityPolicy || typeof authorityPolicy !== 'object' || Array.isArray(authorityPolicy)) {
    return Object.freeze({});
  }
  const ugcZone = /** @type {{ugcZone?:unknown}} */ (authorityPolicy).ugcZone;
  return Object.freeze(typeof ugcZone === 'string' && /^[a-z0-9-]{1,80}$/.test(ugcZone)
    ? { ugcZone } : {});
};

// why: confirmation is its own host-observed authority stage. A denied prompt
// must remain a refusal even when the semantic heap later claims success.
export const HOST_CONFIRMATION_DECLINED = Object.freeze({
  code: 'confirmation_declined',
  error: 'The user declined the authority operation.',
  retryable: false,
});

// why: a proven no-effect host outcome is not necessarily a refusal. Exact
// authorities use no-effect for successful idempotent operations too (for
// example a clean repository checkpoint or an unchanged memory write).
// Refusal is derived only from a closed, host-authored failure shape; the
// controller cannot turn a no-op value into policy approval or vice versa.
export const hostEffectValueIsRefusal = (/** @type {unknown} */ value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const detail = /** @type {{ok?:unknown,refused?:unknown,refusal?:unknown,rejected?:unknown,error?:unknown,code?:unknown}} */ (value);
  return detail.ok === false || detail.refused === true || detail.rejected === true
    || detail.refusal != null
    || typeof detail.error === 'string' && detail.error.length > 0
    || typeof detail.code === 'string' && detail.code.length > 0;
};

export const authorityReceiptsForCall = (
  /** @type {Map<string,any>} */ receiptMap,
  /** @type {unknown} */ callId,
) => typeof callId === 'string' ? [...receiptMap.values()]
  .filter((receipt) => receipt.callId === callId)
  .map(({ callId: _callId, ...receipt }) => receipt) : [];

const stripAuthorityVerdict = (/** @type {Record<string,any>} */ value) => {
  const {
    authorityReceipt: _receipt, authorityReceipts: _receipts,
    authorityPerformed: _authorityPerformed, performed: _performed,
    hostOutcome: _hostOutcome, authorityOutcome: _authorityOutcome,
    authorityPolicy: _authorityPolicy,
    ...clean
  } = value;
  return clean;
};

// why: the host owns whether an exact effect was refused, but controller-owned
// semantics own model-facing recovery guidance. A reviewed host message wins;
// otherwise preserve the sealed controller's bounded presentation instead of
// collapsing it to an opaque authority code.
const refusalPresentation = (/** @type {any} */ refusal,
  /** @type {Record<string,any>} */ semantic, /** @type {string} */ fallback) => (
  typeof refusal?.content === 'string' && refusal.content
    ? refusal.content
    : (semantic?.ok === false || semantic?.is_error === true)
        && typeof semantic?.content === 'string' && semantic.content
      ? semantic.content
      : refusal?.error ?? fallback
);

const aggregateAuthorityReceipts = (/** @type {any[]} */ receipts) => {
  // why: optimistic exact operations can return a retryable, proven no-effect
  // conflict and then succeed later in the same semantic call. Only the same
  // durable target proves that the later attempt superseded the refusal: the
  // target binds operation, authority scope, and canonical args. Operation
  // equality alone would let a different page click hide a discarded failure.
  // Targetless and non-retryable refusals therefore never disappear.
  const refusals = receipts.filter((receipt, index) => receipt.outcome === 'not-performed'
    && (receipt.refused === true || typeof receipt.code === 'string'
      || typeof receipt.error === 'string')
    && !(receipt.retryable === true && typeof receipt.target === 'string'
      && receipt.target.length > 0 && receipts.slice(index + 1).some((later) =>
      later.operation === receipt.operation && later.target === receipt.target
        && later.performed === true)));
  return {
    performed: receipts.some((receipt) => receipt.performed === true),
    unknown: receipts.some((receipt) => receipt.outcomeKnown === false),
    refused: refusals.length > 0,
    retryable: refusals.every((receipt) => receipt.retryable === true),
    refusal: refusals[0],
  };
};

const IDENTITY_PROVIDER_TRANSIT_ONLY_CODE = 'actor_identity_provider_transit_only';
const receiptsSafeForSemanticRealm = (/** @type {any[]} */ receipts) => receipts.map((receipt) => {
  const hidesSuccessorHandle = receipt?.operation === 'turn.actor.message'
    && receipt?.outcome === 'not-performed' && receipt?.performed === false
    && (receipt?.code === IDENTITY_PROVIDER_TRANSIT_ONLY_CODE
      || receipt?.error === IDENTITY_PROVIDER_TRANSIT_ONLY_CODE);
  if (!hidesSuccessorHandle || !Object.hasOwn(receipt, 'target')) return receipt;
  const { target: _target, ...safe } = receipt;
  return safe;
});

// why: these are exact host-handler outcomes that prove the browser action
// never reached its dispatch edge. Any unclassified page failure stays
// unknown; page disappearance or an injection rejection can occur after a
// click/type/navigation has already taken effect.
const provenPageNoEffect = (/** @type {any} */ value) => {
  const error = typeof value?.error === 'string' ? value.error : '';
  return /^(?:no_target_tab|selector_or_ref_required|text_required|stale_ref:|matched_count_mismatch|invalid_selector:|no_match:|nth_out_of_range:|debugger_unavailable:|cross_origin_form_submission_blocked$|no_option_matching$|not_typable$|page_code_(?:unavailable|requires_actor_session|run_registry_unavailable|aborted)|code_required)/.test(error);
};

// why: these contracts are selected only by their matching exact authority
// handler. Once that wrapper returns, the named physical operation crossed its
// completion edge even when its domain value is void or reports a command/app
// failure. Only an explicit host stamp may prove pre-effect refusal or loss.
const completedExactEffect = Object.freeze({
  fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
    || value?.outcomeKind === 'host-lost' || value?.outcomeKind === 'transport-lost'
    ? 'unknown'
    : value?.performed === false || value?.outcomeKind === 'pre-effect-failure'
      ? 'not-performed' : 'performed',
  rejected,
});

const refusalAwareExactEffect = Object.freeze({
  fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
    || value?.outcomeKind === 'host-lost' || value?.outcomeKind === 'transport-lost'
    ? 'unknown'
    : value?.performed === false || value?.outcomeKind === 'pre-effect-failure'
      || value?.refusal || value?.refused === true || value?.aborted === true
      ? 'not-performed' : 'performed',
  rejected,
});

const recordMutation = Object.freeze({
  fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
    ? 'unknown'
    : value?.performed === true || typeof value?.id === 'string' && value.id.length > 0
      ? 'performed'
      : value?.performed === false || value === null || value === false
        ? 'not-performed' : 'unknown',
  rejected,
});

const booleanMutation = Object.freeze({
  fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
    ? 'unknown'
    : value?.performed === true || value === true
      ? 'performed'
      : value?.performed === false || value === false
        ? 'not-performed' : 'unknown',
  rejected,
});

const closedOkEffect = Object.freeze({
  fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
    || value?.actorOutcomeKnown === false
    ? 'unknown'
    : value?.performed === true || value?.actorPerformed === true || value?.ok === true
      ? 'performed'
      : value?.performed === false || value?.actorPerformed === false || value?.ok === false
        || value?.refusal || value?.refused === true
        || value?.outcomeKind === 'pre-effect-failure'
        ? 'not-performed' : 'unknown',
  rejected,
});

export const stampAuthorityToolResult = (
  /** @type {any[]} */ receipts,
  /** @type {Record<string,any>} */ result,
) => {
  const clean = stripAuthorityVerdict(result);
  if (receipts.length === 0) return clean;
  const safeReceipts = receiptsSafeForSemanticRealm(receipts);
  const { performed, unknown, refused, retryable, refusal } =
    aggregateAuthorityReceipts(safeReceipts);
  const ugcZone = safeReceipts.find((receipt) => typeof receipt.ugcZone === 'string')?.ugcZone;
  const stamped = {
    ...clean, authorityReceipts: safeReceipts, authorityPerformed: performed,
    ...(ugcZone ? { authorityPolicy: Object.freeze({ ugcZone }) } : {}),
  };
  if (unknown) return {
    ...stamped, ok: false, outcomeKnown: false, retryable: false,
    error: 'Authority effect outcome is unknown; verify before retrying.',
  };
  if (refused) return {
    ...stamped, ok: false, outcomeKnown: true, retryable: performed ? false : retryable,
    error: performed
      ? 'Authority host performed only part of the requested effects; do not retry the whole call.'
      : refusalPresentation(
        refusal, clean, 'Authority host did not perform the requested effect.',
      ),
    ...(typeof refusal?.code === 'string' ? { code: refusal.code } : {}),
  };
  if (clean.ok === false) return {
    ...stamped, ok: false, outcomeKnown: clean.outcomeKnown !== false,
    retryable: performed ? false : clean.retryable,
  };
  return { ...stamped, ok: true, outcomeKnown: true, retryable: false };
};

export const stampAuthorityToolResultBlock = (
  /** @type {any[]} */ receipts,
  /** @type {Record<string,any>} */ block,
) => {
  const clean = stripAuthorityVerdict(block);
  if (receipts.length === 0) return clean;
  const safeReceipts = receiptsSafeForSemanticRealm(receipts);
  const { performed, unknown, refused, retryable, refusal } =
    aggregateAuthorityReceipts(safeReceipts);
  const ugcZone = safeReceipts.find((receipt) => typeof receipt.ugcZone === 'string')?.ugcZone;
  const stamped = {
    ...clean, authorityReceipts: safeReceipts, authorityPerformed: performed,
    ...(ugcZone ? { authorityPolicy: Object.freeze({ ugcZone }) } : {}),
  };
  if (unknown) return {
    ...stamped, is_error: true, outcomeKnown: false, retryable: false,
    content: 'Authority effect outcome is unknown; verify before retrying.',
  };
  if (refused) return {
    ...stamped, is_error: true, outcomeKnown: true, retryable: performed ? false : retryable,
    content: performed
      ? 'Authority host performed only part of the requested effects; do not retry the whole call.'
      : refusalPresentation(
        refusal, clean, 'Authority host did not perform the requested effect.',
      ),
    ...(typeof refusal?.code === 'string' ? { code: refusal.code } : {}),
  };
  if (clean.is_error === true) return {
    ...stamped, is_error: true, outcomeKnown: clean.outcomeKnown !== false,
    retryable: performed ? false : clean.retryable,
  };
  return { ...stamped, is_error: false, outcomeKnown: true, retryable: false };
};

/**
 * Apply the strongest durable lifecycle rewrite to one live or stored result.
 * Both orchestrator and actor hosts use this pure projection so their recovery
 * truth cannot drift while their separate authority state machines remain
 * isolated.
 * @param {{receipts:any[],rewrites:Iterable<any>,callId:unknown,
 *   value:Record<string,any>,stored?:boolean}} input
 */
export const stampLifecycleToolResult = ({
  receipts, rewrites, callId, value, stored = false,
}) => {
  const stamped = stored
    ? stampAuthorityToolResultBlock(receipts, value)
    : stampAuthorityToolResult(receipts, value);
  const recoveryEntry = strongestLifecycleRewrite(
    typeof callId === 'string' ? [...rewrites].filter((entry) => entry.callId === callId) : [],
  );
  if (!recoveryEntry) return stamped;
  const { rewrite, physical } = recoveryEntry;
  return {
    ...stamped,
    ...(stored
      ? { is_error: true, content: rewrite.error }
      : { ok: false, error: rewrite.error }),
    recovery: rewrite.recovery,
    ...recoveryCustody(rewrite),
    ...actorRecoveryCustody(rewrite, { ...stamped, ...physical }),
    meta: {
      ...(isRecord(stamped.meta) ? stamped.meta : {}),
      recovery: rewrite.recovery,
    },
  };
};

/** @param {Promise<unknown>} pending @param {number} timeoutMs */
export const settleWithin = (pending, timeoutMs) => new Promise((resolve) => {
  let finished = false;
  const finish = (/** @type {unknown} */ value) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => finish(undefined), timeoutMs);
  pending.then(finish, () => finish(undefined));
});

export const HOST_EFFECT_OUTCOME = Object.freeze({
  okResult: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.ok === true
        ? 'performed' : value?.ok === false ? 'not-performed' : 'unknown',
    rejected,
  }),
  partialMutation: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.performed === true || value?.ok === true
        || value?.outcomeKind === 'effect-completed'
        ? 'performed'
        : value?.performed === false || value?.ok === false
          || value?.outcomeKind === 'pre-effect-failure'
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  repositoryCheckpoint: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.created === true
        ? 'performed' : value?.created === false ? 'not-performed' : 'unknown',
    rejected,
  }),
  repositoryRestore: Object.freeze({
    // why: restore may create only its safety checkpoint even when no tree
    // bytes change. That durable checkpoint still makes a whole-call retry
    // unsafe, while a true no-op proves that nothing was performed.
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.restored === true || typeof value?.checkpointOid === 'string'
        ? 'performed'
        : value?.restored === false && value?.checkpointOid == null
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  siteClientRun: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.performed === true || value?.executionDispatched === true
        || value?.outcomeKind === 'effect-completed' || value?.ok === true
        ? 'performed' : value?.outcomeKind === 'pre-effect-failure'
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  pageMutation: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      || value?.outcomeKind === 'host-lost' || value?.outcomeKind === 'transport-lost'
      ? 'unknown'
      : value?.ok === true || value?.performed === true
        || value?.authorityPerformed === true || value?.outcomeKind === 'effect-completed'
        ? 'performed'
        : value?.outcomeKind === 'pre-effect-failure' || provenPageNoEffect(value)
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  webRequest: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      || value?.outcomeKind === 'host-lost' || value?.outcomeKind === 'transport-lost'
      ? 'unknown'
      : value?.ok === true || value?.reason === 'redirect_blocked'
        || value?.outcomeKind === 'effect-completed'
        ? 'performed'
        : value?.reason === 'private_network'
          || value?.outcomeKind === 'pre-effect-failure'
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  memoryResult: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.ok === false
      || value?.rejected === true || value?.op === 'noop'
      ? 'not-performed' : value?.ok === true || typeof value?.op === 'string'
        ? 'performed' : 'unknown',
    rejected,
  }),
  actorSpawn: Object.freeze({
    // A synchronous child session and an asynchronous task handle are both
    // durable host-created resources even when later isolation startup refuses.
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown'
      : typeof value?.sessionId === 'string' && value.sessionId
        || typeof value?.taskId === 'string' && value.taskId
        ? 'performed'
        : value?.sessionId === null || value?.ok === false || value?.refused === true
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  actorCancel: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.ok === true
        ? 'performed' : value?.ok === false ? 'not-performed' : 'unknown',
    rejected,
  }),
  defaultSelection: Object.freeze({
    // why: the exact registry adapters return a boolean only after the durable
    // session default is updated. An unmarked fulfillment proves nothing.
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value === true || value?.performed === true || value?.ok === true
        ? 'performed' : value === false || value?.performed === false || value?.ok === false
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  notebookRun: Object.freeze({
    // jsClient.eval returns arbitrary user-code values. Fulfillment proves the
    // notebook execution finished; `{ok:false}` inside that value is not an
    // authority verdict and cannot erase OPFS/runtime mutations.
    fulfilled: (/** @type {any} */ _value) => 'performed',
    rejected,
  }),
  scriptRun: Object.freeze({
    // The exact execution adapter stamps nested custody loss on its own
    // wrapper. A normal job result, including an ordinary user-code error,
    // proves the sealed worker ran; only that host stamp makes it unknown.
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      || value?.outcomeKind === 'host-lost' || value?.outcomeKind === 'transport-lost'
      ? 'unknown'
      : value?.ok === true
        ? 'performed'
        : value?.performed === false || value?.outcomeKind === 'pre-effect-failure'
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  meshProgramRun: Object.freeze({
    // Like scriptRun, but finite to the mesh program wrapper. A resolved job
    // can contain an ambiguous signed send/publish acknowledgement; the dweb
    // authority promotes that host stamp instead of treating RPC fulfillment
    // as proof that the mesh effect is known.
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      || value?.outcomeKind === 'host-lost' || value?.outcomeKind === 'transport-lost'
      ? 'unknown'
      : value?.ok === true
        ? 'performed'
        : value?.performed === false || value?.outcomeKind === 'pre-effect-failure'
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  podCancel: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.cancelled === true
        ? 'performed' : value?.cancelled === false || value?.ok === false
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  spill: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : typeof value === 'string' && value.length > 0
        ? 'performed' : value?.ok === false ? 'not-performed' : 'unknown',
    rejected,
  }),
  confirmation: Object.freeze({
    fulfilled: (/** @type {unknown} */ value) => value === true
      || value === 'yes_once' || value === 'yes_session'
      ? 'performed' : 'not-performed',
    rejected: () => 'not-performed',
  }),
  dwebPublish: Object.freeze({
    // A local Git release can be durable even when mesh publication or later
    // metadata settlement fails. The authority, never `{ok:false}`, owns that fact.
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.performed === true || value?.ok === true
        || value?.outcomeKind === 'effect-completed'
        ? 'performed' : value?.performed === false || value?.ok === false
          || value?.outcomeKind === 'pre-effect-failure'
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  dwebInstall: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.performed === true || value?.ok === true
        || value?.outcomeKind === 'effect-completed'
        ? 'performed' : value?.performed === false || value?.ok === false
          || value?.outcomeKind === 'pre-effect-failure'
          ? 'not-performed' : 'unknown',
    rejected,
  }),
  // Finite handler-owned contracts. Keeping the names at the exact domain
  // boundary prevents a future arbitrary fulfillment from borrowing a generic
  // "fulfilled means performed" rule.
  podExecution: completedExactEffect,
  podMutation: completedExactEffect,
  repositoryMutation: completedExactEffect,
  vmExecution: completedExactEffect,
  vmMutation: completedExactEffect,
  notebookMutation: completedExactEffect,
  appOpen: completedExactEffect,
  appUpdate: recordMutation,
  appDelete: booleanMutation,
  appMutation: completedExactEffect,
  appAction: refusalAwareExactEffect,
  programRun: refusalAwareExactEffect,
  actorMessage: closedOkEffect,
  dwebPolicyMutation: closedOkEffect,
  scheduleCancel: booleanMutation,
});
