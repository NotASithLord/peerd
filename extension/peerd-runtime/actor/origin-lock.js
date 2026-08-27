// @ts-check
// peerd-runtime/actor — the origin lock's imperative shell (issue #251).
//
// The POLICY is pure and lives next door (landing-rule.js decides,
// origin-sensitivity.js classifies). This binds it to a live actor: reads the
// actor's mode and owned origin, asks the rule, persists what changed, and
// reports what happened. All IO is injected, so the shell is testable without a
// browser and the SW's wiring stays a few lines.
//
// WHERE IT IS ENFORCED, AND WHERE IT IS NOT. The RULE, stated structurally so it
// survives the code growing: `judgeLanding` is called wherever a tool resolves or
// observes a tab's LIVE url. Today that is three places —
//
//   * `resolveTargetTab` — every DOM tool, on the tab's current URL
//   * `navigate` — again, on the URL it just landed on; the only point in the
//     tree that observes a landing as it is CREATED, which is what catches a 302
//     nobody made a tool call for
//   * `site_capture` — which needs the tabId rather than the Tab and so does not
//     pass through the resolver at all
//
// The list is enumerated because it must be kept in sync, and named as three
// because an earlier version of this header said "two" after the third had
// already been added in the same arc — a map that is wrong is worse than no map,
// since the next reader will trust it about what is unjudged.
//
// That covers the DOM surface. It does NOT cover every way the actor's session
// authority can be spent, and an earlier draft of this header wrongly implied it
// did. The web actor also holds `fetch_url`, `read_result` and the
// `site_client_*` tools, none of which pass through `resolveTargetTab`. Their
// credential scope is `ctx.activeTab.origin`, read live — so a page that
// redirects itself to a credentialed origin moves that scope with no tool call
// to judge, and those tools could spend it before any DOM tool re-entered the
// chokepoint.
//
// `makeCredentialScope` below is the answer to that, and it is a DIFFERENT shape
// on purpose: synchronous, so it can sit inside the credential-scope getter the
// egress wrapper already reads live on every request. It withholds the scope
// rather than refusing the call, so it can only ever narrow what the pre-#251
// code handed over. What remains uncovered is a SESSIONLESS cross-origin fetch,
// which is exactly what those tools do today when off-origin — no authority to
// take away.
//
// WHAT THIS DOES NOT DO, and must not silently appear to. On a `handoff` it
// records the successor origin and ends the actor — it does NOT mint the bound
// actor or forward a goal. Routing is the orchestrator's, and the goal text must
// be re-authored there rather than carried over from a possibly-hijacked roaming
// actor. If a future change makes this file forward actor-authored text into a
// handoff, the segmentation becomes decorative and #251's whole point is lost.

import { decideLanding, mayHoldCredentials, EXCURSION_MS, MAX_EXCURSIONS } from './landing-rule.js';
import { classifyOriginSensitivity, sameOrigin } from './origin-sensitivity.js';
import { normalizeApiOrigin } from './web-actor.js';

/**
 * @typedef {object} ActorOriginState
 * @property {'roaming' | 'bound'} mode
 * @property {string | null} [ownedOrigin]
 * @property {boolean} [provisional]  was ownedOrigin ASKED FOR rather than
 *   OBSERVED (a `site:<origin>` handle the orchestrator spelled)? Cleared the
 *   moment a real landing settles it. See decideLanding's provisional branch.
 * @property {import('./landing-rule.js').Excursion | null} [excursion]
 * @property {import('./landing-rule.js').AuthGrant | null} [authGrant]
 * @property {number} [excursionsUsed]
 * @property {boolean} [retired] a stopped roaming actor whose page-influenced
 *   transcript must never receive another turn
 */

/**
 * Build the `judgeLanding` an actor's tool context carries.
 *
 * @param {object} deps
 * @param {() => ActorOriginState | null} deps.getState  the calling actor's origin state,
 *   or null for a context the lock does not apply to (the orchestrator, an API
 *   actor with no tab, an engine kind). Null means "no lock".
 * @param {(patch: Partial<ActorOriginState>) => void | Promise<void>} deps.saveState
 * @param {(event: { action: string, reason: string, from: string | null, to: string, handoffTo?: string }) => void | Promise<void>} deps.onStop
 *   called when the verdict ends the actor — the SW turns this into the
 *   environment_changed report the orchestrator sees.
 * @param {(origin: string) => boolean} [deps.isUgcZone]
 * @param {(origin: string) => boolean} [deps.hasVaultSecret]
 * @param {(origin: string) => boolean} [deps.isKnownIdp]
 * @param {() => ReadonlySet<string> | ReadonlyMap<string, any>} [deps.getLearned]
 * @param {(origin: string) => boolean} [deps.isIdp]
 * @param {() => boolean} [deps.isCurrent]
 * @param {() => number} [deps.now]
 * @returns {(url: string) => Promise<{ action: string, reason: string } | null>}
 */
export const makeJudgeLanding = (deps) => {
  const {
    getState, saveState, onStop,
    isUgcZone, hasVaultSecret, isKnownIdp, getLearned, isIdp,
    isCurrent = () => true, now = Date.now,
  } = deps;

  return async (url) => {
    if (!isCurrent()) return null;
    const state = getState();
    // No state means the lock does not apply here. why not fail closed: this
    // function runs on EVERY DOM tool call including the orchestrator's own
    // and the engine kinds', and refusing those would break the product
    // wholesale. The security decision is which contexts GET a state, made
    // once in the SW, not re-litigated per call.
    if (!state) return null;

    const sensitivity = classifyOriginSensitivity(url, {
      isKnownIdp, isUgcZone, hasVaultSecret, learned: getLearned?.(),
    });

    const verdict = decideLanding({
      mode: state.mode,
      ownedOrigin: state.ownedOrigin ?? null,
      landing: url,
      landingIsSensitive: sensitivity.sensitive,
      landingIsIdp: isIdp?.(url) === true,
      excursion: state.excursion ?? null,
      authGrant: state.authGrant ?? null,
      excursionsUsed: state.excursionsUsed ?? 0,
      provisional: state.provisional === true,
      now: now(),
    });

    if (verdict.action === 'continue' || verdict.action === 'wait') {
      // Persist BOTH excursion transitions and the first-landing adoption.
      //
      // why `excursion` is written unconditionally rather than only when
      // present: absence means "cleared" in the rule's contract (a discharged
      // excursion returns no field), so coalescing it against the stored value
      // would keep a spent corridor alive forever. Always assign.
      /** @type {Partial<ActorOriginState>} */
      const patch = {
        excursion: verdict.excursion ?? null,
        authGrant: verdict.authGrant ?? null,
      };
      // Adopt on a first landing (no owned origin yet) AND on the one other
      // case the rule returns adoptOrigin for: a PROVISIONAL origin settling
      // onto its own www-fold. Guarding on `!state.ownedOrigin` alone silently
      // dropped that second case, which would have left the rule agreeing to
      // continue while the state kept pointing at the origin the site had just
      // redirected away from — the same dead end, one step later.
      if (verdict.adoptOrigin && (!state.ownedOrigin || state.provisional)) {
        patch.ownedOrigin = verdict.adoptOrigin;
      }
      // A NAMED landing settles the question of what this actor owns, so the
      // origin stops being a guess. Cleared on any continue past that point —
      // 'no page loaded' is not a landing and must not consume the allowance.
      if (verdict.action === 'continue'
        && state.provisional && verdict.reason !== 'no page loaded') patch.provisional = false;
      // Count an excursion when one OPENS — the lifetime cap is what stops the
      // corridor being refreshed by bouncing home, so it must not be reset by
      // the same discharge that clears the corridor.
      if (verdict.action === 'wait' && verdict.excursion && !state.excursion) {
        patch.excursionsUsed = (state.excursionsUsed ?? 0) + 1;
      }
      if (!isCurrent()) return null;
      await saveState(patch);
      if (!isCurrent()) return null;
      return verdict;
    }

    // A terminal landing consumes any pending or active corridor state. Without
    // this, recovering the actor after a wrong IdP or third-origin stop could
    // replay the same durable grant.
    if (state.authGrant != null || state.excursion != null) {
      if (!isCurrent()) return null;
      await saveState({ authGrant: null, excursion: null });
    }

    if (!isCurrent()) return null;

    // end | handoff — both stop this actor. The distinction rides in the event
    // so the orchestrator knows whether a successor is implied.
    await onStop({
      action: verdict.action,
      reason: verdict.reason,
      from: state.ownedOrigin ?? null,
      to: url,
      ...(verdict.handoffTo ? { handoffTo: verdict.handoffTo } : {}),
    });
    return verdict;
  };
};

/**
 * Build the SYNCHRONOUS credential-scope getter the web actor's egress wrapper
 * reads on every request.
 *
 * The SW today does `withSessionScopedCredentials(webFetch, () => ctx.activeTab?.origin)`.
 * This wraps that getter: same value when the lock is content for the actor to
 * be spending a session there, `undefined` — meaning sessionless — when it is
 * not. Undefined is already the wrapper's "no session" case, so nothing
 * downstream needs to learn a new shape.
 *
 * WHERE THE BEHAVIOUR ACTUALLY CHANGES, stated because a narrowing fails safe
 * but not visibly, and an earlier draft of this comment claimed more than it
 * should have. A ROAMING actor is unchanged everywhere it was allowed to be,
 * including on hosts `normalizeApiOrigin` cannot canonicalize — an IDN, a
 * single-label intranet name, a trailing-dot FQDN — because refusing those
 * bought nothing and cost the actor a logged-out page with no error to explain
 * it. What a roaming actor loses is its session on a SENSITIVE origin, which is
 * the whole point. A BOUND actor loses it everywhere except the one origin it
 * owns, which is also the whole point.
 *
 * why this cannot reuse `judgeLanding`: that function is async (it persists) and
 * it MUTATES state (it spends excursion budget). A credential-scope getter is
 * called synchronously, possibly several times per request, and must be free of
 * consequences. So the policy is asked in its read-only form (`mayHoldCredentials`)
 * and nothing here writes.
 *
 * @param {object} deps
 * @param {() => ActorOriginState | null} deps.getState
 * @param {() => string | undefined} deps.getOrigin  the live scope, normally `ctx.activeTab?.origin`
 * @param {(origin: string) => boolean} [deps.isUgcZone]
 * @param {(origin: string) => boolean} [deps.hasVaultSecret]
 * @param {(origin: string) => boolean} [deps.isKnownIdp]
 * @param {() => ReadonlySet<string> | ReadonlyMap<string, any>} [deps.getLearned]
 * @returns {() => string | undefined}
 */
export const makeCredentialScope = (deps) => {
  const { getState, getOrigin, isKnownIdp, isUgcZone, hasVaultSecret, getLearned } = deps;
  return () => {
    const origin = getOrigin();
    if (!origin) return undefined;
    const state = getState();
    // No state means the lock does not apply to this context — the same
    // "decided once in the SW" rule as judgeLanding. Hand back the unmodified
    // scope so a non-locked actor behaves exactly as it did before #251.
    if (!state) return origin;
    if (state.retired === true) return undefined;
    const sensitivity = classifyOriginSensitivity(origin, {
      isKnownIdp, isUgcZone, hasVaultSecret, learned: getLearned?.(),
    });
    return mayHoldCredentials({
      mode: state.mode,
      ownedOrigin: state.ownedOrigin ?? null,
      excursion: state.excursion ?? null,
      origin,
      originIsSensitive: sensitivity.sensitive,
    })
      ? origin
      : undefined;
  };
};

/**
 * Turn a user-confirmed sign-in on a relying site into a bound actor.
 *
 * The login tool supplies the origin it read before consent. This authorizer
 * independently reads the actor's owned tab after consent, so neither model
 * bytes nor a stale tool-context snapshot can choose the boundary. Dedicated
 * identity-provider hosts are transit only and can never become the owner.
 *
 * @param {object} deps
 * @param {() => ActorOriginState | null} deps.getState
 * @param {() => Promise<{ status: 'none' | 'unreadable' } | { status: 'live', url: string }>} deps.getLiveLanding
 * @param {(patch: Partial<ActorOriginState>) => void | Promise<void>} deps.saveState
 * @param {(origin: string) => boolean} [deps.isKnownIdp]
 * @param {() => boolean} [deps.isCurrent]
 * @param {(origin: string) => void | Promise<void>} [deps.onBound]
 * @returns {(origin: string, signal?: AbortSignal) => Promise<boolean>}
 */
export const makeSignInOriginAuthorizer = ({
  getState, getLiveLanding, saveState, isKnownIdp, isCurrent = () => true, onBound,
}) =>
  async (origin, signal) => {
    if (signal?.aborted) return false;
    const requested = normalizeApiOrigin(origin);
    if (!requested || !requested.startsWith('https://') || isKnownIdp?.(requested) === true) return false;

    const landing = await getLiveLanding()
      .catch(() => ({ status: /** @type {'unreadable'} */ ('unreadable') }));
    if (signal?.aborted) return false;
    if (landing.status !== 'live' || !sameOrigin(landing.url, requested)) return false;

    if (signal?.aborted || !isCurrent()) return false;
    const state = getState();
    if (!state) return false;
    if (state.mode === 'bound') return sameOrigin(state.ownedOrigin, requested);
    if (state.mode !== 'roaming') return false;

    const durableWrite = saveState({
      mode: 'bound',
      ownedOrigin: requested,
      provisional: false,
      excursion: null,
    });
    await durableWrite;
    try { await onBound?.(requested); } catch { /* audit is best-effort */ }
    return true;
  };

/**
 * Stamp the one-shot grant that lets a confirmed relying-site login enter one
 * exact identity provider. Both origins are independently checked against live
 * host state. The caller cannot grant from a stale tab or stale turn.
 *
 * @param {object} deps
 * @param {() => ActorOriginState | null} deps.getState
 * @param {() => Promise<{ status: 'none' | 'unreadable' } | { status: 'live', url: string }>} deps.getLiveLanding
 * @param {(patch: Partial<ActorOriginState>) => void | Promise<void>} deps.saveState
 * @param {(origin: string) => boolean} deps.isKnownIdp
 * @param {() => boolean} [deps.isCurrent]
 * @param {() => number} [deps.now]
 * @returns {(idpOrigin: string, signal?: AbortSignal) => Promise<boolean>}
 */
export const makeSignInExcursionAuthorizer = ({
  getState, getLiveLanding, saveState, isKnownIdp, isCurrent = () => true, now = Date.now,
}) => async (idpOrigin, signal) => {
  if (signal?.aborted || !isCurrent()) return false;
  const idp = normalizeApiOrigin(idpOrigin);
  if (!idp || !idp.startsWith('https://')) return false;
  try { if (isKnownIdp(idp) !== true) return false; } catch { return false; }

  const landing = await getLiveLanding()
    .catch(() => ({ status: /** @type {'unreadable'} */ ('unreadable') }));
  if (signal?.aborted || !isCurrent() || landing.status !== 'live') return false;

  const state = getState();
  if (state?.mode !== 'bound' || !state.ownedOrigin) return false;
  const owned = normalizeApiOrigin(state.ownedOrigin);
  if (!owned || !sameOrigin(landing.url, owned)) return false;
  if (state.excursion != null || (state.excursionsUsed ?? 0) >= MAX_EXCURSIONS) return false;

  const grant = { returnTo: owned, idpOrigin: idp, deadline: now() + EXCURSION_MS };
  if (!Number.isFinite(grant.deadline) || signal?.aborted || !isCurrent()) return false;
  await saveState({ authGrant: grant });
  // A turn can become stale while the durable write is settling. Remove the
  // grant before reporting failure so a later turn cannot inherit it.
  if (signal?.aborted || !isCurrent()) {
    await saveState({ authGrant: null });
    return false;
  }
  return true;
};

/**
 * Revoke only the still-pending grant for one exact provider. This is used when
 * the verified login action fails after arming. It cannot clear an active
 * excursion or another provider's grant.
 *
 * @param {object} deps
 * @param {() => ActorOriginState | null} deps.getState
 * @param {() => Promise<{ status: 'none' | 'unreadable' } | { status: 'live', url: string }>} deps.getLiveLanding
 * @param {(patch: Partial<ActorOriginState>) => void | Promise<void>} deps.saveState
 * @param {(origin: string) => boolean} deps.isKnownIdp
 * @param {() => boolean} [deps.isCurrent]
 * @returns {(idpOrigin: string, signal?: AbortSignal) => Promise<boolean>}
 */
export const makeSignInExcursionRevoker = ({
  getState, getLiveLanding, saveState, isKnownIdp, isCurrent = () => true,
}) => async (idpOrigin, signal) => {
  if (signal?.aborted || !isCurrent()) return false;
  const idp = normalizeApiOrigin(idpOrigin);
  if (!idp || !idp.startsWith('https://')) return false;
  try { if (isKnownIdp(idp) !== true) return false; } catch { return false; }

  const landing = await getLiveLanding()
    .catch(() => ({ status: /** @type {'unreadable'} */ ('unreadable') }));
  if (signal?.aborted || !isCurrent() || landing.status !== 'live') return false;

  const state = getState();
  const grant = state?.authGrant;
  if (state?.mode !== 'bound' || !state.ownedOrigin || !grant || state.excursion != null) return false;
  if (!sameOrigin(landing.url, state.ownedOrigin)
    || !sameOrigin(grant.returnTo, state.ownedOrigin)
    || !sameOrigin(grant.idpOrigin, idp)) return false;

  if (signal?.aborted || !isCurrent()) return false;
  await saveState({ authGrant: null });
  return true;
};

/**
 * May this web actor touch the durable SITE CLIENT keyed by `targetOrigin`?
 *
 * This is intentionally NOT `judgeLanding(targetOrigin)`: a stored-client key
 * is not a tab landing, and pretending it is would mutate excursion state and
 * could stop/release the actor's real tab. Durable client custody is a
 * side-effect-free question:
 *
 *   - a bound actor owns exactly its canonical origin;
 *   - a roaming actor may preliminarily address ordinary public clients, but
 *     final authorization also requires that exact live tab origin;
 *   - missing/corrupt state fails closed.
 *
 * @param {object} input
 * @param {ActorOriginState | null | undefined} input.state
 * @param {string} input.targetOrigin
 * @param {boolean} [input.targetIsSensitive]
 * @returns {boolean}
 */
export const mayAddressSiteClientOrigin = ({ state, targetOrigin, targetIsSensitive = false }) => {
  if (!state) return false;
  // The same canonicalizer the store uses must be able to name the target; a
  // roaming default may not turn malformed/private/single-label input into an
  // accidental allow before the tool's own bad_origin response.
  if (!sameOrigin(targetOrigin, targetOrigin)) return false;
  if (state.mode === 'roaming') return targetIsSensitive !== true;
  if (state.mode !== 'bound' || !state.ownedOrigin) return false;
  return sameOrigin(targetOrigin, state.ownedOrigin);
};

/**
 * Does a durable session record carry an explicit client-custody state? The
 * origin-state store seeds legacy absence as roaming for navigation
 * compatibility; durable clients must keep that absence distinguishable so it
 * cannot silently become arbitrary-origin artifact access.
 * @param {unknown} state
 * @returns {boolean}
 */
export const hasDurableSiteClientState = (state) => {
  if (!state || typeof state !== 'object') return false;
  const value = /** @type {Partial<ActorOriginState>} */ (state);
  if (value.mode === 'roaming') return true;
  return value.mode === 'bound'
    && typeof value.ownedOrigin === 'string'
    && sameOrigin(value.ownedOrigin, value.ownedOrigin);
};

/**
 * Final tab-backed custody decision after the actor's ACTUAL live landing has
 * been read and judged. A bound actor may use its owned client before it opens a
 * tab; once a tab exists it must still be home. A roaming actor owns no durable
 * origin, so it must have a tab and may use only that exact ordinary origin.
 *
 * @param {object} input
 * @param {ActorOriginState | null | undefined} input.state
 * @param {string} input.targetOrigin
 * @param {boolean} [input.targetIsSensitive]
 * @param {'none' | 'live' | 'unreadable'} input.tabStatus
 * @param {string} [input.liveOrigin]
 * @returns {boolean}
 */
export const mayUseSiteClientOrigin = ({
  state, targetOrigin, targetIsSensitive = false, tabStatus, liveOrigin,
}) => {
  if (!mayAddressSiteClientOrigin({ state, targetOrigin, targetIsSensitive })) return false;
  if (state?.mode === 'bound') {
    if (tabStatus === 'none') return true;
    return tabStatus === 'live' && sameOrigin(liveOrigin, state.ownedOrigin);
  }
  return state?.mode === 'roaming'
    && tabStatus === 'live'
    && sameOrigin(liveOrigin, targetOrigin);
};

/**
 * Build the complete custody predicate for a tab-free API actor. Its instance
 * id is the origin it owns, so there is no mutable tab landing to consult.
 * Keeping this next to the tab policy gives the context builder and worker
 * relay one canonical comparison instead of two open-coded approximations.
 *
 * @param {string | null | undefined} ownedOrigin
 * @param {object} [deps]
 * @param {(origin: string) => boolean} [deps.isKnownIdp]
 * @returns {(targetOrigin: string) => boolean}
 */
export const makeFixedSiteClientOriginGuard = (ownedOrigin, { isKnownIdp } = {}) =>
  (targetOrigin) => {
    try {
      if (isKnownIdp?.(ownedOrigin ?? '') === true || isKnownIdp?.(targetOrigin) === true) return false;
    } catch { return false; }
    return mayUseSiteClientOrigin({
      state: { mode: 'bound', ownedOrigin: ownedOrigin ?? null },
      targetOrigin,
      tabStatus: 'none',
    });
  };

/**
 * Build the synchronous state-only preliminary predicate carried by a
 * tab-backed actor's tool context. The async authorizer below reads the tab.
 *
 * @param {object} deps
 * @param {() => ActorOriginState | null} deps.getState
 * @param {(origin: string) => boolean} [deps.isUgcZone]
 * @param {(origin: string) => boolean} [deps.hasVaultSecret]
 * @param {(origin: string) => boolean} [deps.isKnownIdp]
 * @param {() => ReadonlySet<string> | ReadonlyMap<string, any>} [deps.getLearned]
 * @returns {(origin: string) => boolean}
 */
export const makeSiteClientOriginGuard = ({ getState, isKnownIdp, isUgcZone, hasVaultSecret, getLearned }) =>
  (origin) => mayAddressSiteClientOrigin({
    state: getState(),
    targetOrigin: origin,
    targetIsSensitive: classifyOriginSensitivity(origin, {
      isKnownIdp, isUgcZone, hasVaultSecret, learned: getLearned?.(),
    }).sensitive,
  });

/**
 * Build the final async site-client authorizer. The caller injects the owned
 * tab lookup so this core stays browser-free and testable. `judgeLanding` is
 * given ONLY the actual live URL, never the model-supplied client key.
 *
 * @param {object} deps
 * @param {() => ActorOriginState | null} deps.getState
 * @param {() => Promise<{ status: 'none' | 'unreadable' } | { status: 'live', url: string }>} deps.getLiveLanding
 * @param {(url: string) => Promise<{ action: string } | null>} deps.judgeLanding
 * @param {(origin: string) => boolean} [deps.isUgcZone]
 * @param {(origin: string) => boolean} [deps.hasVaultSecret]
 * @param {(origin: string) => boolean} [deps.isKnownIdp]
 * @param {() => ReadonlySet<string> | ReadonlyMap<string, any>} [deps.getLearned]
 * @returns {(origin: string) => Promise<boolean>}
 */
export const makeSiteClientOriginAuthorizer = ({
  getState, getLiveLanding, judgeLanding, isKnownIdp, isUgcZone, hasVaultSecret, getLearned,
}) => async (origin) => {
  const targetIsSensitive = () => classifyOriginSensitivity(origin, {
    isKnownIdp, isUgcZone, hasVaultSecret, learned: getLearned?.(),
  }).sensitive;
  if (!mayAddressSiteClientOrigin({
    state: getState(), targetOrigin: origin, targetIsSensitive: targetIsSensitive(),
  })) return false;

  const landing = await getLiveLanding().catch(() => ({ status: /** @type {'unreadable'} */ ('unreadable') }));
  if (landing.status === 'live') {
    const verdict = await judgeLanding(landing.url).catch(() => null);
    if (verdict?.action !== 'continue') return false;
    // judgeLanding may persist state or emit a stop, so the tab can move while
    // it awaits. Never authorize from the pre-await snapshot. A same-origin
    // path hop is fine (custody is origin-scoped); any origin/status change
    // refuses this operation and the next browser chokepoint will judge it.
    const verified = await getLiveLanding()
      .catch(() => ({ status: /** @type {'unreadable'} */ ('unreadable') }));
    if (verified.status !== 'live' || !sameOrigin(verified.url, landing.url)) return false;
    return mayUseSiteClientOrigin({
      state: getState(),
      targetOrigin: origin,
      targetIsSensitive: targetIsSensitive(),
      tabStatus: 'live',
      liveOrigin: verified.url,
    });
  }
  return mayUseSiteClientOrigin({
    state: getState(),
    targetOrigin: origin,
    targetIsSensitive: targetIsSensitive(),
    tabStatus: landing.status,
  });
};

/**
 * Recheck custody at the sealed-worker relay. This helper deliberately accepts
 * only the minimum trusted owner facts; the route supplies those from the
 * persisted actor session, never from worker bytes.
 *
 * @param {object} input
 * @param {unknown} input.backing
 * @param {string | null | undefined} [input.instanceOrigin]
 * @param {ActorOriginState | null | undefined} [input.durableState]
 * @param {string} input.targetOrigin
 * @param {(origin: string) => Promise<boolean>} [input.authorizeTabOrigin]
 * @param {(origin: string) => boolean} [input.isKnownIdp]
 * @returns {Promise<boolean>}
 */
export const authorizeSiteClientRelayOrigin = async ({
  backing, instanceOrigin, durableState, targetOrigin, authorizeTabOrigin, isKnownIdp,
}) => {
  if (backing === 'api') return makeFixedSiteClientOriginGuard(instanceOrigin, { isKnownIdp })(targetOrigin);
  // Tab backing is historically represented by an absent field; only API
  // actors persist a backing value. Preserve that exact trusted record shape,
  // while refusing any unknown future spelling until it earns policy here.
  if ((backing !== undefined && backing !== 'tab')
    || !hasDurableSiteClientState(durableState)
    || !authorizeTabOrigin) return false;
  try { return await authorizeTabOrigin(targetOrigin) === true; }
  catch { return false; }
};
