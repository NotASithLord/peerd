// @ts-check
// User-visible recovery semantics (contract §14).
//
// The UI and the agent must receive the SAME semantic distinction, not a
// generic tool-error string. This module maps a recovery verdict to one of
// the six documented categories, with the user-facing sentence and the
// agent-facing structured record built from one source so they can never
// disagree.
//
// Pure shaping; no IO.

import { OPERATION_STATES } from './operation-state.js';
import { RETRY_CLASSES, normalizeRetryClass } from './retry-class.js';

export const RECOVERY_CATEGORIES = Object.freeze({
  SAFE_TO_RETRY: /** @type {const} */ ('safe_to_retry'),
  RETRY_REQUIRES_BUDGET: /** @type {const} */ ('retry_requires_budget'),
  VERIFY_BEFORE_RETRY: /** @type {const} */ ('verify_before_retry'),
  RESOURCE_LOST: /** @type {const} */ ('resource_lost'),
  SECURITY_DEGRADATION: /** @type {const} */ ('security_degradation'),
  MIGRATION_BLOCKED: /** @type {const} */ ('migration_blocked'),
});

const USER_TEXT = Object.freeze({
  [RECOVERY_CATEGORIES.SAFE_TO_RETRY]:
    'The operation was interrupted before making an external change. It is safe to retry.',
  [RECOVERY_CATEGORIES.RETRY_REQUIRES_BUDGET]:
    'The read or model call was interrupted. Retrying may incur additional network or model cost.',
  [RECOVERY_CATEGORIES.VERIFY_BEFORE_RETRY]:
    'This action may have completed, but peerd did not receive confirmation. '
    + 'Check the target before repeating it.',
  [RECOVERY_CATEGORIES.RESOURCE_LOST]:
    'The execution environment stopped. Your saved files remain, but live process state was lost.',
  [RECOVERY_CATEGORIES.SECURITY_DEGRADATION]:
    'A secure isolated execution host could not be created. This operation was not run.',
  [RECOVERY_CATEGORIES.MIGRATION_BLOCKED]:
    'This profile requires a newer or supported peerd version. No data was changed.',
});

/**
 * Map a recovery verdict (retry-class.js) to its §14 category.
 *
 * @param {import('./retry-class.js').RecoveryVerdict} recoveryVerdict
 * @param {{ retryClass?: unknown }} [context]
 * @returns {typeof RECOVERY_CATEGORIES[keyof typeof RECOVERY_CATEGORIES]}
 */
export const categorizeRecovery = (recoveryVerdict, context = {}) => {
  if (recoveryVerdict.state === OPERATION_STATES.OUTCOME_UNKNOWN
      || recoveryVerdict.verificationRequired) {
    return RECOVERY_CATEGORIES.VERIFY_BEFORE_RETRY;
  }
  if (recoveryVerdict.recreateResource) return RECOVERY_CATEGORIES.RESOURCE_LOST;
  if (normalizeRetryClass(context.retryClass) === RETRY_CLASSES.COSTED_READ) {
    return RECOVERY_CATEGORIES.RETRY_REQUIRES_BUDGET;
  }
  return RECOVERY_CATEGORIES.SAFE_TO_RETRY;
};

/**
 * Build the paired user/agent report for a settled operation. One source,
 * two renderings — the agent gets structure (state, category, what a retry
 * requires), the user gets the documented sentence.
 *
 * @param {import('./retry-class.js').RecoveryVerdict} recoveryVerdict
 * @param {{ retryClass?: unknown, operationId?: string, toolName?: string }} [context]
 */
export const describeRecovery = (recoveryVerdict, context = {}) => {
  const category = categorizeRecovery(recoveryVerdict, context);
  return {
    category,
    user: USER_TEXT[category],
    agent: {
      category,
      state: recoveryVerdict.state,
      autoRetry: recoveryVerdict.autoRetry,
      retryRequires: recoveryVerdict.retryRequires,
      verificationRequired: recoveryVerdict.verificationRequired,
      keepIdempotencyKey: recoveryVerdict.keepIdempotencyKey,
      ...(context.operationId ? { operationId: context.operationId } : {}),
      ...(context.toolName ? { toolName: context.toolName } : {}),
      reason: recoveryVerdict.reason,
    },
  };
};

/**
 * The two categories that don't arise from a retry-class verdict — a
 * refused isolation host and a blocked migration — get explicit builders
 * so their callers share the same report shape.
 * @param {{ detail?: string }} [input]
 */
export const securityDegradationReport = ({ detail } = {}) => ({
  category: RECOVERY_CATEGORIES.SECURITY_DEGRADATION,
  user: USER_TEXT[RECOVERY_CATEGORIES.SECURITY_DEGRADATION],
  agent: {
    category: RECOVERY_CATEGORIES.SECURITY_DEGRADATION,
    state: OPERATION_STATES.FAILED,
    autoRetry: false,
    retryRequires: ['isolation-host'],
    verificationRequired: false,
    keepIdempotencyKey: false,
    reason: detail ?? 'isolated execution host could not be created; operation not run',
  },
});

/** @param {{ diagnosticId?: string, reason?: string }} [input] */
export const migrationBlockedReport = ({ diagnosticId, reason } = {}) => ({
  category: RECOVERY_CATEGORIES.MIGRATION_BLOCKED,
  user: USER_TEXT[RECOVERY_CATEGORIES.MIGRATION_BLOCKED],
  agent: {
    category: RECOVERY_CATEGORIES.MIGRATION_BLOCKED,
    state: OPERATION_STATES.FAILED,
    autoRetry: false,
    retryRequires: ['compatible-peerd-version'],
    verificationRequired: false,
    keepIdempotencyKey: false,
    ...(diagnosticId ? { diagnosticId } : {}),
    reason: reason ?? 'store schema unsupported; no data was changed',
  },
});
