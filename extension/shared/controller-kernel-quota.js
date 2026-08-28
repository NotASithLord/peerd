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
import {
  createTurnPhaseQuota,
  turnPhaseOuterPayloadCap,
  turnPhasePayloadAllowed,
  turnPhaseResultAllowed,
} from './controller-turn-phase-policy.js';
import { exactEffectLossSemantics } from './exact-effect-outcome.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const HARD_TURN_STEPS = 100;
const TURN_OUTER_BYTES = 2 * MIB;
const PROMPT_OUTER_BYTES = 128 * KIB;
const TOOL_PROJECTION_OUTER_BYTES = 64 * KIB;
const GENERIC_OUTER_BYTES = SEMANTIC_DEMAND_MAX_BYTES;
const TURN_VALUE_BYTES = 4 * MIB;
const MODEL_EVENT_BYTES = 256 * KIB;
const MODEL_STREAM_BYTES = 8 * MIB;
// A 64k-token model stream also carries start/stop/usage/tool framing events.
// Keep the independent 8 MiB byte rail authoritative while leaving enough
// event headroom for a maximally fragmented but otherwise valid response.
const MODEL_STREAM_EVENTS = 131_072;
const MAX_CONCURRENT_KERNEL_CALLS = 256;
const MAX_EFFECTS_PER_MODEL_CALL = 256;
const TURN_IDLE_DEADLINE_MS = 30 * 60_000;
export const CONTROLLER_DOMAIN_OPERATIONS = Object.freeze({
  'turn.goal.complete': { authorityClass: 'local', riskClass: 'control', confirmation: 'never', retryClass: 'C' },
  'turn.actor.spawn-sync': { authorityClass: 'actor', riskClass: 'resource', confirmation: 'permission', retryClass: 'F' },
  'turn.actor.spawn-async': { authorityClass: 'actor', riskClass: 'resource', confirmation: 'permission', retryClass: 'F' },
  'turn.actor.tasks': { authorityClass: 'actor', riskClass: 'read' },
  'turn.actor.cancel': { authorityClass: 'actor', riskClass: 'control', confirmation: 'permission', retryClass: 'E' },
  'turn.actor.message': { authorityClass: 'actor', riskClass: 'resource', confirmation: 'permission', retryClass: 'E' },
  'turn.pod.resolve': { authorityClass: 'pod', riskClass: 'read' },
  'turn.pod.read-remote': { authorityClass: 'pod', riskClass: 'read' },
  'turn.pod.confirm-git': { authorityClass: 'pod', riskClass: 'control', confirmation: 'self' },
  'turn.pod.exec': { authorityClass: 'pod', riskClass: 'resource' },
  'turn.pod.status': { authorityClass: 'pod', riskClass: 'read' },
  'turn.pod.cancel': { authorityClass: 'pod', riskClass: 'control' },
  'turn.pod.read-file': { authorityClass: 'pod', riskClass: 'read' },
  'turn.pod.write-file': { authorityClass: 'pod', riskClass: 'commit' },
  'turn.repository.read-pod': { authorityClass: 'repository', riskClass: 'read' },
  'turn.repository.destroy-pod': { authorityClass: 'repository', riskClass: 'commit' },
  'turn.repository.read-status': { authorityClass: 'repository', riskClass: 'read' },
  'turn.repository.read-history': { authorityClass: 'repository', riskClass: 'read' },
  'turn.repository.read-remote': { authorityClass: 'repository', riskClass: 'read' },
  'turn.repository.read-diff': { authorityClass: 'repository', riskClass: 'read' },
  'turn.repository.confirm-restore': { authorityClass: 'repository', riskClass: 'control', confirmation: 'self' },
  'turn.repository.checkpoint': { authorityClass: 'repository', riskClass: 'commit' },
  'turn.repository.branch': { authorityClass: 'repository', riskClass: 'commit' },
  'turn.repository.checkout': { authorityClass: 'repository', riskClass: 'commit' },
  'turn.repository.restore': { authorityClass: 'repository', riskClass: 'commit', confirmation: 'never' },
  'turn.repository.confirm-remote': { authorityClass: 'repository', riskClass: 'control', confirmation: 'self' },
  'turn.repository.link': { authorityClass: 'repository', riskClass: 'commit', confirmation: 'never' },
  'turn.repository.fetch': { authorityClass: 'repository', riskClass: 'commit', confirmation: 'never' },
  'turn.repository.push': { authorityClass: 'repository', riskClass: 'resource', confirmation: 'never' },
  'turn.vm.read': { authorityClass: 'vm', riskClass: 'read' },
  'turn.vm.list': { authorityClass: 'vm', riskClass: 'read' },
  'turn.vm.set-default': { authorityClass: 'vm', riskClass: 'control' },
  'turn.vm.run': { authorityClass: 'vm', riskClass: 'resource' },
  'turn.vm.import-file': { authorityClass: 'vm', riskClass: 'resource' },
  'turn.vm.write-text-file': { authorityClass: 'vm', riskClass: 'commit' },
  'turn.vm.destroy': { authorityClass: 'vm', riskClass: 'commit' },
  'turn.notebook.read': { authorityClass: 'notebook', riskClass: 'read' },
  'turn.notebook.list': { authorityClass: 'notebook', riskClass: 'read' },
  'turn.notebook.set-default': { authorityClass: 'notebook', riskClass: 'control' },
  'turn.notebook.run': { authorityClass: 'notebook', riskClass: 'resource' },
  'turn.notebook.write-file': { authorityClass: 'notebook', riskClass: 'commit' },
  'turn.notebook.read-file': { authorityClass: 'notebook', riskClass: 'read' },
  'turn.notebook.destroy': { authorityClass: 'notebook', riskClass: 'commit' },
  'turn.app.update': { authorityClass: 'app', riskClass: 'commit' },
  'turn.app.open': { authorityClass: 'app', riskClass: 'resource' },
  'turn.app.search': { authorityClass: 'app', riskClass: 'read' },
  'turn.app.read': { authorityClass: 'app', riskClass: 'read' },
  'turn.app.delete': { authorityClass: 'app', riskClass: 'commit' },
  'turn.app.write-file': { authorityClass: 'app', riskClass: 'commit' },
  'turn.app.read-file': { authorityClass: 'app', riskClass: 'read' },
  'turn.app.list-files': { authorityClass: 'app', riskClass: 'read' },
  'turn.app.delete-file': { authorityClass: 'app', riskClass: 'commit' },
  'turn.app.observe': { authorityClass: 'app', riskClass: 'read' },
  'turn.app.act': { authorityClass: 'app', riskClass: 'resource' },
  'turn.app.run-code': { authorityClass: 'app', riskClass: 'resource' },
  'turn.memory.read-scope': { authorityClass: 'persistence', riskClass: 'read' },
  'turn.memory.read-subtree': { authorityClass: 'persistence', riskClass: 'read' },
  'turn.memory.write': { authorityClass: 'persistence', riskClass: 'commit', confirmation: 'self', retryClass: 'E' },
  'turn.todo.read': { authorityClass: 'persistence', riskClass: 'read' },
  'turn.todo.replace': { authorityClass: 'persistence', riskClass: 'commit' },
  'turn.page.open-tab': { authorityClass: 'page', riskClass: 'resource' },
  'turn.page.read': { authorityClass: 'page', riskClass: 'read' },
  'turn.page.snapshot': { authorityClass: 'page', riskClass: 'read' },
  'turn.page.read-state': { authorityClass: 'page', riskClass: 'read' },
  'turn.page.watch-changes': { authorityClass: 'page', riskClass: 'read' },
  'turn.page.query-dom': { authorityClass: 'page', riskClass: 'read' },
  'turn.page.navigate': { authorityClass: 'page', riskClass: 'resource' },
  'turn.page.fill': { authorityClass: 'page', riskClass: 'resource', confirmation: 'self' },
  'turn.page.click': { authorityClass: 'page', riskClass: 'resource', confirmation: 'self' },
  'turn.page.login': { authorityClass: 'page', riskClass: 'resource', confirmation: 'self' },
  'turn.page.run-program': { authorityClass: 'page', riskClass: 'resource', confirmation: 'self' },
  'turn.page.capture-foreground': { authorityClass: 'page', riskClass: 'read' },
  'turn.page.capture-owned': { authorityClass: 'page', riskClass: 'read' },
  'turn.resource.confirm-web-write': { authorityClass: 'resource', riskClass: 'control', confirmation: 'self' },
  'turn.resource.request-web-text': { authorityClass: 'resource', riskClass: 'resource', confirmation: 'never' },
  'turn.resource.extract-markdown': { authorityClass: 'resource', riskClass: 'read' },
  'turn.resource.extract-document': { authorityClass: 'resource', riskClass: 'read' },
  'turn.resource.spill-result': { authorityClass: 'resource', riskClass: 'control', confirmation: 'never' },
  'turn.resource.read-result': { authorityClass: 'resource', riskClass: 'read' },
  'turn.site-client.read': { authorityClass: 'siteclient', riskClass: 'read' },
  'turn.site-client.run': { authorityClass: 'siteclient', riskClass: 'resource', confirmation: 'never' },
  'turn.site-client.commit': { authorityClass: 'siteclient', riskClass: 'commit', confirmation: 'self', retryClass: 'E' },
  'turn.site-client.capture-start': { authorityClass: 'siteclient', riskClass: 'resource', confirmation: 'never' },
  'turn.site-client.capture-stop': { authorityClass: 'siteclient', riskClass: 'resource', confirmation: 'never' },
  'turn.execution.create-webvm': { authorityClass: 'execution', riskClass: 'commit' },
  'turn.execution.create-notebook': { authorityClass: 'execution', riskClass: 'commit' },
  'turn.execution.create-pod': { authorityClass: 'execution', riskClass: 'commit' },
  'turn.execution.create-app': { authorityClass: 'execution', riskClass: 'commit' },
  'turn.execution.run-script': { authorityClass: 'execution', riskClass: 'resource', confirmation: 'never' },
  'turn.execution.spill-script': { authorityClass: 'execution', riskClass: 'control', confirmation: 'never' },
  'turn.editing.read-target': { authorityClass: 'editing', riskClass: 'read' },
  'turn.editing.write-target': { authorityClass: 'editing', riskClass: 'commit' },
  'turn.introspection.actor-roster': { authorityClass: 'introspection', riskClass: 'read' },
  'turn.introspection.provider-posture': { authorityClass: 'introspection', riskClass: 'read' },
  'turn.introspection.storage-snapshot': { authorityClass: 'introspection', riskClass: 'read' },
  'turn.introspection.automatable-tabs': { authorityClass: 'introspection', riskClass: 'read' },
  'turn.introspection.denylist-patterns': { authorityClass: 'introspection', riskClass: 'read' },
  'turn.introspection.audit-entries': { authorityClass: 'introspection', riskClass: 'read' },
  'turn.introspection.installed-skill': { authorityClass: 'introspection', riskClass: 'read' },
  'turn.schedule.read-routines': { authorityClass: 'schedule', riskClass: 'read' },
  'turn.schedule.arm-confirmed-routine': { authorityClass: 'schedule', riskClass: 'commit', confirmation: 'self', retryClass: 'E' },
  'turn.schedule.cancel-routine': { authorityClass: 'schedule', riskClass: 'commit', confirmation: 'permission', retryClass: 'E' },
  'turn.dweb.discover-apps': { authorityClass: 'dweb', riskClass: 'read' },
  'turn.dweb.publish-confirmed-app': { authorityClass: 'dweb', riskClass: 'commit', confirmation: 'self', retryClass: 'E' },
  'turn.dweb.install-confirmed-app': { authorityClass: 'dweb', riskClass: 'commit', confirmation: 'self', retryClass: 'E' },
  'turn.dweb.read-peers': { authorityClass: 'dweb', riskClass: 'read' },
  'turn.dweb.set-peer-blocked': { authorityClass: 'dweb', riskClass: 'commit' },
  'turn.dweb.set-discovery-enabled': { authorityClass: 'dweb', riskClass: 'commit' },
  'turn.dweb.run-mesh-program': { authorityClass: 'dweb', riskClass: 'resource' },
});

/** @param {string} operation */
/**
 * @param {unknown} operation
 * @returns {{authorityClass:string,riskClass:string,confirmation?:string,retryClass?:string}|null}
 */
export const controllerDomainOperationPolicy = (operation) =>
  CONTROLLER_DOMAIN_OPERATIONS[/** @type {keyof typeof CONTROLLER_DOMAIN_OPERATIONS} */ (operation)]
  ?? null;

const PLAN_OPERATION_CARVE_OUTS = Object.freeze(new Set([
  // Pure URL loads and delegation are the operation-level equivalents of the
  // public Plan-mode carve-outs. The child receives the same live permission.
  'turn.page.open-tab', 'turn.page.navigate', 'turn.actor.message',
  // Goal progress is session-local bookkeeping, not a world mutation. Plan
  // must be able to maintain its checklist and terminate the bounded run.
  'turn.goal.complete', 'turn.todo.replace',
  // These are support effects of model-visible read tools. They do not grant a
  // browser mutation, filesystem write, or external credential by themselves.
  'turn.resource.spill-result', 'turn.site-client.run',
  'turn.site-client.capture-start', 'turn.site-client.capture-stop',
]));

/** @param {string} operation @param {unknown} mode */
export const controllerOperationSkipsConfirmationInPermissionMode = (operation, mode) =>
  mode === 'plan' && PLAN_OPERATION_CARVE_OUTS.has(operation);

export const controllerOperationRequiresConfirmation = (
  /** @type {string} */ operation,
  /** @type {{mode?:unknown,confirmActions?:unknown}|null|undefined} */ permission,
  /** @type {any} */ args = {},
  /** @type {boolean} */ confirmedIntentRequired = false,
) => {
  if (controllerOperationSkipsConfirmationInPermissionMode(operation, permission?.mode)) {
    return false;
  }
  const policy = controllerDomainOperationPolicy(operation);
  // A headless script is ordinarily ephemeral compute. workspace:true mounts
  // durable per-session OPFS, so the exact host—not the semantic tool name—
  // upgrades only that final argument shape to the permission confirmation.
  const confirmation = operation === 'turn.execution.run-script' && args?.workspace === true
    ? 'permission' : policy?.confirmation ?? 'permission';
  return confirmation === 'always'
    || confirmation === 'permission' && permission?.confirmActions !== false
    || confirmedIntentRequired;
};

// why: the semantic heap is not the Plan/Act boundary. A compromised Worker
// can skip its dispatcher, so the SW independently applies the permission mode
// to exact operations. No semantic tool name participates in this decision.
export const controllerOperationAllowedInPermissionMode = (
  /** @type {string} */ operation,
  /** @type {unknown} */ mode,
  /** @type {any} */ args = {},
) => {
  const policy = controllerDomainOperationPolicy(operation);
  if (!policy) return false;
  if (mode === 'act' || policy.riskClass === 'read'
      || PLAN_OPERATION_CARVE_OUTS.has(operation)) return true;
  if (operation === 'turn.resource.request-web-text') {
    const method = typeof args?.method === 'string' ? args.method.toUpperCase() : 'GET';
    return method === 'GET' || method === 'HEAD';
  }
  return false;
};

/** @param {string} operation */
export const controllerDomainOperationPayloadCap = (operation) => {
  const policy = controllerDomainOperationPolicy(operation);
  if (policy?.authorityClass === 'resource') return 20 * MIB;
  if (typeof policy?.authorityClass === 'string'
      && ['app', 'execution', 'editing', 'siteclient'].includes(policy.authorityClass)) {
    return 8 * MIB;
  }
  return MIB;
};

// why: model-facing tool growth reuses these fixed authority capabilities.
// Adding a semantic tool cannot widen the orchestrator; only adding a reviewed
// host operation changes this list or the native service-worker graph.
export const ORCHESTRATOR_OPERATION_GRANT = Object.freeze([
  'turn.goal.complete',
  'turn.actor.spawn-sync', 'turn.actor.spawn-async', 'turn.actor.tasks',
  'turn.actor.cancel', 'turn.actor.message',
  'turn.app.open', 'turn.app.search',
  'turn.memory.read-scope', 'turn.memory.read-subtree', 'turn.memory.write',
  'turn.todo.read', 'turn.todo.replace',
  'turn.page.open-tab', 'turn.page.capture-foreground',
  'turn.resource.read-result',
  'turn.execution.create-webvm', 'turn.execution.create-notebook',
  'turn.execution.create-pod', 'turn.execution.create-app',
  'turn.execution.run-script', 'turn.execution.spill-script',
  'turn.introspection.actor-roster', 'turn.introspection.provider-posture',
  'turn.introspection.storage-snapshot', 'turn.introspection.automatable-tabs',
  'turn.introspection.denylist-patterns', 'turn.introspection.audit-entries',
  'turn.introspection.installed-skill',
  'turn.schedule.read-routines', 'turn.schedule.arm-confirmed-routine',
  'turn.schedule.cancel-routine',
]);
const ORCHESTRATOR_OPERATION_SET = new Set(ORCHESTRATOR_OPERATION_GRANT);
const REPLAYABLE_CONTROL_OPERATIONS = new Set([
  'turn.pod.confirm-git', 'turn.repository.confirm-restore',
  'turn.repository.confirm-remote', 'turn.resource.confirm-web-write',
]);

// why: `control` is a scheduling class, not a factual effect verdict. Default
// selection, cancellation, goal completion, and spills mutate durable/live
// state and make a later whole-turn retry unsafe. Only these exact confirmation
// observations are intrinsically replayable after settlement.
export const controllerOperationReplayableAfterSettlement = (/** @type {string} */ operation) => {
  const policy = controllerDomainOperationPolicy(operation);
  return policy?.riskClass === 'read' || REPLAYABLE_CONTROL_OPERATIONS.has(operation);
};

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
      : capability === 'turn.tools.project' ? TOOL_PROJECTION_OUTER_BYTES
        : turnPhaseOuterPayloadCap(capability)
          || kernelFeatureOuterPayloadCap(capability) || GENERIC_OUTER_BYTES;

export const controllerPayloadAllowed = (/** @type {string} */ capability,
  /** @type {unknown} */ payload) => {
  if (capability === KERNEL_FEATURE_DISPATCH_CAPABILITY) {
    return kernelFeaturePayloadAllowed(capability, payload);
  }
  if (turnPhaseOuterPayloadCap(capability) > 0) {
    return turnPhasePayloadAllowed(capability, payload);
  }
  return true;
};

export const controllerResultAllowed = (/** @type {string} */ capability,
  /** @type {unknown} */ result) => turnPhaseOuterPayloadCap(capability) > 0
  ? turnPhaseResultAllowed(capability, result) : true;

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
  && (operation === 'turn.model.cancel-inference' || operation === 'turn.model.cancel-local'
    || operation === 'turn.abort.finalize' || operation === 'turn.finalize');

/**
 * @param {string} capability
 * @param {unknown} outerPayload
 */
export const createControllerKernelQuota = (
  capability, outerPayload,
) => {
  if (capability === KERNEL_FEATURE_DISPATCH_CAPABILITY) {
    return createKernelFeatureEffectQuota(capability, outerPayload);
  }
  if (turnPhaseOuterPayloadCap(capability) > 0) {
    return createTurnPhaseQuota(capability, outerPayload);
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
  const turnGeneration = Number.isSafeInteger(outer?.turnGeneration)
    ? Number(outer?.turnGeneration) : null;
  const steps = safeSteps(outer?.maxSteps ?? ctx?.maxSteps);
  const toolBudget = 4_096 * steps;
  const streamBudget = MODEL_STREAM_EVENTS * steps;
  /** @type {Map<string, number>} */
  const counts = new Map();
  const custody = makeCustody();
  /** @type {Map<string, number>} */
  const semanticEffectSequences = new Map();
  /** @type {Map<string, { events:number, bytes:number, pending:boolean }>} */
  const models = new Map();

  const limits = Object.freeze({
    'turn.session.get': steps + 4,
    'turn.session.append': 2 * steps + 8,
    'turn.session.update-assistant': steps * MODEL_STREAM_EVENTS + 10 * steps + 8,
    'turn.session.set-trim': steps,
    'turn.prompt.get': steps + 1,
    'turn.tools.refresh': steps,
    'turn.trim.enrich': steps,
    'turn.model.bind': 1,
    'turn.model.open-inference': 32 * steps,
    'turn.model.read-inference': streamBudget,
    'turn.model.cancel-inference': 32 * steps,
    'turn.model.read-inventory': steps,
    'turn.model.read-context': steps,
    'turn.model.open-local': 32 * steps,
    'turn.model.read-local': streamBudget,
    'turn.model.cancel-local': 32 * steps,
    'turn.model.observe-event': streamBudget,
    'turn.model.observe-failover': 8 * steps,
    ...Object.fromEntries(Object.keys(CONTROLLER_DOMAIN_OPERATIONS).map((operation) => [
      operation, toolBudget,
    ])),
    'turn.event': streamBudget + 2 * toolBudget + 8 * steps + 16,
    'turn.abort.finalize': 1,
    'turn.finalize': 1,
  });
  const allowed = new Set(Object.keys(limits));

  const admit = (/** @type {string} */ operation, /** @type {unknown} */ payload) => {
    if (!allowed.has(operation)) return refusal('kernel-operation-denied');
    if (!bounded(payload, operation === 'turn.model.read-inference'
      || operation === 'turn.model.read-local'
      ? MODEL_EVENT_BYTES : TURN_VALUE_BYTES)) {
      return refusal('kernel-operation-payload-too-large');
    }
    const used = counts.get(operation) ?? 0;
    const limit = limits[/** @type {keyof typeof limits} */ (operation)];
    if (used >= limit) return refusal('kernel-operation-budget-exhausted');
    const value = record(record(payload)?.value);
    const domainPolicy = controllerDomainOperationPolicy(operation);
    if (domainPolicy) {
      const effectSequence = Number(value?.effectSequence);
      const directClaim = ORCHESTRATOR_OPERATION_SET.has(operation)
        && typeof value?.callId === 'string'
        && value.callId.length >= 1 && value.callId.length <= 512
        && typeof value?.effectId === 'string'
        && value.effectId === `${value.callId}:${effectSequence}`
        && Number.isSafeInteger(effectSequence)
        && effectSequence >= 1 && effectSequence <= MAX_EFFECTS_PER_MODEL_CALL
        && effectSequence === (semanticEffectSequences.get(value.callId) ?? 0) + 1
        && turnGeneration !== null && value.turnGeneration === turnGeneration;
      if (!directClaim) return refusal('kernel-domain-authority-invalid');
      semanticEffectSequences.set(value.callId, effectSequence);
    }
    if (operation === 'turn.model.read-inference'
        || operation === 'turn.model.cancel-inference'
        || operation === 'turn.model.read-local'
        || operation === 'turn.model.cancel-local') {
      const streamId = value?.streamId;
      const model = typeof streamId === 'string' ? models.get(streamId) : null;
      if (!model) return refusal('kernel-model-channel-invalid');
      if (operation === 'turn.model.read-inference' || operation === 'turn.model.read-local') {
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
      || operation === 'turn.model.read-local'
      ? MODEL_EVENT_BYTES : TURN_VALUE_BYTES)) {
      if (operation.startsWith('turn.model.')) {
        const streamId = value?.streamId ?? replyValue?.streamId;
        if (typeof streamId === 'string') models.delete(streamId);
      }
      return refusal('kernel-operation-result-too-large', false);
    }
    if ((operation === 'turn.model.open-inference' || operation === 'turn.model.open-local')
        && reply?.ok === true) {
      const streamId = replyValue?.streamId;
      if (typeof streamId !== 'string' || streamId.length < 1 || models.has(streamId)) {
        return refusal('kernel-model-channel-invalid', false);
      }
      models.set(streamId, { events: 0, bytes: 0, pending: false });
    }
    if (operation === 'turn.model.read-inference' || operation === 'turn.model.read-local') {
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
    if (operation === 'turn.model.cancel-inference' || operation === 'turn.model.cancel-local') {
      const streamId = value?.streamId;
      if (typeof streamId === 'string') models.delete(streamId);
    }
    const replayable = operation === 'turn.session.get'
      || operation === 'turn.prompt.get' || operation === 'turn.tools.refresh'
      || controllerOperationReplayableAfterSettlement(operation);
    custody.observe(result, replayable);
    return Object.freeze({ ok: true, outcomeKnown: true });
  };

  const pendingLoss = (/** @type {string} */ operation, /** @type {unknown} */ payload) => {
    const domainPolicy = controllerDomainOperationPolicy(operation);
    if (domainPolicy) {
      const effect = record(record(payload)?.value);
      const effectSequence = Number(effect?.effectSequence);
      const directClaim = ORCHESTRATOR_OPERATION_SET.has(operation)
        && typeof effect?.callId === 'string'
        && effect.callId.length >= 1 && effect.callId.length <= 512
        && typeof effect?.effectId === 'string'
        && effect.effectId === `${effect.callId}:${effectSequence}`
        && Number.isSafeInteger(effectSequence)
        && effectSequence >= 1 && effectSequence <= MAX_EFFECTS_PER_MODEL_CALL
        && turnGeneration !== null && effect.turnGeneration === turnGeneration;
      if (!directClaim) return unknownPendingLoss();
      return exactEffectLossSemantics(domainPolicy.riskClass, 'during');
    }
    return unknownPendingLoss();
  };

  return Object.freeze({
    admit, observe, pendingLoss, custody: custody.snapshot,
    pendingCap: MAX_CONCURRENT_KERNEL_CALLS,
  });
};
