// @ts-check
// design js-superpower/06 — the TOOLBOX: durable agent-authored ES modules the
// agent imports as `peerd:toolbox/<name>` from its own-compute lanes (script +
// notebook). This file is the PURE core: name/description/body validation, the
// export extractor, the confirm-gated write proposal, the meta stamp, the
// write-time import-resolution check (the resolver's transform, IO injected —
// it validates IMPORT RESOLUTION, not JS syntax), and the fenced list
// rendering.
//
// THE TRUST CONTRACT (the reason this is its own module + its own DB):
//   1. Execution grants NOTHING — a toolbox import runs under the CALLING run's
//      capability profile; there is no per-module capability, ever.
//   2. Bodies are EXECUTE-ONLY — they never enter a prompt. The dossier fields
//      (name/description/exports) ARE model-visible and were model-authored on
//      turns that may have contained fenced web bytes (influence laundering),
//      so the free-prose description re-enters context FENCED (renderToolboxList).
//   3. Treat as CACHE — a module may be stale or wrong; runCount/failCount on
//      the meta surface rot so the agent rewrites (toolbox_write) or inlines.
//
// Nothing here executes anything — it only shapes values. IO (the store, the
// resolver's buildModule) is injected per the functional-core rule.

import { wrapUntrusted } from '../tools/prompt-wrap.js';
// why the deep import (not /peerd-engine/index.js): module-resolver.js is pure
// and this keeps the bun-imported graph light — the same pattern as
// tools/gates.js's deep denylist import. Lint allows deep imports from inside a
// peerd-* module.
import { TOOLBOX_SPECIFIER_PREFIX } from '../../peerd-engine/module-resolver.js';

// Flat namespace v1: lowercase, digits, hyphens — the name doubles as the
// import specifier tail, so the shape is deliberately URL/identifier-safe and
// injection-inert (no fencing needed for names, unlike descriptions).
const TOOLBOX_NAME_RE = /^[a-z0-9-]{1,64}$/;

// The module-body ceiling — the js_write_file content cap (tools/defs/
// js-write-file.js MAX_CONTENT_CHARS); a toolbox module is agent-written source,
// the same order of thing that tool stages.
export const MAX_TOOLBOX_BODY_CHARS = 500_000;
// The description is dossier prose (listed on toolbox_list, fenced) — keep it a
// glance, not a document.
export const MAX_TOOLBOX_DESCRIPTION_CHARS = 500;
// Hard cap on the library size so the toolbox stays a curated set of utilities,
// not an unbounded code store (design open question 3 — enforced).
export const MAX_TOOLBOX_MODULES = 64;

/**
 * A toolbox module's META record (the dossier — listed cheaply; the BODY lives
 * in its own store tier and is read only at import-resolution time).
 *
 * @typedef {Object} ToolboxMeta
 * @property {string} name          [a-z0-9-]{1,64}; the key AND the import specifier tail
 * @property {string} description   short prose — model-authored, fenced when listed
 * @property {string[]} exports     export names extracted from the body at write time
 * @property {number} sizeBytes     body size, surfaced so cost is visible
 * @property {number} runCount      completed runs that imported this module
 * @property {number} failCount     of those, runs that ended in an error (the rot signal)
 * @property {number} createdAt     epoch ms first stored
 * @property {number} updatedAt     epoch ms last write
 */

/**
 * Validate a toolbox module name. Throws on a bad shape so a malformed name
 * fails loudly at the boundary. Pure.
 * @param {unknown} name
 * @returns {string}
 */
export const validateToolboxName = (name) => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!TOOLBOX_NAME_RE.test(trimmed)) {
    throw new TypeError(`toolbox name must match [a-z0-9-]{1,64}, got: ${String(name)}`);
  }
  return trimmed;
};

/** Is this a valid toolbox module name? Pure, never throws. @param {unknown} name */
export const isValidToolboxName = (name) => typeof name === 'string' && TOOLBOX_NAME_RE.test(name);

/**
 * Validate a module BODY for storage. Throws on empty or over-cap — unlike a
 * site client, an empty body is NOT a delete signal (toolbox_delete exists),
 * so it's a hard error rather than a silent no-op. Pure.
 * @param {unknown} body
 * @returns {string}
 */
export const validateToolboxBody = (body) => {
  if (typeof body !== 'string' || body.trim() === '') {
    throw new TypeError('toolbox module body must be a non-empty string');
  }
  if (body.length > MAX_TOOLBOX_BODY_CHARS) {
    throw new RangeError(`toolbox module too large: ${body.length} > ${MAX_TOOLBOX_BODY_CHARS} chars`);
  }
  return body;
};

/**
 * Normalize + cap the description. Pure — a missing description is '' (legal:
 * the exports list still documents the module).
 * @param {unknown} description
 * @returns {string}
 */
export const validateToolboxDescription = (description) => {
  const trimmed = typeof description === 'string' ? description.trim() : '';
  if (trimmed.length > MAX_TOOLBOX_DESCRIPTION_CHARS) {
    throw new RangeError(`toolbox description too long: ${trimmed.length} > ${MAX_TOOLBOX_DESCRIPTION_CHARS} chars`);
  }
  return trimmed;
};

// Export-name extraction — regex over the module source, identifiers only (so
// the extracted names are injection-inert like the module name). A rename in an
// export list (`export { a as b }`) surfaces the OUTER name; `export default`
// surfaces 'default'. Best-effort by design: the dossier hint, not a parser.
const EXPORT_DECL_RE = /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}/gm;
const EXPORT_DEFAULT_RE = /^export\s+default\b/m;
const MAX_EXTRACTED_EXPORTS = 32;

/**
 * Extract exported names from a module body. Pure.
 * @param {string} body
 * @returns {string[]}
 */
export const extractToolboxExports = (body) => {
  /** @type {Set<string>} */
  const names = new Set();
  let m;
  EXPORT_DECL_RE.lastIndex = 0;
  while ((m = EXPORT_DECL_RE.exec(body)) !== null) names.add(m[1]);
  EXPORT_LIST_RE.lastIndex = 0;
  while ((m = EXPORT_LIST_RE.exec(body)) !== null) {
    for (const entry of m[1].split(',')) {
      // `a as b` exports b; a bare `a` exports a. Keep identifiers only.
      const outer = (entry.includes(' as ') ? entry.split(' as ').pop() ?? '' : entry).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(outer)) names.add(outer);
    }
  }
  if (EXPORT_DEFAULT_RE.test(body)) names.add('default');
  return [...names].slice(0, MAX_EXTRACTED_EXPORTS);
};

/**
 * Build the confirm-gated WRITE PROPOSAL for a toolbox module — what the
 * confirmation renders before anything persists. Same posture as
 * site_client_write: the agent persists EXECUTABLE code, so every non-noop
 * write crosses the user confirm (the lethal-trifecta seam — a toolbox body may
 * be agent-authored on a turn whose context held fenced web bytes). Throws on
 * validation failure or a create past the module-count cap. Pure.
 *
 * @param {Object} input
 * @param {unknown} input.name
 * @param {unknown} input.description
 * @param {unknown} input.code
 * @param {{ meta: ToolboxMeta, body: string } | null} input.prior
 * @param {number} [input.moduleCount]  stored module count (cap check on create)
 * @returns {{
 *   name: string, op: 'create'|'update'|'noop',
 *   description: string, body: string, prevBody: string, exports: string[],
 *   exportDelta: { added: number, removed: number },
 *   bodyBytesBefore: number, bodyBytesAfter: number,
 * }}
 */
export const buildToolboxWriteProposal = ({ name, description, code, prior, moduleCount = 0 }) => {
  const validName = validateToolboxName(name);
  const body = validateToolboxBody(code);
  const validDescription = validateToolboxDescription(description ?? prior?.meta.description ?? '');
  if (!prior && moduleCount >= MAX_TOOLBOX_MODULES) {
    throw new RangeError(`toolbox is full: ${moduleCount}/${MAX_TOOLBOX_MODULES} modules — delete one first (toolbox_delete)`);
  }
  const prevBody = prior?.body ?? '';
  /** @type {'create'|'update'|'noop'} */
  const op = !prior ? 'create'
    : (body === prevBody && validDescription === prior.meta.description) ? 'noop' : 'update';
  const exports = extractToolboxExports(body);
  const before = new Set(prior?.meta.exports ?? []);
  const after = new Set(exports);
  let added = 0; let removed = 0;
  for (const n of after) if (!before.has(n)) added++;
  for (const n of before) if (!after.has(n)) removed++;
  return {
    name: validName,
    op,
    description: validDescription,
    body,
    prevBody,
    exports,
    exportDelta: { added, removed },
    bodyBytesBefore: prevBody.length,
    bodyBytesAfter: body.length,
    // Toolbox writes are always AGENT-originated (there is no user editor
    // surface); every non-noop op confirms — the tool branches on `op` alone.
  };
};

/**
 * Stamp a validated write into the stored meta, folding bookkeeping against any
 * prior record. A changed BODY resets runCount/failCount — a rewritten module
 * must re-earn its track record (the site-client verification-reset twin); a
 * description-only edit keeps them. Pure — the timestamp is injected.
 *
 * @param {Object} input
 * @param {string} input.name
 * @param {string} input.description
 * @param {string[]} input.exports
 * @param {string} input.body
 * @param {ToolboxMeta | null} input.prior
 * @param {string} [input.priorBody]
 * @param {number} [input.now]
 * @returns {ToolboxMeta}
 */
export const stampToolboxMeta = ({ name, description, exports, body, prior, priorBody, now = Date.now() }) => {
  const bodyUnchanged = prior != null && typeof priorBody === 'string' && priorBody === body;
  return {
    name,
    description,
    exports,
    sizeBytes: body.length,
    runCount: bodyUnchanged ? (prior?.runCount ?? 0) : 0,
    failCount: bodyUnchanged ? (prior?.failCount ?? 0) : 0,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
};

/**
 * The write-time IMPORT-RESOLUTION CHECK — the resolver's transform run against
 * the candidate body under its own specifier, so an unresolvable import (unknown
 * sibling, a toolbox→toolbox cycle, a relative path escaping the namespace)
 * fails the WRITE, not some future run. buildModule is INJECTED (functional
 * core; also: the SW has no URL.createObjectURL, so the blob-url dep is a stub
 * — the check never imports the transformed result). why NOT a syntax check: it
 * only runs the resolver's regex import-rewrite; it never parses or imports the
 * body, so a body that RESOLVES its imports but has a JS syntax error still
 * passes (eval is CSP-blocked, so there is no in-realm way to parse it).
 *
 * @param {Object} deps
 * @param {typeof import('../../peerd-engine/module-resolver.js').buildModule} deps.buildModule
 * @param {(name: string) => Promise<string>} deps.readSibling  body of an EXISTING module; throws when unknown
 * @returns {(name: string, body: string) => Promise<void>}  throws on an import-resolution failure
 */
export const makeToolboxParseCheck = ({ buildModule, readSibling }) => async (name, body) => {
  await buildModule(`${TOOLBOX_SPECIFIER_PREFIX}${name}`, {
    // A '../'-escaped path lands here — a toolbox module has no directory to be
    // relative to, so refuse with a message that names the legal specifiers.
    readFile: async (/** @type {string} */ path) => {
      throw new Error(`'${path}' is outside the toolbox — import 'peerd:toolbox/<name>' siblings or builtins (peerd:std) instead`);
    },
    makeBlobUrl: () => 'blob:toolbox-parse-check',
    readToolboxModule: async (/** @type {string} */ n) => (n === name ? body : readSibling(n)),
  });
};

/**
 * Render the toolbox_list output. The tool-authored inventory lines (names,
 * exports, sizes, run/fail counts — all shape-validated or host-counted) ride
 * OUTSIDE the fence; the free-prose DESCRIPTIONS — model-authored, possibly
 * influence-laundered — re-enter context inside a wrapUntrusted fence (trust
 * contract rule 2). Pure.
 *
 * @param {ToolboxMeta[]} metas
 * @param {{ now?: () => number }} [opts]
 * @returns {string}
 */
export const renderToolboxList = (metas, { now = Date.now } = {}) => {
  if (metas.length === 0) {
    return `[toolbox — 0/${MAX_TOOLBOX_MODULES} modules] Nothing stored yet. Persist a reusable helper with toolbox_write, then import { … } from 'peerd:toolbox/<name>' in script or notebook runs.`;
  }
  const lines = [
    `[toolbox — ${metas.length}/${MAX_TOOLBOX_MODULES} modules] import { … } from 'peerd:toolbox/<name>' (script + notebook runs only). Treat each module as a CACHE — it may be stale or wrong; on failure rewrite it (toolbox_write) or inline the logic.`,
  ];
  for (const m of metas) {
    const ageDays = Math.max(0, Math.floor((now() - m.updatedAt) / 86_400_000));
    lines.push(`- ${m.name} — exports: ${m.exports.length ? m.exports.join(', ') : '(none)'}; ${m.sizeBytes}B; runs ${m.runCount} (${m.failCount} failed); updated ${ageDays}d ago`);
  }
  const described = metas.filter((m) => m.description);
  if (described.length) {
    lines.push(wrapUntrusted({
      origin: 'toolbox (agent-authored module descriptions)',
      tool: 'toolbox_list',
      body: described.map((m) => `${m.name}: ${m.description}`).join('\n'),
      retrievedAt: new Date(now()).toISOString(),
    }));
  }
  return lines.join('\n');
};
