// @ts-check
// DESIGN-19 — site clients: the PURE core.
//
// A SITE CLIENT is per-origin derived knowledge the web actor accumulates by
// driving/probing a site once, frozen so every LATER web/API actor for that
// origin skips the DOM. Two artifacts per origin (the skills store's meta/body
// split, keyed by origin instead of skill name):
//   - a DOSSIER (meta): a short prose note — what the site is, what the client
//     covers, quirks — plus staleness metadata. Loaded at mint, injected fenced.
//   - a CLIENT MODULE (body): the executable JS the sealed worker runs on demand
//     (site_client_run), never injected into model context wholesale.
//
// This file is functional-core: origin normalization, validation, the
// confirm-gated write proposal (memory.js buildWriteProposal is the template),
// the staleness header (TOOL-AUTHORED — rides OUTSIDE the fence), and the
// dossier fence (wrapUntrusted — every byte is untrusted-provenance). The store
// (store.js) owns IDB; the digester (digest.js) turns capture into a draft; the
// SW owns the confirm round-trip + mint injection.
//
// THE INVARIANT (see docs/specs/DESIGN-19-site-clients.md): a client never gains
// authority beyond what the live actor already has for its origin, and its bytes
// never enter model context UNFENCED. Making it durable always crosses a user
// confirm. Nothing here executes anything — it only shapes values.

import { wrapUntrusted } from '../tools/prompt-wrap.js';
import { normalizeApiOrigin } from '../actor/web-actor.js';

// The canonical owned-origin for a site client IS the API-actor origin: a public
// dotted host, https-or-http, reduced to scheme://host[:port] — immune to
// userinfo / host-suffix spoofing (the same value the egress boundary compares).
// Re-exported so the store + tools have ONE normalizer, never a second regex to
// drift from the same-origin lock.
export { normalizeApiOrigin as normalizeSiteOrigin };

// The client MODULE body cap — a derived client is small (paths + parsing), not a
// library. ~32KB is generous; a hostile/runaway body fails loudly at the write
// boundary rather than bloating IDB. (Skills use ~a similar order for SKILL.md.)
export const MAX_CLIENT_BODY_CHARS = 32_000;
// The DOSSIER cap — it is INJECTED at mint (fenced) into every future actor for
// the origin, so it must stay lean; the budget is the memory-doc order of size.
export const MAX_DOSSIER_CHARS = 4_000;
// One endpoint inventory line is short by construction (method + path template +
// a param hint). Cap the count so a pathological digest can't balloon the meta.
export const MAX_ENDPOINTS = 60;

/**
 * A site-client DOSSIER — the small, always-loadable meta record. Keyed by
 * origin. Everything here is UNTRUSTED-PROVENANCE (derived from page/response
 * bytes) EXCEPT the staleness metadata, which is tool/SW-authored.
 *
 * @typedef {Object} SiteClientMeta
 * @property {string} origin          normalized scheme://host[:port]; the key
 * @property {string} summary         prose: what the site is, what the client covers, quirks
 * @property {SiteEndpoint[]} endpoints  one-line inventory (method + path template + hint)
 * @property {'session'|'bearer'|'none'|'unknown'} auth  observed auth POSTURE — never a value
 * @property {'probe'|'capture-cdp'|'capture-tap'} deriver  how it was derived (fidelity signal)
 * @property {number} sizeBytes       client-module body size — surfaced so users see cost
 * @property {number} derivedAt       epoch ms the client was (re)derived
 * @property {number} lastVerifiedAt  epoch ms a run last succeeded + was accepted (0 = never)
 * @property {number} recentFailures  consecutive failed runs since the last success
 * @property {number} createdAt       epoch ms first stored
 * @property {number} updatedAt       epoch ms last write
 */

/**
 * One endpoint the client covers — the inventory line the dossier surfaces and
 * the model reads to know what the client can do WITHOUT reading the module body.
 *
 * @typedef {Object} SiteEndpoint
 * @property {string} method   GET | POST | PUT | PATCH | DELETE
 * @property {string} path     path TEMPLATE with parameterized segments (/v1/charges/:id)
 * @property {string} [note]   a short hint (params, pagination, what it returns)
 */

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_POSTURES = new Set(['session', 'bearer', 'none', 'unknown']);
const DERIVERS = new Set(['probe', 'capture-cdp', 'capture-tap']);

/**
 * Normalize + validate a proposed dossier (the untrusted-provenance half). Throws
 * a RangeError/TypeError on a body that would blow a cap or a malformed shape, so
 * a bad derivation fails loudly at the boundary instead of persisting junk.
 * Staleness fields are NOT taken from the input here — the store stamps those
 * (they're the trusted half); this validates only the derived content.
 *
 * @param {Partial<SiteClientMeta>} draft
 * @returns {{ origin: string, summary: string, endpoints: SiteEndpoint[], auth: SiteClientMeta['auth'], deriver: SiteClientMeta['deriver'] }}
 */
export const validateDossier = (draft) => {
  const origin = normalizeApiOrigin(draft?.origin);
  if (!origin) throw new TypeError(`site-client: not a usable origin: ${draft?.origin}`);
  const summary = typeof draft?.summary === 'string' ? draft.summary.trim() : '';
  if (summary.length > MAX_DOSSIER_CHARS) {
    throw new RangeError(`site-client dossier too large: ${summary.length} > ${MAX_DOSSIER_CHARS} chars`);
  }
  const endpoints = normalizeEndpoints(draft?.endpoints);
  const auth = AUTH_POSTURES.has(/** @type {string} */ (draft?.auth)) ? /** @type {SiteClientMeta['auth']} */ (draft.auth) : 'unknown';
  const deriver = DERIVERS.has(/** @type {string} */ (draft?.deriver)) ? /** @type {SiteClientMeta['deriver']} */ (draft.deriver) : 'probe';
  return { origin, summary, endpoints, auth, deriver };
};

/**
 * Coerce an endpoints array to the canonical shape, dropping malformed entries
 * and capping the count. Pure — never throws (a bad entry is skipped, not fatal;
 * the count cap is the only hard bound and it truncates).
 *
 * @param {unknown} raw
 * @returns {SiteEndpoint[]}
 */
export const normalizeEndpoints = (raw) => {
  if (!Array.isArray(raw)) return [];
  /** @type {SiteEndpoint[]} */
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const method = String(/** @type {any} */ (e).method ?? '').toUpperCase();
    const path = typeof /** @type {any} */ (e).path === 'string' ? /** @type {any} */ (e).path.trim() : '';
    if (!METHODS.has(method) || !path) continue;
    /** @type {SiteEndpoint} */
    const ep = { method, path: path.slice(0, 200) };
    const note = /** @type {any} */ (e).note;
    if (typeof note === 'string' && note.trim()) ep.note = note.trim().slice(0, 200);
    out.push(ep);
    if (out.length >= MAX_ENDPOINTS) break;
  }
  return out;
};

/**
 * Validate a client MODULE body for storage. Throws on over-cap so a runaway
 * derivation fails at the boundary. An empty/whitespace body is a DELETE signal
 * (returns '') — the same convention memory.normalizeBody uses. Pure.
 *
 * @param {string} body
 * @returns {string}
 */
export const validateClientBody = (body) => {
  if (typeof body !== 'string') throw new TypeError('site-client body must be a string');
  if (body.length > MAX_CLIENT_BODY_CHARS) {
    throw new RangeError(`site-client body too large: ${body.length} > ${MAX_CLIENT_BODY_CHARS} chars`);
  }
  return body.trim() === '' ? '' : body;
};

/**
 * Build a confirm-gated WRITE PROPOSAL for a site client — the diff a
 * confirmation renders before anything is persisted. This is the lethal-trifecta
 * seam: an AGENT deriving/patching a client produces one of these; the SW
 * round-trips it through the confirm protocol; only an explicit user yes commits.
 * The DOSSIER is the primary consent surface (a raw-JS diff is not glanceable);
 * the code delta is summarized as byte counts + line delta, expandable in the UI.
 *
 * Pure: prior record (or null) + the proposed dossier/body → a structured,
 * glanceable proposal. USER-originated writes skip the prompt (already explicit);
 * AGENT writes always confirm — mirrors memory.buildWriteProposal exactly.
 *
 * @param {Object} input
 * @param {Partial<SiteClientMeta>} input.dossier   proposed dossier (untrusted-provenance)
 * @param {string} input.body                       proposed client module ('' = delete)
 * @param {{ meta: SiteClientMeta, body: string } | null} input.prior  existing record, if any
 * @param {'agent'|'user'} [input.origin='agent']
 * @returns {{
 *   key: string, op: 'create'|'update'|'delete'|'noop',
 *   dossier: { origin: string, summary: string, endpoints: SiteEndpoint[], auth: SiteClientMeta['auth'], deriver: SiteClientMeta['deriver'] },
 *   body: string, prevBody: string,
 *   summaryDelta: { added: number, removed: number },
 *   endpointDelta: { added: number, removed: number },
 *   bodyBytesBefore: number, bodyBytesAfter: number,
 *   requiresConfirmation: boolean,
 * }}
 */
export const buildClientWriteProposal = ({ dossier, body, prior, origin = 'agent' }) => {
  const validated = validateDossier(dossier);
  const nextBody = validateClientBody(body);
  const prevBody = prior?.body ?? '';
  const prevMeta = prior?.meta ?? null;

  /** @type {'create'|'update'|'delete'|'noop'} */
  let op;
  if (nextBody === '' && prevBody === '') op = 'noop';
  else if (nextBody === '') op = 'delete';
  else if (prevBody === '') op = 'create';
  else if (nextBody === prevBody && sameSummary(prevMeta, validated)) op = 'noop';
  else op = 'update';

  return {
    key: validated.origin,
    op,
    dossier: validated,
    body: nextBody,
    prevBody,
    summaryDelta: lineDelta(prevMeta?.summary ?? '', validated.summary),
    endpointDelta: endpointDelta(prevMeta?.endpoints ?? [], validated.endpoints),
    bodyBytesBefore: prevBody.length,
    bodyBytesAfter: nextBody.length,
    // AGENT writes always confirm (the trifecta defense); noop never prompts;
    // a user edit is already explicit.
    requiresConfirmation: origin === 'agent' && op !== 'noop',
  };
};

/** @param {SiteClientMeta | null} prevMeta @param {{ summary: string, endpoints: SiteEndpoint[] }} next */
const sameSummary = (prevMeta, next) => {
  if (!prevMeta) return false;
  if ((prevMeta.summary ?? '') !== next.summary) return false;
  return endpointKey(prevMeta.endpoints ?? []) === endpointKey(next.endpoints);
};

/** @param {SiteEndpoint[]} eps @returns {string} */
const endpointKey = (eps) => eps.map((e) => `${e.method} ${e.path}`).sort().join('\n');

/**
 * Coarse add/remove line counts between two prose bodies — a set difference, not
 * a real LCS, which is plenty for a "+12 / −3" badge. Pure. (memory.lineDelta twin.)
 * @param {string} prev @param {string} next @returns {{ added: number, removed: number }}
 */
export const lineDelta = (prev, next) => {
  const before = new Set((prev || '').split('\n'));
  const after = new Set((next || '').split('\n'));
  let added = 0; let removed = 0;
  for (const l of after) if (!before.has(l)) added++;
  for (const l of before) if (!after.has(l)) removed++;
  return { added, removed };
};

/**
 * Add/remove counts over the endpoint inventory (by "METHOD path" identity), for
 * the proposal summary — "3 endpoints added, 1 removed" reads better than a body
 * diff. Pure.
 * @param {SiteEndpoint[]} prev @param {SiteEndpoint[]} next @returns {{ added: number, removed: number }}
 */
export const endpointDelta = (prev, next) => {
  const before = new Set((prev ?? []).map((e) => `${e.method} ${e.path}`));
  const after = new Set((next ?? []).map((e) => `${e.method} ${e.path}`));
  let added = 0; let removed = 0;
  for (const k of after) if (!before.has(k)) added++;
  for (const k of before) if (!after.has(k)) removed++;
  return { added, removed };
};

// ── mint-time injection: the fenced dossier + its TOOL-AUTHORED header ────────

/**
 * The staleness HEADER — tool/SW-authored, rides OUTSIDE the fence (page content
 * must never forge or suppress it, same rule as fetch_url's paging footer). It
 * frames the dossier as an unreliable CACHE: derived knowledge, possibly stale or
 * misleading, verify on use. The metadata is the trusted half of the record.
 *
 * @param {SiteClientMeta} meta
 * @param {{ now?: () => number }} [opts]
 * @returns {string}
 */
export const stalenessHeader = (meta, { now = Date.now } = {}) => {
  const ageDays = typeof meta.derivedAt === 'number' ? Math.max(0, Math.floor((now() - meta.derivedAt) / 86_400_000)) : null;
  const verified = meta.lastVerifiedAt
    ? `last verified ${Math.max(0, Math.floor((now() - meta.lastVerifiedAt) / 86_400_000))}d ago`
    : 'never verified since derivation';
  const fails = meta.recentFailures > 0 ? `, ${meta.recentFailures} recent failure(s)` : '';
  const age = ageDays === null ? 'unknown age' : `derived ${ageDays}d ago`;
  return [
    `[site-client for ${meta.origin} — ${age}, ${verified}${fails}; deriver: ${meta.deriver}]`,
    'This is DERIVED knowledge from observed traffic — a cache, not a contract. It',
    'may be STALE, WRONG, or MISLEADING. Verify on use: prefer site_client_run and',
    'fall back to driving the page (it is ground truth) if a call fails. If you',
    'learn the client is wrong, propose a patched client (a confirmed write).',
  ].join(' ');
};

/**
 * Fence the dossier body (summary + endpoint inventory + auth posture) as
 * UNTRUSTED content for mint-time injection — every byte derives from page/
 * response bytes, so it re-enters as DATA, tagged with the owned origin. The
 * module BODY is never injected (it loads on demand via site_client_read/run).
 *
 * @param {SiteClientMeta} meta
 * @param {{ now?: () => number }} [opts]
 * @returns {string}
 */
export const fenceDossier = (meta, { now = Date.now } = {}) => {
  const lines = [];
  if (meta.summary) lines.push(meta.summary, '');
  lines.push(`auth posture: ${meta.auth}`);
  if (meta.endpoints?.length) {
    lines.push('endpoints:');
    for (const e of meta.endpoints) lines.push(`  ${e.method} ${e.path}${e.note ? ` — ${e.note}` : ''}`);
  }
  return wrapUntrusted({
    origin: `site-client(${meta.origin})`,
    tool: 'site_client',
    body: lines.join('\n'),
    retrievedAt: new Date(now()).toISOString(),
  });
};

/**
 * Assemble the FULL mint-time injection block: the tool-authored header (outside
 * the fence) followed by the fenced dossier. This is what the SW prepends to a
 * web/API actor's first turn when its origin has a stored client. Pure.
 *
 * @param {SiteClientMeta} meta
 * @param {{ now?: () => number }} [opts]
 * @returns {string}
 */
export const buildMintInjection = (meta, opts = {}) =>
  `${stalenessHeader(meta, opts)}\n${fenceDossier(meta, opts)}`;

/**
 * Resolve a client's `site.fetch(pathOrUrl)` argument against the PINNED origin,
 * enforcing the one-origin-per-run rule. A path (leading '/') is joined to the
 * pinned origin. An absolute URL is allowed ONLY when it is same-origin to the
 * pin — a cross-origin absolute URL is REFUSED here (not silently sessionless):
 * a run drives exactly the origin its client was derived for. Pure — the SW route
 * calls this before any fetch, so the worker can never point the pinned, session-
 * scoped fetch at another host.
 *
 * @param {unknown} pathOrUrl
 * @param {string} pinnedOrigin   normalized scheme://host[:port]
 * @returns {{ url: string } | { error: string }}
 */
export const resolveSiteUrl = (pathOrUrl, pinnedOrigin) => {
  const pin = normalizeApiOrigin(pinnedOrigin);
  if (!pin) return { error: `site-client: bad pinned origin: ${pinnedOrigin}` };
  const raw = typeof pathOrUrl === 'string' ? pathOrUrl.trim() : '';
  if (!raw) return { error: 'site-client: fetch needs a path or URL' };
  // A relative path (or query/fragment-only) joins to the pin.
  if (/^\/|^\?|^#/.test(raw) || !/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try { return { url: new URL(raw, `${pin}/`).toString() }; }
    catch { return { error: `site-client: bad path: ${raw}` }; }
  }
  // An absolute URL — allowed only same-origin to the pin.
  let u;
  try { u = new URL(raw); } catch { return { error: `site-client: bad url: ${raw}` }; }
  if (u.origin !== pin) {
    return { error: `site-client: cross-origin fetch refused — this run is pinned to ${pin}, not ${u.origin}. Derive a separate client for that origin.` };
  }
  return { url: u.toString() };
};

/**
 * Stamp a validated dossier + body into a full stored record, folding staleness
 * metadata against any prior record (createdAt preserved; derivedAt bumps on a
 * new derivation; failures reset). Pure — the timestamp is injected. The store
 * calls this to build the meta+body pair it persists after a confirmed write.
 *
 * @param {Object} input
 * @param {ReturnType<typeof validateDossier>} input.dossier
 * @param {string} input.body
 * @param {SiteClientMeta | null} input.prior
 * @param {number} [input.now]
 * @returns {{ meta: SiteClientMeta, body: string }}
 */
export const stampRecord = ({ dossier, body, prior, now = Date.now() }) => {
  /** @type {SiteClientMeta} */
  const meta = {
    origin: dossier.origin,
    summary: dossier.summary,
    endpoints: dossier.endpoints,
    auth: dossier.auth,
    deriver: dossier.deriver,
    sizeBytes: body.length,
    derivedAt: now,
    // A fresh derivation resets verification + failure count — the model must
    // re-earn trust in the new client by a successful run.
    lastVerifiedAt: 0,
    recentFailures: 0,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  return { meta, body };
};
