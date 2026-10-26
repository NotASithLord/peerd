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
import { normalizeApiOrigin } from '../../shared/api-origin.js';

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

// Deliberately a small JSON Schema vocabulary. Unknown keywords fail closed;
// callers cannot mistake an ignored condition for a validated contract.
export const MAX_SITE_CLIENT_OPERATIONS = 12;
export const MAX_SITE_VALIDATION_CASES = 24;
const MAX_CONTRACT_CHARS = 24_000;
const MAX_VALUE_CHARS = 32_000;
const plainObject = (/** @type {any} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const failContract = () => { throw new TypeError('site_client_contract_invalid: unsupported or malformed bounded JSON contract'); };
const failValue = () => { throw new TypeError('site_client_value_invalid: value does not satisfy the bounded JSON contract'); };

/** Canonical, bounded JSON only; also rejects cycles, classes and non-finite numbers.
 * @param {unknown} value @param {number} [limit] @returns {string} */
export const canonicalSiteClientJson = (value, limit = MAX_VALUE_CHARS) => {
  let nodes = 0;
  /** @param {any} item @param {number} depth @returns {any} */
  const visit = (item, depth) => {
    if (++nodes > 4096 || depth > 16) return failValue();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (item.length > limit) return failValue();
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    if (!plainObject(item)) return failValue();
    return Object.fromEntries(Object.keys(item).sort().map((key) => {
      if (key.length > 256) return failValue();
      return [key, visit(item[key], depth + 1)];
    }));
  };
  const text = JSON.stringify(visit(value, 0));
  if (text.length > limit) failValue();
  return text;
};

/** @param {any} schema @returns {any} */
export const normalizeSiteClientSchema = (schema) => {
  let nodes = 0;
  const walk = (/** @type {any} */ value, /** @type {number} */ depth) => {
    if (++nodes > 128 || depth > 6 || !plainObject(value)) return failContract();
    const vocabulary = {
      object: ['properties', 'required', 'additionalProperties'],
      array: ['items', 'minItems', 'maxItems'], string: ['minLength', 'maxLength', 'enum'],
      number: ['minimum', 'maximum', 'enum'], integer: ['minimum', 'maximum', 'enum'],
      boolean: ['enum'], null: ['enum'],
    };
    if (typeof value.type !== 'string' || !Object.hasOwn(vocabulary, value.type)) return failContract();
    const allowed = vocabulary[/** @type {keyof typeof vocabulary} */ (value.type)];
    if (Object.keys(value).some(key => key !== 'type' && !allowed.includes(key))) return failContract();
    /** @type {any} */ const out = { type: value.type };
    if (value.type === 'object') {
      if (value.additionalProperties !== undefined && value.additionalProperties !== false) return failContract();
      const props = value.properties ?? {};
      const required = value.required ?? [];
      if (!plainObject(props) || Object.keys(props).length > 32 || !Array.isArray(required)
          || required.some(key => typeof key !== 'string' || !Object.hasOwn(props, key))
          || new Set(required).size !== required.length) return failContract();
      out.properties = Object.fromEntries(Object.keys(props).sort().map(key => {
        if (!key || key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key)) return failContract();
        return [key, walk(props[key], depth + 1)];
      }));
      out.required = [...required].sort();
      out.additionalProperties = false;
    } else if (value.type === 'array') {
      out.items = walk(value.items, depth + 1);
    }
    for (const [low, high, ceiling] of [
      ['minLength', 'maxLength', MAX_VALUE_CHARS], ['minItems', 'maxItems', 1024],
    ]) {
      for (const key of [low, high]) if (value[key] !== undefined) {
        if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > ceiling) return failContract();
        out[key] = value[key];
      }
      if (value[low] !== undefined && value[high] !== undefined && value[low] > value[high]) return failContract();
    }
    for (const key of ['minimum', 'maximum']) if (value[key] !== undefined) {
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return failContract();
      out[key] = value[key];
    }
    if (out.minimum !== undefined && out.maximum !== undefined && out.minimum > out.maximum) return failContract();
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 32
          || value.enum.some((/** @type {any} */ item) => !['string', 'number', 'boolean'].includes(typeof item) && item !== null)) return failContract();
      out.enum = JSON.parse(canonicalSiteClientJson(value.enum, 4096));
      if (new Set(out.enum.map((/** @type {any} */ item) => JSON.stringify(item))).size !== out.enum.length) return failContract();
      for (const item of out.enum) checkSiteValue(item, { ...out, enum: undefined });
    }
    return out;
  };
  const normalized = walk(schema, 0);
  if (JSON.stringify(normalized).length > 8000) failContract();
  return normalized;
};

/** @param {any} value @param {any} schema */
const checkSiteValue = (value, schema) => {
  if (schema.type === 'object') {
    if (!plainObject(value) || schema.required.some((/** @type {string} */ key) => !Object.hasOwn(value, key))
        || Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return failValue();
    for (const [key, item] of Object.entries(value)) checkSiteValue(item, schema.properties[key]);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0)
        || value.length > (schema.maxItems ?? 1024)) return failValue();
    for (const item of value) checkSiteValue(item, schema.items);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0)
        || value.length > (schema.maxLength ?? MAX_VALUE_CHARS)) return failValue();
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)
        || schema.type === 'integer' && !Number.isInteger(value)
        || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return failValue();
  } else if (schema.type === 'null' ? value !== null : typeof value !== 'boolean') return failValue();
  if (schema.enum && !schema.enum.some((/** @type {any} */ item) => Object.is(item, value))) failValue();
};

/** @param {unknown} value @param {any} schema @returns {any} */
export const validateSiteClientValue = (value, schema) => {
  const cloned = JSON.parse(canonicalSiteClientJson(value));
  checkSiteValue(cloned, normalizeSiteClientSchema(schema));
  return cloned;
};

/** @param {any} [operations] @param {any} [validationCases]
 * @returns {{operations:any[],validationCases:any[]}} */
export const normalizeSiteClientContracts = (operations = [], validationCases = []) => {
  if (!Array.isArray(operations) || operations.length > MAX_SITE_CLIENT_OPERATIONS
      || !Array.isArray(validationCases) || validationCases.length > MAX_SITE_VALIDATION_CASES) return failContract();
  const names = new Set();
  const normalized = operations.map(operation => {
    if (!plainObject(operation)
        || Object.keys(operation).some(key => !['name', 'description', 'inputSchema', 'outputSchema', 'readOnly'].includes(key))
        || typeof operation.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(operation.name)
        || ['constructor', 'prototype', '__proto__'].includes(operation.name)
        || names.has(operation.name) || typeof operation.readOnly !== 'boolean'
        || operation.description !== undefined && (typeof operation.description !== 'string' || operation.description.length > 400)) return failContract();
    names.add(operation.name);
    return { name: operation.name, ...(operation.description === undefined ? {} : { description: operation.description }),
      inputSchema: normalizeSiteClientSchema(operation.inputSchema), outputSchema: normalizeSiteClientSchema(operation.outputSchema),
      readOnly: operation.readOnly };
  });
  const cases = validationCases.map(item => {
    if (!plainObject(item) || Object.keys(item).some(key => !['operation', 'input', 'expected'].includes(key))
        || !Object.hasOwn(item, 'input') || !Object.hasOwn(item, 'expected')) return failContract();
    const operation = normalized.find(op => op.name === item.operation);
    if (!operation?.readOnly) return failContract();
    return { operation: operation.name, input: validateSiteClientValue(item.input, operation.inputSchema),
      expected: validateSiteClientValue(item.expected, operation.outputSchema) };
  });
  const result = { operations: normalized, validationCases: cases };
  if (JSON.stringify(result).length > MAX_CONTRACT_CHARS) failContract();
  return result;
};

/** Operations need two different declared inputs; all declared cases must pass.
 * @param {any} meta @returns {string[]} */
export const siteClientValidatedOperations = (meta) => {
  const proof = meta?.validation;
  if (!meta?.revision || proof?.schema !== 1 || proof.revision !== meta.revision
      || proof.status !== 'validated' || !Array.isArray(proof.cases)
      || !Array.isArray(meta.operations) || !Array.isArray(meta.validationCases)
      || proof.cases.length !== meta.validationCases?.length || !proof.cases.length
      || proof.cases.some((/** @type {any} */ receipt, /** @type {number} */ index) =>
        receipt.index !== index || receipt.operation !== meta.validationCases[index]?.operation || receipt.ok !== true)) return [];
  return (meta.operations ?? []).filter((/** @type {any} */ operation) => operation.readOnly === true
    && new Set(meta.validationCases.filter((/** @type {any} */ item) => item.operation === operation.name)
      .map((/** @type {any} */ item) => canonicalSiteClientJson(item.input))).size >= 2)
    .map((/** @type {any} */ operation) => operation.name);
};

/** @param {any} meta @returns {'draft'|'validated'|'stale'} */
export const siteClientContractStatus = (meta) => siteClientValidatedOperations(meta).length
  ? 'validated' : meta?.recentFailures > 0 || meta?.validation?.status === 'failed' ? 'stale' : 'draft';

/** A machine-readable host envelope. All descriptions, schemas and result values
 * remain data; escaping '<' prevents any string from forging its delimiter.
 * @param {string} tag @param {any} value */
export const siteClientEnvelope = (tag, value) => `<${tag}>\n${JSON.stringify(value).replace(/</g, '\\u003c')}\n</${tag}>`;

/** The three run modes are mutually exclusive. The host repeats this validation
 * after exact argument binding; callers cannot smuggle code into a typed read.
 * @param {any} args @returns {any} */
export const normalizeSiteClientRun = (args) => {
  const revision = typeof args?.revision === 'string' && args.revision.length > 0
    && args.revision.length <= 128 ? args.revision : null;
  if (args?.mode === 'validate' && revision && args.code === undefined
      && args.operation === undefined && args.input === undefined) return { kind: 'validate', revision };
  if (args?.mode === undefined && revision && args.code === undefined
      && typeof args.operation === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(args.operation)
      && Object.hasOwn(args, 'input')) return {
    kind: 'operation', revision, operation: args.operation,
    input: JSON.parse(canonicalSiteClientJson(args.input)),
  };
  if (args?.mode === undefined && args?.operation === undefined && args?.input === undefined
      && args?.revision === undefined && typeof args?.code === 'string' && args.code.trim()) {
    return { kind: 'legacy', code: args.code };
  }
  throw new TypeError('site_client_run_invalid: use code OR operation+input+revision OR mode:validate+revision');
};

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
 * @property {number} lastVerifiedAt  epoch ms declared validation cases passed (0 = never); not a business-outcome judgment
 * @property {number} recentFailures  consecutive failed runs since the last success
 * @property {number} createdAt       epoch ms first stored
 * @property {number} updatedAt       epoch ms last write
 * @property {string} [revision]      host-minted identity of exact body + contracts + declared cases
 * @property {any[]} [operations]     bounded named input/output contracts (untrusted data)
 * @property {any[]} [validationCases] declared deterministic read cases (untrusted data)
 * @property {any} [validation]       host-authored revision-bound test receipts
 * @property {string} [validationAttempt] live validation attempt; failures/edits invalidate it
 * @property {number} [lastRunAt]     successful execution is distinct from validation
 * @property {boolean} [lastRunOk]
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
 * @returns {{ origin: string, summary: string, endpoints: SiteEndpoint[], auth: SiteClientMeta['auth'], deriver: SiteClientMeta['deriver'], operations:any[], validationCases:any[] }}
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
  return { origin, summary, endpoints, auth, deriver,
    ...normalizeSiteClientContracts(draft?.operations, draft?.validationCases) };
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
  const trimmed = body.trim() === '' ? '' : body;
  // FAIL LOUD at the write boundary on module-only syntax. site_client_run embeds
  // the body inside an async IIFE (`const client = await (async () => { <body> })()`),
  // where a top-level `export`/`import` is a hard SyntaxError — so an un-runnable
  // client would otherwise persist through a confirmed write and fail on EVERY run.
  // The body must instead RETURN its ops object. Heuristic (line-leading keyword),
  // which is what breaks the wrapper anyway.
  if (trimmed && /^[ \t]*(export|import)\b/m.test(trimmed)) {
    throw new SyntaxError('site-client body must not use top-level export/import — the module runs inside an async function and must RETURN its ops object instead.');
  }
  return trimmed;
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
 *   dossier: ReturnType<typeof validateDossier>,
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

/** @param {SiteClientMeta | null} prevMeta @param {ReturnType<typeof validateDossier>} next */
const sameSummary = (prevMeta, next) => {
  if (!prevMeta) return false;
  if ((prevMeta.summary ?? '') !== next.summary) return false;
  return endpointKey(prevMeta.endpoints ?? []) === endpointKey(next.endpoints)
    && prevMeta.auth === next.auth && prevMeta.deriver === next.deriver
    && canonicalSiteClientJson([prevMeta.operations ?? [], prevMeta.validationCases ?? []], MAX_CONTRACT_CHARS)
      === canonicalSiteClientJson([next.operations, next.validationCases], MAX_CONTRACT_CHARS);
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
  const verified = siteClientValidatedOperations(meta).length && meta.lastVerifiedAt
    ? `declared checks last verified ${Math.max(0, Math.floor((now() - meta.lastVerifiedAt) / 86_400_000))}d ago`
    : 'never verified since derivation';
  const fails = meta.recentFailures > 0 ? `, ${meta.recentFailures} recent failure(s)` : '';
  const age = ageDays === null ? 'unknown age' : `derived ${ageDays}d ago`;
  return [
    `[site-client for ${meta.origin} — ${age}, ${verified}${fails}; deriver: ${meta.deriver}]`,
    'This is DERIVED knowledge from observed traffic. Declared cases and schemas',
    'do not independently establish business correctness. It may be STALE, WRONG,',
    'or MISLEADING. Inspect site_client_read for validated named reads; prefer those and',
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
  // Parse relative-to-pin OR absolute in ONE step, then enforce the pin on the
  // RESULT. why the single post-check (not a branch): WHATWG URL resolution turns
  // several "relative-looking" inputs into a DIFFERENT origin — `//evil.com`,
  // `\\evil.com`, `/\evil.com` (protocol-relative + backslash forms all resolve
  // cross-origin against a base). Branching on shape and trusting the relative
  // branch let those escape the pin (a hostile client body could then combine a
  // credentialed same-origin read with cross-origin GET exfil). Resolving against
  // the base and asserting `u.origin === pin` on the OUTPUT closes the whole class
  // — a bare path stays same-origin, anything that resolves elsewhere is refused.
  let u;
  try { u = new URL(raw, `${pin}/`); } catch { return { error: `site-client: bad path or url: ${raw}` }; }
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
 * @param {string} [input.priorBody]  the prior module body, to detect a dossier-only
 *   patch (body unchanged) so it doesn't needlessly reset verification.
 * @param {number} [input.now]
 * @param {string} [input.revision] fresh host-minted revision for a changed executable contract
 * @returns {{ meta: SiteClientMeta, body: string }}
 */
export const stampRecord = ({ dossier, body, prior, priorBody, now = Date.now(), revision }) => {
  // why: evidence belongs to the exact executable, schemas AND declared cases.
  // A prose-only edit preserves that identity; legacy "successful run" timestamps
  // never acquire typed-read authority during migration.
  const bodyUnchanged = prior != null && typeof priorBody === 'string' && priorBody === body;
  const unchanged = bodyUnchanged
    && canonicalSiteClientJson([prior?.operations ?? [], prior?.validationCases ?? []], MAX_CONTRACT_CHARS)
      === canonicalSiteClientJson([dossier.operations, dossier.validationCases], MAX_CONTRACT_CHARS);
  const currentRevision = unchanged && prior?.revision ? prior.revision : revision;
  const validation = unchanged && prior?.revision && prior.validation?.revision === currentRevision
    ? prior.validation : undefined;
  /** @type {SiteClientMeta} */
  const meta = {
    origin: dossier.origin,
    summary: dossier.summary,
    endpoints: dossier.endpoints,
    auth: dossier.auth,
    deriver: dossier.deriver,
    operations: dossier.operations,
    validationCases: dossier.validationCases,
    ...(currentRevision ? { revision: currentRevision } : {}),
    ...(validation ? { validation } : {}),
    ...(unchanged && prior?.validationAttempt ? { validationAttempt: prior.validationAttempt } : {}),
    sizeBytes: body.length,
    // derivedAt reflects when the MODULE was last derived — keep it on a prose-only edit.
    derivedAt: unchanged ? (prior?.derivedAt ?? now) : now,
    lastVerifiedAt: validation?.status === 'validated' ? (prior?.lastVerifiedAt ?? 0) : 0,
    recentFailures: unchanged ? (prior?.recentFailures ?? 0) : 0,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  return { meta, body };
};
