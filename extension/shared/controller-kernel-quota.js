// @ts-check
// Capability-specific bounds for controller -> authority-kernel calls. The
// semantic Worker never chooses these limits. Both channel ends instantiate
// the same state machine from the kernel-granted capability and outer payload,
// so drift retires the channel instead of widening it.

import { controllerPayloadBytes } from './structured-clone-size.js';
import {
  createSemanticDemandQuota,
  SEMANTIC_DEMAND_MAX_BYTES,
} from './semantic-demand-policy.js';
import {
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
  KERNEL_FEATURE_EVENT_CAPABILITY,
  createKernelFeatureEffectQuota,
  kernelFeatureOuterPayloadCap,
  kernelFeaturePayloadAllowed,
  parseKernelFeatureCall,
} from './kernel-feature-policy.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const HARD_TURN_STEPS = 100;
const TURN_OUTER_BYTES = 2 * MIB;
const PROMPT_OUTER_BYTES = 128 * KIB;
const GENERIC_OUTER_BYTES = SEMANTIC_DEMAND_MAX_BYTES;
const TURN_VALUE_BYTES = 4 * MIB;
const MODEL_EVENT_BYTES = 256 * KIB;
const MODEL_STREAM_BYTES = 8 * MIB;
// A 64k-token model stream also carries start/stop/usage/tool framing events.
// Keep the independent 8 MiB byte rail authoritative while leaving enough
// event headroom for a maximally fragmented but otherwise valid response.
const MODEL_STREAM_EVENTS = 131_072;
const MAX_CONCURRENT_KERNEL_CALLS = 256;
const TURN_IDLE_DEADLINE_MS = 30 * 60_000;

const safeSteps = (/** @type {unknown} */ value) => Number.isSafeInteger(value)
  ? Math.max(1, Math.min(HARD_TURN_STEPS, Number(value))) : HARD_TURN_STEPS;
const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string, any>} */ (value) : null;
const bounded = (/** @type {unknown} */ value, /** @type {number} */ max) => {
  // Large valid transcripts/tool results can exceed the generic 10k-node
  // traversal default while remaining far below their byte budget. This wider
  // traversal is still bounded and both channel ends run the same accounting.
  const bytes = controllerPayloadBytes(value, { maxDepth: 32, maxNodes: 250_000 });
  return Number.isFinite(bytes) && bytes <= max;
};
const refusal = (/** @type {string} */ code, /** @type {boolean} */ outcomeKnown = true) =>
  Object.freeze({ ok: false, code, outcomeKnown });

export const controllerOuterPayloadCap = (/** @type {string} */ capability) =>
  capability === 'turn.run' ? TURN_OUTER_BYTES
    : capability === 'prompt.render' ? PROMPT_OUTER_BYTES
      : kernelFeatureOuterPayloadCap(capability) || GENERIC_OUTER_BYTES;

export const controllerPayloadAllowed = (/** @type {string} */ capability,
  /** @type {unknown} */ payload) => {
  if (capability === KERNEL_FEATURE_DISPATCH_CAPABILITY
      || capability === KERNEL_FEATURE_EVENT_CAPABILITY) {
    return kernelFeaturePayloadAllowed(capability, payload);
  }
  return true;
};

export const controllerCallMaxDuration = (/** @type {string} */ capability,
  /** @type {unknown} */ payload) => parseKernelFeatureCall(capability, payload)
    ?.policy.maxDurationMs ?? Number.POSITIVE_INFINITY;

// Renewals are progress-bound and never widen unattended host custody beyond
// one idle window.
export const controllerRenewalIdleCap = (/** @type {string} */ capability) =>
  capability === 'turn.run' ? TURN_IDLE_DEADLINE_MS : 0;

export const controllerOperationAllowedAfterCancel = (
  /** @type {string} */ capability,
  /** @type {string} */ operation,
) => capability === 'turn.run'
  && (operation === 'turn.abort.finalize' || operation === 'turn.finalize');

/**
 * @param {string} capability
 * @param {unknown} outerPayload
 */
export const createControllerKernelQuota = (capability, outerPayload) => {
  if (capability === KERNEL_FEATURE_DISPATCH_CAPABILITY
      || capability === KERNEL_FEATURE_EVENT_CAPABILITY) {
    return createKernelFeatureEffectQuota(capability, outerPayload);
  }
  if (capability === 'semantic.dispatch') {
    const quota = createSemanticDemandQuota(outerPayload);
    return Object.freeze({
      admit: quota.admit,
      observe: (
        /** @type {string} */ operation,
        /** @type {unknown} */ _payload,
        /** @type {unknown} */ result,
      ) => quota.observe(operation, result),
      pendingCap: quota.pendingCap,
    });
  }
  if (capability !== 'turn.run') {
    return Object.freeze({
      admit: () => refusal('kernel-operation-denied'),
      observe: () => refusal('kernel-operation-denied'),
      pendingCap: 0,
    });
  }
  const outer = record(outerPayload);
  const ctx = record(outer?.ctx);
  const steps = safeSteps(outer?.maxSteps ?? ctx?.maxSteps);
  const toolBudget = 4_096 * steps;
  const streamBudget = MODEL_STREAM_EVENTS * steps;
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {Map<string, { events:number, bytes:number, pending:boolean }>} */
  const models = new Map();

  const limits = Object.freeze({
    'turn.session.get': steps + 4,
    'turn.session.append': 2 * steps + 8,
    'turn.session.update-assistant': steps * MODEL_STREAM_EVENTS + 10 * steps + 8,
    'turn.session.set-trim': steps,
    'turn.prompt.get': steps + 1,
    'turn.tools.refresh': steps,
    'turn.audit.append': toolBudget + steps + 8,
    'turn.trim.enrich': steps,
    'turn.model.open': steps,
    'turn.model.next': streamBudget,
    'turn.model.cancel': steps,
    'turn.tool.dispatch': toolBudget,
    'turn.event': streamBudget + 2 * toolBudget + 8 * steps + 16,
    'turn.abort.finalize': 1,
    'turn.finalize': 1,
  });
  const allowed = new Set(Object.keys(limits));

  const admit = (/** @type {string} */ operation, /** @type {unknown} */ payload) => {
    if (!allowed.has(operation)) return refusal('kernel-operation-denied');
    if (!bounded(payload, operation === 'turn.model.next' ? MODEL_EVENT_BYTES : TURN_VALUE_BYTES)) {
      return refusal('kernel-operation-payload-too-large');
    }
    const used = counts.get(operation) ?? 0;
    const limit = limits[/** @type {keyof typeof limits} */ (operation)];
    if (used >= limit) return refusal('kernel-operation-budget-exhausted');
    const value = record(record(payload)?.value);
    if (operation === 'turn.model.next' || operation === 'turn.model.cancel') {
      const modelId = value?.modelId;
      const model = typeof modelId === 'string' ? models.get(modelId) : null;
      if (!model) return refusal('kernel-model-channel-invalid');
      if (operation === 'turn.model.next') {
        if (model.pending) return refusal('kernel-model-pull-overlap');
        if (model.events >= MODEL_STREAM_EVENTS || model.bytes >= MODEL_STREAM_BYTES) {
          models.delete(modelId);
          return refusal('kernel-model-budget-exhausted');
        }
        model.pending = true;
      }
    }
    counts.set(operation, used + 1);
    return Object.freeze({ ok: true, outcomeKnown: true });
  };

  const observe = (
    /** @type {string} */ operation,
    /** @type {unknown} */ payload,
    /** @type {unknown} */ result,
  ) => {
    if (!allowed.has(operation)) return refusal('kernel-operation-denied');
    const value = record(record(payload)?.value);
    const reply = record(result);
    const replyValue = record(reply?.value);
    if (!bounded(result, operation === 'turn.model.next' ? MODEL_EVENT_BYTES : TURN_VALUE_BYTES)) {
      if (operation.startsWith('turn.model.')) {
        const modelId = value?.modelId ?? replyValue?.modelId;
        if (typeof modelId === 'string') models.delete(modelId);
      }
      return refusal('kernel-operation-result-too-large', false);
    }
    if (operation === 'turn.model.open' && reply?.ok === true) {
      const modelId = replyValue?.modelId;
      if (typeof modelId !== 'string' || modelId.length < 1 || models.has(modelId)) {
        return refusal('kernel-model-channel-invalid', false);
      }
      models.set(modelId, { events: 0, bytes: 0, pending: false });
    }
    if (operation === 'turn.model.next') {
      const modelId = value?.modelId;
      const model = typeof modelId === 'string' ? models.get(modelId) : null;
      if (!model) return refusal('kernel-model-channel-invalid', false);
      model.pending = false;
      if (reply?.ok !== true || replyValue?.done === true) {
        models.delete(modelId);
      } else {
        const eventBytes = controllerPayloadBytes(replyValue?.event);
        model.events += 1;
        model.bytes += Number.isFinite(eventBytes) ? eventBytes : MODEL_EVENT_BYTES + 1;
        if (model.events > MODEL_STREAM_EVENTS || model.bytes > MODEL_STREAM_BYTES) {
          models.delete(modelId);
          return refusal('kernel-model-budget-exhausted', false);
        }
      }
    }
    if (operation === 'turn.model.cancel') {
      const modelId = value?.modelId;
      if (typeof modelId === 'string') models.delete(modelId);
    }
    return Object.freeze({ ok: true, outcomeKnown: true });
  };

  return Object.freeze({ admit, observe, pendingCap: MAX_CONCURRENT_KERNEL_CALLS });
};
