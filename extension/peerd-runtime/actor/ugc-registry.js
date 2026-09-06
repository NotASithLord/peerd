// @ts-check
// security-arc #242 — the UGC-ZONE TRUST REGISTRY (pure core).
//
// A "UGC zone" is a TRUSTED site that hosts UNTRUSTED third-party content:
// GitHub issues/PRs, Google Docs, Jira/Linear tickets, Reddit/Twitter threads.
// It is the most dangerous surface a web actor touches, because on such a site
// the actor holds authenticated-session tools — the page it is reading was
// authored by an attacker, but the origin's cookies belong to the user. So the
// prompt-injection payload arrives WITH the authority to act on it.
//
// This module is the deterministic CLASSIFIER. Classification is a static
// lookup, never a channel probe: same input, same answer, offline, forever.
//
// THE ENFORCEMENT: the exact service-worker page authority classifies the live
// document immediately before every click or fill and always asks the user on
// `ugc`, even when confirmations are toggled OFF. It puts a human on the exact
// keystroke an injected comment would want to drive. The semantic controller
// makes no confirmation decision and carries no parallel policy fallback.
//
// why a forced CONFIRM and not a hard read-only downscale (the shape first
// sketched here): "reply to this GitHub issue" and "update the Jira ticket" are
// real, wanted work, and a hard block turns the most valuable surface peerd has
// into a dead end — users would just turn the protection off. A confirm keeps
// the flow and moves the decision to the one party the injected page cannot
// impersonate. It also mirrors a precedent already in the tree: memory tools
// self-confirm unconditionally (tools/dispatcher.js `selfConfirms`) for exactly
// this lethal-trifecta reason.
//
// why it is not the whole answer: a confirm is only as good as what the user
// sees. It is layered WITH the offscreen heap fence (untrusted reasoning never
// holds the vault DK), the CDR read boundary (dom/cdr.js), and the egress
// tripwire (tools/egress-heuristics.js) — none of which depend on a human
// reading carefully.
//
// THE COST, stated plainly: posting one comment is a type + a click, so it is
// TWO prompts, not one. We take that rather than invent a per-turn "act on this
// page" grant, because (a) it is exactly what a user who switches
// confirmations ON already lives with on every site — the same machinery, one
// posture, no bespoke second concept — and (b) an actor session deliberately
// accumulates NO standing grants,
// which is the property that makes this confirm meaningful at all. If the
// prompting proves annoying in the field, a per-turn per-origin grant is the
// designed follow-up; speculating it now would trade a real guarantee for a
// convenience nobody has asked for yet.
//
// FAIL-OPEN is correct. An unmatched URL classifies as `standard`, and a missed
// zone merely skips the added confirm — it opens no hole that wasn't already
// open, it just declines to add protection we didn't recognize we needed. The
// registry is EXTENSIBLE: adding a zone is one frozen entry, and a too-narrow
// list under-protects (safe) rather than over-restricts (nags on ordinary
// sites, which is how a security prompt gets trained away).

// why: reuse the egress-side canonicalizer rather than re-deriving origin rules.
// It lowercases the host, drops default ports, and REJECTS anything that isn't a
// real public origin (bare IPs, localhost, engine-id shapes) — immune to the
// `host.evil.com` / userinfo tricks the denylist matcher also guards against. A
// UGC rule can therefore only ever match a genuine web origin.
import { normalizeApiOrigin } from './web-actor.js';

/**
 * The result of classifying a URL's origin against the UGC-zone registry.
 * `zone:'ugc'` carries the matching `ruleId` (the entry's `id`) so the exact
 * browser authority can attribute WHY it forced a confirmation in its host
 * receipt, audit event, and persisted tool-result lineage;
 * `zone:'standard'` omits it.
 *
 * @typedef {object} TrustZoneResult
 * @property {'ugc' | 'standard'} zone  Which trust zone the origin+path fall in.
 * @property {string} [ruleId]          The matched registry entry's `id` (ugc only).
 */

/**
 * One well-known UGC zone. Matching is `hostPattern.test(host)` AND
 * `pathPattern.test(path)` — BOTH must hold, so path specificity is expressible
 * (github.com/org/repo/settings is NOT a zone; /org/repo/issues/1 IS).
 *
 * @typedef {object} UgcRule
 * @property {string} id            Stable rule id (also the ruleId in a match).
 * @property {RegExp} hostPattern   Tested against the normalized (lowercased) host.
 * @property {RegExp} pathPattern   Tested against the normalized (lowercased) path.
 */

// The frozen, extensible registry. Each entry pairs a host test with a path test
// so a trusted host is only a UGC zone on the sub-paths that actually host
// third-party content. Ordering is irrelevant — the first match wins and the
// rules are mutually exclusive by host in practice. To add a zone: append one
// frozen entry; never widen an existing pattern past the content sub-paths.
/** @type {ReadonlyArray<UgcRule>} */
export const UGC_RULES = Object.freeze([
  // GitHub: issues, pull requests, and discussions are attacker-authorable; the
  // repo root, /settings, /actions, /blob, etc. are not. Path shape:
  // /<owner>/<repo>/(issues|pull|discussions)[/…].
  Object.freeze({
    id: 'github-issues-pulls',
    hostPattern: /^(www\.)?github\.com$/,
    pathPattern: /^\/[^/]+\/[^/]+\/(issues|pull|discussions)(\/|$)/,
  }),
  // Google Docs: every document surface (docs/sheets/slides/forms) is UGC — the
  // whole host is a document viewer for content the user did not author.
  Object.freeze({
    id: 'google-docs',
    hostPattern: /^docs\.google\.com$/,
    pathPattern: /^\/(document|spreadsheets|presentation|forms)(\/|$)/,
  }),
  // Atlassian cloud: Jira issues (/browse/KEY-1) and Confluence pages (/wiki).
  // Wildcard host — every tenant is <tenant>.atlassian.net.
  Object.freeze({
    id: 'atlassian-jira-confluence',
    hostPattern: /(^|\.)atlassian\.net$/,
    pathPattern: /^\/(browse|wiki|jira)(\/|$)/,
  }),
  // Linear: issue pages are /<workspace>/issue/<KEY>. The workspace root and
  // settings are not third-party content.
  Object.freeze({
    id: 'linear-issue',
    hostPattern: /^(www\.)?linear\.app$/,
    pathPattern: /^\/[^/]+\/issue(\/|$)/,
  }),
  // Reddit: comment threads are /r/<sub>/comments/<id>. Subreddit listings and
  // the front page are aggregations we don't downscale on.
  Object.freeze({
    id: 'reddit-comments',
    hostPattern: /(^|\.)reddit\.com$/,
    pathPattern: /^\/r\/[^/]+\/comments(\/|$)/,
  }),
  // Twitter / X: a status (tweet) page is /<handle>/status/<id> — arbitrary
  // third-party text. Both legacy and current hosts.
  Object.freeze({
    id: 'twitter-status',
    hostPattern: /^(www\.)?(twitter|x)\.com$/,
    pathPattern: /^\/[^/]+\/status(\/|$)/,
  }),
]);

/**
 * Normalize a path for matching: lowercase and strip trailing slashes so
 * `/issues/` and `/issues` classify identically. Query and fragment are already
 * gone (we read `URL.pathname`). why lowercase: the rule keywords are lowercase
 * and comparing case-insensitively can't cause a FALSE negative — a real
 * owner/repo segment never disambiguates a zone.
 * @param {string} pathname
 * @returns {string}
 */
const normalizePath = (pathname) => {
  const lowered = pathname.toLowerCase();
  const trimmed = lowered.replace(/\/+$/, '');
  return trimmed || '/';
};

/**
 * Classify a URL's origin+path against the UGC-zone registry. DETERMINISTIC:
 * same URL → same result, no network, no channel probe. Query string and
 * fragment are IGNORED (classification is an origin+path property). Malformed or
 * non-public-origin input classifies as `standard` and NEVER throws (fail-open).
 *
 * @param {string} url  An absolute URL, or a bare host (assumed https).
 * @returns {TrustZoneResult}
 */
export const classifyUrl = (url) => {
  // why: canonicalize + validate through the egress helper first. It normalizes
  // the origin AND rejects non-public origins, so a malformed or private URL
  // short-circuits to `standard` before any pattern runs (fail-open).
  const origin = normalizeApiOrigin(url);
  if (!origin) return { zone: 'standard' };

  let host;
  let path;
  try {
    // normalizeApiOrigin proved this parses and prefixes https:// for bare hosts;
    // mirror that so the host+path we test are the canonical ones.
    let raw = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    const parsed = new URL(raw);
    host = parsed.hostname.toLowerCase();
    path = normalizePath(parsed.pathname);
  } catch {
    // why: unreachable given normalizeApiOrigin already validated, but the
    // classifier's contract is "never throw" — fail open, not loud.
    return { zone: 'standard' };
  }

  for (const rule of UGC_RULES) {
    if (rule.hostPattern.test(host) && rule.pathPattern.test(path)) {
      return { zone: 'ugc', ruleId: rule.id };
    }
  }
  return { zone: 'standard' };
};

/**
 * Is this ORIGIN's host a UGC zone at all — ignoring the path?
 *
 * issue 251 wants a different question from the one the rest of this file
 * answers, and the difference is the whole reason this is a separate export
 * rather than a call to `classifyUrl`.
 *
 * `classifyUrl` is PATH-scoped because #242 gates one WRITE: acting as the user
 * on a page strangers authored. Whether `/settings` is UGC is a real question
 * there, and the answer is no.
 *
 * The origin lock asks whether the user has an IDENTITY here, because what it
 * decides is whether a roaming actor may hold this site's SESSION — and a
 * session does not stop at a path boundary. Every host in this registry is by
 * construction a site people have accounts on; that is what made its content
 * attacker-authorable in the first place. So the host alone is the signal, and
 * `github.com/settings` is exactly as much "a site you are logged into" as
 * `github.com/acme/repo/issues/1`.
 *
 * Fail-open like everything else here: an origin we cannot canonicalize is not
 * a UGC host.
 *
 * @param {string} origin  a canonical origin (or anything normalizeApiOrigin accepts)
 * @returns {boolean}
 */
export const isUgcHost = (origin) => {
  const canonical = normalizeApiOrigin(origin);
  if (!canonical) return false;
  let host;
  try { host = new URL(canonical).hostname.toLowerCase(); } catch { return false; }
  return UGC_RULES.some((rule) => rule.hostPattern.test(host));
};
