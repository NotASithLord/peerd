// @ts-check
// peerd-runtime/actor — is this origin one where the user has an IDENTITY?
// (issue #251, the classifier half.)
//
// PURE (values in -> verdict out), so the policy is testable without a browser,
// a vault, or a storage layer. Every input is passed in; nothing is imported
// that reaches IO.
//
// WHAT THIS DECIDES. A web actor is either ROAMING (browses freely, holds no
// authority) or BOUND (owns exactly one credentialed origin, like an API
// actor). This function is what sorts origins into those two worlds: a
// sensitive origin is one a roaming actor may NOT enter and a bound actor may
// NOT leave.
//
// why "sensitive" is about IDENTITY, not danger: a hijacked actor loose on the
// open web is a nuisance — everything it can reach it could already reach, and
// everything it read was public. The damage is entirely in the sites where it
// acts AS THE USER. So the line is drawn at "do you have an account here",
// which is also why the signals below are all about accounts and none of them
// are about how sketchy a site looks.
//
// FAIL-OPEN, deliberately, and the consequence is named: an origin we don't
// know about is treated as ordinary, so a roaming actor may enter it. A
// missed classification does NOT open a hole in an existing protection — it
// declines to add one. The learned signals exist to shrink that gap with use
// rather than to make the seed list exhaustive, which it never could be.
//
// WHAT IS NOT HERE. The store (peerd-egress), the observation points that feed
// it (the DOM walk, the confirm path), and the enforcement (gates,
// resolveTargetTab) all live elsewhere. This file only answers the question.

import { normalizeApiOrigin } from './web-actor.js';

/**
 * Why an origin was classified sensitive. Rendered in the handoff notice and
 * the audit trail, so the user can see WHICH signal fired rather than being
 * told a site is special with no account of it.
 * @typedef {'ugc-zone' | 'vault-secret' | 'password-field' | 'confirmed-write'} SensitivityReason
 */

/**
 * @typedef {object} SensitivityVerdict
 * @property {boolean} sensitive
 * @property {SensitivityReason} [reason]   present only when sensitive
 * @property {string} [origin]              the normalized origin that matched
 */

/** why frozen: a verdict is passed around and rendered; nothing downstream should edit it. */
const ORDINARY = Object.freeze({ sensitive: false });

/**
 * The LEARNED signals, in the order they are trusted. Both are byproducts of
 * ordinary use — neither asks the user anything, and neither needs a
 * permission we don't already hold.
 *
 * why these two and not "does it have cookies": we have no `cookies`
 * permission and adding one is a broad ask on a store-reviewed extension (the
 * same reasoning that kept `webNavigation` out — see the SW's tabs.onUpdated
 * comment). These two are observable from data we already collect.
 *
 *   password-field   A password input was seen in the DOM walk on this origin.
 *                    Nothing else on the web means "this site has accounts"
 *                    as reliably, and we already walk the DOM for the snapshot.
 *   confirmed-write  The user approved a web:write on this origin. They
 *                    affirmed acting there under their own name.
 *
 * KNOWN OVER-TRIGGER (jonybur flagged the shape): a newsletter modal with a
 * password field on a marketing page would mark the whole origin. Accepted for
 * now — the failure mode is a site being treated as MORE protected than it
 * needs to be, which costs a handoff, not a breach. If it proves noisy the fix
 * is to require the field to be in a form that also carries an identifier
 * input, not to drop the signal.
 * @type {readonly SensitivityReason[]}
 */
export const LEARNED_REASONS = Object.freeze(['password-field', 'confirmed-write']);

/**
 * Classify an origin.
 *
 * Order is deliberate: the two SEEDS are checked before the learned set,
 * because a seed carries a stronger provenance (a curated registry entry, or a
 * credential the user typed in themselves) and makes for a better explanation
 * in the handoff notice than "we saw a password box once".
 *
 * @param {unknown} input                   a URL or bare host
 * @param {object} deps
 * @param {(origin: string) => boolean} [deps.isUgcZone]  is it in the #242 UGC registry.
 *   INJECTED rather than imported: the registry is a separate concern that
 *   lands on its own schedule (#242 / PR #250), and taking it as a signal keeps
 *   this classifier independently testable and free of a hard dependency on
 *   which registry happens to exist. It is a signal here, not a special case.
 * @param {(origin: string) => boolean} [deps.hasVaultSecret]  is there an `origin:` secret for it
 * @param {ReadonlySet<string> | ReadonlyMap<string, SensitivityReason>} [deps.learned]
 *   the learned set, keyed by normalized origin. A Map carries WHICH signal
 *   fired; a Set is accepted so callers with no provenance still work.
 * @returns {SensitivityVerdict}
 */
export const classifyOriginSensitivity = (input, deps = {}) => {
  const { isUgcZone, hasVaultSecret, learned } = deps;
  const origin = normalizeApiOrigin(input);
  // Not a usable public origin at all (a blank tab, an extension page, an IP,
  // localhost, junk). Nothing to be signed in to.
  if (!origin) return ORDINARY;

  // SEED 1 — a curated UGC zone (#242). These are exactly "you have an identity
  // here AND strangers author the content", the worst combination, and the
  // registry is already reviewed. Classified on the ORIGIN, not the path: the
  // #242 rule is path-scoped because it gates one WRITE, whereas an actor being
  // bound is about the whole site's session.
  if (isUgcZone?.(origin) === true) {
    return { sensitive: true, reason: 'ugc-zone', origin };
  }

  // SEED 2 — the user stored a credential for it. Definitionally credentialed:
  // they authored the fact.
  if (hasVaultSecret?.(origin) === true) {
    return { sensitive: true, reason: 'vault-secret', origin };
  }

  // LEARNED — grown from ordinary use.
  if (learned) {
    if (learned instanceof Map) {
      const reason = learned.get(origin);
      if (reason) return { sensitive: true, reason, origin };
    } else if (learned.has(origin)) {
      // Provenance wasn't retained; report the weaker of the two rather than
      // claiming a signal we can't substantiate.
      return { sensitive: true, reason: 'password-field', origin };
    }
  }

  return ORDINARY;
};

/**
 * Do two URLs sit on the same origin? The comparison the landing rule runs on
 * every tool call, so it is here rather than open-coded at the call sites.
 *
 * why not a string compare of `.origin`: both sides go through
 * normalizeApiOrigin first, so `HTTPS://GitHub.com:443` and `https://github.com`
 * agree, and a non-origin input (blank tab, `about:`, junk) yields null rather
 * than a string that could accidentally equal another null-ish value.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean} false if EITHER side isn't a usable origin — an unknown
 *   location is never "the same as" a known one.
 */
export const sameOrigin = (a, b) => {
  const x = normalizeApiOrigin(a);
  const y = normalizeApiOrigin(b);
  return x !== null && y !== null && x === y;
};
