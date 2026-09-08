// @ts-check
// observability/debug-bundle.js — the debug-bundle assembler.
//
// One session's whole debugging story in one local JSON file: the full
// transcript (root session + every child actor/actor session it
// spawned), the audit slice for those sessions, cost, the secret-free
// settings snapshot, any live context snapshots, and a provenance block
// that says honestly what may be missing (pruned audit, evicted
// snapshots). The SW route does the IO reads; THIS module is pure —
// values in, one bundle out — so the whole shape is bun-testable.
//
// why local export and not telemetry: peerd has no backend by design.
// Observability here means the user's own data leaves IndexedDB as a
// file THE USER saves, on purpose, per session — never a wire.
//
// Secrets: none reach this module by construction. API keys live only
// in the vault (settings and session records never hold them), and the
// context snapshots are shaped key-free at capture. The assembler still
// never touches a vault or kv handle — it can only emit what it is
// handed.

import { classifyFailure } from './failure-classify.js';
import { normalizeTally } from '../cost/accumulator.js';

export const DEBUG_BUNDLE_FORMAT = 'peerd-debug-bundle';
export const DEBUG_BUNDLE_VERSION = 1;

// Caps: a bundle is a debugging artifact, not an archive. The transcript
// is included whole (it IS the story), but the unbounded collections are
// clamped so a monster session still exports in one breath.
export const BUNDLE_MAX_AUDIT_ENTRIES = 2000;
export const BUNDLE_MAX_CHILD_SESSIONS = 40;

/**
 * Walk the parent links to collect every descendant session of the root
 * (actors + spawned, transitively). Pure: operates on the already-read
 * session rows, returns ids in stable creation order.
 * @param {Array<{ sessionId: string, parentSessionId?: string, createdAt?: number }>} allSessions
 * @param {string} rootId
 * @returns {string[]}
 */
export const childSessionIdsOf = (allSessions, rootId) => {
  /** @type {Map<string, string[]>} */
  const byParent = new Map();
  for (const s of allSessions) {
    if (!s.parentSessionId) continue;
    const list = byParent.get(s.parentSessionId) ?? [];
    list.push(s.sessionId);
    byParent.set(s.parentSessionId, list);
  }
  /** @type {string[]} */
  const out = [];
  const queue = [rootId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    for (const child of byParent.get(/** @type {string} */ (id)) ?? []) {
      if (seen.has(child)) continue; // why: defensive — a corrupt parent cycle must not hang the export
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
};

/**
 * Scan one session's messages for every failure and classify each: the
 * bundle's "what went wrong, where" index. Failed turns are message-level
 * `error` strings; failed tools are result blocks with is_error.
 * @param {Record<string, any>} session  a session record with messages
 */
export const collectFailures = (session) => {
  /** @type {Array<Record<string, unknown>>} */
  const failures = [];
  for (const message of session.messages ?? []) {
    if (typeof message.error === 'string' && message.error) {
      failures.push({
        sessionId: session.sessionId,
        messageId: message.id,
        when: message.when,
        scope: 'turn',
        ...classifyFailure(message.error, { stopReason: message.stopReason }),
        error: message.error,
      });
    }
    for (const result of message.toolResults ?? []) {
      if (!result.is_error) continue;
      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
      failures.push({
        sessionId: session.sessionId,
        messageId: message.id,
        toolUseId: result.tool_use_id,
        when: message.when,
        scope: 'tool',
        ...classifyFailure(content),
        error: content.slice(0, 2000),
      });
    }
  }
  return failures;
};

/**
 * Assemble the bundle. Everything is passed in; nothing is read here.
 * @param {object} input
 * @param {Record<string, any>} input.session          the full assembled root session (with messages)
 * @param {Array<Record<string, any>>} [input.childSessions]  full assembled child sessions (actors/spawned)
 * @param {Array<Record<string, any>>} [input.auditEntries]   the audit slice, already filtered to these sessions
 * @param {Record<string, any>} [input.settings]       the merged secret-free settings snapshot
 * @param {Array<Record<string, any>>} [input.contextSnapshots]  live model-request snapshots for these sessions
 * @param {string} [input.channel]
 * @param {string} [input.appVersion]
 * @param {number} input.now
 * @param {{ auditMaxEntries?: number, snapshotsPerSession?: number }} [input.limits]  the caps in force at capture, for provenance
 * @param {{ ok: boolean, checked: number, unchained: number, reason?: string } | null} [input.auditChain]
 *   the audit log's hash-chain verification result (R4), when the caller ran it
 */
export const assembleDebugBundle = ({
  session, childSessions = [], auditEntries = [], settings = {},
  contextSnapshots = [], channel, appVersion, now, limits = {}, auditChain = null,
}) => {
  const children = childSessions.slice(0, BUNDLE_MAX_CHILD_SESSIONS);
  const audit = auditEntries.slice(-BUNDLE_MAX_AUDIT_ENTRIES);
  const failures = [session, ...children].flatMap((s) => collectFailures(s));
  const cost = normalizeTally(session.cost);
  const toolCalls = [session, ...children]
    .flatMap((s) => s.messages ?? [])
    .reduce((n, msg) => n + (msg.toolUses?.length ?? 0), 0);

  return {
    format: DEBUG_BUNDLE_FORMAT,
    version: DEBUG_BUNDLE_VERSION,
    exportedAt: new Date(now).toISOString(),
    channel: channel ?? 'unknown',
    appVersion: appVersion ?? 'unknown',
    summary: {
      sessionId: session.sessionId,
      title: session.title ?? '',
      provider: session.provider,
      model: session.model,
      turns: cost.turns,
      messages: (session.messages ?? []).length,
      toolCalls,
      childSessions: children.length,
      failures: failures.length,
      cost,
    },
    session,
    childSessions: children,
    failures,
    audit,
    contextSnapshots,
    settings,
    provenance: {
      // why: honesty over implication — a reader must know what absence means.
      audit: `append-only log, retention-capped at ${limits.auditMaxEntries ?? 'default'} entries; `
        + `entries for old sessions may have been pruned. This slice is filtered to the sessions above${
         auditEntries.length > BUNDLE_MAX_AUDIT_ENTRIES ? `, then clamped to the last ${BUNDLE_MAX_AUDIT_ENTRIES}.` : '.'}`,
      contextSnapshots: `in-memory ring (last ${limits.snapshotsPerSession ?? 'N'} model calls per session), `
        + 'held for the service worker\'s lifetime only — empty after a browser restart or worker eviction, '
        + 'not an error.',
      childSessions: childSessions.length > BUNDLE_MAX_CHILD_SESSIONS
        ? `clamped: ${childSessions.length} descendants existed, first ${BUNDLE_MAX_CHILD_SESSIONS} included.`
        : 'all descendant actor/actor sessions included.',
      secrets: 'none by construction: API keys live only in the vault and are attached at fetch-header '
        + 'time; they never enter settings, session records, or captured request bodies.',
      ...(auditChain ? {
        auditChain: auditChain.ok
          ? `hash chain verified over ${auditChain.checked} entries${
             auditChain.unchained > 0 ? ` (${auditChain.unchained} pre-chain legacy entries unverifiable).` : '.'}`
          : `hash chain FAILED verification: ${auditChain.reason ?? 'inconsistent'} — the audit slice may have been altered.`,
      } : {}),
    },
    ...(auditChain ? { auditChainVerification: auditChain } : {}),
  };
};
