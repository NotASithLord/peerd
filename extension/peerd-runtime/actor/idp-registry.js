// @ts-check
// peerd-runtime/actor — which origins are dedicated identity providers.
// (issue #251, the narrow exemption's input.)
//
// PURE. A URL in, a boolean out. No IO, no storage, no learning — deliberately
// unlike origin-sensitivity.js, and the difference is the whole point.
//
// WHY THIS LIST IS SHORT AND WHY IT MUST STAY SHORT. Saying "this is an IdP" is
// the ONE way a bound actor is allowed off the origin it owns. Everything the
// excursion rule then bounds — budget, deadline, recorded opener, lifetime cap
// (landing-rule.js) — is bounding a corridor that this file decided to open. So
// every entry here is a small hole, and a generous list is a large one. The
// classifier next door fails OPEN because a miss there declines to add a
// protection; this file fails CLOSED because a false positive here REMOVES one.
//
// THE MEMBERSHIP RULE: an origin qualifies only if signing in is essentially all
// it does. A host like `accounts.google.com` or `login.microsoftonline.com`
// exists to authenticate and nothing else, so a tab sitting there is doing the
// thing we meant to allow. That rule is what excludes the ones people will ask
// about first:
//
//   github.com, gitlab.com, facebook.com — these are full products that ALSO
//   speak OAuth. Admitting them would mean a bound actor sent to "sign in with
//   GitHub" gets a budgeted corridor onto the whole of github.com — issues,
//   pull requests, settings — under the opener exemption, on a site the user is
//   logged into. That is a strictly worse position than the one the excursion
//   exists to avoid.
//
// WHAT THE EXCLUSION COSTS, stated plainly rather than buried: a bound actor
// that hits "sign in with GitHub" ENDS. The user sees a helper that stopped, not
// a helper that quietly did something on GitHub. That is the failure we want if
// we must have one, but it IS a failure, and whether it happens often enough to
// change the design is a question for real use rather than for this comment.
// Widening the list is a one-line change; unwidening it after a hijack is not.

/**
 * Exact origins. Hosts whose entire purpose is authentication.
 * @type {ReadonlySet<string>}
 */
const IDP_ORIGINS = new Set([
  'https://accounts.google.com',
  'https://login.microsoftonline.com',
  'https://login.live.com',
  'https://login.microsoft.com',
  'https://appleid.apple.com',
  'https://signin.aws.amazon.com',
  'https://login.yahoo.com',
  'https://id.atlassian.com',
  'https://auth.atlassian.com',
  'https://accounts.spotify.com',
  'https://identity.linuxfoundation.org',
]);

/**
 * Identity VENDORS — companies whose product is the login box, deployed on a
 * per-customer subdomain (`acme.okta.com`, `login.acme.auth0.com`). Matched by
 * registrable suffix because the customer half is unknowable in advance.
 *
 * why a suffix match is acceptable here and nowhere else in this arc: the whole
 * domain belongs to an authentication product, so there is no non-auth surface
 * underneath it to wander onto. Contrast a suffix rule on a general site, which
 * would hand over everything the company hosts.
 * @type {readonly string[]}
 */
const IDP_SUFFIXES = Object.freeze([
  'okta.com',
  'oktapreview.com',
  'auth0.com',
  'onelogin.com',
  'pingidentity.com',
  'duosecurity.com',
  'cloudflareaccess.com',
  'workos.com',
  'authkit.app',
  'miniorange.com',
  'jumpcloud.com',
]);

/**
 * Is this landing a known identity provider?
 *
 * https ONLY. A sign-in over cleartext is either a downgrade attack or a site
 * whose credentials are already lost; either way it is not something to open a
 * corridor for.
 *
 * @param {unknown} input   a URL (the tab's live location)
 * @returns {boolean}
 */
export const isKnownIdp = (input) => {
  let u;
  try { u = new URL(String(input ?? '')); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  // Compare on the canonical origin, so a default port, uppercase host or
  // trailing dot can't slip past the exact set by spelling.
  const origin = `https://${host}${u.port && u.port !== '443' ? `:${u.port}` : ''}`;
  if (IDP_ORIGINS.has(origin)) return true;
  // A non-default port on a vendor domain is not the vendor's login box.
  if (u.port && u.port !== '443') return false;
  return IDP_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

/** Exported for tests and for the settings surface that will eventually show it. */
export const knownIdpSeeds = () => Object.freeze({
  origins: Object.freeze([...IDP_ORIGINS]),
  suffixes: IDP_SUFFIXES,
});
