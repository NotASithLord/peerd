// @ts-check
// login-affordance — the PURE classifier + the ground-truth page reader for the
// Tier-0 `login` tool.
//
// TWO exports, one boundary:
//
//   classifyLoginAffordance(descriptor, { isKnownIdp })
//     A pure function: a describes-the-element descriptor in, a verdict out. No
//     DOM, no chrome, no IO, no clock, no randomness — so it is Bun-testable and
//     deterministic. It decides, from GROUND TRUTH the tool read off the page,
//     WHETHER the target is a login affordance and, if so, WHICH kind. The tool
//     then names the verdict's method/provider in the confirm — so the model
//     CANNOT spoof the confirm text: what the user sees is derived here from the
//     page, not from a model-supplied argument. (why the classifier exists.)
//
//   loginTargetReader(selector, nth, walkId)
//     The injected page reader (serialized into the page world by
//     chrome.scripting.executeScript, exactly like click.js's clickInjected).
//     It resolves the element the SAME way click.js does — a DOM-walk `walkId`
//     via the isolated world's registry, or a CSS `selector` + `nth` — and reads
//     back a LoginTargetDescriptor. A read needs no trusted input, so scripting
//     is fine on every channel. It reads ATTRIBUTES and structure ONLY — never a
//     field VALUE, and specifically never a password value: it reports only
//     whether the nearest form CONTAINS a password field, not its contents.
//
// why they live together: the reader produces exactly the shape the classifier
// consumes, so keeping them in one module keeps that contract in one place.
//
// TRUST POSTURE: the descriptor's name/autocomplete/href are UNTRUSTED page text.
// The classifier matches on normalized tokens and NEVER evaluates any of it. It
// also treats the extracted `provider` as untrusted (it is echoed into a confirm
// summary), so it is whitespace-collapsed and length-capped here at the source.

/**
 * @typedef {{ tag: string, type?: string, role?: string, name?: string,
 *   autocomplete?: string, href?: string, formAction?: string,
 *   hasPasswordFieldInForm?: boolean }} LoginTargetDescriptor
 */
/**
 * @typedef {{ method: 'passkey'|'sso'|'password'|'unknown', provider?: string, idpOrigin?: string,
 *   supported: boolean, verified: boolean, reason: string }} LoginAffordanceVerdict
 *
 * `verified` — the DESTINATION is proven to be a known IdP (an href/formAction host
 * that passes isKnownIdp), so peerd may AUTO-CLICK it. A recognized provider NAME
 * alone is supported-but-unverified: assisted-manual, never an auto-click. passkey is
 * verified:true (WebAuthn is origin-bound by the browser); password/unknown false.
 */

// SSO providers whose sign-in peerd's origin lock may grant access to: the
// dedicated identity providers and the big consumer IdPs. Mirrors the SPIRIT of
// idp-registry.js: membership means "signing in there is essentially all it does",
// so a bound actor sent through it lands on an auth surface, not a full product.
// The href path defers to isKnownIdp (deps) directly; this NAME set is the fallback
// for a "Sign in with X" affordance that exposes no IdP href to check.
// why every name here maps to a host isKnownIdp accepts (asserted by the registry-
// subset test): a "recognized name" must correspond to a dedicated IdP, so the
// ambiguous consumer names whose "Sign in with X" lands elsewhere are kept out
// ('amazon' → the retail site, not signin.aws.amazon.com; 'ping' → ambiguous). Keep the
// unambiguous forms ('aws', 'pingidentity').
export const SUPPORTED_SSO_PROVIDERS = Object.freeze(new Set([
  'google', 'apple', 'microsoft', 'azure', 'okta', 'auth0', 'onelogin',
  'pingidentity', 'duo', 'workos', 'jumpcloud', 'atlassian',
  'spotify', 'yahoo', 'aws',
]));

// The deliberate EXCLUSIONS — full products that ALSO speak OAuth. idp-registry.js
// keeps these out for a reason (admitting them makes the WHOLE product origin
// eligible for a sign-in grant), and this set makes the
// refusal explicit and defensive: even if one crept into the supported set above,
// it is refused here. why by name: an affordance labelled "Sign in with GitHub"
// gives us a provider word, not a dedicated-IdP origin to check.
const EXCLUDED_SSO_PROVIDERS = Object.freeze(new Set([
  'github', 'gitlab', 'facebook', 'meta', 'discord', 'twitter', 'x',
  'linkedin', 'reddit', 'instagram', 'tiktok',
]));

// Accessible-name signals for a passkey / WebAuthn affordance. why a token/phrase
// match and never eval: the name is untrusted page text.
const PASSKEY_NAME_RE = /passkey|security key|use your (face|fingerprint|device)|sign in with a passkey/;

// "Sign in / continue / log in with <provider>" — the SSO affordance shape. Group 2
// is the provider phrase (untrusted; sanitized before use).
const SSO_NAME_RE = /(?:sign in|log ?in|continue) with (?:an? )?([a-z][\w .-]+)/;

/**
 * Collapse whitespace, strip anything non-printable, trim, cap. Applied to any
 * page-derived string BEFORE it can reach a confirm summary — the provider name
 * is untrusted, so it must not carry newlines/controls into the consent card.
 * Pure.
 * @param {unknown} s
 * @param {number} [cap]
 * @returns {string}
 */
const cleanText = (s, cap = 60) =>
  (typeof s === 'string' ? s : '')
    // Strip C0/C1 controls from untrusted page text before it reaches a confirm card.
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);

/**
 * The lookup KEY for a provider phrase — its first alphabetic token, lowercased.
 * "Google Account" → "google"; "Microsoft 365" → "microsoft". Pure.
 * @param {string} provider
 * @returns {string}
 */
const providerKey = (provider) => {
  const first = provider.toLowerCase().match(/[a-z][a-z0-9]*/);
  return first ? first[0] : '';
};

/**
 * A CANONICAL, title-cased provider LABEL from a lowercase key ('google' → 'Google').
 * why not the raw phrase: SSO_NAME_RE captures up to 40 chars of untrusted page text
 * after "with" ("google to approve the pending transfer"), and the confirm card must
 * show a clean single word, never the greedy phrase. Pure.
 * @param {string} key
 * @returns {string}
 */
const titleCase = (key) => (typeof key === 'string' && key ? key.charAt(0).toUpperCase() + key.slice(1) : '');

/**
 * Best-effort HTTPS destination from an href. Pure; malformed or insecure
 * destinations are not eligible for a sign-in grant.
 * @param {string | undefined} href
 * @returns {{ host: string, origin: string } | null}
 */
const destinationFromHref = (href) => {
  if (typeof href !== 'string' || !href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') return null;
    return { host: url.hostname.toLowerCase(), origin: url.origin };
  } catch { return null; }
};

/**
 * Classify a login target from GROUND TRUTH. Pure and deterministic.
 *
 * @param {LoginTargetDescriptor | null | undefined} descriptor  read off the page
 *   (untrusted text). Nullish fails closed to an `unknown`, unsupported verdict.
 * @param {{ isKnownIdp: (input: unknown) => boolean }} deps  injected — the
 *   functional-core rule: the idp-registry is imported at the call site and
 *   passed in, so this module stays IO-free and unit-testable.
 * @returns {LoginAffordanceVerdict}
 */
export const classifyLoginAffordance = (descriptor, deps) => {
  const d = /** @type {LoginTargetDescriptor} */ (descriptor ?? {});
  const isKnownIdp = deps?.isKnownIdp ?? (() => false);
  const type = typeof d.type === 'string' ? d.type.trim().toLowerCase() : '';
  const name = typeof d.name === 'string' ? d.name.replace(/\s+/g, ' ').trim().toLowerCase() : '';
  const autocompleteTokens = typeof d.autocomplete === 'string'
    ? d.autocomplete.toLowerCase().split(/\s+/).filter(Boolean)
    : [];
  const hrefDestination = destinationFromHref(d.href);
  const formActionDestination = destinationFromHref(d.formAction);
  const hrefHost = hrefDestination?.host ?? '';
  const formActionHost = formActionDestination?.host ?? '';
  const hrefIsIdp = hrefHost ? isKnownIdp(`https://${hrefHost}`) : false;
  const formActionIsIdp = formActionHost ? isKnownIdp(`https://${formActionHost}`) : false;

  // 1) PASSKEY — checked first so "sign in with a passkey" is never mis-read as an
  //    SSO provider named "passkey" by the broader SSO regex below. verified:true —
  //    WebAuthn is origin-bound by the browser, so the ceremony is inherently on the
  //    real origin; there is no destination to spoof.
  if (autocompleteTokens.includes('webauthn') || (name && PASSKEY_NAME_RE.test(name))) {
    return { method: 'passkey', supported: true, verified: true, reason: 'passkey/WebAuthn affordance' };
  }

  // 2) SSO — a "sign in with <provider>" affordance, or an element whose href/host
  //    (or form action) is itself a dedicated identity provider.
  const nameMatch = name ? name.match(SSO_NAME_RE) : null;
  if (nameMatch || hrefIsIdp || formActionIsIdp) {
    const providerPhrase = cleanText(nameMatch ? nameMatch[1] : (hrefHost || formActionHost), 40);
    const key = providerKey(providerPhrase);
    // The provider shown to the user is a CANONICAL single-word label, never the raw
    // greedy phrase (Fix 3) — so the confirm card cannot echo attacker page text.
    const provider = titleCase(key) || providerPhrase;
    // VERIFIED — where does it actually LEAD? Proven only when an href or form-action
    // host passes isKnownIdp. This is what gates an AUTO-CLICK: a recognized NAME with
    // an unverifiable (or missing) destination is supported-but-unverified.
    const verifiedDestination = [hrefDestination, formActionDestination]
      .find((destination) => destination && isKnownIdp(destination.origin));
    const verified = !!verifiedDestination;
    // Supported when the destination is a proven IdP OR the provider word is a
    // recognized IdP — but NEVER for the explicit exclusions, even if a future edit
    // adds one to the supported set (defense in depth).
    const supported = (verified || SUPPORTED_SSO_PROVIDERS.has(key)) && !EXCLUDED_SSO_PROVIDERS.has(key);
    if (supported && verified) {
      return {
        method: 'sso', provider, supported: true, verified: true,
        idpOrigin: verifiedDestination?.origin,
        reason: 'sign in to a verified identity provider',
      };
    }
    if (supported) {
      // Recognized name, unverified destination — assisted-manual, not an auto-click.
      return {
        method: 'sso',
        provider,
        supported: true,
        verified: false,
        reason: `looks like a "Sign in with ${provider}" button — peerd could not verify where it leads`,
      };
    }
    // why refuse gracefully instead of clicking: idp-registry.js deliberately
    // EXCLUDES github/gitlab/facebook, and no exact provider grant can be issued
    // for them. Clicking here would end the actor when the tab leaves home;
    // returning an unsupported verdict lets it (and the user) learn why.
    return {
      method: 'sso',
      provider,
      supported: false,
      verified: false,
      reason: "SSO provider outside peerd's identity-provider registry (the origin lock would end the actor)",
    };
  }

  // 3) PASSWORD — a password input, or a form that contains one and shows no
  //    passkey/SSO affordance. peerd holds no credentials at Tier 0.
  if (type === 'password' || (d.hasPasswordFieldInForm === true)) {
    return { method: 'password', supported: false, verified: false, reason: 'password login: peerd holds no credentials (Tier 0)' };
  }

  // 4) Everything else is NOT a login affordance. A "Delete account" / "Submit"
  //    button lands here, not in any login branch.
  return { method: 'unknown', supported: false, verified: false, reason: 'not a recognized login affordance' };
};

/**
 * The injected page reader. Serialized by chrome.scripting.executeScript and run
 * in the page's classic-script world, so it closes over NOTHING from this module
 * and is written to be self-contained (same rule as click.js's clickInjected).
 * Resolves the element by walkId (DOM-walk registry) or selector+nth, then reads
 * a LoginTargetDescriptor — ATTRIBUTES and structure only, never a field value.
 *
 * why exported (not inlined): the Bun tests exercise the REAL body's extraction
 * against a jsdom-free descriptor shape, and — as with clickInjected — `export`
 * is not part of Function.prototype.toString, so serialization is unchanged.
 *
 * @param {string | null} selector
 * @param {number} nth
 * @param {number | null} [walkId]
 */
export function loginTargetReader(selector, nth, walkId) {
  'use strict';
  /** @type {HTMLElement | null} */
  let el;
  if (walkId != null) {
    // why: __peerdWalkEls is set on the page world by walk-injected.js — reach it
    // through an erased cast, same as clickInjected.
    const reg = /** @type {{ __peerdWalkEls?: Map<number, HTMLElement> }} */ (globalThis).__peerdWalkEls;
    el = reg && typeof reg.get === 'function' ? (reg.get(walkId) ?? null) : null;
    if (!el || !el.isConnected) {
      return { ok: false, error: 'stale_ref: element no longer in the page — re-run snapshot on this tab first' };
    }
  } else {
    if (typeof selector !== 'string' || !selector) {
      return { ok: false, error: 'selector_or_ref_required' };
    }
    /** @type {NodeListOf<HTMLElement>} */
    let nodes;
    try { nodes = document.querySelectorAll(selector); }
    catch (e) { return { ok: false, error: `invalid_selector: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` }; }
    if (nodes.length === 0) return { ok: false, error: `no_match: ${selector}` };
    const idx = Number.isInteger(nth) && nth >= 0 ? nth : 0;
    if (idx >= nodes.length) {
      return { ok: false, error: `nth_out_of_range: selector matched ${nodes.length} element(s), requested index ${idx}` };
    }
    el = nodes[idx];
  }

  // Accessible name, best-effort and BOUNDED: prefer aria-label / aria-labelledby,
  // then visible text, then value/title/alt. Read as text only.
  const attr = (/** @type {string} */ n) => { const v = el && el.getAttribute ? el.getAttribute(n) : null; return v == null ? '' : String(v); };
  let name = attr('aria-label');
  if (!name) {
    const labelledby = attr('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map((id) => {
        const ref = id ? document.getElementById(id) : null;
        return ref ? (ref.textContent || '') : '';
      });
      name = parts.join(' ');
    }
  }
  if (!name) name = (el.innerText || el.textContent || '');
  if (!name) name = attr('title') || attr('alt');
  if (!name) {
    // why NEVER a bare `value`: for a text/password/email input the value IS the
    // typed secret, and folding it into descriptor.name would be a credential READ.
    // Read `value` ONLY for controls where it is the CONTROL LABEL, not user input:
    // a submit/button/reset input, a <button>, or an <option>.
    const t = (el.tagName || '').toLowerCase();
    const ty = (attr('type') || '').toLowerCase();
    if (t === 'button' || t === 'option' || (t === 'input' && (ty === 'submit' || ty === 'button' || ty === 'reset'))) {
      name = attr('value');
    }
  }
  name = String(name).replace(/\s+/g, ' ').trim().slice(0, 200);

  // Nearest form (or aria-owning form) — does it CONTAIN a password field? We
  // report only its EXISTENCE, never its value (peerd never reads a password).
  let hasPasswordFieldInForm = false;
  try {
    const form = el.closest ? el.closest('form') : null;
    const scope = form || document;
    hasPasswordFieldInForm = !!(scope.querySelector && scope.querySelector('input[type="password"]'));
  } catch (e) { /* best-effort */ }

  // An href for the provider check: the element's own href, or the nearest anchor.
  const ownHref = /** @type {{ href?: string }} */ (el).href;
  let href = typeof ownHref === 'string' && ownHref ? ownHref : attr('href');
  if (!href && el.closest) {
    const a = /** @type {HTMLAnchorElement | null} */ (el.closest('a[href]'));
    if (a) href = a.href || a.getAttribute('href') || '';
  }

  // The FORM ACTION — where a login click navigates. why ONLY for a SUBMIT control:
  // a `type=button`/`reset` does NOT submit its form, so the form's action is NOT
  // where its click leads — trusting it would be a FALSE "verified" signal (a
  // `<form action="accounts.google.com"><button type=button onclick=evil>` would
  // read as a verified Google destination while the onclick does something else).
  // A `<button>` with no/empty type defaults to submit. Captured so the classifier
  // can VERIFY the destination is a known IdP (never a field value).
  let formAction = '';
  try {
    const tg = (el.tagName || '').toLowerCase();
    const ty2 = (attr('type') || '').toLowerCase();
    const isSubmit = (tg === 'input' && ty2 === 'submit') || (tg === 'button' && (ty2 === '' || ty2 === 'submit'));
    if (isSubmit) {
      const own = /** @type {{ formAction?: string }} */ (el).formAction;
      if (typeof own === 'string' && own) {
        formAction = own;
      } else {
        const f = el.closest ? el.closest('form') : null;
        if (f) formAction = f.getAttribute('action') || /** @type {{ action?: string }} */ (f).action || '';
      }
    }
  } catch (e) { /* best-effort */ }

  return {
    ok: true,
    descriptor: {
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      type: (attr('type') || '').toLowerCase(),
      role: attr('role'),
      name,
      autocomplete: (attr('autocomplete') || '').toLowerCase(),
      href: String(href || '').slice(0, 2048),
      formAction: String(formAction || '').slice(0, 2048),
      hasPasswordFieldInForm,
    },
  };
}
