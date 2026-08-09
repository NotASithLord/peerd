// @ts-check
// A numeric tab id names a browser location. It does not authorize peerd to
// mint a bound actor for whichever site that location happens to show.

import { classifyOriginSensitivity } from './origin-sensitivity.js';
import { normalizeApiOrigin, siteHandleFor } from './web-actor.js';

export const NUMERIC_TAB_SENSITIVE_CODE = 'actor_sensitive_tab_requires_site';
export const NUMERIC_TAB_POLICY_UNAVAILABLE_CODE = 'actor_tab_sensitivity_unavailable';
export const IDENTITY_PROVIDER_TRANSIT_ONLY_CODE = 'actor_identity_provider_transit_only';

/** @typedef {import('./origin-sensitivity.js').SensitivityReason} SensitivityReason */
/**
 * @typedef {{
 *   allowed: false,
 *   code: string,
 *   retryable: boolean,
 *   origin: string|null,
 *   reason: SensitivityReason|null,
 *   suggestedHandle: string|null,
 *   requiresUserIntent: boolean,
 * }} NumericTabAuthorityRefusalDecision
 */
/** @typedef {{ allowed: true, origin: string } | NumericTabAuthorityRefusalDecision} NumericTabAuthorityDecision */

/**
 * Decide whether a browser-observed URL may become a numeric tab actor's owned
 * origin. Pure so every sensitivity signal and failure direction is testable.
 *
 * why `policyReady` is explicit: an empty cache during service-worker startup
 * is not evidence that an origin is ordinary. Numeric addressing mints
 * authority, so it waits for the durable policy inputs and fails closed when
 * they cannot be established.
 *
 * @param {unknown} liveUrl
 * @param {{ policyReady?: boolean, isKnownIdp?: (origin: string) => boolean, isUgcZone?: (origin: string) => boolean, hasVaultSecret?: (origin: string) => boolean, learned?: ReadonlySet<string>|ReadonlyMap<string, import('./origin-sensitivity.js').SensitivityReason> }} deps
 * @returns {Readonly<NumericTabAuthorityDecision>}
 */
export const decideNumericTabAuthority = (liveUrl, deps = {}) => {
  const origin = normalizeApiOrigin(liveUrl);
  if (!origin || deps.policyReady !== true) {
    return Object.freeze({
      allowed: false,
      code: NUMERIC_TAB_POLICY_UNAVAILABLE_CODE,
      retryable: false,
      origin: null,
      reason: null,
      suggestedHandle: null,
      requiresUserIntent: false,
    });
  }
  const sensitivity = classifyOriginSensitivity(origin, deps);
  if (sensitivity.sensitive) {
    const identityProvider = sensitivity.reason === 'identity-provider';
    return Object.freeze({
      allowed: false,
      code: identityProvider ? IDENTITY_PROVIDER_TRANSIT_ONLY_CODE : NUMERIC_TAB_SENSITIVE_CODE,
      retryable: false,
      origin,
      reason: sensitivity.reason ?? null,
      suggestedHandle: identityProvider ? null : siteHandleFor(origin),
      requiresUserIntent: identityProvider ? false : true,
    });
  }
  return Object.freeze({ allowed: true, origin });
};

/**
 * A bounded model-facing refusal containing no page-authored text or URL path.
 * @param {Readonly<NumericTabAuthorityRefusalDecision>} decision
 */
export const numericTabAuthorityRefusal = (decision) => {
  if (decision?.code === IDENTITY_PROVIDER_TRANSIT_ONLY_CODE) {
    const policy = {
      code: decision.code,
      performed: false,
      outcomeKnown: true,
      retryable: false,
      origin: decision.origin,
      transitOnly: true,
      requiresRelyingSite: true,
    };
    return {
      ok: /** @type {const} */ (false),
      error: decision.code,
      content: 'No actor work was started. This address is a sign-in service, which peerd helpers may visit only while signing in to another site. '
        + "Continue through the relying site already named in the user's request. If none was named, ask which site they want to sign in to. "
        + 'Do not retry this address or create a standalone helper for it.\n'
        + `Policy: ${JSON.stringify(policy)}`,
      structured: policy,
      outcomeKind: /** @type {const} */ ('pre-effect-failure'),
    };
  }
  if (decision?.code === NUMERIC_TAB_SENSITIVE_CODE) {
    const policy = {
      code: decision.code,
      performed: false,
      outcomeKnown: true,
      retryable: false,
      origin: decision.origin,
      suggestedHandle: decision.suggestedHandle,
      requiresUserIntent: true,
    };
    return {
      ok: /** @type {const} */ (false),
      error: decision.code,
      content: 'No actor work was started. This numeric tab points to a site peerd treats as signed in. '
        + `Use ${decision.suggestedHandle} only if the user's request already asks for work on that site. `
        + 'Otherwise stop and explain that numeric tab addressing cannot authorize work on that site. '
        + 'Do not retry the numeric tab id.\n'
        + `Policy: ${JSON.stringify(policy)}`,
      structured: policy,
      outcomeKind: /** @type {const} */ ('pre-effect-failure'),
    };
  }
  const policy = {
    code: NUMERIC_TAB_POLICY_UNAVAILABLE_CODE,
    performed: false,
    outcomeKnown: true,
    retryable: false,
  };
  return {
    ok: /** @type {const} */ (false),
    error: NUMERIC_TAB_POLICY_UNAVAILABLE_CODE,
    content: 'No actor work was started because peerd could not verify the tab authority policy. '
      + 'Do not retry automatically or create a site actor from the current page. '
      + 'Ask the user to reload peerd before another attempt.\n'
      + `Policy: ${JSON.stringify(policy)}`,
    structured: policy,
    outcomeKind: /** @type {const} */ ('pre-effect-failure'),
  };
};
