// @ts-check
// Memory — pure functional core (no IO).
//
// File-based memory, AGENTS.md flavoured (the open standard Claude
// Code's CLAUDE.md and OpenCode's AGENTS.md both share). The agent
// keeps durable, human-readable notes that load into the system prompt
// at the top of every session so it doesn't re-learn the workspace each
// time.
//
// Everything here is a pure function over values — scope identity,
// document shape, the hierarchical merge, the always-loaded line budget,
// and the system-prompt block. The imperative shell (store.js) owns IDB;
// the SW owns the confirm round-trip. Keeping the rules here is the
// testability lever: store.test.js exercises this module with no browser.
//
// why three scopes (user → project → subtree): the same hierarchy
// Claude Code's memory uses, mapped onto a browser. "project" is keyed
// by a workspace id — for peerd a workspace is NOT just a file tree, it
// is a browsing context: an origin the user works on, a WebVM, or an
// App. "subtree" narrows to a path/section inside that workspace and
// loads ON DEMAND, keeping the always-loaded surface lean.

/** @typedef {'user' | 'project' | 'subtree'} MemoryScopeKind */

/**
 * A scope identifier — the addressable handle for a memory doc. workspace
 * and subpath are optional at the API boundary (user scope needs neither;
 * project needs workspace; subtree needs both).
 * @typedef {Object} MemoryScope
 * @property {MemoryScopeKind} kind
 * @property {string} [workspace]
 * @property {string} [subpath]
 */

/**
 * A write proposal — the diff a confirmation prompt renders before a doc
 * is persisted (see buildWriteProposal). The scope here is normalized.
 * @typedef {Object} WriteProposal
 * @property {string} id
 * @property {{ kind: MemoryScopeKind, workspace: string, subpath: string }} scope
 * @property {'create'|'update'|'delete'|'noop'} op
 * @property {string} header
 * @property {string} body
 * @property {string} prevBody
 * @property {number} addedLines
 * @property {number} removedLines
 * @property {boolean} requiresConfirmation
 */

/**
 * A stored memory document. One AGENTS.md per scope id.
 *
 * @typedef {Object} MemoryDoc
 * @property {string} id            scope id — see scopeId()
 * @property {MemoryScopeKind} kind
 * @property {string} workspace     workspace key ('' for the user scope)
 * @property {string} [subpath]     subtree path (subtree scope only)
 * @property {string} body          the AGENTS.md markdown
 * @property {number} updatedAt      epoch ms
 * @property {number} createdAt      epoch ms
 */

// why: the always-loaded context budget. CLAUDE.md mandates lean memory
// — the block stitched into every system prompt stays under ~200 lines.
// Subtree memory is deliberately excluded from the always-loaded set and
// fetched on demand, so deep per-folder notes never bloat the prompt.
export const ALWAYS_LOADED_LINE_BUDGET = 200;

// Cap a single document's body so one runaway write can't blow the
// budget or the IDB value size. ~24KB of markdown is a generous ceiling
// for hand-curated notes.
export const MAX_DOC_CHARS = 24_000;

/**
 * Canonical id for a scope. Stable + collision-free across kinds:
 *   user                 → 'user'
 *   project  + workspace → 'project:<workspace>'
 *   subtree  + ws + path → 'subtree:<workspace>:<subpath>'
 *
 * Pure. The store keys IDB rows on this; the loader dedupes on it.
 *
 * @param {MemoryScope} s
 * @returns {string}
 */
export const scopeId = (s) => {
  if (!s || typeof s.kind !== 'string') {
    throw new TypeError('scopeId: kind is required');
  }
  if (s.kind === 'user') return 'user';
  const ws = normalizeWorkspace(s.workspace);
  if (!ws) throw new TypeError(`scopeId: ${s.kind} scope needs a workspace`);
  if (s.kind === 'project') return `project:${ws}`;
  if (s.kind === 'subtree') {
    const sub = normalizeSubpath(s.subpath);
    if (!sub) throw new TypeError('scopeId: subtree scope needs a subpath');
    return `subtree:${ws}:${sub}`;
  }
  throw new TypeError(`scopeId: unknown kind '${s.kind}'`);
};

/**
 * Normalize a workspace key. A workspace is a browsing context, so we
 * accept an origin ('https://github.com'), a vm/app/js id
 * ('vm:abc123'), or a plain label. We lower-case the host of an origin
 * (origins are case-insensitive in their host) but leave opaque ids
 * untouched. Returns '' for falsy input.
 *
 * @param {string | undefined} ws
 * @returns {string}
 */
export const normalizeWorkspace = (ws) => {
  if (typeof ws !== 'string') return '';
  const trimmed = ws.trim();
  if (!trimmed) return '';
  // why: only real web origins (have a host) get host-lowercased; an id
  // like 'vm:AbC' parses as a URL with protocol 'vm:' but NO host, and
  // must round-trip verbatim (it's a case-sensitive opaque id, not an
  // origin). Guard on u.host so we don't mangle ids into 'vm://'.
  try {
    const u = new URL(trimmed);
    if (u.host) return `${u.protocol}//${u.host.toLowerCase()}`;
    return trimmed;
  } catch {
    return trimmed;
  }
};

/**
 * Normalize a subtree path: trim, strip leading/trailing slashes,
 * collapse runs of slashes. '' when empty.
 *
 * @param {string | undefined} p
 * @returns {string}
 */
export const normalizeSubpath = (p) => {
  if (typeof p !== 'string') return '';
  return p.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
};

/**
 * Does subtree `sub` live under the path scope the loader was asked for?
 * A subtree doc at 'src/api' is in scope for a request targeting
 * 'src/api/handlers' (prefix on path segments). Pure.
 *
 * @param {string} docSub   normalized subpath of a stored subtree doc
 * @param {string} targetSub normalized subpath the caller is working in
 * @returns {boolean}
 */
export const subpathInScope = (docSub, targetSub) => {
  if (!docSub) return false;
  if (!targetSub) return false;
  if (docSub === targetSub) return true;
  // segment-prefix: 'src/api' covers 'src/api/x' but NOT 'src/apix'
  return targetSub.startsWith(`${docSub}/`);
};

/**
 * Count lines a body contributes. Trailing newline does not count as an
 * extra empty line. Pure.
 *
 * @param {string} body
 * @returns {number}
 */
export const countLines = (body) => {
  if (typeof body !== 'string' || body === '') return 0;
  return body.replace(/\n$/, '').split('\n').length;
};

/**
 * Validate + normalize a body for storage. Throws on over-budget so a
 * bad write fails loudly at the API boundary rather than silently
 * truncating the user's notes. Trims a trailing-whitespace-only body to
 * '' (an empty doc is a delete signal upstream).
 *
 * @param {string} body
 * @returns {string}
 */
export const normalizeBody = (body) => {
  if (typeof body !== 'string') throw new TypeError('memory body must be a string');
  const trimmed = body.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  if (trimmed.length > MAX_DOC_CHARS) {
    throw new RangeError(`memory body too large: ${trimmed.length} > ${MAX_DOC_CHARS} chars`);
  }
  return trimmed.trim() === '' ? '' : trimmed;
};

/**
 * Order the docs that make up the always-loaded context, most general
 * first (user, then project). Subtree docs are NOT always-loaded — they
 * are excluded here and fetched on demand by readSubtree(). Pure.
 *
 * @param {MemoryDoc[]} docs
 * @returns {MemoryDoc[]}
 */
export const orderAlwaysLoaded = (docs) => {
  /** @type {Record<MemoryScopeKind, number>} */
  const rank = { user: 0, project: 1, subtree: 2 };
  return docs
    .filter((d) => d && (d.kind === 'user' || d.kind === 'project') && d.body)
    .sort((a, b) => (rank[a.kind] - rank[b.kind]) || (a.id < b.id ? -1 : 1));
};

/**
 * Assemble the always-loaded memory block from ordered scope docs, under
 * the line budget. More-general scopes win the budget first (user notes
 * are nearly always relevant; a specific project's notes are next). When
 * the budget is hit we stop adding whole docs and append a truncation
 * marker so the agent KNOWS more memory exists on demand rather than
 * assuming it has seen everything. Pure.
 *
 * @param {MemoryDoc[]} docs   already-fetched user+project docs
 * @param {Object} [opts]
 * @param {number} [opts.budget=ALWAYS_LOADED_LINE_BUDGET]
 * @returns {{ text: string, includedIds: string[], truncated: boolean, lineCount: number }}
 */
export const assembleAlwaysLoaded = (docs, { budget = ALWAYS_LOADED_LINE_BUDGET } = {}) => {
  const ordered = orderAlwaysLoaded(docs);
  const sections = [];
  const includedIds = [];
  let used = 0;
  let truncated = false;

  for (const doc of ordered) {
    const header = scopeHeader(doc);
    const lines = countLines(doc.body) + 2; // +1 header, +1 blank separator
    if (used + lines > budget) { truncated = true; break; }
    sections.push(`${header}\n${doc.body.trim()}`);
    includedIds.push(doc.id);
    used += lines;
  }

  if (sections.length === 0) {
    return { text: '', includedIds: [], truncated, lineCount: 0 };
  }

  const note = truncated
    ? '\n\n(Some memory was omitted to stay within budget. Deeper or '
      + 'subtree-scoped memory loads on demand — ask to read it.)'
    : '';
  const inner = sections.join('\n\n');
  const text = `<memory>\n${inner}${note}\n</memory>`;
  return { text, includedIds, truncated, lineCount: used };
};

/**
 * Human-readable per-scope header line for the assembled block. The
 * agent uses these to attribute a note to its scope. Pure.
 *
 * @param {{kind: MemoryScopeKind, workspace?: string, subpath?: string}} doc
 * @returns {string}
 */
export const scopeHeader = (doc) => {
  if (doc.kind === 'user') return '## Memory: user (global)';
  if (doc.kind === 'project') return `## Memory: project ${doc.workspace}`;
  return `## Memory: ${doc.workspace} › ${doc.subpath}`;
};

/**
 * Build a write proposal: the diff a confirmation prompt renders before
 * anything is persisted. This is the lethal-trifecta seam — an AGENT
 * proposing a memory write produces one of these; the SW round-trips it
 * through the confirm protocol; only an explicit user yes calls
 * commitWrite(). Pure: takes the prior doc (or null) + the proposed body
 * and returns a structured, glanceable proposal.
 *
 * @param {Object} input
 * @param {MemoryScope} input.scope
 * @param {MemoryDoc | null} input.prior  existing doc at this scope, if any
 * @param {string} input.body             proposed new body ('' = delete)
 * @param {'agent' | 'user'} [input.origin='agent']
 * @returns {WriteProposal}
 */
export const buildWriteProposal = ({ scope, prior, body, origin = 'agent' }) => {
  const id = scopeId(scope);
  const next = normalizeBody(body);
  const prevBody = prior?.body ?? '';
  /** @type {'create'|'update'|'delete'|'noop'} */
  let op;
  if (next === '' && prevBody === '') op = 'noop';
  else if (next === '') op = 'delete';
  else if (prevBody === '') op = 'create';
  else if (next === prevBody) op = 'noop';
  else op = 'update';

  const { added, removed } = lineDelta(prevBody, next);
  return {
    id,
    scope: { kind: scope.kind, workspace: normalizeWorkspace(scope.workspace), subpath: normalizeSubpath(scope.subpath) },
    op,
    header: scopeHeader({ kind: scope.kind, workspace: normalizeWorkspace(scope.workspace), subpath: normalizeSubpath(scope.subpath) }),
    body: next,
    prevBody,
    addedLines: added,
    removedLines: removed,
    // why: USER-originated writes (the user typed /remember or edited the
    // doc in the UI) are already an explicit act and skip the prompt.
    // AGENT-proposed writes ALWAYS require confirmation — the whole point
    // of the lethal-trifecta defense. noop never needs a prompt.
    requiresConfirmation: origin === 'agent' && op !== 'noop',
  };
};

/**
 * Coarse line-level add/remove counts between two bodies, for the
 * proposal summary. Not a real LCS diff — a set difference on lines,
 * which is plenty for a glanceable "+12 / −3" badge. Pure.
 *
 * @param {string} prev
 * @param {string} next
 * @returns {{ added: number, removed: number }}
 */
export const lineDelta = (prev, next) => {
  const before = new Set((prev || '').split('\n'));
  const after = new Set((next || '').split('\n'));
  let added = 0; let removed = 0;
  for (const l of after) if (!before.has(l)) added++;
  for (const l of before) if (!after.has(l)) removed++;
  return { added, removed };
};

// ── Initializer-session pattern ────────────────────────────────────────
//
// Cognition's initializer/recovery idea, adapted: the FIRST session in a
// workspace writes a progress log + a feature checklist into a dedicated
// memory doc; EVERY later session reads it, works, and updates it before
// exiting. It turns memory into a running build journal the agent can
// resume from after an SW death or a fresh chat. Stored as a normal
// project-scoped doc under a reserved subpath so it never pollutes the
// curated AGENTS.md but still rides the same store + confirm path.

export const INITIALIZER_SUBPATH = '.peerd/initializer';

/**
 * The scope a workspace's initializer journal lives at. It is a SUBTREE
 * doc (reserved subpath) so it is NOT always-loaded — the agent reads it
 * explicitly at session start via readInitializer(). Pure.
 *
 * @param {string} workspace
 * @returns {{kind:'subtree', workspace:string, subpath:string}}
 */
export const initializerScope = (workspace) => ({
  kind: 'subtree',
  workspace: normalizeWorkspace(workspace),
  subpath: INITIALIZER_SUBPATH,
});

/**
 * Seed body for a brand-new initializer journal. Pure — the timestamp is
 * injected so tests are deterministic.
 *
 * @param {Object} input
 * @param {string} input.workspace
 * @param {string[]} [input.checklist]  initial feature checklist items
 * @param {string} [input.nowIso]       ISO timestamp (injected)
 * @returns {string}
 */
export const seedInitializerBody = ({ workspace, checklist = [], nowIso }) => {
  const ts = nowIso ?? new Date().toISOString();
  const items = checklist.length
    ? checklist.map((c) => `- [ ] ${c}`).join('\n')
    : '- [ ] (no features captured yet)';
  return [
    `# Initializer journal — ${normalizeWorkspace(workspace) || 'workspace'}`,
    '',
    'First-run build journal. Read this at session start; append a',
    'progress entry and update the checklist before you exit.',
    '',
    '## Feature checklist',
    items,
    '',
    '## Progress log',
    `- ${ts} — initialized.`,
  ].join('\n');
};

/**
 * Append a progress entry to an existing initializer body. Pure: returns
 * the new body, leaving the checklist section intact. If no "## Progress
 * log" section exists, one is appended. The timestamp is injected.
 *
 * @param {string} body       current initializer body
 * @param {string} entry      one-line progress note
 * @param {string} [nowIso]
 * @returns {string}
 */
export const appendProgress = (body, entry, nowIso) => {
  const ts = nowIso ?? new Date().toISOString();
  const line = `- ${ts} — ${entry.trim()}`;
  if (!/^##\s+Progress log\s*$/m.test(body)) {
    return `${body.trimEnd()}\n\n## Progress log\n${line}\n`;
  }
  // Append under the existing Progress log heading (at end of body — the
  // log is the last section by seed convention).
  return `${body.trimEnd()}\n${line}\n`;
};
