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
  createKernelFeatureEffectQuota,
  kernelFeatureOuterPayloadCap,
  kernelFeaturePayloadAllowed,
  parseKernelFeatureCall,
} from './kernel-feature-policy.js';
import { RUNTIME_DISPATCH_CAPABILITY } from './kernel-runtime-policy.js';
import { CONTROLLER_TOOL_MANIFEST } from './controller-tool-manifest.js';
import {
  parseToolExecutionRequest,
  toolEffectLossSemantics,
} from './tool-execution-protocol.js';

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
const DOMAIN_OPERATIONS = Object.freeze({
  'turn.actor.spawn-sync': { tool: 'actor_create', riskClass: 'resource' },
  'turn.actor.spawn-async': { tool: 'actor_create', riskClass: 'resource' },
  'turn.actor.tasks': { tool: 'actor_tasks', riskClass: 'read' },
  'turn.actor.cancel': { tool: 'actor_cancel', riskClass: 'control' },
  'turn.actor.message': { tool: 'message_actor', riskClass: 'resource' },
  'turn.pod.resolve': { tool: 'pod_exec', riskClass: 'read' },
  'turn.pod.read-remote': { tool: 'pod_exec', riskClass: 'read' },
  'turn.pod.confirm-git': { tool: 'pod_exec', riskClass: 'control' },
  'turn.pod.exec': { tool: 'pod_exec', riskClass: 'resource' },
  'turn.pod.status': { tool: 'pod_status', riskClass: 'read' },
  'turn.pod.cancel': { tool: 'pod_cancel', riskClass: 'control' },
  'turn.pod.read-file': { tool: 'pod_read', riskClass: 'read' },
  'turn.pod.write-file': { tool: 'pod_write', riskClass: 'commit' },
  'turn.repository.read-pod': { tool: 'pod_destroy', riskClass: 'read' },
  'turn.repository.destroy-pod': { tool: 'pod_destroy', riskClass: 'commit' },
  'turn.repository.read-status': { tool: 'repo_history', riskClass: 'read' },
  'turn.repository.read-history': { tool: 'repo_history', riskClass: 'read' },
  'turn.repository.read-remote': { tools: ['repo_history', 'repo_remote'], riskClass: 'read' },
  'turn.repository.read-diff': { tool: 'repo_history', riskClass: 'read' },
  'turn.repository.confirm-restore': { tool: 'repo_version', riskClass: 'control' },
  'turn.repository.checkpoint': { tool: 'repo_version', riskClass: 'commit' },
  'turn.repository.branch': { tool: 'repo_version', riskClass: 'commit' },
  'turn.repository.checkout': { tool: 'repo_version', riskClass: 'commit' },
  'turn.repository.restore': { tool: 'repo_version', riskClass: 'commit' },
  'turn.repository.confirm-remote': { tool: 'repo_remote', riskClass: 'control' },
  'turn.repository.link': { tool: 'repo_remote', riskClass: 'commit' },
  'turn.repository.fetch': { tool: 'repo_remote', riskClass: 'commit' },
  'turn.repository.push': { tool: 'repo_remote', riskClass: 'resource' },
  'turn.vm.read': { tools: ['vm_boot', 'vm_delete'], riskClass: 'read' },
  'turn.vm.list': { tool: 'vm_boot', riskClass: 'read' },
  'turn.vm.set-default': { tool: 'vm_boot', riskClass: 'control' },
  'turn.vm.run': { tool: 'vm_boot', riskClass: 'resource' },
  'turn.vm.import-file': { tool: 'vm_import', riskClass: 'resource' },
  'turn.vm.write-text-file': { tool: 'vm_write_file', riskClass: 'commit' },
  'turn.vm.destroy': { tool: 'vm_delete', riskClass: 'commit' },
  'turn.notebook.read': { tools: ['js_notebook', 'js_delete'], riskClass: 'read' },
  'turn.notebook.list': { tool: 'js_notebook', riskClass: 'read' },
  'turn.notebook.set-default': { tool: 'js_notebook', riskClass: 'control' },
  'turn.notebook.run': { tool: 'js_notebook', riskClass: 'resource' },
  'turn.notebook.write-file': { tool: 'js_write_file', riskClass: 'commit' },
  'turn.notebook.read-file': { tool: 'js_read_file', riskClass: 'read' },
  'turn.notebook.destroy': { tool: 'js_delete', riskClass: 'commit' },
  'turn.app.update': { tool: 'app_update', riskClass: 'commit' },
  'turn.app.open': { tool: 'app_open', riskClass: 'resource' },
  'turn.app.search': { tool: 'app_search', riskClass: 'read' },
  'turn.app.read': { tool: 'app_delete', riskClass: 'read' },
  'turn.app.delete': { tool: 'app_delete', riskClass: 'commit' },
  'turn.app.write-file': { tool: 'app_write_file', riskClass: 'commit' },
  'turn.app.read-file': { tool: 'app_read_file', riskClass: 'read' },
  'turn.app.list-files': { tool: 'app_list_files', riskClass: 'read' },
  'turn.app.delete-file': { tool: 'app_delete_file', riskClass: 'commit' },
  'turn.app.observe': { tool: 'app_observe', riskClass: 'read' },
  'turn.app.act': { tool: 'app_act', riskClass: 'resource' },
  'turn.app.run-code': { tool: 'app_code', riskClass: 'resource' },
});

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
const unknownPendingLoss = () => Object.freeze({ outcomeKnown: false, retryable: false });
const makeCustody = () => {
  let settledIrreversible = false;
  let unknownIrreversible = false;
  return Object.freeze({
    observe: (/** @type {unknown} */ result, /** @type {boolean} */ replayable) => {
      if (replayable) return;
      const reply = record(result);
      if (reply?.outcomeKnown !== true) unknownIrreversible = true;
      else if (reply.ok === true || reply.retryable !== true) settledIrreversible = true;
    },
    snapshot: () => unknownIrreversible
      ? Object.freeze({ outcomeKnown: false, retryable: false })
      : Object.freeze({ outcomeKnown: true, retryable: !settledIrreversible }),
  });
};

export const controllerCustodyIsAuthoritative = (/** @type {string} */ capability) =>
  capability === KERNEL_FEATURE_DISPATCH_CAPABILITY
  || capability === RUNTIME_DISPATCH_CAPABILITY;

export const normalizeControllerCustody = (
  /** @type {string} */ capability,
  /** @type {any} */ result,
  /** @type {{outcomeKnown:boolean,retryable:boolean}|null} */ custody,
  /** @type {boolean} */ pending,
) => {
  const preservesUnknown = result?.ok === false && result.outcomeKnown === false
    && result.retryable === false;
  const base = pending && !preservesUnknown ? {
    ok: false, code: 'controller-pending-kernel-effect',
    outcomeKnown: result?.outcomeKnown === true,
    ...(result?.retryable === false ? { retryable: false } : {}),
  } : result ?? { ok: false, code: 'controller-result-missing' };
  if (!custody) return base;
  if (custody.outcomeKnown !== true) {
    return { ...base, outcomeKnown: false, retryable: false };
  }
  if (!controllerCustodyIsAuthoritative(capability) && base?.outcomeKnown !== true) {
    return { ...base, outcomeKnown: false, retryable: false };
  }
  if (base?.ok === true) return { ...base, outcomeKnown: true };
  return {
    ...base, ok: false, outcomeKnown: true,
    retryable: custody.retryable && base?.retryable !== false,
  };
};

export const controllerOuterPayloadCap = (/** @type {string} */ capability) =>
  capability === 'turn.run' ? TURN_OUTER_BYTES
    : capability === 'prompt.render' ? PROMPT_OUTER_BYTES
      : kernelFeatureOuterPayloadCap(capability) || GENERIC_OUTER_BYTES;

export const controllerPayloadAllowed = (/** @type {string} */ capability,
  /** @type {unknown} */ payload) => {
  if (capability === KERNEL_FEATURE_DISPATCH_CAPABILITY) {
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
  && (operation === 'turn.model.cancel-inference' || operation === 'turn.tool.settle'
    || operation === 'turn.abort.finalize' || operation === 'turn.finalize');

/**
 * @param {string} capability
 * @param {unknown} outerPayload
 * @param {typeof CONTROLLER_TOOL_MANIFEST} [toolManifest]
 */
export const createControllerKernelQuota = (
  capability, outerPayload, toolManifest = CONTROLLER_TOOL_MANIFEST,
) => {
  if (capability === KERNEL_FEATURE_DISPATCH_CAPABILITY) {
    return createKernelFeatureEffectQuota(capability, outerPayload);
  }
  if (capability === 'semantic.dispatch') {
    const quota = createSemanticDemandQuota(outerPayload);
    const custody = makeCustody();
    return Object.freeze({
      admit: quota.admit,
      observe: (
        /** @type {string} */ operation,
        /** @type {unknown} */ _payload,
        /** @type {unknown} */ result,
      ) => {
        const observed = quota.observe(operation, result);
        custody.observe(observed?.ok === true ? result : observed, false);
        return observed;
      },
      pendingCap: quota.pendingCap,
      pendingLoss: unknownPendingLoss,
      custody: custody.snapshot,
    });
  }
  if (capability !== 'turn.run') {
    return Object.freeze({
      admit: () => refusal('kernel-operation-denied'),
      observe: () => refusal('kernel-operation-denied'),
      pendingCap: 0,
      pendingLoss: unknownPendingLoss,
      custody: unknownPendingLoss,
    });
  }
  const outer = record(outerPayload);
  const ctx = record(outer?.ctx);
  const steps = safeSteps(outer?.maxSteps ?? ctx?.maxSteps);
  const toolBudget = 4_096 * steps;
  const streamBudget = MODEL_STREAM_EVENTS * steps;
  /** @type {Map<string, number>} */
  const counts = new Map();
  const custody = makeCustody();
  /** @type {Map<string, ReturnType<typeof parseToolExecutionRequest>>} */
  const toolExecutions = new Map();
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
    'turn.model.bind': 1,
    'turn.model.open-inference': 32 * steps,
    'turn.model.read-inference': streamBudget,
    'turn.model.cancel-inference': 32 * steps,
    'turn.model.read-inventory': steps,
    'turn.model.read-context': steps,
    'turn.model.observe-event': streamBudget,
    'turn.model.observe-failover': 8 * steps,
    'turn.tool.prepare': toolBudget,
    'turn.tool.effect': 8 * toolBudget,
    'turn.tool.settle': toolBudget,
    'turn.tool.dispatch': toolBudget,
    'turn.actor.spawn-sync': toolBudget,
    'turn.actor.spawn-async': toolBudget,
    'turn.actor.tasks': toolBudget,
    'turn.actor.cancel': toolBudget,
    'turn.actor.message': toolBudget,
    'turn.pod.resolve': toolBudget,
    'turn.pod.read-remote': toolBudget,
    'turn.pod.confirm-git': toolBudget,
    'turn.pod.exec': toolBudget,
    'turn.pod.status': toolBudget,
    'turn.pod.cancel': toolBudget,
    'turn.pod.read-file': toolBudget,
    'turn.pod.write-file': toolBudget,
    'turn.repository.read-pod': toolBudget,
    'turn.repository.destroy-pod': toolBudget,
    'turn.repository.read-status': toolBudget,
    'turn.repository.read-history': toolBudget,
    'turn.repository.read-remote': toolBudget,
    'turn.repository.read-diff': toolBudget,
    'turn.repository.confirm-restore': toolBudget,
    'turn.repository.checkpoint': toolBudget,
    'turn.repository.branch': toolBudget,
    'turn.repository.checkout': toolBudget,
    'turn.repository.restore': toolBudget,
    'turn.repository.confirm-remote': toolBudget,
    'turn.repository.link': toolBudget,
    'turn.repository.fetch': toolBudget,
    'turn.repository.push': toolBudget,
    'turn.vm.read': toolBudget,
    'turn.vm.list': toolBudget,
    'turn.vm.set-default': toolBudget,
    'turn.vm.run': toolBudget,
    'turn.vm.import-file': toolBudget,
    'turn.vm.write-text-file': toolBudget,
    'turn.vm.destroy': toolBudget,
    'turn.notebook.read': toolBudget,
    'turn.notebook.list': toolBudget,
    'turn.notebook.set-default': toolBudget,
    'turn.notebook.run': toolBudget,
    'turn.notebook.write-file': toolBudget,
    'turn.notebook.read-file': toolBudget,
    'turn.notebook.destroy': toolBudget,
    'turn.app.update': toolBudget,
    'turn.app.open': toolBudget,
    'turn.app.search': toolBudget,
    'turn.app.read': toolBudget,
    'turn.app.delete': toolBudget,
    'turn.app.write-file': toolBudget,
    'turn.app.read-file': toolBudget,
    'turn.app.list-files': toolBudget,
    'turn.app.delete-file': toolBudget,
    'turn.app.observe': toolBudget,
    'turn.app.act': toolBudget,
    'turn.app.run-code': toolBudget,
    'turn.event': streamBudget + 2 * toolBudget + 8 * steps + 16,
    'turn.abort.finalize': 1,
    'turn.finalize': 1,
  });
  const allowed = new Set(Object.keys(limits));

  const admit = (/** @type {string} */ operation, /** @type {unknown} */ payload) => {
    if (!allowed.has(operation)) return refusal('kernel-operation-denied');
    if (!bounded(payload, operation === 'turn.model.read-inference'
      ? MODEL_EVENT_BYTES : TURN_VALUE_BYTES)) {
      return refusal('kernel-operation-payload-too-large');
    }
    const used = counts.get(operation) ?? 0;
    const limit = limits[/** @type {keyof typeof limits} */ (operation)];
    if (used >= limit) return refusal('kernel-operation-budget-exhausted');
    const value = record(record(payload)?.value);
    const domainPolicy = DOMAIN_OPERATIONS[/** @type {keyof typeof DOMAIN_OPERATIONS} */ (operation)];
    if (domainPolicy) {
      const execution = typeof value?.executionId === 'string'
        ? toolExecutions.get(value.executionId) : null;
      const allowedTools = 'tools' in domainPolicy
        ? domainPolicy.tools : [domainPolicy.tool];
      if (!execution || !allowedTools.includes(execution.toolName)
          || value?.argsDigest !== execution.argsDigest
          || value?.turnGeneration !== execution.turnGeneration) {
        return refusal('kernel-domain-authority-invalid');
      }
    }
    if (operation === 'turn.model.read-inference'
        || operation === 'turn.model.cancel-inference') {
      const streamId = value?.streamId;
      const model = typeof streamId === 'string' ? models.get(streamId) : null;
      if (!model) return refusal('kernel-model-channel-invalid');
      if (operation === 'turn.model.read-inference') {
        if (model.pending) return refusal('kernel-model-pull-overlap');
        if (model.events >= MODEL_STREAM_EVENTS || model.bytes >= MODEL_STREAM_BYTES) {
          models.delete(streamId);
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
    if (!bounded(result, operation === 'turn.model.read-inference'
      ? MODEL_EVENT_BYTES : TURN_VALUE_BYTES)) {
      if (operation.startsWith('turn.model.')) {
        const streamId = value?.streamId ?? replyValue?.streamId;
        if (typeof streamId === 'string') models.delete(streamId);
      }
      return refusal('kernel-operation-result-too-large', false);
    }
    if (operation === 'turn.model.open-inference' && reply?.ok === true) {
      const streamId = replyValue?.streamId;
      if (typeof streamId !== 'string' || streamId.length < 1 || models.has(streamId)) {
        return refusal('kernel-model-channel-invalid', false);
      }
      models.set(streamId, { events: 0, bytes: 0, pending: false });
    }
    if (operation === 'turn.model.read-inference') {
      const streamId = value?.streamId;
      const model = typeof streamId === 'string' ? models.get(streamId) : null;
      if (!model) return refusal('kernel-model-channel-invalid', false);
      model.pending = false;
      if (reply?.ok !== true || replyValue?.done === true) {
        models.delete(streamId);
      } else {
        const eventBytes = controllerPayloadBytes(replyValue?.chunk);
        model.events += 1;
        model.bytes += Number.isFinite(eventBytes) ? eventBytes : MODEL_EVENT_BYTES + 1;
        if (model.events > MODEL_STREAM_EVENTS || model.bytes > MODEL_STREAM_BYTES) {
          models.delete(streamId);
          return refusal('kernel-model-budget-exhausted', false);
        }
      }
    }
    if (operation === 'turn.model.cancel-inference') {
      const streamId = value?.streamId;
      if (typeof streamId === 'string') models.delete(streamId);
    }
    if (operation === 'turn.tool.prepare' && reply?.ok === true
        && typeof replyValue?.requestJson === 'string') {
      try {
        const request = parseToolExecutionRequest(
          JSON.parse(replyValue.requestJson), toolManifest,
        );
        if (request) toolExecutions.set(request.executionId, request);
      } catch { /* malformed preparation remains kernel-owned */ }
    }
    const domainPolicy = DOMAIN_OPERATIONS[/** @type {keyof typeof DOMAIN_OPERATIONS} */ (operation)];
    const replayable = operation === 'turn.session.get'
      || operation === 'turn.prompt.get' || operation === 'turn.tools.refresh'
      || operation === 'turn.tool.prepare'
      || domainPolicy?.riskClass === 'read' || domainPolicy?.riskClass === 'control'
      || (operation === 'turn.tool.effect'
        && pendingLoss(operation, payload).retryable === true);
    custody.observe(result, replayable);
    return Object.freeze({ ok: true, outcomeKnown: true });
  };

  const pendingLoss = (/** @type {string} */ operation, /** @type {unknown} */ payload) => {
    const domainPolicy = DOMAIN_OPERATIONS[/** @type {keyof typeof DOMAIN_OPERATIONS} */ (operation)];
    if (domainPolicy) {
      const effect = record(record(payload)?.value);
      const execution = typeof effect?.executionId === 'string'
        ? toolExecutions.get(effect.executionId) : null;
      const allowedTools = 'tools' in domainPolicy
        ? domainPolicy.tools : [domainPolicy.tool];
      if (!execution || !allowedTools.includes(execution.toolName)
          || effect?.argsDigest !== execution.argsDigest
          || effect?.turnGeneration !== execution.turnGeneration) {
        return unknownPendingLoss();
      }
      return toolEffectLossSemantics(domainPolicy.riskClass, 'during');
    }
    if (operation !== 'turn.tool.effect') return unknownPendingLoss();
    const effect = record(record(payload)?.value);
    const execution = typeof effect?.executionId === 'string'
      ? toolExecutions.get(effect.executionId) : null;
    if (!execution || effect?.argsDigest !== execution.argsDigest
        || effect?.turnGeneration !== execution.turnGeneration
        || typeof effect?.operation !== 'string') {
      return unknownPendingLoss();
    }
    const policy = execution.policy.effects.find(
      (/** @type {any} */ candidate) => candidate.operation === effect.operation,
    );
    return policy ? toolEffectLossSemantics(policy.riskClass, 'during')
      : unknownPendingLoss();
  };

  return Object.freeze({
    admit, observe, pendingLoss, custody: custody.snapshot,
    pendingCap: MAX_CONCURRENT_KERNEL_CALLS,
  });
};
