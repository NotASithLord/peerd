// @ts-check
// Authority-kernel bridge for the pure orchestrator loop hosted by the sealed
// semantic controller. The controller receives transcript text and opaque
// binary references; every effect and every authority-bearing lookup stays in
// this service-worker closure.

import { normalizeExactEffectOutcome } from '../shared/exact-effect-outcome.js';
import {
  authorityReceiptsForCall,
  HOST_CONFIRMATION_DECLINED,
  HOST_EFFECT_OUTCOME,
  hostEffectValueIsRefusal,
  safeHostEffectFailure,
  safeHostPolicyAttribution,
  stampAuthorityToolResult,
  stampAuthorityToolResultBlock,
} from './host-effect-verdict.js';
import { semanticCallAuditEntry } from './semantic-call-audit.js';
import { parsePodShell, podGitRemoteIntents } from '/peerd-engine/authority.js';
import { bindRepositoryToolAuthority } from './repository-tool-authority.js';
import { bindVmToolAuthority } from './vm-tool-authority.js';
import { bindNotebookToolAuthority } from './notebook-tool-authority.js';
import { bindAppToolAuthority } from './app-tool-authority.js';
import { bindPersistenceToolAuthority } from './persistence-tool-authority.js';
import { bindPageToolAuthority } from './page-tool-authority.js';
import { bindResourceToolAuthority } from './resource-tool-authority.js';
import { bindSiteClientToolAuthority } from './site-client-tool-authority.js';
import { bindExecutionToolAuthority } from './execution-tool-authority.js';
import { bindEditingToolAuthority } from './editing-tool-authority.js';
import { bindIntrospectionToolAuthority } from './introspection-tool-authority.js';
import { bindScheduleToolAuthority } from './schedule-tool-authority.js';
import { bindDwebToolAuthority } from './dweb-tool-authority.js';
import {
  controllerDomainOperationPayloadCap,
  controllerDomainOperationPolicy,
  controllerOperationAllowedInPermissionMode,
  controllerOperationRequiresConfirmation,
  ORCHESTRATOR_OPERATION_GRANT,
} from '../shared/controller-kernel-quota.js';
import { createAuthorityEffectScheduler } from './authority-effect-scheduler.js';
import { authorityEffectResourceKey } from './authority-effect-resource.js';
import { canonicalCloneDigest } from '../shared/canonical-clone-digest.js';
import { authorityEffectConfirmationPresentation } from '../shared/authority-confirmation-presentation.js';
import {
  createReadOnlyOperationGrant,
  projectControllerTurnAuthorityClass,
  projectControllerTurnBridgeAuthority,
  snapshotControllerTurnAuthorityBinding,
} from './controller-turn-authority-scope.js';

const TURN_EVENT_QUEUE_CAP = 8;
const OPAQUE_PREFIX = 'peerd-controller-opaque:';
const ABORT_CLEANUP_OPERATIONS = new Set([
  'turn.model.cancel-inference', 'turn.model.cancel-local',
  'turn.abort.finalize', 'turn.finalize',
]);
const ORCHESTRATOR_OPERATION_SET = new Set(ORCHESTRATOR_OPERATION_GRANT);

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value !== null
  && typeof value === 'object' && !Array.isArray(value);

const exactOptionalKeys = (
  /** @type {Record<string,any>|null} */ value,
  /** @type {string[]} */ required,
  /** @type {string[]} */ optional = [],
) => !!value && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

const projectedOperationSet = (/** @type {unknown} */ value) => {
  if (!Array.isArray(value) || value.length > ORCHESTRATOR_OPERATION_GRANT.length
      || value.some((operation) => typeof operation !== 'string'
        || !ORCHESTRATOR_OPERATION_SET.has(operation))) return null;
  return new Set(value);
};

const projectedToolNameSet = (/** @type {unknown} */ value) => {
  if (!Array.isArray(value) || value.length > 512) return null;
  const names = new Set();
  for (const tool of value) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name
        || names.has(tool.name)) return null;
    names.add(tool.name);
  }
  return names;
};

/** @param {unknown} left @param {unknown} right */
const sameClone = (left, right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
};

const known = (/** @type {unknown} */ value) => ({
  ok: true, value, outcomeKnown: true,
});
const failed = (/** @type {unknown} */ cause, /** @type {boolean} */ outcomeKnown) => ({
  ok: false,
  code: 'turn-kernel-call-failed',
  error: cause instanceof Error ? cause.message : String(cause),
  outcomeKnown,
});
const jsonWire = (/** @type {unknown} */ value) => JSON.stringify(value);
const jsonUnwire = (/** @type {unknown} */ value, /** @type {string} */ label) => {
  if (typeof value !== 'string') throw new Error(`${label} wire payload is invalid`);
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} wire payload is invalid`); }
};
const digestJson = async (/** @type {unknown} */ value) => {
  const bytes = new TextEncoder().encode(jsonWire(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
const unknown = (/** @type {any} */ run, /** @type {unknown} */ cause) => {
  run.nestedUnknown = true;
  return { ...failed(cause, false), retryable: false };
};

const makeEventQueue = () => {
  /** @type {{value:unknown,ack:()=>void}[]} */
  const values = [];
  /** @type {Array<(value:{done:boolean,value?:unknown,ack?:()=>void})=>void>} */
  const readers = [];
  /** @type {Array<()=>void>} */
  const writers = [];
  /** @type {Set<()=>void>} */
  const acks = new Set();
  let closed = false;
  const releaseWriter = () => writers.shift()?.();
  return {
    push: async (/** @type {unknown} */ value) => {
      if (closed) throw new Error('turn event stream is closed');
      let resolveAck = () => {};
      const acked = new Promise((resolve) => { resolveAck = () => resolve(undefined); });
      let settled = false;
      const ack = () => {
        if (settled) return;
        settled = true;
        acks.delete(ack);
        resolveAck();
      };
      acks.add(ack);
      const entry = { value, ack };
      if (readers.length > 0) {
        readers.shift()?.({ done: false, ...entry });
        await acked;
        return;
      }
      while (values.length >= TURN_EVENT_QUEUE_CAP && !closed) {
        await new Promise((resolve) => {
          writers.push(() => resolve(undefined));
        });
      }
      if (closed) { ack(); throw new Error('turn event stream is closed'); }
      values.push(entry);
      await acked;
    },
    next: () => {
      if (values.length > 0) {
        const entry = values.shift();
        releaseWriter();
        return Promise.resolve({ done: false, ...entry });
      }
      if (closed) return Promise.resolve({ done: true });
      return new Promise((resolve) => readers.push(resolve));
    },
    close: () => {
      if (closed) return;
      closed = true;
      while (readers.length > 0) readers.shift()?.({ done: true });
      while (writers.length > 0) releaseWriter();
      for (const ack of [...acks]) ack();
      values.length = 0;
    },
  };
};

/** @param {Record<string, any>} ctx */
const controllerCtx = (ctx) => {
  const keys = [
    'userText', 'synthetic', 'resume', 'previousTurnAt', 'turnNow',
    'activeTabContext', 'protectedTabContext', 'recoveryBlock',
    'reasoningEnabled', 'reasoningEffort',
    'actorReply', 'contextWindow', 'oneShot', 'maxSteps', 'persistDeltas',
    'preflightReply', 'runtimeCapabilities', 'providerFailoverEnabled',
    'providerFallbacks', 'contextWindowOverrides', 'pricingOverrides',
    'semanticPolicy',
  ];
  const out = /** @type {Record<string, unknown>} */ ({});
  for (const key of keys) if (ctx[key] !== undefined) out[key] = ctx[key];
  return out;
};

/**
 * @param {Object} deps
 * @param {() => Promise<{call:(capability:string,payload:unknown,options?:any)=>Promise<any>}>} deps.getClient
 * @param {() => string} [deps.newId]
 * @param {(value:unknown,options?:{maxBytes?:number})=>Promise<string>} [deps.digestArgs]
 * @param {ReturnType<import('./provider-egress-authority.js').createProviderEgressAuthority>}
 *   [deps.providerEgress]
 * @param {ReturnType<typeof createAuthorityEffectScheduler>} [deps.authorityScheduler]
 * @param {number} [deps.cleanupTimeoutMs]
 */
export const makeControllerTurnBridge = ({
  getClient,
  newId = () => crypto.randomUUID(),
  digestArgs = canonicalCloneDigest,
  providerEgress,
  authorityScheduler = createAuthorityEffectScheduler(),
  cleanupTimeoutMs = 250,
}) => {
  /** @type {Map<string, any>} */
  const runs = new Map();
  /** @type {Map<string, number>} */
  const sessionGenerations = new Map();
  const runIsLive = (/** @type {any} */ run) =>
    runs.get(run.runId) === run && run.signal.aborted !== true;
  const ensureAuthorityBinding = async (/** @type {any} */ run) => {
    if (run.authorityBindingReady) return run.authorityBindingReady;
    if (typeof run.loadAuthorityContext !== 'function') {
      throw new TypeError('turn authority context loader unavailable');
    }
    run.authorityBindingReady = Promise.resolve().then(() =>
      run.loadAuthorityContext()).then((value) => {
      // why: take one stable host snapshot without copying transcript, prompt,
      // projection, or controller-owned callbacks into the privileged root.
      // Exact class scopes below can only narrow this fixed binding.
      run.authorityBinding = snapshotControllerTurnAuthorityBinding(value, {
        sessionId: run.sessionId,
        operationGrant: run.ctx.operationGrant,
        abortSignal: run.signal,
      });
      return run.authorityBinding;
    });
    return run.authorityBindingReady;
  };
  const authorityContextForOperation = (/** @type {any} */ run,
    /** @type {string} */ operation) => {
    const policy = controllerDomainOperationPolicy(operation);
    if (!policy) return null;
    if (!run.authorityBinding) return null;
    const cached = run.authorityScopes.get(policy.authorityClass);
    if (cached) return cached;
    // why: the semantic caller chooses no host object and no selector. The
    // bridge's fixed operation policy admits one authority class, then exposes
    // only that class's named dependencies to its exact in-kernel binder.
    const scope = projectControllerTurnAuthorityClass(
      run.authorityBinding, policy.authorityClass,
    );
    if (!scope) return null;
    run.authorityScopes.set(policy.authorityClass, scope);
    return scope;
  };
  const authorityBridgeContext = (/** @type {any} */ run) => {
    if (!run.authorityBinding) return null;
    if (run.authorityBridge) return run.authorityBridge;
    // why: lifecycle tracking never enters a domain binder. Confirmation and
    // live permission remain duplicated only where an exact domain requires
    // its own final-edge recheck; receipts and audit stay in this bridge.
    run.authorityBridge = projectControllerTurnBridgeAuthority(run.authorityBinding);
    return run.authorityBridge;
  };
  const cleanupFuseMs = Number.isFinite(cleanupTimeoutMs) && cleanupTimeoutMs > 0
    ? Math.floor(cleanupTimeoutMs) : 250;
  const boundedCleanup = (/** @type {Promise<unknown>} */ pending) =>
    new Promise((resolve) => {
      let finished = false;
      const finish = (/** @type {unknown} */ value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), cleanupFuseMs);
      pending.then(finish, () => finish(undefined));
    });
  const openProviderCustody = async (
    /** @type {any} */ run,
    /** @type {()=>Promise<any>} */ open,
  ) => {
    let result;
    try {
      result = await open();
    } finally {
      // why: even a rejected admission may have made owner-scoped provider
      // state visible before failing. Advance custody so finalization cannot
      // reuse a close that completed while the admission was still pending.
      run.providerCustodyGeneration += 1;
      if (run.signal.aborted) await closeProviderOwner(run);
    }
    if (!run.signal.aborted) return result;
    return { ok: false, code: 'turn-run-aborted', outcomeKnown: true };
  };


  const mintOpaque = (
    /** @type {any} */ run,
    /** @type {'attachment'|'tool-image'} */ kind,
    /** @type {string} */ value,
  ) => {
    const token = `${OPAQUE_PREFIX}${run.runId}:${newId()}`;
    run.opaque.set(token, { kind, value });
    return token;
  };
  const externalizeAttachments = (/** @type {any} */ run, /** @type {unknown} */ attachments) =>
    Array.isArray(attachments) ? attachments.map((attachment) => {
      if (!isRecord(attachment) || attachment.data === undefined) return attachment;
      if (typeof attachment.data !== 'string') {
        throw new Error('binary attachment must remain kernel-owned');
      }
      return { ...attachment, data: mintOpaque(run, 'attachment', attachment.data) };
    }) : attachments;
  const externalizeToolResult = (/** @type {any} */ run, /** @type {unknown} */ result) => {
    if (!isRecord(result) || !Array.isArray(result.images)) return result;
    return {
      ...result,
      images: result.images.map((image) => {
        if (!isRecord(image) || image.data === undefined) return image;
        if (typeof image.data !== 'string') {
          throw new Error('binary tool image must remain kernel-owned');
        }
        return { ...image, data: mintOpaque(run, 'tool-image', image.data) };
      }),
    };
  };
  const redeem = (
    /** @type {any} */ run,
    /** @type {unknown} */ token,
    /** @type {'attachment'|'tool-image'} */ kind,
  ) => {
    if (typeof token !== 'string') return token;
    const opaque = run.opaque.get(token);
    return opaque?.kind === kind ? opaque.value : token;
  };
  const rehydrateData = (
    /** @type {any} */ run,
    /** @type {Record<string, any>} */ value,
    /** @type {'attachment'|'tool-image'} */ kind,
  ) => value.data === undefined
    ? value : { ...value, data: redeem(run, value.data, kind) };
  const rehydrateImages = (/** @type {any} */ run, /** @type {unknown} */ images) =>
    Array.isArray(images) ? images.map((image) => isRecord(image)
      ? rehydrateData(run, image, 'tool-image') : image) : images;
  const stampLiveToolResult = (
    /** @type {any} */ run,
    /** @type {unknown} */ callId,
    /** @type {Record<string,any>} */ result,
  ) => {
    const receipts = authorityReceiptsForCall(run.effectReceipts, callId);
    return stampAuthorityToolResult(receipts, result);
  };
  const stampStoredToolResult = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ block,
  ) => {
    const receipts = authorityReceiptsForCall(run.effectReceipts, block.tool_use_id);
    return stampAuthorityToolResultBlock(receipts, block);
  };
  const closeSemanticCall = async (
    /** @type {any} */ run, /** @type {string} */ callId,
  ) => {
    if (run.completedSemanticCalls.has(callId)) return;
    const existing = run.closingSemanticCallPromises.get(callId);
    if (existing) return existing;
    run.closingSemanticCalls.add(callId);
    const closing = (async () => {
      // why: closing rejects new exact claims synchronously. Drain the already
      // accepted host work for only this semantic call before any controller
      // result can be stamped, persisted, or shown.
      while (true) {
        const active = [...(run.dispatchesByCall.get(callId) ?? [])];
        if (active.length === 0) break;
        await Promise.allSettled(active);
      }
      const claimed = run.claimedEffectsByCall.get(callId) ?? new Map();
      for (const [effectId, operation] of claimed) {
        if (run.effectReceipts.has(effectId)) continue;
        run.nestedUnknown = true;
        run.effectReceipts.set(effectId, Object.freeze({
          callId, effectId, operation, outcome: 'unknown', outcomeKnown: false,
          performed: false, retryable: false, code: 'authority_receipt_missing',
          error: 'An accepted authority claim ended without a host outcome receipt.',
        }));
      }
      run.completedSemanticCalls.add(callId);
      run.semanticCallState.delete(callId);
      run.dispatchesByCall.delete(callId);
    })();
    run.closingSemanticCallPromises.set(callId, closing);
    try { await closing; }
    finally { run.closingSemanticCallPromises.delete(callId); }
  };
  const rehydrateEvent = async (/** @type {any} */ run, /** @type {unknown} */ event) => {
    if (!isRecord(event) || event.type !== 'tool-result' || !isRecord(event.result)) return event;
    if (typeof event.toolUseId === 'string') {
      await closeSemanticCall(run, event.toolUseId);
    }
    const result = {
      ...event,
      result: stampLiveToolResult(run, event.toolUseId, {
        ...event.result, images: rehydrateImages(run, event.result.images),
      }),
    };
    return result;
  };
  const rehydrateMessage = async (/** @type {any} */ run, /** @type {unknown} */ message) => {
    if (!isRecord(message)) return message;
    const toolResults = Array.isArray(message.toolResults) ? message.toolResults : [];
    const rawCallIds = toolResults.map((result) => isRecord(result)
      && typeof result.tool_use_id === 'string' ? result.tool_use_id : null);
    const callIds = [...new Set(rawCallIds.filter((callId) => callId !== null))];
    if (rawCallIds.includes(null) || callIds.length !== rawCallIds.length
        || callIds.some((callId) => !run.modelToolCalls.has(callId)
          || run.persistedSemanticCalls.has(callId))) {
      throw new Error('session tool result does not reference a model-issued call');
    }
    // why: transcript persistence is an authority boundary too. A controller
    // cannot append its result before the exact host effects it started have
    // closed and been stamped into the durable block.
    await Promise.all(callIds.map((callId) => closeSemanticCall(run, callId)));
    return {
      ...message,
      ...(Array.isArray(message.attachments) ? {
        attachments: message.attachments.map((attachment) => isRecord(attachment)
          ? rehydrateData(run, attachment, 'attachment')
          : attachment),
      } : {}),
      ...(toolResults.length > 0 ? {
        toolResults: toolResults.map((result) => isRecord(result)
          ? stampStoredToolResult(run, {
            ...result, images: rehydrateImages(run, result.images),
          }) : result),
      } : {}),
    };
  };
  const externalizeSession = (/** @type {any} */ run, /** @type {unknown} */ session) => {
    if (!isRecord(session) || !Array.isArray(session.messages)) return session;
    return {
      ...session,
      messages: session.messages.map((message) => {
        if (!isRecord(message)) return message;
        return {
          ...message,
          ...(Array.isArray(message.attachments)
            ? { attachments: externalizeAttachments(run, message.attachments) } : {}),
          ...(Array.isArray(message.toolResults) ? {
            toolResults: message.toolResults.map((result) => externalizeToolResult(run, result)),
          } : {}),
        };
      }),
    };
  };
  const externalizeSessionWire = (/** @type {any} */ run, /** @type {unknown} */ session) =>
    jsonWire(externalizeSession(run, session));
  const setTools = (/** @type {any} */ run, /** @type {unknown} */ tools) => {
    run.tools = Array.isArray(tools) ? tools : [];
  };
  const runAuthorityOperation = async (
    /** @type {any} */ run,
    /** @type {string} */ operation,
    /** @type {()=>Promise<any>|any} */ execute,
    /** @type {string|null} */ callId = null,
  ) => {
    const policy = controllerDomainOperationPolicy(operation);
    if (!policy || !run.allowedOperations.has(operation)) {
      return failed('domain authority operation is not granted', true);
    }
    const pending = (async () => {
      if (!runIsLive(run)) return failed('domain authority run is not live', true);
      return execute();
    })();
    run.activeDispatches.add(pending);
    if (policy.riskClass === 'read') run.activeSafeDispatches.add(pending);
    const callDispatches = typeof callId === 'string'
      ? run.dispatchesByCall.get(callId) ?? new Set() : null;
    if (callDispatches) {
      callDispatches.add(pending);
      run.dispatchesByCall.set(callId, callDispatches);
    }
    try { return await pending; }
    finally {
      run.activeDispatches.delete(pending);
      run.activeSafeDispatches.delete(pending);
      callDispatches?.delete(pending);
      if (callDispatches?.size === 0) run.dispatchesByCall.delete(callId);
    }
  };
  const performSemanticEffect = async (
    /** @type {any} */ run,
    /** @type {{callId:string,effectId:string}} */ effect,
    /** @type {string} */ operation,
    /** @type {string|null} */ target,
    /** @type {()=>Promise<any>|any} */ execute,
    /** @type {{fulfilled?:(value:any)=>unknown,rejected?:(cause:unknown)=>unknown}|null} */ effectOutcome = null,
    /** @type {any} */ tracking = null,
    /** @type {string|null} */ schedulerTarget = target,
    /** @type {{args:unknown,confirmed:boolean,confirmedIntentRequired:boolean}|null} */ dispatchAdmission = null,
  ) => {
    const policy = controllerDomainOperationPolicy(operation);
    const authorityCtx = authorityBridgeContext(run);
    if (!authorityCtx) return failed('domain authority context unavailable', true);
    const replayable = policy?.riskClass === 'read';
    if (!replayable && (typeof effectOutcome?.fulfilled !== 'function'
        || typeof effectOutcome?.rejected !== 'function')) {
      return failed('domain effect verdict contract is unavailable', true);
    }
    try {
      const result = await authorityScheduler.run({
        read: policy?.riskClass === 'read', target: schedulerTarget ?? operation,
        signal: run.signal,
      }, async () => {
        if (!runIsLive(run)) throw Object.assign(
          new Error('authority effect stopped before host dispatch'),
          { outcomeKnown: true, retryable: false },
        );
        if (dispatchAdmission) {
          const livePermission = typeof authorityCtx.readAuthorityPermission === 'function'
            ? await authorityCtx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
            : authorityCtx.permission;
          if (!controllerOperationAllowedInPermissionMode(
            operation, livePermission?.mode, dispatchAdmission.args,
          )) throw Object.assign(
            new Error('permission changed while the authority effect was queued'),
            { code: 'plan_mode_refused', outcomeKnown: true, retryable: false },
          );
          const confirmationRequired = controllerOperationRequiresConfirmation(
            operation, livePermission, dispatchAdmission.args,
            dispatchAdmission.confirmedIntentRequired,
          );
          if (confirmationRequired && dispatchAdmission.confirmed !== true) {
            throw Object.assign(
              new Error('confirmation policy changed while the authority effect was queued'),
              { code: 'confirmation_required', outcomeKnown: true, retryable: true },
            );
          }
          if (!runIsLive(run)) throw Object.assign(
            new Error('authority effect stopped before host dispatch'),
            { outcomeKnown: true, retryable: false },
          );
        }
        return execute();
      });
      const verdict = typeof effectOutcome?.fulfilled === 'function'
        ? normalizeExactEffectOutcome(effectOutcome.fulfilled(result))
        : 'not-performed';
      const confirmationStage = effectOutcome === HOST_EFFECT_OUTCOME.confirmation;
      const policyAttribution = safeHostPolicyAttribution(result);
      const confirmationDeclined = confirmationStage && verdict === 'not-performed';
      const refusal = confirmationDeclined
        || verdict === 'not-performed' && hostEffectValueIsRefusal(result);
      const refusalFailure = confirmationDeclined
        ? HOST_CONFIRMATION_DECLINED : safeHostEffectFailure(result);
      const performed = !confirmationStage && (verdict === 'performed'
        || verdict === 'unknown' && result?.performed === true);
      const receiptOutcome = confirmationStage && verdict === 'performed'
        ? 'observed' : replayable && effectOutcome === null ? 'observed' : verdict;
      if (!replayable && verdict === 'unknown') run.nestedUnknown = true;
      const receipt = Object.freeze({
        effectId: effect.effectId, operation,
        outcome: receiptOutcome,
        outcomeKnown: verdict !== 'unknown',
        performed,
        retryable: refusal && refusalFailure.retryable,
        ...(refusal ? { refused: true, ...refusalFailure } : {}),
        ...policyAttribution,
        ...(target ? { target } : {}),
      });
      run.effectReceipts.set(effect.effectId, { ...receipt, callId: effect.callId });
      if (tracking && typeof authorityCtx.lifecycle?.settleTracking === 'function') {
        await authorityCtx.lifecycle.settleTracking(tracking, {
          ok: verdict === 'performed' || verdict === 'not-performed' && !refusal,
          outcomeKind: verdict === 'performed' ? 'effect-completed'
            : verdict === 'unknown' ? 'host-lost'
              : refusal ? 'pre-effect-failure' : undefined,
        }).catch(() => null);
      }
      await run.ctx.appendAudit({
        type: 'authority_effect', sessionId: run.sessionId,
        details: {
          operation, outcome: receiptOutcome,
          outcomeKnown: receipt.outcomeKnown === true,
          performed: receipt.performed === true,
          refused: receipt.refused === true,
          retryable: receipt.retryable === true,
          ...(typeof receipt.code === 'string' ? { code: receipt.code } : {}),
          ...policyAttribution,
          ...(target ? { target } : {}), runId: run.runId,
        },
      }).catch(() => {});
      return verdict === 'unknown' ? unknown(run, 'authority effect outcome is unknown')
        : known({ authorityValue: result, authorityReceipt: receipt });
    } catch (cause) {
      const verdict = typeof effectOutcome?.rejected === 'function'
        ? normalizeExactEffectOutcome(effectOutcome.rejected(cause))
        : 'not-performed';
      const outcomeKnown = replayable || verdict !== 'unknown';
      if (!outcomeKnown) run.nestedUnknown = true;
      const detail = /** @type {{retryable?:boolean}} */ (cause);
      const failure = safeHostEffectFailure(cause);
      const performed = verdict === 'performed'
        || verdict === 'unknown'
          && /** @type {{performed?:unknown}} */ (cause)?.performed === true;
      const safeError = verdict === 'not-performed'
        ? failure.error ?? failure.code ?? 'Authority operation was refused before execution.'
        : verdict === 'performed'
          ? 'Authority operation failed after an effect was performed.'
          : 'Authority operation outcome is unknown.';
      const receiptOutcome = replayable && effectOutcome === null && verdict !== 'unknown'
        ? 'observed' : verdict;
      const receipt = Object.freeze({
        effectId: effect.effectId, operation, outcome: receiptOutcome,
        outcomeKnown, performed,
        retryable: verdict === 'not-performed' && detail?.retryable !== false,
        ...(verdict === 'not-performed' ? { refused: true, ...failure } : {}),
        ...(target ? { target } : {}),
      });
      run.effectReceipts.set(effect.effectId, { ...receipt, callId: effect.callId });
      if (tracking && typeof authorityCtx.lifecycle?.settleTracking === 'function') {
        await authorityCtx.lifecycle.settleTracking(tracking, {
          ok: verdict === 'performed',
          error: safeError,
          outcomeKind: verdict === 'performed' ? 'effect-completed'
            : verdict === 'unknown' ? 'host-lost' : 'pre-effect-failure',
        }).catch(() => null);
      }
      await run.ctx.appendAudit({
        type: 'authority_effect_failed', sessionId: run.sessionId,
        details: {
          operation, outcome: verdict,
          outcomeKnown: receipt.outcomeKnown === true,
          performed: receipt.performed === true,
          refused: receipt.refused === true,
          retryable: receipt.retryable === true,
          ...(typeof receipt.code === 'string' ? { code: receipt.code } : {}),
          ...(target ? { target } : {}), runId: run.runId,
        },
      }).catch(() => {});
      return {
        ok: false, code: 'domain-authority-operation-lost',
        error: safeError,
        outcomeKnown, retryable: verdict === 'not-performed' && detail?.retryable !== false,
        authorityReceipt: receipt,
      };
    }
  };
  const runSemanticEffect = async (
    /** @type {any} */ run,
    /** @type {{callId:string,effectId:string}} */ effect,
    /** @type {string} */ operation,
    /** @type {string|null} */ target,
    /** @type {()=>Promise<any>|any} */ execute,
    /** @type {{fulfilled?:(value:any)=>unknown,rejected?:(cause:unknown)=>unknown}|null} */ effectOutcome = null,
    /** @type {any} */ tracking = null,
    /** @type {string|null} */ schedulerTarget = target,
  ) => runAuthorityOperation(run, operation, () => performSemanticEffect(
    run, effect, operation, target, execute, effectOutcome, tracking, schedulerTarget,
  ), effect.callId);
  const durableAuthorityTarget = async (
    /** @type {any} */ run,
    /** @type {string} */ operation,
    /** @type {unknown} */ args,
  ) => {
    const ctx = await authorityContextForOperation(run, operation);
    if (!ctx) throw new TypeError('domain authority context unavailable');
    const actorKind = typeof ctx?.actorType === 'string' ? ctx.actorType : 'orchestrator';
    const actorInstance = typeof ctx?.actorInstanceId === 'string'
      ? ctx.actorInstanceId : 'session';
    const tabId = Number.isInteger(ctx?.activeTab?.id) ? String(ctx.activeTab.id) : 'no-tab';
    // why: lifecycle recovery must match the same exact intent after a Worker
    // restart or a new model-call id, without persisting code, content, or other
    // sensitive arguments in the target label. The digest covers final
    // post-hook arguments; the SW-owned actor/tab scope prevents cross-instance
    // redemption of an otherwise identical request.
    return `${operation}:${actorKind}:${actorInstance}:${tabId}:${await digestArgs(args, {
      maxBytes: controllerDomainOperationPayloadCap(operation),
    })}`;
  };
  const authorityTool = (
    /** @type {string} */ operation,
    /** @type {string} */ retryClass,
  ) => {
    const policy = controllerDomainOperationPolicy(operation);
    return Object.freeze({
      name: operation, primitive: 'authority', retryClass,
      sideEffect: policy?.riskClass === 'read' ? 'read'
        : policy?.riskClass === 'resource' ? 'mutate_external' : 'write',
    });
  };
  const beginAuthorityTracking = async (
    /** @type {any} */ run,
    /** @type {{callId:string,effectId:string}} */ effect,
    /** @type {string} */ operation,
    /** @type {string} */ target,
    /** @type {unknown} */ args,
    /** @type {string} */ retryClass,
    /** @type {boolean} */ confirmed,
    /** @type {any} */ confirmedIntent,
  ) => {
    const authorityCtx = authorityBridgeContext(run);
    if (!authorityCtx || typeof authorityCtx.lifecycle?.beginTracking !== 'function') {
      return { refuseValue: {
        ok: false, code: 'authority_lifecycle_unavailable',
        error: 'Authority lifecycle is unavailable.', retryable: false,
      } };
    }
    const begun = await authorityCtx.lifecycle.beginTracking({
      callId: effect.effectId,
      tool: authorityTool(operation, retryClass),
      sessionId: run.sessionId,
      ownerSessionId: authorityCtx.lifecycleOwnerSessionId ?? run.sessionId,
      target, args, confirmed, confirmedIntent,
      turnId: authorityCtx.lifecycleTurnId,
      userInitiated: authorityCtx.lifecycleUserInitiated,
    });
    return begun?.refuse ? { refuseValue: {
      ok: false, error: begun.refuse.error,
      ...(begun.refuse.recovery ? { recovery: begun.refuse.recovery } : {}),
      retryable: false,
    } } : { tracking: begun?.handle ?? null };
  };
  const prepareAuthorityEffect = async (
    /** @type {any} */ run,
    /** @type {{callId:string,effectId:string}} */ effect,
    /** @type {string} */ operation,
    /** @type {string} */ target,
    /** @type {unknown} */ args,
    /** @type {string} */ _summary,
  ) => {
    const policy = controllerDomainOperationPolicy(operation);
    const authorityCtx = authorityBridgeContext(run);
    if (!authorityCtx) return { refuse: failed('domain authority context unavailable', true) };
    const livePermission = typeof authorityCtx.readAuthorityPermission === 'function'
      ? await authorityCtx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
      : authorityCtx.permission;
    if (!controllerOperationAllowedInPermissionMode(
      operation, livePermission?.mode, args,
    )) {
      return { refuse: await performSemanticEffect(
        run, effect, operation, target,
        () => ({
          ok: false, code: 'plan_mode_refused',
          error: 'plan mode is read-only for this authority operation', retryable: false,
        }),
        HOST_EFFECT_OUTCOME.okResult,
      ) };
    }
    const retryClass = typeof policy?.retryClass === 'string' ? policy.retryClass : 'E';
    const tool = authorityTool(operation, retryClass);
    const confirmedIntent = await Promise.resolve(
      authorityCtx.lifecycle?.requiresIntentConfirmation?.({
        tool, sessionId: run.sessionId,
        ownerSessionId: authorityCtx.lifecycleOwnerSessionId ?? run.sessionId,
        target, args, userInitiated: authorityCtx.lifecycleUserInitiated,
      }),
    ).catch(() => false);
    const mustConfirm = controllerOperationRequiresConfirmation(
      operation, livePermission, args, confirmedIntent?.required === true,
    );
    let confirmed = false;
    if (mustConfirm) {
      if (typeof authorityCtx.confirm !== 'function') {
        return { refuse: await performSemanticEffect(
          run, effect, operation, target,
          () => ({ ok: false, error: 'confirmation_unavailable', retryable: false }),
          HOST_EFFECT_OUTCOME.okResult,
        ) };
      }
      const presentation = authorityEffectConfirmationPresentation(operation, args, target);
      if (!presentation) {
        return { refuse: await performSemanticEffect(
          run, effect, operation, target,
          () => ({
            ok: false, code: 'confirmation_presentation_unavailable',
            error: 'authority confirmation target cannot be presented safely', retryable: false,
          }),
          HOST_EFFECT_OUTCOME.okResult,
        ) };
      }
      let answer;
      try {
        answer = await authorityCtx.confirm({
          tool: operation,
          sideEffect: policy?.riskClass === 'resource' ? 'mutate_external' : 'write',
          origins: [...presentation.origins], sessionId: run.sessionId,
          ...(confirmedIntent?.required === true ? { lifecycleTarget: target } : {}),
          oneShot: confirmedIntent && confirmedIntent.required === true ? true : undefined,
          summary: presentation.summary,
        }, run.signal);
      } catch {
        return { refuse: await performSemanticEffect(
          run, effect, operation, target,
          () => ({
            ok: false, code: 'confirmation_failed',
            error: 'Authority confirmation could not be completed.', retryable: false,
          }),
          HOST_EFFECT_OUTCOME.okResult,
        ) };
      }
      if (!runIsLive(run)) {
        return { refuse: await performSemanticEffect(
          run, effect, operation, target,
          () => ({ ok: false, error: 'authority_effect_aborted' }),
          HOST_EFFECT_OUTCOME.okResult,
        ) };
      }
      confirmed = answer === true || answer === 'yes_once' || answer === 'yes_session';
      if (!confirmed) {
        return { refuse: await performSemanticEffect(
          run, effect, operation, target,
          () => ({ ok: false, error: 'declined', retryable: false }),
          HOST_EFFECT_OUTCOME.okResult,
        ) };
      }
    }
    const dispatchPermission = typeof authorityCtx.readAuthorityPermission === 'function'
      ? await authorityCtx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
      : authorityCtx.permission;
    if (!controllerOperationAllowedInPermissionMode(
      operation, dispatchPermission?.mode, args,
    )) {
      return { refuse: await performSemanticEffect(
        run, effect, operation, target,
        () => ({
          ok: false, code: 'plan_mode_refused',
          error: 'permission changed before authority dispatch', retryable: false,
        }),
        HOST_EFFECT_OUTCOME.okResult,
      ) };
    }
    const begun = await beginAuthorityTracking(
      run, effect, operation, target, args, retryClass, confirmed, confirmedIntent,
    );
    if (begun.refuseValue) return { refuse: await performSemanticEffect(
      run, effect, operation, target, () => begun.refuseValue,
      HOST_EFFECT_OUTCOME.okResult,
    ) };
    if (!runIsLive(run)) {
      return { refuse: await performSemanticEffect(
        run, effect, operation, target,
        () => ({ ok: false, error: 'authority_effect_aborted' }),
        HOST_EFFECT_OUTCOME.okResult, begun.tracking,
      ) };
    }
    return {
      tracking: begun.tracking,
      dispatchAdmission: {
        args, confirmed,
        confirmedIntentRequired: confirmedIntent?.required === true,
      },
    };
  };
  const semanticEffectEnvelopeAllowed = (
    /** @type {any} */ run,
    /** @type {Record<string, any>} */ value,
    /** @type {string} */ operation,
  ) => typeof value.callId === 'string'
    && typeof value.effectId === 'string'
    && Number.isSafeInteger(value.effectSequence)
    && value.effectSequence >= 1 && value.effectSequence <= 256
    && value.effectId === `${value.callId}:${value.effectSequence}`
    && value.turnGeneration === run.turnGeneration
    && !run.semanticEffectIds.has(value.effectId)
    && run.allowedOperations.has(operation)
    && !run.completedSemanticCalls.has(value.callId)
    && !run.closingSemanticCalls.has(value.callId)
    && run.finalizing !== true
    && run.modelToolCalls.has(value.callId);
  const claimSemanticEffect = (
    /** @type {any} */ run,
    /** @type {Record<string, any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ businessKeys,
    /** @type {string[]} */ optionalKeys = [],
  ) => {
    if (!exactOptionalKeys(value, [
      'callId', 'effectId', 'effectSequence', 'turnGeneration', ...businessKeys,
    ], optionalKeys)
        || !semanticEffectEnvelopeAllowed(run, value, operation)) return null;
    run.semanticEffectIds.add(value.effectId);
    const claimed = run.claimedEffectsByCall.get(value.callId) ?? new Map();
    claimed.set(value.effectId, operation);
    run.claimedEffectsByCall.set(value.callId, claimed);
    let state = run.semanticCallState.get(value.callId);
    if (!state) {
      state = { domainState: {}, domainCalls: new Set() };
      run.semanticCallState.set(value.callId, state);
    }
    return {
      callId: value.callId, effectId: value.effectId,
      ctx: run.ctx, domainState: state.domainState, domainCalls: state.domainCalls,
    };
  };
  const closeProviderOwner = (/** @type {any} */ run) => {
    // why: bridge shutdown and ordinary turn finalization can race. One exact
    // bounded close per custody generation makes cleanup idempotent without
    // masking a stream admitted after Stop's prior close already settled.
    if (run.providerClose
        && run.providerCloseGeneration === run.providerCustodyGeneration) {
      return run.providerClose;
    }
    run.providerCloseGeneration = run.providerCustodyGeneration;
    run.providerClose = providerEgress?.closeOwner
      ? boundedCleanup(Promise.resolve().then(() => providerEgress.closeOwner(run.providerOwner)))
      : Promise.resolve();
    return run.providerClose;
  };
  const recordModelEvent = (/** @type {any} */ run, /** @type {any} */ event) => {
    if (event?.type === 'tool-use-start'
        && typeof event.id === 'string' && typeof event.name === 'string') {
      run.modelToolCalls.set(event.id, { name: event.name, inputBuf: '' });
    } else if (event?.type === 'tool-use-delta' && typeof event.id === 'string') {
      const pending = run.modelToolCalls.get(event.id);
      if (pending && typeof event.partialJson === 'string') pending.inputBuf += event.partialJson;
    }
  };
  const redeemModelOpaque = (/** @type {any} */ run, /** @type {string} */ token) => {
    const opaque = run.opaque.get(token);
    return opaque?.kind === 'attachment' || opaque?.kind === 'tool-image'
      ? opaque.value : null;
  };
  const modelCandidate = (/** @type {any} */ value) => isRecord(value)
    && typeof value.provider === 'string' && value.provider.length > 0
    && value.provider.length <= 64
    && typeof value.model === 'string' && value.model.length > 0
    && value.model.length <= 256
    ? { provider: value.provider, model: value.model } : null;
  const modelGrant = (/** @type {any} */ run) => ({
    owner: run.providerOwner,
    signal: run.signal,
    maxOutputTokens: run.maxOutputTokens,
    permits: (/** @type {string} */ providerId, /** @type {string} */ modelId) =>
      run.modelCandidates.some((/** @type {any} */ candidate) =>
        candidate.provider === providerId && candidate.model === modelId),
    permitsProvider: (/** @type {string} */ providerId) =>
      run.modelCandidates.some((/** @type {any} */ candidate) => candidate.provider === providerId),
    redeemOpaque: (/** @type {string} */ token) => redeemModelOpaque(run, token),
  });
  const domainExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string} */ domain,
    /** @type {string[]} */ businessKeys,
    /** @type {string[]} */ optionalKeys = [],
  ) => {
    const policy = controllerDomainOperationPolicy(operation);
    const effect = policy?.authorityClass === domain
      ? claimSemanticEffect(run, value, operation, businessKeys, optionalKeys) : null;
    if (!effect) return null;
    const args = Object.fromEntries([...businessKeys, ...optionalKeys]
      .filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
    return /** @type {any} */ ({
      semanticEffect: effect,
      call: { id: effect.callId, args }, custody: {
        ctx: authorityContextForOperation(run, operation),
      },
      domain, domainCalls: effect.domainCalls, domainState: effect.domainState,
    });
  };
  const runDomainEffect = async (
    /** @type {any} */ run,
    /** @type {any} */ entry,
    /** @type {string} */ operation,
    /** @type {'read'|'control'|'commit'|'resource'} */ _riskClass,
    /** @type {()=>Promise<any>|any} */ execute,
    /** @type {boolean} */ _recordEffectVerdict = false,
    /** @type {{fulfilled?:(value:any)=>unknown,rejected?:(cause:unknown)=>unknown}|null} */ effectOutcome = null,
  ) => {
    const policy = controllerDomainOperationPolicy(operation);
    const schedulerTarget = authorityEffectResourceKey(
      operation, entry.call.args, entry.custody.ctx,
    );
    return runAuthorityOperation(run, operation, async () => {
      // why: the accepted claim enters this call's dispatch drain before
      // canonical hashing can yield. An early tool-result close therefore
      // cannot observe an empty call and let the delayed effect enter later.
      let target;
      try { target = await durableAuthorityTarget(run, operation, entry.call.args); }
      catch { return failed('domain authority arguments are invalid', true); }
      if (!runIsLive(run)) return performSemanticEffect(
        run, entry.semanticEffect, operation, target,
        () => ({ ok: false, error: 'authority_effect_aborted' }),
        HOST_EFFECT_OUTCOME.okResult, null, schedulerTarget,
      );
      if (policy?.riskClass === 'read') {
        return performSemanticEffect(
          run, entry.semanticEffect, operation, target, execute, effectOutcome, null,
          schedulerTarget,
        );
      }
      const prepared = await prepareAuthorityEffect(
        run, entry.semanticEffect, operation, target, entry.call.args,
        `Allow ${operation.replace(/^turn\./, '').replaceAll('.', ' ')}?`,
      );
      if (prepared.refuse) return prepared.refuse;
      return performSemanticEffect(
        run, entry.semanticEffect, operation, target, execute,
        effectOutcome, prepared.tracking, schedulerTarget, prepared.dispatchAdmission,
      );
    }, entry.semanticEffect.callId);
  };
  const repositoryExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
    /** @type {string[]} */ optional = [],
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'repository', fields, optional);
    if (!entry) return null;
    entry.authority = bindRepositoryToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const vmExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
    /** @type {string[]} */ optional = [],
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'vm', fields, optional);
    if (!entry) return null;
    entry.authority = bindVmToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx,
    });
    return entry;
  };
  const notebookExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'notebook', fields);
    if (!entry) return null;
    entry.authority = bindNotebookToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const appExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'app', fields);
    if (!entry) return null;
    entry.authority = bindAppToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const persistenceExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'persistence', fields);
    if (!entry) return null;
    entry.authority = bindPersistenceToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx,
    });
    return entry;
  };
  const pageExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'page', ['args']);
    if (!entry) return null;
    entry.authority = bindPageToolAuthority(entry.domainState, {
      operation, args: entry.call.args.args, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const resourceExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'resource', fields);
    if (!entry) return null;
    entry.authority = bindResourceToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const siteClientExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
    /** @type {string[]} */ optional = [],
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'siteclient', fields, optional);
    if (!entry) return null;
    entry.authority = bindSiteClientToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const executionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'execution', fields);
    if (!entry) return null;
    entry.authority = bindExecutionToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const editingEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'editing', fields);
    if (!entry) return null;
    entry.authority = bindEditingToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx,
    });
    return entry;
  };
  const introspectionExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'introspection', fields);
    if (!entry) return null;
    entry.authority = bindIntrospectionToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx,
    });
    return entry;
  };
  const scheduleExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'schedule', fields);
    if (!entry) return null;
    entry.authority = bindScheduleToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const dwebExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ operation,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, operation, 'dweb', fields);
    if (!entry) return null;
    entry.authority = bindDwebToolAuthority(entry.domainState, {
      operation, args: entry.call.args, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const assertRunPayload = (/** @type {unknown} */ payload, /** @type {any} */ context) => {
    if (!isRecord(payload) || typeof payload.runId !== 'string') return null;
    const run = runs.get(payload.runId);
    if (!run || run.sessionId !== context.authority.sessionId
        || context.capability !== 'turn.run') return null;
    return { run, value: isRecord(payload.value) ? payload.value : {} };
  };

  const authorize = (/** @type {unknown} */ payload) => {
    if (!isRecord(payload) || typeof payload.runId !== 'string'
        || typeof payload.sessionId !== 'string' || !runs.has(payload.runId)) return null;
    const run = runs.get(payload.runId);
    if (run.sessionId !== payload.sessionId) return null;
    return {
      ownerId: 'peerd-authority-kernel', sessionId: payload.sessionId,
      instanceId: null, origin: null, target: 'orchestrator-turn', replayClass: 'E',
    };
  };

  const handleKernelCall = async (
    /** @type {string} */ operation,
    /** @type {unknown} */ payload,
    /** @type {any} */ context,
  ) => {
    const parsed = assertRunPayload(payload, context);
    if (!parsed) return {
      ok: false, code: 'turn-run-authority-mismatch', outcomeKnown: true,
    };
    const { run, value } = parsed;
    if ((context.signal.aborted || run.signal.aborted)
        && !ABORT_CLEANUP_OPERATIONS.has(operation)) return {
      ok: false, code: 'turn-run-aborted', outcomeKnown: true,
    };
    // why: finalization is a terminal host transition, not a reusable receipt.
    // A controller cannot finalize an empty snapshot and then mutate the
    // transcript, open model custody, or publish events under that stale proof.
    if (run.finalizing || run.finalizedKnown) return {
      ok: false, code: 'turn-run-finalized', outcomeKnown: true, retryable: false,
    };
    let settleAdmission = () => {};
    const settledAdmission = new Promise((resolve) => {
      settleAdmission = () => resolve(undefined);
    });
    const admission = Object.freeze({
      operation,
      settled: settledAdmission,
    });
    run.activeKernelCalls.add(admission);
    const sameSession = () => value.sessionId === run.sessionId;
    try {
      try {
        const domainPolicy = controllerDomainOperationPolicy(operation);
        if (domainPolicy && !run.allowedOperations.has(operation)) {
          return failed('domain authority operation is not granted', true);
        }
        // why: a compromised semantic realm must first prove that this exact
        // effect belongs to a live model-issued call. Forged, stale, duplicate,
        // or ungranted envelopes cannot force construction of the rich host
        // authority binding even though the binding remains lazy per turn.
        if (domainPolicy && !semanticEffectEnvelopeAllowed(run, value, operation)) {
          return failed('domain authority effect envelope is invalid', true);
        }
        if (domainPolicy) {
          await ensureAuthorityBinding(run);
          if ((context.signal.aborted || run.signal.aborted)
              && !ABORT_CLEANUP_OPERATIONS.has(operation)) return {
            ok: false, code: 'turn-run-aborted', outcomeKnown: true,
          };
        }
        switch (operation) {
        case 'turn.session.get':
          if (!sameSession()) return failed('session authority mismatch', true);
          try {
            const session = await run.ctx.sessions.get(run.sessionId);
            if (run.ctx.resume === true && run.currentAssistantId === null) {
              const trailing = session?.messages?.at?.(-1);
              run.resumeAssistantId = trailing?.role === 'assistant'
                && trailing?.streaming === true && typeof trailing.id === 'string'
                ? trailing.id : null;
            }
            return known(externalizeSessionWire(
              run, session,
            ));
          }
          catch (cause) { return failed(cause, true); }
        case 'turn.session.append':
          if (!sameSession()) return failed('session authority mismatch', true);
          try {
            const message = /** @type {any} */ (await rehydrateMessage(
              run, jsonUnwire(value.messageJson, 'session message'),
            ));
            const session = await run.ctx.sessions.appendMessage(
              run.sessionId, message,
            );
            for (const result of message?.toolResults ?? []) {
              run.persistedSemanticCalls.add(result.tool_use_id);
              const issued = run.modelToolCalls.get(result.tool_use_id);
              await run.ctx.appendAudit(semanticCallAuditEntry({
                sessionId: run.sessionId,
                callId: result.tool_use_id,
                label: issued?.name,
                result,
              })).catch(() => {});
            }
            run.resumeAssistantId = null;
            if (message?.role === 'assistant' && typeof message.id === 'string') {
              run.currentAssistantId = message.id;
            }
            return known(externalizeSessionWire(run, session));
          } catch (cause) { return unknown(run, cause); }
        case 'turn.session.update-assistant':
          {
          if (!sameSession() || typeof value.messageId !== 'string') {
            return failed('session authority mismatch', true);
          }
          let patch;
          try { patch = jsonUnwire(value.patchJson, 'session patch'); }
          catch (cause) { return failed(cause, true); }
          const resumeFinalize = value.messageId === run.resumeAssistantId
            && isRecord(patch) && Object.keys(patch).length === 1
            && patch.streaming === false;
          if (value.messageId !== run.currentAssistantId && !resumeFinalize) {
            return failed('session authority mismatch', true);
          }
          try {
            await run.ctx.sessions.updateAssistantMessage(
              run.sessionId, value.messageId, patch,
            );
            if (resumeFinalize) run.resumeAssistantId = null;
            return known(null);
          } catch (cause) { return unknown(run, cause); }
          }
        case 'turn.session.set-trim':
          if (!sameSession()) return failed('session authority mismatch', true);
          try {
            await run.ctx.sessions.setTrimSummary?.(
              run.sessionId, jsonUnwire(value.stateJson, 'trim state'),
            );
            return known(null);
          } catch (cause) { return unknown(run, cause); }
        case 'turn.prompt.get': {
          const prompt = await run.ctx.getSystemPrompt();
          run.system = prompt;
          return known(prompt);
        }
        case 'turn.tools.refresh': {
          const surface = await run.ctx.refreshTools();
          const projected = isRecord(surface)
            ? projectedOperationSet(surface.operations) : null;
          const projectedToolNames = isRecord(surface)
            ? projectedToolNameSet(surface.tools) : null;
          if (!projected || !projectedToolNames || !Array.isArray(surface.tools)) {
            return failed('controller tool projection is invalid', true);
          }
          // The controller heap has consumed model/history bytes by refresh
          // time. It may narrow a capability that failed live, but it cannot
          // widen the clean generation admitted before the turn. Legitimate
          // expansion starts a fresh turn generation and projection.
          for (const operation of run.allowedOperations) {
            if (!projected.has(operation)) run.allowedOperations.delete(operation);
          }
          for (const name of run.allowedToolNames) {
            if (!projectedToolNames.has(name)) run.allowedToolNames.delete(name);
          }
          setTools(run, surface.tools.filter((/** @type {any} */ tool) =>
            run.allowedToolNames.has(tool.name)));
          return known({ toolsJson: jsonWire(run.tools) });
        }
        case 'turn.trim.enrich':
          try { return known(run.ctx.enrichTrimSummary?.(value.request)); }
          catch (cause) { return failed(cause, true); }
        case 'turn.model.bind': {
          if (run.modelCandidates.length !== 0 || !Array.isArray(value.candidates)
              || value.candidates.length < 1 || value.candidates.length > 8) {
            return failed('model plan already bound or invalid', true);
          }
          const session = await run.ctx.sessions.get(run.sessionId);
          const candidates = value.candidates.map(modelCandidate);
          if (!session || candidates.some((candidate) => candidate === null)
              || candidates[0]?.provider !== session.provider
              || (session.model && candidates[0]?.model !== session.model)) {
            return failed('model plan primary mismatch', true);
          }
          const allowedFallbacks = run.ctx.providerFailoverEnabled === true
            && Array.isArray(run.ctx.providerFallbacks)
            ? new Set(run.ctx.providerFallbacks.filter(
              (/** @type {unknown} */ name) => typeof name === 'string',
            ))
            : new Set();
          const seen = new Set([session.provider]);
          for (const candidate of candidates.slice(1)) {
            if (!candidate || !allowedFallbacks.has(candidate.provider)
                || seen.has(candidate.provider)) {
              return failed('model plan fallback mismatch', true);
            }
            seen.add(candidate.provider);
          }
          if (!session.model) {
            try {
              await run.ctx.sessions.update(run.sessionId, { model: candidates[0]?.model });
            } catch (cause) { return unknown(run, cause); }
          }
          run.modelCandidates = candidates;
          return known({ candidates });
        }
        case 'turn.model.open-inference': {
          if (!providerEgress || run.modelCandidates.length === 0) {
            return failed('model egress unavailable', true);
          }
          run.modelToolCalls.clear();
          return openProviderCustody(run, () =>
            providerEgress.openInference(value, modelGrant(run)));
        }
        case 'turn.model.read-inference':
          return providerEgress
            ? providerEgress.readInferenceChunk(value, modelGrant(run))
            : failed('model egress unavailable', true);
        case 'turn.model.cancel-inference':
          return providerEgress
            ? providerEgress.cancelInference(value, modelGrant(run))
            : failed('model egress unavailable', true);
        case 'turn.model.read-inventory':
          return providerEgress
            ? providerEgress.readModelInventory(value, modelGrant(run))
            : failed('model egress unavailable', true);
        case 'turn.model.read-context':
          return providerEgress
            ? providerEgress.readModelContext(value, modelGrant(run))
            : failed('model egress unavailable', true);
        case 'turn.model.open-local':
          return providerEgress
            ? openProviderCustody(run, () =>
              providerEgress.openLocalGeneration(value, modelGrant(run)))
            : failed('local model egress unavailable', true);
        case 'turn.model.read-local':
          return providerEgress
            ? providerEgress.readLocalGeneration(value, modelGrant(run))
            : failed('local model egress unavailable', true);
        case 'turn.model.cancel-local':
          return providerEgress
            ? providerEgress.cancelLocalGeneration(value, modelGrant(run))
            : failed('local model egress unavailable', true);
        case 'turn.model.observe-event':
          if (value.type === 'tool-use-start'
              && typeof value.id === 'string' && typeof value.name === 'string') {
            recordModelEvent(run, value);
            return known(null);
          }
          if (value.type === 'tool-use-delta'
              && typeof value.id === 'string' && typeof value.partialJson === 'string'
              && value.partialJson.length <= 256 * 1024) {
            recordModelEvent(run, value);
            return known(null);
          }
          return failed('model event observation invalid', true);
        case 'turn.model.observe-failover': {
          const from = modelCandidate(value.from);
          const to = modelCandidate(value.to);
          if (!from || !to || !modelGrant(run).permits(from.provider, from.model)
              || !modelGrant(run).permits(to.provider, to.model)) {
            return failed('model failover observation invalid', true);
          }
          run.ctx.appendAudit({
            type: 'provider_failover', sessionId: run.sessionId,
            details: { from: from.provider, to: to.provider, reason: String(value.reason ?? 'error').slice(0, 128) },
          }).catch(() => {});
          run.ctx.postChatNote?.(`${from.provider} unavailable; switching to ${to.provider} and continuing…`);
          return known(null);
        }
        case 'turn.goal.complete': {
          const authorityCtx = authorityContextForOperation(run, operation);
          const bridgeAuthority = authorityBridgeContext(run);
          const complete = authorityCtx?.completeGoalRun;
          const effect = typeof value.summary === 'string'
            && value.summary.length <= 4_096
            ? claimSemanticEffect(run, value, operation, ['summary']) : null;
          if (!effect
              || typeof value.summary !== 'string'
              || value.summary.length > 4_096
              || typeof complete !== 'function') {
            return failed('goal completion authority mismatch', true);
          }
          return runSemanticEffect(
            run, effect, operation, 'active-goal',
            async () => {
              const livePermission = typeof bridgeAuthority?.readAuthorityPermission === 'function'
                ? await bridgeAuthority.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
                : bridgeAuthority?.permission;
              if (!controllerOperationAllowedInPermissionMode(
                operation, livePermission?.mode, { summary: value.summary },
              )) return {
                ok: false, code: 'plan_mode_refused',
                error: 'plan mode is read-only for this authority operation', retryable: false,
              };
              // why: goal completion is its own generation-bound lifecycle
              // transition. It needs neither a synthetic tool preparation nor
              // a semantic name check in the authority graph.
              return { ended: complete(value.summary) === true };
            },
            {
              fulfilled: (result) => result?.ended === true ? 'performed' : 'not-performed',
              rejected: () => 'not-performed',
            },
          );
        }
        case 'turn.actor.spawn-sync':
        case 'turn.actor.spawn-async': {
          const valid = typeof value.task === 'string' && value.task.length >= 1
              && value.task.length <= 65_536 && typeof value.allowRecursion === 'boolean'
              && (value.tools === undefined || (Array.isArray(value.tools)
                && value.tools.every((/** @type {unknown} */ name) => typeof name === 'string')))
              && Array.isArray(value.grantedOperations)
              && value.grantedOperations.length <= 256
              && value.grantedOperations.every((/** @type {unknown} */ candidate) =>
                typeof candidate === 'string' && run.allowedOperations.has(candidate));
          const effect = valid
            && (value.maxSteps === undefined || Number.isFinite(value.maxSteps))
            && (value.maxDepth === undefined || Number.isFinite(value.maxDepth))
            ? claimSemanticEffect(run, value, operation, ['task', 'allowRecursion'], [
              'tools', 'maxSteps', 'maxDepth', 'grantedOperations',
            ]) : null;
          if (!effect || !valid
              || (value.maxSteps !== undefined && !Number.isFinite(value.maxSteps))
              || (value.maxDepth !== undefined && !Number.isFinite(value.maxDepth))) {
            return failed('actor spawn authority mismatch', true);
          }
          const ctx = authorityContextForOperation(run, operation);
          const actorAuthority = ctx?.actorAuthority;
          const spawn = operation === 'turn.actor.spawn-sync'
            ? actorAuthority?.spawnSync : actorAuthority?.spawnAsync;
          if (typeof spawn !== 'function') {
            return known({ ok: false, error: 'actor_orchestrator_unavailable', outcomeKnown: true });
          }
          const synchronous = operation === 'turn.actor.spawn-sync';
          const target = `actor:${synchronous ? 'sync' : 'async'}:${run.sessionId}:${effect.effectId}`;
          return runAuthorityOperation(run, operation, async () => {
            const args = {
              task: value.task,
              ...(value.tools === undefined ? {} : { tools: value.tools }),
              ...(value.maxSteps === undefined ? {} : { maxSteps: value.maxSteps }),
              ...(value.maxDepth === undefined ? {} : { maxDepth: value.maxDepth }),
              allowRecursion: value.allowRecursion,
              grantedOperations: [...new Set(value.grantedOperations)],
            };
            const prepared = await prepareAuthorityEffect(
              run, effect, operation, target, args,
              `${synchronous ? 'Run' : 'Start'} a delegated actor task?`,
            );
            if (prepared.refuse) return prepared.refuse;
            return performSemanticEffect(run, effect, operation, target, () => spawn({
              ...args,
              parentSessionId: ctx.session?.sessionId,
              parentDepth: ctx.session?.depth ?? 0,
              parentInbound: ctx.inbound !== false,
              parentToolUseId: effect.callId,
            }), HOST_EFFECT_OUTCOME.actorSpawn, prepared.tracking, target,
            prepared.dispatchAdmission);
          }, effect.callId);
        }
        case 'turn.actor.tasks': {
          const effect = claimSemanticEffect(run, value, operation, []);
          if (!effect) return failed('actor tasks authority mismatch', true);
          const list = authorityContextForOperation(run, operation)?.actorAuthority?.listTasks;
          return runSemanticEffect(
            run, effect, operation, 'actor-task-list',
            () => typeof list === 'function' ? list() : [],
          );
        }
        case 'turn.actor.cancel': {
          const effect = typeof value.taskId === 'string' && value.taskId.length >= 1
            && value.taskId.length <= 512
            ? claimSemanticEffect(run, value, operation, ['taskId']) : null;
          if (!effect || typeof value.taskId !== 'string') {
            return failed('actor cancel authority mismatch', true);
          }
          const cancel = authorityContextForOperation(run, operation)?.actorAuthority?.cancelTask;
          const target = `actor-task:${value.taskId}`;
          return runAuthorityOperation(run, operation, async () => {
            const prepared = await prepareAuthorityEffect(
              run, effect, operation, target, { taskId: value.taskId },
              `Cancel delegated actor task ${value.taskId}?`,
            );
            if (prepared.refuse) return prepared.refuse;
            return performSemanticEffect(run, effect, operation, target, () =>
              typeof cancel === 'function'
                ? cancel(value.taskId) : { ok: false, error: 'actor_unavailable' },
            HOST_EFFECT_OUTCOME.actorCancel, prepared.tracking, target,
            prepared.dispatchAdmission);
          }, effect.callId);
        }
        case 'turn.actor.message': {
          const effect = typeof value.to === 'string' && value.to.length >= 1
            && value.to.length <= 512 && typeof value.message === 'string'
            && value.message.length >= 1 && value.message.length <= 65_536
            && typeof value.oneShot === 'boolean' && typeof value.awaitReply === 'boolean'
            && typeof value.degradeToAsync === 'boolean'
            && Number.isSafeInteger(value.awaitCapMs) && value.awaitCapMs >= 1
            && value.awaitCapMs <= 3 * 60_000
            ? claimSemanticEffect(run, value, operation, [
              'to', 'message', 'oneShot', 'awaitReply', 'degradeToAsync', 'awaitCapMs',
            ]) : null;
          if (!effect || typeof value.to !== 'string' || typeof value.message !== 'string'
              || typeof value.oneShot !== 'boolean' || typeof value.awaitReply !== 'boolean'
              || typeof value.degradeToAsync !== 'boolean'
              || !Number.isSafeInteger(value.awaitCapMs) || value.awaitCapMs < 1
              || value.awaitCapMs > 3 * 60_000) {
            return failed('actor message authority mismatch', true);
          }
          const ctx = authorityContextForOperation(run, operation);
          const messageActor = ctx?.actorAuthority?.deliverMessage;
          if (typeof messageActor !== 'function') {
            return known({ ok: false, error: 'actor messaging is not enabled', outcomeKnown: true });
          }
          const target = `actor:${value.to}`;
          return runAuthorityOperation(run, operation, async () => {
            const args = {
              to: value.to, message: value.message, oneShot: value.oneShot,
              awaitReply: value.awaitReply, degradeToAsync: value.degradeToAsync,
              awaitCapMs: value.awaitCapMs,
            };
            const prepared = await prepareAuthorityEffect(
              run, effect, operation, target, args,
              `Send a message to actor ${value.to}?`,
            );
            if (prepared.refuse) return prepared.refuse;
            return performSemanticEffect(run, effect, operation, target, () => messageActor({
              ...args,
              senderSessionId: ctx.session?.sessionId,
              inbound: ctx.inbound === true,
              toolUseId: effect.callId,
              awaitSignal: run.signal,
            }), HOST_EFFECT_OUTCOME.actorMessage, prepared.tracking, target,
            prepared.dispatchAdmission);
          }, effect.callId);
        }
        case 'turn.pod.resolve': {
          const entry = domainExecutionEntry(
            run, value, operation, 'pod', ['podId'], ['command'],
          );
          if (!entry || value.podId !== entry.call?.args?.podId) {
            return failed('Pod resolution authority mismatch', true);
          }
          const ctx = entry.custody?.ctx;
          if (typeof ctx?.podClient?.resolveId !== 'function') {
            return failed('pod_unavailable', true);
          }
          const result = /** @type {any} */ (await runDomainEffect(
            run, entry, operation, 'read', () =>
              ctx.podClient.resolveId({ sessionId: ctx.session?.sessionId, podId: value.podId }),
          ));
          if (result?.ok === true && typeof result.value === 'string') {
            entry.domainState.podId = result.value;
            if (typeof value.command === 'string') entry.domainState.command = value.command;
          }
          return result;
        }
        case 'turn.pod.read-remote': {
          const entry = domainExecutionEntry(run, value, operation, 'pod', ['podId']);
          const intent = entry ? podGitRemoteIntents(entry.domainState.command ?? '')[0] : null;
          if (!entry || typeof value.podId !== 'string'
              || value.podId !== entry.domainState.podId
              || !intent || intent.url) {
            return failed('Pod remote authority mismatch', true);
          }
          const readRemote = entry.custody?.ctx?.repositories?.getRemote;
          const result = /** @type {any} */ (await runDomainEffect(
            run, entry, operation, 'read', () => typeof readRemote === 'function'
              ? readRemote({ kind: 'pod', id: value.podId }) : null,
          ));
          if (result?.ok === true) entry.domainState.remote = result.value;
          return result;
        }
        case 'turn.pod.confirm-git': {
          const entry = domainExecutionEntry(run, value, operation, 'pod', ['op']);
          const intents = entry ? podGitRemoteIntents(entry.domainState.command ?? '') : [];
          const intent = intents.length === 1 ? intents[0] : null;
          const target = intent?.url ?? entry?.domainState?.remote?.url;
          if (!entry || typeof entry.domainState.podId !== 'string'
              || !intent || value.op !== intent.op || typeof target !== 'string') {
            return failed('Pod Git confirmation authority mismatch', true);
          }
          let origin;
          try { origin = new URL(target).origin; }
          catch { return failed('Pod Git remote is invalid', true); }
          const confirm = entry.custody?.ctx?.confirm;
          if (typeof confirm !== 'function') return known(false);
          const result = /** @type {any} */ (await runDomainEffect(
            run, entry, operation, 'control', () => confirm({
            tool: 'pod_exec', kind: `git_${intent.op}`,
            sideEffect: intent.op === 'push' ? 'mutate_external' : 'write',
            origins: [origin],
            summary: intent.op === 'push'
              ? `Allow this one Pod job to push code and commit history to ${target}?`
              : `Allow this one Pod job to ${intent.op} ${target} through peerd's audited Git transport?`,
            }, run.signal), false, HOST_EFFECT_OUTCOME.confirmation,
          ));
          if (result?.ok === true
              && runIsLive(run)
              && [true, 'yes_once', 'yes_session'].includes(result.value)) {
            entry.domainState.remoteGitGrant = { op: intent.op, url: target };
          }
          return result;
        }
        case 'turn.pod.exec': {
          const entry = domainExecutionEntry(run, value, operation, 'pod', [
            'command', 'podId', 'timeoutMs', 'background', 'remoteGitGrant',
          ]);
          const args = entry?.call?.args;
          let program;
          let intents;
          try {
            program = parsePodShell(args?.command ?? '');
            intents = podGitRemoteIntents(args?.command ?? '');
          } catch { return failed('Pod command authority mismatch', true); }
          const expectedTimeout = Math.min(300_000, Math.max(1, Number(args?.timeoutMs) || 30_000));
          const expectedBackground = args?.background === true || program.background;
          const expectedGrant = intents.length === 1
            ? entry?.domainState?.remoteGitGrant ?? null : null;
          if (!entry || intents.length > 1 || typeof entry.domainState.podId !== 'string'
              || value.command !== args?.command || value.podId !== entry.domainState.podId
              || value.timeoutMs !== expectedTimeout || value.background !== expectedBackground
              || !sameClone(value.remoteGitGrant, expectedGrant)) {
            return failed('Pod execution authority mismatch', true);
          }
          if (expectedGrant) entry.domainState.remoteGitGrant = null;
          const execute = entry.custody?.ctx?.podClient?.exec;
          if (typeof execute !== 'function') return failed('pod_unavailable', true);
          return runDomainEffect(run, entry, operation, 'resource', () => execute(value.command, {
            podId: value.podId,
            timeoutMs: expectedTimeout,
            background: expectedBackground,
            remoteGitGrant: expectedGrant,
            signal: expectedBackground ? undefined : run.signal,
          }), false, HOST_EFFECT_OUTCOME.podExecution);
        }
        case 'turn.pod.status': {
          const entry = domainExecutionEntry(run, value, operation, 'pod', [
            'podId', 'jobId', 'stream', 'offset', 'limit',
          ]);
          const args = entry?.call?.args;
          if (!entry || value.podId !== args?.podId || value.jobId !== args?.jobId
              || value.stream !== args?.stream || value.offset !== args?.offset
              || value.limit !== args?.limit) {
            return failed('Pod status authority mismatch', true);
          }
          const readStatus = entry.custody?.ctx?.podClient?.status;
          if (typeof readStatus !== 'function') return failed('pod_unavailable', true);
          return runDomainEffect(run, entry, operation, 'read', () => readStatus({
            sessionId: entry.custody.ctx.session?.sessionId,
            podId: value.podId, jobId: value.jobId, stream: value.stream,
            offset: value.offset, limit: value.limit,
          }));
        }
        case 'turn.pod.cancel': {
          const entry = domainExecutionEntry(run, value, operation, 'pod', [
            'podId', 'jobId',
          ]);
          const args = entry?.call?.args;
          if (!entry || typeof value.jobId !== 'string' || value.jobId !== args?.jobId
              || value.podId !== args?.podId) {
            return failed('Pod cancellation authority mismatch', true);
          }
          const cancel = entry.custody?.ctx?.podClient?.cancel;
          if (typeof cancel !== 'function') return failed('pod_unavailable', true);
          return runDomainEffect(run, entry, operation, 'control', () => cancel(value.jobId, {
            sessionId: entry.custody.ctx.session?.sessionId, podId: value.podId,
          }), false, HOST_EFFECT_OUTCOME.podCancel);
        }
        case 'turn.pod.read-file': {
          const entry = domainExecutionEntry(run, value, operation, 'pod', ['podId', 'path']);
          const args = entry?.call?.args;
          if (!entry || typeof value.path !== 'string' || value.path !== args?.path
              || value.podId !== args?.podId) {
            return failed('Pod file-read authority mismatch', true);
          }
          const readFile = entry.custody?.ctx?.podClient?.readFile;
          if (typeof readFile !== 'function') return failed('pod_unavailable', true);
          return runDomainEffect(run, entry, operation, 'read', () => readFile(value.path, {
            sessionId: entry.custody.ctx.session?.sessionId, podId: value.podId,
          }));
        }
        case 'turn.pod.write-file': {
          const entry = domainExecutionEntry(run, value, operation, 'pod', [
            'podId', 'path', 'content',
          ]);
          const args = entry?.call?.args;
          if (!entry || typeof value.path !== 'string' || typeof value.content !== 'string'
              || value.path !== args?.path || value.content !== args?.content
              || value.podId !== args?.podId) {
            return failed('Pod file-write authority mismatch', true);
          }
          const writeFile = entry.custody?.ctx?.podClient?.writeFile;
          if (typeof writeFile !== 'function') return failed('pod_unavailable', true);
          return runDomainEffect(run, entry, operation, 'commit', () => writeFile(
            value.path, value.content, {
              sessionId: entry.custody.ctx.session?.sessionId, podId: value.podId,
            },
          ), false, HOST_EFFECT_OUTCOME.podMutation);
        }
        case 'turn.repository.read-pod': {
          const entry = repositoryExecutionEntry(run, value, operation, ['podId']);
          if (!entry) return failed('repository Pod read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readPod(value.podId));
        }
        case 'turn.repository.destroy-pod': {
          const entry = repositoryExecutionEntry(run, value, operation, ['podId']);
          if (!entry) return failed('repository Pod destroy authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.destroyPod(value.podId), false, HOST_EFFECT_OUTCOME.podMutation);
        }
        case 'turn.repository.read-status': {
          const entry = repositoryExecutionEntry(run, value, operation, []);
          if (!entry) return failed('repository status authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readStatus());
        }
        case 'turn.repository.read-history': {
          const entry = repositoryExecutionEntry(run, value, operation, ['depth']);
          if (!entry) return failed('repository history authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readHistory(value.depth));
        }
        case 'turn.repository.read-remote': {
          const entry = repositoryExecutionEntry(
            run, value, operation, [],
          );
          if (!entry) return failed('repository remote-read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readRemote());
        }
        case 'turn.repository.read-diff': {
          const entry = repositoryExecutionEntry(
            run, value, operation, ['from', 'to'],
          );
          if (!entry) return failed('repository diff authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readDiff(value.from, value.to));
        }
        case 'turn.repository.confirm-restore': {
          const entry = repositoryExecutionEntry(run, value, operation, ['to']);
          if (!entry) return failed('repository restore confirmation mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.authority.confirmRestore(value.to), false, HOST_EFFECT_OUTCOME.confirmation);
        }
        case 'turn.repository.checkpoint': {
          const entry = repositoryExecutionEntry(run, value, operation, ['message']);
          if (!entry) return failed('repository checkpoint authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.checkpoint(value.message), false,
            HOST_EFFECT_OUTCOME.repositoryCheckpoint);
        }
        case 'turn.repository.branch': {
          const entry = repositoryExecutionEntry(run, value, operation, ['name']);
          if (!entry) return failed('repository branch authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.branch(value.name), false, HOST_EFFECT_OUTCOME.repositoryMutation);
        }
        case 'turn.repository.checkout': {
          const entry = repositoryExecutionEntry(run, value, operation, ['name']);
          if (!entry) return failed('repository checkout authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.checkout(value.name), false, HOST_EFFECT_OUTCOME.repositoryMutation);
        }
        case 'turn.repository.restore': {
          const entry = repositoryExecutionEntry(run, value, operation, ['to']);
          if (!entry) return failed('repository restore authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.restore(value.to), false, HOST_EFFECT_OUTCOME.repositoryRestore);
        }
        case 'turn.repository.confirm-remote': {
          const entry = repositoryExecutionEntry(
            run, value, operation, ['op', 'target', 'branch'], ['url'],
          );
          if (!entry) return failed('repository remote confirmation mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.authority.confirmRemote(value.op, value.target, value.branch), false,
          HOST_EFFECT_OUTCOME.confirmation);
        }
        case 'turn.repository.link': {
          const entry = repositoryExecutionEntry(run, value, operation, ['url']);
          if (!entry) return failed('repository link authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.link(value.url), false, HOST_EFFECT_OUTCOME.repositoryMutation);
        }
        case 'turn.repository.fetch': {
          const entry = repositoryExecutionEntry(run, value, operation, ['target']);
          if (!entry) return failed('repository fetch authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.fetch(value.target), false, HOST_EFFECT_OUTCOME.repositoryMutation);
        }
        case 'turn.repository.push': {
          const entry = repositoryExecutionEntry(
            run, value, operation, ['target', 'branch'],
          );
          if (!entry) return failed('repository push authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.push(value.target, value.branch), false, HOST_EFFECT_OUTCOME.partialMutation);
        }
        case 'turn.vm.read': {
          const entry = vmExecutionEntry(run, value, operation, ['vmId']);
          if (!entry) return failed('VM read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readVm(value.vmId));
        }
        case 'turn.vm.list': {
          const entry = vmExecutionEntry(run, value, operation, []);
          if (!entry) return failed('VM list authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.listVms());
        }
        case 'turn.vm.set-default': {
          const entry = vmExecutionEntry(run, value, operation, ['vmId']);
          if (!entry) return failed('VM default authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.authority.setDefaultVm(value.vmId), false, HOST_EFFECT_OUTCOME.defaultSelection);
        }
        case 'turn.vm.run': {
          const entry = vmExecutionEntry(
            run, value, operation, ['command', 'timeoutMs'], ['vmId'],
          );
          if (!entry) return failed('VM run authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.runVm(value.command, value.timeoutMs, value.vmId), false, HOST_EFFECT_OUTCOME.vmExecution);
        }
        case 'turn.vm.import-file': {
          const entry = vmExecutionEntry(
            run, value, operation, ['url', 'path', 'maxBytes'],
          );
          if (!entry) return failed('VM import authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.importFile(value.url, value.path, value.maxBytes), false, HOST_EFFECT_OUTCOME.vmMutation);
        }
        case 'turn.vm.write-text-file': {
          const entry = vmExecutionEntry(
            run, value, operation, ['path', 'content'],
          );
          if (!entry) return failed('VM file-write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.writeTextFile(value.path, value.content), false, HOST_EFFECT_OUTCOME.vmMutation);
        }
        case 'turn.vm.destroy': {
          const entry = vmExecutionEntry(run, value, operation, ['vmId']);
          if (!entry) return failed('VM destroy authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.destroyVm(value.vmId), false, HOST_EFFECT_OUTCOME.vmMutation);
        }
        case 'turn.notebook.read': {
          const entry = notebookExecutionEntry(
            run, value, operation, ['notebookId'],
          );
          if (!entry) return failed('Notebook read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readNotebook(value.notebookId));
        }
        case 'turn.notebook.list': {
          const entry = notebookExecutionEntry(run, value, operation, []);
          if (!entry) return failed('Notebook list authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.listNotebooks());
        }
        case 'turn.notebook.set-default': {
          const entry = notebookExecutionEntry(
            run, value, operation, ['notebookId'],
          );
          if (!entry) return failed('Notebook default authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.authority.setDefaultNotebook(value.notebookId), false,
            HOST_EFFECT_OUTCOME.defaultSelection);
        }
        case 'turn.notebook.run': {
          const entry = notebookExecutionEntry(
            run, value, operation, ['code', 'timeoutMs', 'notebookId'],
          );
          if (!entry) return failed('Notebook run authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.runNotebook(
              value.code, value.timeoutMs, value.notebookId,
            ), false, HOST_EFFECT_OUTCOME.notebookRun);
        }
        case 'turn.notebook.write-file': {
          const entry = notebookExecutionEntry(
            run, value, operation, ['path', 'content', 'notebookId'],
          );
          if (!entry) return failed('Notebook file-write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.writeFile(
              value.path, value.content, value.notebookId,
            ), false, HOST_EFFECT_OUTCOME.notebookMutation);
        }
        case 'turn.notebook.read-file': {
          const entry = notebookExecutionEntry(
            run, value, operation, ['path', 'notebookId'],
          );
          if (!entry) return failed('Notebook file-read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readFile(value.path, value.notebookId));
        }
        case 'turn.notebook.destroy': {
          const entry = notebookExecutionEntry(run, value, operation, ['notebookId']);
          if (!entry) return failed('Notebook destroy authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.destroyNotebook(value.notebookId), false, HOST_EFFECT_OUTCOME.notebookMutation);
        }
        case 'turn.app.update': {
          const entry = appExecutionEntry(
            run, value, operation, ['appId', 'name', 'html', 'tags', 'entryFile'],
          );
          if (!entry) return failed('App update authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.updateApp(
              value.appId, value.name, value.html, value.tags, value.entryFile,
            ), false, HOST_EFFECT_OUTCOME.appUpdate);
        }
        case 'turn.app.open': {
          const entry = appExecutionEntry(run, value, operation, ['appId']);
          if (!entry) return failed('App open authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.openApp(value.appId), false, HOST_EFFECT_OUTCOME.appOpen);
        }
        case 'turn.app.search': {
          const entry = appExecutionEntry(run, value, operation, ['query']);
          if (!entry) return failed('App search authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.searchApps(value.query));
        }
        case 'turn.app.read': {
          const entry = appExecutionEntry(run, value, operation, ['appId']);
          if (!entry) return failed('App read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readApp(value.appId));
        }
        case 'turn.app.delete': {
          const entry = appExecutionEntry(run, value, operation, ['appId']);
          if (!entry) return failed('App delete authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.deleteApp(value.appId), false, HOST_EFFECT_OUTCOME.appDelete);
        }
        case 'turn.app.write-file': {
          const entry = appExecutionEntry(
            run, value, operation, ['appId', 'path', 'content'],
          );
          if (!entry) return failed('App file-write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.writeFile(value.appId, value.path, value.content), false, HOST_EFFECT_OUTCOME.appMutation);
        }
        case 'turn.app.read-file': {
          const entry = appExecutionEntry(
            run, value, operation, ['appId', 'path'],
          );
          if (!entry) return failed('App file-read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readFile(value.appId, value.path));
        }
        case 'turn.app.list-files': {
          const entry = appExecutionEntry(run, value, operation, ['appId']);
          if (!entry) return failed('App file-list authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.listFiles(value.appId));
        }
        case 'turn.app.delete-file': {
          const entry = appExecutionEntry(
            run, value, operation, ['appId', 'path'],
          );
          if (!entry) return failed('App file-delete authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.deleteFile(value.appId, value.path), false, HOST_EFFECT_OUTCOME.appMutation);
        }
        case 'turn.app.observe': {
          const entry = appExecutionEntry(run, value, operation, []);
          if (!entry) return failed('App observe authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.observeRuntime());
        }
        case 'turn.app.act': {
          const entry = appExecutionEntry(run, value, operation, ['action', 'params']);
          if (!entry) return failed('App action authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.actRuntime(value.action, value.params), false, HOST_EFFECT_OUTCOME.appAction);
        }
        case 'turn.app.run-code': {
          const entry = appExecutionEntry(
            run, value, operation, ['code', 'timeoutMs'],
          );
          if (!entry) return failed('App code authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.runCode(value.code, value.timeoutMs), false, HOST_EFFECT_OUTCOME.programRun);
        }
        case 'turn.memory.read-scope': {
          const entry = persistenceExecutionEntry(run, value, operation, ['scope']);
          if (!entry) return failed('memory read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readMemoryScope(value.scope));
        }
        case 'turn.memory.read-subtree': {
          const entry = persistenceExecutionEntry(
            run, value, operation, ['workspace', 'subpath'],
          );
          if (!entry) return failed('memory subtree authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readMemorySubtree(value.workspace, value.subpath));
        }
        case 'turn.memory.write': {
          const entry = persistenceExecutionEntry(
            run, value, operation, ['scope', 'body'],
          );
          if (!entry) return failed('memory write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.writeMemory(value.scope, value.body), false, HOST_EFFECT_OUTCOME.memoryResult);
        }
        case 'turn.todo.read': {
          const entry = persistenceExecutionEntry(
            run, value, operation, [],
          );
          if (!entry) return failed('todo read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readTodos());
        }
        case 'turn.todo.replace': {
          const entry = persistenceExecutionEntry(
            run, value, operation, ['version', 'todos'],
          );
          if (!entry) return failed('todo replace authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.replaceTodos(value.version, value.todos), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.page.open-tab': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page open authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.openProtectedBackgroundTab(), false, HOST_EFFECT_OUTCOME.pageMutation);
        }
        case 'turn.page.read': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readOwnedPage());
        }
        case 'turn.page.snapshot': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page snapshot authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.captureOwnedAccessibilityTree());
        }
        case 'turn.page.read-state': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page state authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readOwnedFrameworkState());
        }
        case 'turn.page.watch-changes': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page watch authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.drainOwnedDomChanges());
        }
        case 'turn.page.query-dom': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page query authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.queryOwnedDom());
        }
        case 'turn.page.navigate': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page navigation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.navigateOwnedTab(), false, HOST_EFFECT_OUTCOME.pageMutation);
        }
        case 'turn.page.fill': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page fill authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.fillOwnedTarget(), false, HOST_EFFECT_OUTCOME.pageMutation);
        }
        case 'turn.page.click': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page click authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.clickOwnedTarget(), false, HOST_EFFECT_OUTCOME.pageMutation);
        }
        case 'turn.page.login': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page login authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.performConfirmedOwnedLogin(), false, HOST_EFFECT_OUTCOME.pageMutation);
        }
        case 'turn.page.run-program': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page program authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.runOwnedPageProgram(), false, HOST_EFFECT_OUTCOME.programRun);
        }
        case 'turn.page.capture-foreground': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page foreground capture authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.captureForegroundPixels());
        }
        case 'turn.page.capture-owned': {
          const entry = pageExecutionEntry(run, value, operation);
          if (!entry) return failed('page owned capture authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.captureOwnedTabPixels());
        }
        case 'turn.resource.confirm-web-write': {
          const entry = resourceExecutionEntry(
            run, value, operation, ['url', 'method', 'headers', 'body'],
          );
          if (!entry) return failed('web write confirmation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.authority.confirmWebWrite({
              url: value.url, method: value.method, headers: value.headers, body: value.body,
            }), true, HOST_EFFECT_OUTCOME.confirmation);
        }
        case 'turn.resource.request-web-text': {
          const entry = resourceExecutionEntry(
            run, value, operation, ['url', 'method', 'headers', 'body'],
          );
          if (!entry) return failed('web resource authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.requestWebText({
              url: value.url, method: value.method, headers: value.headers, body: value.body,
            }), false, HOST_EFFECT_OUTCOME.webRequest);
        }
        case 'turn.resource.extract-markdown': {
          const entry = resourceExecutionEntry(run, value, operation, ['html', 'url']);
          if (!entry) return failed('markdown extraction authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.extractReadableMarkdown(value.html, value.url));
        }
        case 'turn.resource.extract-document': {
          const entry = resourceExecutionEntry(
            run, value, operation, ['url', 'format', 'engine'],
          );
          if (!entry) return failed('document extraction authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.extractDocument({
              url: value.url, format: value.format, engine: value.engine,
            }));
        }
        case 'turn.resource.spill-result': {
          const entry = resourceExecutionEntry(run, value, operation, [
            'url', 'format', 'text', 'producer', 'fenced', 'originLabel',
          ]);
          if (!entry) return failed('result spill authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.authority.spillResult({
              url: value.url, format: value.format, text: value.text,
              producer: value.producer, fenced: value.fenced,
              originLabel: value.originLabel,
            }), false, HOST_EFFECT_OUTCOME.spill);
        }
        case 'turn.resource.read-result': {
          const entry = resourceExecutionEntry(run, value, operation, ['key']);
          if (!entry) return failed('result read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readResult(value.key));
        }
        case 'turn.site-client.read': {
          const entry = siteClientExecutionEntry(run, value, operation, ['origin']);
          if (!entry) return failed('site-client read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readStoredClient(value.origin));
        }
        case 'turn.site-client.run': {
          const entry = siteClientExecutionEntry(
            run, value, operation, ['origin', 'code', 'timeoutMs'],
          );
          if (!entry) return failed('site-client run authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.runStoredClient(
              value.origin, value.code, value.timeoutMs,
            ), false, HOST_EFFECT_OUTCOME.siteClientRun);
        }
        case 'turn.site-client.commit': {
          const entry = siteClientExecutionEntry(run, value, operation, ['origin'], [
            'summary', 'endpoints', 'auth', 'deriver', 'body',
          ]);
          if (!entry) return failed('site-client write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.commitConfirmedClient(value.origin), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.site-client.capture-start': {
          const entry = siteClientExecutionEntry(run, value, operation, []);
          if (!entry) return failed('site capture start authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.startOwnedCapture(), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.site-client.capture-stop': {
          const entry = siteClientExecutionEntry(run, value, operation, []);
          if (!entry) return failed('site capture stop authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.stopOwnedCapture(), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.create-webvm': {
          const entry = executionEntry(run, value, operation, ['plan']);
          if (!entry) return failed('webvm creation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.createWebVm(value.plan), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.create-notebook': {
          const entry = executionEntry(run, value, operation, ['plan']);
          if (!entry) return failed('notebook creation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.createNotebook(value.plan), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.create-pod': {
          const entry = executionEntry(run, value, operation, ['plan']);
          if (!entry) return failed('pod creation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.createPod(value.plan), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.create-app': {
          const entry = executionEntry(run, value, operation, ['plan']);
          if (!entry) return failed('app creation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.createApp(value.plan), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.run-script': {
          const entry = executionEntry(run, value, operation, [
            'code', 'actors', 'provider', 'workspace', 'timeoutMs',
          ]);
          if (!entry) return failed('headless script authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.runHeadlessScript({
              code: value.code, actors: value.actors, provider: value.provider,
              workspace: value.workspace, timeoutMs: value.timeoutMs,
            }), false, HOST_EFFECT_OUTCOME.scriptRun);
        }
        case 'turn.execution.spill-script': {
          const entry = executionEntry(
            run, value, operation, ['text', 'fenced', 'originLabel'],
          );
          if (!entry) return failed('script spill authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.authority.spillScriptValue({
              text: value.text, fenced: value.fenced, originLabel: value.originLabel,
            }), false, HOST_EFFECT_OUTCOME.spill);
        }
        case 'turn.editing.read-target': {
          const entry = editingEntry(run, value, operation, ['kind', 'targetId', 'path']);
          if (!entry) return failed('edit target read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readEditTarget({
              kind: value.kind, targetId: value.targetId, path: value.path,
            }));
        }
        case 'turn.editing.write-target': {
          const entry = editingEntry(
            run, value, operation, ['kind', 'targetId', 'path', 'content'],
          );
          if (!entry) return failed('edit target write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.writeEditTarget({
              kind: value.kind, targetId: value.targetId,
              path: value.path, content: value.content,
            }), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.introspection.actor-roster': {
          const entry = introspectionExecutionEntry(run, value, operation, []);
          if (!entry) return failed('actor roster authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readActorRoster());
        }
        case 'turn.introspection.provider-posture': {
          const entry = introspectionExecutionEntry(run, value, operation, []);
          if (!entry) return failed('provider posture authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readProviderPosture());
        }
        case 'turn.introspection.storage-snapshot': {
          const entry = introspectionExecutionEntry(run, value, operation, ['prefix']);
          if (!entry) return failed('storage inspection authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readStorageSnapshot(value.prefix));
        }
        case 'turn.introspection.automatable-tabs': {
          const entry = introspectionExecutionEntry(run, value, operation, []);
          if (!entry) return failed('tab inspection authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readAutomatableTabs());
        }
        case 'turn.introspection.denylist-patterns': {
          const entry = introspectionExecutionEntry(run, value, operation, []);
          if (!entry) return failed('denylist inspection authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readDenylistPatterns());
        }
        case 'turn.introspection.audit-entries': {
          const entry = introspectionExecutionEntry(run, value, operation, []);
          if (!entry) return failed('audit inspection authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readAuditEntries());
        }
        case 'turn.introspection.installed-skill': {
          const entry = introspectionExecutionEntry(run, value, operation, ['name']);
          if (!entry) return failed('skill read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readInstalledSkill(value.name));
        }
        case 'turn.schedule.read-routines': {
          const entry = scheduleExecutionEntry(run, value, operation, []);
          if (!entry) return failed('schedule read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readRoutines());
        }
        case 'turn.schedule.arm-confirmed-routine': {
          const entry = scheduleExecutionEntry(
            run, value, operation, ['prompt', 'every', 'dailyAt', 'mode'],
          );
          if (!entry) return failed('schedule arm authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.armConfirmedRoutine({
              prompt: value.prompt, every: value.every,
              dailyAt: value.dailyAt, mode: value.mode,
            }), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.schedule.cancel-routine': {
          const entry = scheduleExecutionEntry(run, value, operation, ['id']);
          if (!entry) return failed('schedule cancel authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.cancelRoutine(value.id), false, HOST_EFFECT_OUTCOME.scheduleCancel);
        }
        case 'turn.dweb.discover-apps': {
          const entry = dwebExecutionEntry(run, value, operation, []);
          if (!entry) return failed('dweb discovery authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.discoverApps());
        }
        case 'turn.dweb.publish-confirmed-app': {
          const entry = dwebExecutionEntry(run, value, operation, ['appId']);
          if (!entry) return failed('dweb publish authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.publishConfirmedApp(value.appId), false, HOST_EFFECT_OUTCOME.dwebPublish);
        }
        case 'turn.dweb.install-confirmed-app': {
          const entry = dwebExecutionEntry(run, value, operation, ['uri', 'name']);
          if (!entry) return failed('dweb install authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.installConfirmedApp(value.uri, value.name), false, HOST_EFFECT_OUTCOME.dwebInstall);
        }
        case 'turn.dweb.read-peers': {
          const entry = dwebExecutionEntry(run, value, operation, []);
          if (!entry) return failed('dweb peer authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.authority.readPeers());
        }
        case 'turn.dweb.set-peer-blocked': {
          const entry = dwebExecutionEntry(
            run, value, operation, ['did', 'block', 'reason'],
          );
          if (!entry) return failed('dweb block authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.setPeerBlocked(value.did, value.block, value.reason), false, HOST_EFFECT_OUTCOME.dwebPolicyMutation);
        }
        case 'turn.dweb.set-discovery-enabled': {
          const entry = dwebExecutionEntry(run, value, operation, ['enabled']);
          if (!entry) return failed('dweb policy authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.authority.setDiscoveryEnabled(value.enabled), false, HOST_EFFECT_OUTCOME.dwebPolicyMutation);
        }
        case 'turn.dweb.run-mesh-program': {
          const entry = dwebExecutionEntry(run, value, operation, ['code', 'timeoutMs']);
          if (!entry) return failed('mesh program authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.authority.runMeshProgram(value.code, value.timeoutMs), false,
            HOST_EFFECT_OUTCOME.meshProgramRun);
        }
        case 'turn.event':
          await run.events.push(await rehydrateEvent(
            run, jsonUnwire(value.eventJson, 'turn event'),
          ));
          return known(null);
        case 'turn.abort.finalize': {
          const controllerOutcomeUnknown = value.outcomeKnown === false;
          if (!sameSession() || typeof value.messageId !== 'string'
              || value.messageId !== run.currentAssistantId
              || (value.content !== undefined && typeof value.content !== 'string')
              || (controllerOutcomeUnknown && (typeof value.error !== 'string'
                || typeof value.code !== 'string' || value.retryable !== false))) {
            return failed('abort finalization authority mismatch', true);
          }
          if (run.abortFinalized) return failed('abort already finalized', true);
          run.finalizing = true;
          const priorKernelCalls = [...run.activeKernelCalls]
            .filter((entry) => entry !== admission);
          let kernelCallsDrained = priorKernelCalls.length === 0;
          let custodyDrained = false;
          const closeCalls = [...run.semanticCallState.keys()].map((callId) =>
            closeSemanticCall(run, callId));
          const drain = Promise.allSettled([
            ...priorKernelCalls.map((entry) => entry.settled), ...closeCalls,
          ]).then(() => {
            kernelCallsDrained = true;
            custodyDrained = run.activeDispatches.size === 0
              && [...run.activeKernelCalls].every((entry) => entry === admission);
          });
          await boundedCleanup(drain);
          const receipts = [...run.effectReceipts.values()];
          const hostOutcomeUnknown = !kernelCallsDrained || !custodyDrained
            || run.activeDispatches.size > 0
            || receipts.some((receipt) => receipt.performed === true
              || receipt.outcomeKnown === false);
          const outcomeUnknown = controllerOutcomeUnknown || hostOutcomeUnknown;
          if (hostOutcomeUnknown) run.nestedUnknown = true;
          run.abortFinalized = true;
          run.currentAssistantId = null;
          try {
            await run.ctx.sessions.updateAssistantMessage(run.sessionId, value.messageId, {
              ...(value.content === undefined ? {} : { content: value.content }),
              streaming: false,
              ...(outcomeUnknown ? {
                error: hostOutcomeUnknown
                  ? 'An authority effect may have completed before the turn stopped; verify before retrying.'
                  : value.error,
                errorCode: hostOutcomeUnknown ? 'turn_abort_effect_outcome_unknown' : value.code,
                outcomeKnown: false,
                retryable: false,
              } : { stopReason: 'aborted' }),
            });
            await run.events.push(outcomeUnknown ? {
              type: 'error', sessionId: run.sessionId, messageId: value.messageId,
              error: hostOutcomeUnknown
                ? 'An authority effect may have completed before the turn stopped; verify before retrying.'
                : value.error,
              code: hostOutcomeUnknown ? 'turn_abort_effect_outcome_unknown' : value.code,
              outcomeKnown: false, retryable: false,
            } : {
              type: 'stop', sessionId: run.sessionId,
              messageId: value.messageId, stopReason: 'aborted',
            });
            run.finalizedKnown = true;
            return known(null);
          } catch (cause) { return unknown(run, cause); }
        }
        case 'turn.finalize':
          run.finalizing = true;
          {
            const priorKernelCalls = [...run.activeKernelCalls]
              .filter((entry) => entry !== admission);
            let kernelCallsDrained = priorKernelCalls.length === 0;
            if (!kernelCallsDrained) {
              await boundedCleanup(Promise.allSettled(
                priorKernelCalls.map((entry) => entry.settled),
              ).then(() => { kernelCallsDrained = true; }));
            }
            if (!kernelCallsDrained
                || [...run.activeKernelCalls].some((entry) => entry !== admission)) {
              return unknown(run, 'a controller kernel call remained active at finalization');
            }
          }
          await Promise.allSettled([...run.activeSafeDispatches]);
          if (run.activeDispatches.size > 0) {
            return unknown(run, 'an irreversible authority operation remained active at finalization');
          }
          for (const callId of new Set([
            ...run.semanticCallState.keys(), ...run.claimedEffectsByCall.keys(),
          ])) await closeSemanticCall(run, callId);
          if ([...run.effectReceipts.values()].some((receipt) =>
            typeof receipt.callId === 'string'
              && !run.persistedSemanticCalls.has(receipt.callId))) {
            return unknown(run, 'an authority result was not persisted before finalization');
          }
          if (run.nestedUnknown) {
            return unknown(run, 'a kernel operation crossed dispatch without a known outcome');
          }
          run.finalizedKnown = true;
          return known(null);
        default:
          return { ok: false, code: 'turn-kernel-operation-denied', outcomeKnown: true };
        }
      } catch (cause) {
        return operation.startsWith('turn.session.') && operation !== 'turn.session.get'
          ? unknown(run, cause) : failed(cause, true);
      }
    } finally {
      run.activeKernelCalls.delete(admission);
      settleAdmission();
    }
  };

  const runUserTurn = async function* (/** @type {Record<string, any>} */ ctx) {
    if (typeof ctx?.sessionId !== 'string' || !ctx.sessionId) {
      throw new Error('controller turn requires a sessionId');
    }
    const runId = newId();
    const events = makeEventQueue();
    const localAbort = new AbortController();
    const onAbort = () => localAbort.abort();
    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
    if (ctx.signal?.aborted) localAbort.abort();
    const turnGeneration = (sessionGenerations.get(ctx.sessionId) ?? 0) + 1;
    sessionGenerations.set(ctx.sessionId, turnGeneration);
    const allowedOperations = projectedOperationSet(ctx.allowedOperations);
    const allowedToolNames = projectedToolNameSet(ctx.tools);
    if (!allowedOperations) throw new TypeError('controller operation projection is invalid');
    if (!allowedToolNames) throw new TypeError('controller tool projection is invalid');
    const operationGrant = createReadOnlyOperationGrant(allowedOperations);
    const authorityContext = {
      ...ctx,
      // why: code-mode nested capabilities must be a frozen projection of this
      // run's exact host grant. Only membership is exposed; the backing Set is
      // closure-private and stays live as trusted refresh narrows the turn.
      operationGrant,
    };
    const run = {
      runId, sessionId: ctx.sessionId, turnGeneration,
      ctx: authorityContext, events, abort: localAbort, signal: localAbort.signal,
      loadAuthorityContext: ctx.loadAuthorityContext,
      authorityBindingReady: null,
      authorityBinding: null,
      authorityScopes: new Map(),
      authorityBridge: null,
      opaque: new Map(), modelToolCalls: new Map(),
      providerOwner: Object.freeze({ runId }), modelCandidates: [],
      maxOutputTokens: Number.isSafeInteger(ctx.maxOutputTokens)
        ? Math.max(1, Math.min(64_000, Number(ctx.maxOutputTokens))) : 64_000,
      providerClose: null,
      providerCustodyGeneration: 0, providerCloseGeneration: -1,
      tools: [], system: null,
      nestedUnknown: false, abortFinalized: false,
      currentAssistantId: null, resumeAssistantId: null,
      activeDispatches: new Set(), activeSafeDispatches: new Set(),
      activeKernelCalls: new Set(),
      dispatchesByCall: new Map(),
      semanticEffectIds: new Set(), semanticCallState: new Map(), effectReceipts: new Map(),
      claimedEffectsByCall: new Map(),
      persistedSemanticCalls: new Set(),
      completedSemanticCalls: new Set(), closingSemanticCalls: new Set(),
      closingSemanticCallPromises: new Map(), finalizing: false,
      finalizedKnown: false,
      allowedOperations, allowedToolNames,
    };
    setTools(run, ctx.tools);
    const cleanCtx = controllerCtx(ctx);
    if (ctx.attachments !== undefined) {
      cleanCtx.attachments = externalizeAttachments(run, ctx.attachments);
    }
    runs.set(runId, run);
    let settled;
    try {
      const client = await getClient();
      settled = client.call('turn.run', {
        runId, sessionId: ctx.sessionId,
        maxSteps: cleanCtx.maxSteps,
        ctxJson: jsonWire(cleanCtx),
        toolsJson: jsonWire(run.tools),
        turnGeneration,
      }, { signal: localAbort.signal, timeoutMs: 30 * 60_000 });
      settled.finally(() => events.close()).catch(() => {});
      while (true) {
        const next = await events.next();
        if (next.done) break;
        try { yield next.value; }
        finally { next.ack?.(); }
      }
      const result = await settled;
      if (result?.ok !== true) {
        const error = new Error(result?.error ?? result?.code ?? 'semantic turn controller failed');
        Object.assign(error, {
          code: result?.code ?? 'controller-turn-failed',
          outcomeKnown: result?.outcomeKnown === true,
          ...(result?.retryable === false ? { retryable: false } : {}),
        });
        throw error;
      }
      if (run.finalizedKnown !== true) {
        const admittedCustody = run.activeDispatches.size > 0
          || run.activeKernelCalls.size > 0
          || run.claimedEffectsByCall.size > 0 || run.effectReceipts.size > 0;
        localAbort.abort();
        await boundedCleanup(Promise.allSettled([
          ...run.activeDispatches,
          ...[...run.activeKernelCalls].map((entry) => entry.settled),
        ]));
        const error = new Error('semantic turn controller returned before host finalization');
        Object.assign(error, {
          code: 'controller-turn-finalization-missing',
          outcomeKnown: !admittedCustody,
          retryable: false,
        });
        throw error;
      }
    } finally {
      localAbort.abort();
      ctx.signal?.removeEventListener?.('abort', onAbort);
      events.close();
      try {
        await boundedCleanup(Promise.allSettled(
          [...run.activeKernelCalls].map((entry) => entry.settled),
        ));
        await closeProviderOwner(run);
      }
      finally {
        runs.delete(runId);
        run.opaque.clear();
      }
    }
  };

  return Object.freeze({
    authorize,
    handleKernelCall,
    runUserTurn,
    close: async () => {
      const providerCleanup = [];
      for (const run of runs.values()) {
        run.abort.abort();
        run.events.close();
        providerCleanup.push(closeProviderOwner(run));
      }
      runs.clear();
      sessionGenerations.clear();
      await Promise.allSettled(providerCleanup);
    },
    activeCount: () => runs.size,
  });
};
