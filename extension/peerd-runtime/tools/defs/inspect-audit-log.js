// @ts-check
// inspect_audit_log — proves the audit trail is real.
//
// Reads recent entries from peerd's append-only audit log. Every
// security-relevant event lands here: vault state transitions, provider
// key set/delete, tool executions, gate blocks. The agent's narration
// of this output is the §02 "every action is recorded" claim,
// demonstrated as real timestamps and event types.

// why: a browser-runner (subagent, depth>0) runs DOM tools whose FAILURE
// messages can echo PAGE CONTENT — e.g. type's `no_option_matching: "<page
// label>" — available: <page labels>`. The dispatcher audits tool_failed with
// details.error = that message. inspect_audit_log is on the MAIN agent's
// surface, so returning those verbatim would let the main agent re-ingest
// untrusted page text through its own audit trail — laundering around the
// do/get/check boundary. We redact the error body on subagent records (the
// runner's internal errors are inspectable in its side-panel card); the
// metadata (tool, depth, parentage) stays.
/** @typedef {import('/peerd-egress/audit/types.js').AuditEntry} AuditEntry */

/** @param {AuditEntry} e @returns {AuditEntry} */
const redactSubagentError = (e) => {
  if (e?.details?.subagentSessionId && typeof e.details.error === 'string') {
    return { ...e, details: { ...e.details, error: '<runner tool error redacted — see the runner card in the side panel>' } };
  }
  return e;
};

/** @type {import('/shared/tool-types.js').Tool} */
export const inspectAuditLogTool = {
  name: 'inspect_audit_log',
  primitive: 'inspect',
  description: [
    'Read recent entries from peerd\'s append-only audit log. Every',
    'security event (vault unlock, tool execution, provider key set,',
    'denylist hit, etc.) lands here, with id (UUIDv7), timestamp,',
    'type, and optional details. Newest first.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'Max entries to return (default 50, max 500).',
      },
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of event types to filter to.',
      },
    },
  },
  sideEffect: 'read',
  origins: () => [],
  execute: async (args, ctx) => {
    const limit = Math.max(1, Math.min(args?.limit ?? 50, 500));
    /** @type {Set<string> | null} */
    const types = Array.isArray(args?.types) && args.types.length > 0
      ? new Set(args.types)
      : null;
    // why: ctx.idb is the opaque `Object` contract slot; narrow it to the
    // getAll seam this tool uses.
    const idb = /** @type {{ getAll: (store: string) => Promise<AuditEntry[]> }} */ (ctx.idb);
    const all = await idb.getAll('audit_log');
    const filtered = types ? all.filter((e) => types.has(e.type)) : all;
    const sorted = filtered.sort((a, b) => b.when - a.when).slice(0, limit);
    return {
      ok: true,
      content: JSON.stringify({
        returned: sorted.length,
        totalInStore: all.length,
        entries: sorted.map(redactSubagentError),
      }, null, 2),
    };
  },
};
