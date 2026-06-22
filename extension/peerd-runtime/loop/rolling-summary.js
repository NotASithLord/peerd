// @ts-check
// Rolling trim-summary state — the functional core of long-session
// context compression.
//
// trimHistory (trim.js) collapses the oldest messages into ONE
// synthesised summary message when a session outgrows the soft cap.
// This module owns the STATE behind that message so the summary can be
// ROLLING: each trim incorporates the prior summary (not just the
// newly-dropped turns), the state persists on the session record
// (`session.trimSummary`) so an SW restart doesn't lose it, and an
// optional cheap model call can enrich it with structured
// facts/decisions/open-threads instead of prose-soup.
//
// Everything here is pure — values in, values out. The imperative
// pieces live elsewhere: trim.js folds the state at plan time inside
// the agent loop (synchronous, mechanical, can never fail the turn),
// and summary-enrichment.js runs the model call AFTER the turn and
// merges the result for future turns.
//
// why two layers: the mechanical fold (counts, tool stats) is the
// always-available fallback — deterministic, instant, no spend. The
// model enrichment is quality-only and strictly optional; when the call
// fails, parses badly, or the spend limit is reached, the summary the
// model sees is simply the mechanical one. The loop NEVER blocks on
// enrichment.

import { extractInstanceHandle, renderHandleLine } from './instance-handle.js';

/** @typedef {import('../../peerd-provider/types.js').InternalMessage} InternalMessage */

/**
 * @typedef {Object} TrimSummaryState
 * @property {1} v                   schema version
 * @property {number} covered        messages[0..covered) are folded in
 * @property {string} coveredLastId  id of messages[covered-1] (drift anchor)
 * @property {number} users          plain user messages folded
 * @property {number} assistants     assistant replies folded
 * @property {number} toolResults    tool results folded
 * @property {number} errors         errored tool results folded
 * @property {Record<string, number>} tools  tool name → call count
 * @property {string} task           first user message, verbatim (the task; set once, never lost)
 * @property {string} goal           model-enriched objective (refines `task`)
 * @property {string[]} facts        model-enriched durable facts
 * @property {string[]} decisions    model-enriched decisions taken
 * @property {string[]} threads     model-enriched open threads
 * @property {string[]} artifacts    model-enriched durable references: open tabs, file paths, key URLs
 * @property {string[]} handles      MECHANICALLY-harvested engine-instance handles (App/Notebook/WebVM ids), append-only — never lost to the optional model layer
 * @property {number} lastWhen       `when` of the newest folded message
 */

// Caps keep the synthesised message a thumbnail, not a second
// transcript: a handful of telegraphic items per section, each one
// line, and a hard ceiling on the rendered block.
export const SUMMARY_MAX_ITEMS = 10;
export const SUMMARY_ITEM_MAX_CHARS = 200;
export const SUMMARY_MAX_CHARS = 4000;

/**
 * A zeroed state. Fresh object each call — never share a mutable default.
 * @returns {TrimSummaryState}
 */
export const emptySummaryState = () => ({
  v: 1,
  covered: 0,
  coveredLastId: '',
  users: 0,
  assistants: 0,
  toolResults: 0,
  errors: 0,
  tools: {},
  task: '',
  goal: '',
  facts: [],
  decisions: [],
  threads: [],
  artifacts: [],
  handles: [],
  lastWhen: 0,
});

// Collapse whitespace, trim, cap length — used for both list items and the
// single durable lines (task / goal).
/** @param {unknown} s */
const cleanItem = (s) =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_ITEM_MAX_CHARS) : '';

/** @param {unknown} list */
const cleanList = (list) => {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const item = cleanItem(raw);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= SUMMARY_MAX_ITEMS) break;
  }
  return out;
};

/**
 * Coerce an arbitrary stored value into a valid state. Sessions written
 * before this feature have none; a corrupt write must not poison the
 * trim path. Pure; returns a fresh object.
 *
 * @param {Partial<TrimSummaryState> | null | undefined} s
 * @returns {TrimSummaryState}
 */
export const normalizeSummaryState = (s) => {
  const base = emptySummaryState();
  if (!s || typeof s !== 'object') return base;
  /** @type {Array<'covered'|'users'|'assistants'|'toolResults'|'errors'|'lastWhen'>} */
  const numericKeys = ['covered', 'users', 'assistants', 'toolResults', 'errors', 'lastWhen'];
  for (const k of numericKeys) {
    const v = s[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) base[k] = v;
  }
  if (typeof s.coveredLastId === 'string') base.coveredLastId = s.coveredLastId;
  if (s.tools && typeof s.tools === 'object') {
    for (const [name, n] of Object.entries(s.tools)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) base.tools[name] = n;
    }
  }
  base.task = cleanItem(s.task);
  base.goal = cleanItem(s.goal);
  base.facts = cleanList(s.facts);
  base.decisions = cleanList(s.decisions);
  base.threads = cleanList(s.threads);
  base.artifacts = cleanList(s.artifacts);
  base.handles = cleanList(s.handles);
  return base;
};

/**
 * Mechanically fold newly-dropped messages into the rolling state.
 * Counting rules are identical to the original one-shot summariser so
 * the stateless render stays byte-compatible with the pinned tests: a
 * user message COUNTS as a tool-result carrier only via the persisted
 * `toolResults` array shape (agent-loop.js resultMessage); anything
 * else with role 'user' counts as a real user message.
 *
 * Pure — returns a NEW state; inputs are not mutated.
 *
 * @param {TrimSummaryState} state
 * @param {readonly InternalMessage[]} dropped
 * @returns {TrimSummaryState}
 */
export const foldDropped = (state, dropped) => {
  const next = normalizeSummaryState(state);
  for (const m of dropped) {
    if (!m) continue;
    if (m.role === 'user') {
      if (Array.isArray(m.toolResults) && m.toolResults.length > 0) {
        next.toolResults += m.toolResults.length;
        for (const tr of m.toolResults) {
          if (tr.is_error) next.errors++;
          // why mechanical handle harvest: a created App/Notebook/WebVM's id
          // is a durable capability — the agent can reopen the tab or pull it
          // from the engine registry by id. When this message is elided the
          // spine (if compacted) carries the id only into the COMPACT path;
          // once trim drops the message entirely, this is the ONLY carrier
          // left. It must be deterministic, not dependent on the optional
          // model enrichment (which never even sees the body — digestMessages
          // strips it). Append-only, deduped, capped (cleanList).
          const primitive = tr.meta?.primitive;
          const handle = !tr.is_error && extractInstanceHandle(primitive, tr.content);
          // why: a non-null handle implies extractInstanceHandle accepted
          // `primitive` as an engine string, so this guard never fails at
          // runtime — it just lets the type narrow from `primitive | undefined`.
          if (handle && typeof primitive === 'string') {
            next.handles.push(renderHandleLine(primitive, handle));
          }
        }
        next.handles = cleanList(next.handles);
      } else {
        next.users++;
        // why: pin the FIRST real user message verbatim — it's the task,
        // the highest-signal context, and the one thing that must survive
        // even when the model enrichment is skipped or fails. Set once;
        // later user turns never overwrite it (the model's `goal` refines
        // it instead). Synthetic trim summaries don't qualify.
        if (!next.task && !m.synthetic && typeof m.content === 'string' && m.content.trim()) {
          next.task = cleanItem(m.content);
        }
      }
    } else if (m.role === 'assistant') {
      next.assistants++;
      if (Array.isArray(m.toolUses)) {
        for (const tu of m.toolUses) {
          next.tools[tu.name] = (next.tools[tu.name] ?? 0) + 1;
        }
      }
    }
    if (typeof m.when === 'number' && Number.isFinite(m.when)) next.lastWhen = m.when;
  }
  next.covered = state.covered + dropped.length;
  const last = dropped[dropped.length - 1];
  if (last && typeof last.id === 'string') next.coveredLastId = last.id;
  return next;
};

/**
 * Merge a model-enrichment result into the state. The model REPLACES
 * the structured sections rather than appending — each enrichment call
 * sees the prior summary plus the newly-dropped turns and re-emits the
 * still-relevant set, which is how stale threads age out instead of
 * accumulating forever. List caps apply.
 *
 * @param {TrimSummaryState} state
 * @param {{ goal?: string, facts?: string[], decisions?: string[], threads?: string[], artifacts?: string[] }} parsed
 * @returns {TrimSummaryState}
 */
export const mergeEnrichment = (state, parsed) => {
  const next = normalizeSummaryState(state);
  if (!parsed || typeof parsed !== 'object') return next;
  // goal refines the deterministic task; only overwrite when the model
  // actually returned one (absent key → keep the prior goal/task floor).
  if (typeof parsed.goal === 'string' && parsed.goal.trim()) next.goal = cleanItem(parsed.goal);
  if (Array.isArray(parsed.facts)) next.facts = cleanList(parsed.facts);
  if (Array.isArray(parsed.decisions)) next.decisions = cleanList(parsed.decisions);
  if (Array.isArray(parsed.threads)) next.threads = cleanList(parsed.threads);
  if (Array.isArray(parsed.artifacts)) next.artifacts = cleanList(parsed.artifacts);
  return next;
};

/**
 * Render the rolling state as the synthesised summary message body.
 * Always includes the mechanical counts; the structured sections render
 * only when the enrichment has populated them. Capped at
 * SUMMARY_MAX_CHARS — over-budget renders drop structured items from
 * the tail (threads first, then decisions, then facts) until it fits,
 * because the counts are load-bearing for the model's sense of elision
 * and the lists are advisory.
 *
 * @param {TrimSummaryState} state
 * @returns {string}
 */
export const renderSummaryText = (state) => {
  const s = normalizeSummaryState(state);
  // The single durable objective line: the model's refined goal when it
  // has one, the verbatim first user message otherwise — so the task is
  // never lost even with zero enrichment.
  const goalLine = s.goal || s.task;
  /**
   * @param {string[]} facts
   * @param {string[]} decisions
   * @param {string[]} threads
   * @param {string[]} artifacts
   */
  const render = (facts, decisions, threads, artifacts) => {
    const toolList = Object.entries(s.tools)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n === 1 ? name : `${name}×${n}`))
      .join(', ');
    /**
     * @param {string} title
     * @param {string[]} items
     */
    const section = (title, items) =>
      items.length > 0 ? [`${title}:`, ...items.map((i) => `  - ${i}`)] : [];
    // The mechanical handles lead the section (deterministic, durable) ahead
    // of the model's prose artifacts; dedup so a handle the model also
    // happened to list isn't doubled.
    const handleLines = cleanList([...s.handles, ...artifacts]);
    const parts = [
      `<conversation_trim_summary>`,
      goalLine ? `Goal: ${goalLine}` : '',
      `${s.covered} earlier messages elided to keep the context budget`
        + ` under control:`,
      `  • ${s.users} user message${s.users === 1 ? '' : 's'}`,
      `  • ${s.assistants} assistant reply${s.assistants === 1 ? '' : 'ies'}`,
      `  • ${s.toolResults} tool result${s.toolResults === 1 ? '' : 's'}${s.errors > 0 ? ` (${s.errors} errored)` : ''}`,
      toolList ? `  • tools used: ${toolList}` : '',
      ...section('Facts', facts),
      ...section('Decisions', decisions),
      ...section('Open threads', threads),
      ...section('Artifacts / handles', handleLines),
      `Newer messages below carry the live context.`,
      `</conversation_trim_summary>`,
    ];
    return parts.filter(Boolean).join('\n');
  };
  let { facts, decisions, threads, artifacts } = s;
  let text = render(facts, decisions, threads, artifacts);
  // Over budget: drop structured items from the least to the most
  // load-bearing — threads, then decisions, then facts, and the model's
  // prose artifacts LAST. The mechanical `handles` are NEVER dropped here (a
  // stranded handle is a broken capability, not just lost prose) — they're
  // bounded by their own cap (SUMMARY_MAX_ITEMS) and lead the section. The
  // counts and the Goal line always survive too.
  while (text.length > SUMMARY_MAX_CHARS
      && (facts.length > 0 || decisions.length > 0 || threads.length > 0 || artifacts.length > 0)) {
    if (threads.length > 0) threads = threads.slice(0, -1);
    else if (decisions.length > 0) decisions = decisions.slice(0, -1);
    else if (facts.length > 0) facts = facts.slice(0, -1);
    else artifacts = artifacts.slice(0, -1);
    text = render(facts, decisions, threads, artifacts);
  }
  return text;
};

/**
 * Render dropped messages as a plain-text digest for the enrichment
 * model call. Text turns carry (truncated) content; tool rounds carry
 * names + result sizes only — page-derived bulk must not ride into the
 * summariser's context, that's the whole point of trimming.
 *
 * Defensive about the message shape: it only reads role/content/
 * toolResults/toolUses, so it accepts anything message-ish (the trim
 * path hands it raw dropped turns, not a strict InternalMessage[]).
 *
 * @typedef {{ role?: string, content?: unknown,
 *   toolResults?: Array<{ is_error?: boolean }>,
 *   toolUses?: Array<{ name?: string }> }} DigestMessage
 *
 * @param {ReadonlyArray<DigestMessage | null | undefined>} dropped
 * @param {Object} [opts]
 * @param {number} [opts.maxChars=6000]      total digest budget
 * @param {number} [opts.perMessageChars=280]
 * @returns {string}
 */
export const digestMessages = (dropped, { maxChars = 6000, perMessageChars = 280 } = {}) => {
  const lines = [];
  for (const m of dropped ?? []) {
    if (!m) continue;
    if (m.role === 'user') {
      if (Array.isArray(m.toolResults) && m.toolResults.length > 0) {
        const errs = m.toolResults.filter((tr) => tr.is_error).length;
        const erroredNote = errs ? `, ${errs} errored` : '';
        lines.push(`[${m.toolResults.length} tool result${m.toolResults.length === 1 ? '' : 's'}${erroredNote}]`);
      } else if (typeof m.content === 'string' && m.content.trim()) {
        lines.push(`User: ${m.content.replace(/\s+/g, ' ').trim().slice(0, perMessageChars)}`);
      }
    } else if (m.role === 'assistant') {
      const bits = [];
      if (typeof m.content === 'string' && m.content.trim()) {
        bits.push(m.content.replace(/\s+/g, ' ').trim().slice(0, perMessageChars));
      }
      if (Array.isArray(m.toolUses) && m.toolUses.length > 0) {
        bits.push(`[tools: ${m.toolUses.map((tu) => tu.name).join(', ')}]`);
      }
      if (bits.length > 0) lines.push(`Assistant: ${bits.join(' ')}`);
    }
  }
  let text = lines.join('\n');
  if (text.length > maxChars) {
    // why head+tail: the opening turns carry the task framing and the
    // closing turns carry where things stand — the middle is the most
    // compressible part of any long transcript.
    const head = text.slice(0, Math.floor(maxChars * 0.6));
    const tail = text.slice(-Math.floor(maxChars * 0.35));
    text = `${head}\n[... elided ...]\n${tail}`;
  }
  return text;
};

/**
 * Build the narrow, clean-context task for the enrichment call. The
 * child agent gets NO tools and a small output cap (cheap-call
 * machinery); the prompt demands strict JSON so parsing stays dumb.
 *
 * @param {Object} input
 * @param {TrimSummaryState} input.state         the rolling state so far
 * @param {string} input.droppedDigest           digest of newly-dropped turns
 * @returns {string}
 */
export const buildSummarizationTask = ({ state, droppedDigest }) => {
  const s = normalizeSummaryState(state);
  const priorLines = [];
  if (s.goal || s.task) priorLines.push(`goal: ${s.goal || s.task}`);
  for (const f of s.facts) priorLines.push(`fact: ${f}`);
  for (const d of s.decisions) priorLines.push(`decision: ${d}`);
  for (const t of s.threads) priorLines.push(`open: ${t}`);
  for (const a of s.artifacts) priorLines.push(`artifact: ${a}`);
  // why: the mechanically-harvested handles are already captured durably
  // (the render carries them regardless of this call) — show them so the
  // model has the live instance inventory as context, not so it must re-emit
  // them. It need not (and should not) repeat these in its `artifacts`.
  for (const h of s.handles) priorLines.push(`handle (already kept): ${h}`);
  const prior = priorLines.length > 0
    ? ['PRIOR SUMMARY (carry forward what still matters):', ...priorLines].join('\n')
    : 'PRIOR SUMMARY: (none yet)';
  // why handoff framing (the Codex/Hermes lesson): "write a handoff for the
  // agent that resumes this task" yields markedly more useful summaries
  // than "summarise this chat" — it forces goal/state/next-steps over
  // prose recap. The task at hand is a browser+sandbox agent, so the
  // handle inventory ("artifacts") is first-class: a lost tab id or
  // sandbox handle strands the resuming agent.
  return [
    'Older turns of a long agent session are being elided to free context.',
    'Write a HANDOFF for the agent that will RESUME this task from here —',
    'enough that it can continue without re-reading the elided turns. Merge',
    'the prior summary with the newly-elided turns: keep what still matters,',
    'drop what was resolved or superseded.',
    '',
    prior,
    '',
    'NEWLY ELIDED TURNS:',
    droppedDigest || '(none)',
    '',
    'Respond with ONLY a JSON object, no prose, in this exact shape:',
    '{"goal": "...", "facts": ["..."], "decisions": ["..."],'
      + ' "threads": ["..."], "artifacts": ["..."]}',
    `Rules: telegraphic one-line items, max ${SUMMARY_MAX_ITEMS} per list,`
      + ' fewer is better. "goal" = the single overall objective in one line;',
    '"facts" = durable context the agent must retain; "decisions" = choices',
    'already made; "threads" = unresolved work still pending; "artifacts" =',
    'live handles to keep (open tab ids, sandbox/Notebook/App handles, edited',
    'file paths, key URLs). Empty lists and an empty goal are fine.',
  ].join('\n');
};

/**
 * Parse the enrichment call's output. Tolerates fenced code blocks and
 * leading/trailing prose around the JSON object; accepts `openThreads`
 * / `open_threads` as aliases for `threads`. Returns null when nothing
 * parseable is found — the caller treats that as "no enrichment", never
 * an error.
 *
 * @param {string} text
 * @returns {{ goal: string, facts: string[], decisions: string[], threads: string[], artifacts: string[] } | null}
 */
export const parseSummarizationResult = (text) => {
  if (typeof text !== 'string' || !text.trim()) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); }
  catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const threads = obj.threads ?? obj.openThreads ?? obj.open_threads;
  return {
    goal: cleanItem(obj.goal),
    facts: cleanList(obj.facts),
    decisions: cleanList(obj.decisions),
    threads: cleanList(threads),
    artifacts: cleanList(obj.artifacts ?? obj.handles),
  };
};
