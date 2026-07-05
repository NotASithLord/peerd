// @ts-check
// background/context-snapshots.js — the context inspector's capture ring.
//
// "What did the model actually see?" — per model call, a SHAPED snapshot
// of the request args (system, messages, tools, params) is recorded into
// a per-session capped ring. Two SW seams feed it and together cover
// every model call peerd makes: the turn driver's failover wrapper (the
// orchestrator) and the 'actor/model-call' relay route (every actor and
// subagent heap). Held in SW memory only — the same lifetime posture as
// the script-runs op mirror — so it answers "what just happened", not
// "what happened last week"; the debug bundle exports whatever is live
// and its provenance says exactly that.
//
// Secrets: none can appear. The captured args are the PRE-WIRE callModel
// args; API keys attach at fetch-header time inside the adapter and are
// never part of the args struct. Size is the real risk (a vision turn
// carries megabytes of base64), so shaping clips every string and drops
// binary payloads with a visible sentinel — the "keep metadata, drop
// bytes" posture the transcript's own redaction already uses.
//
// Pure factory (values + injected clock) — bun-tested without a browser.

export const SNAPSHOTS_PER_SESSION = 10;
export const SNAPSHOT_MAX_SESSIONS = 24;
export const SNAPSHOT_SYSTEM_CHARS = 6000;
export const SNAPSHOT_CONTENT_CHARS = 1500;
export const SNAPSHOT_MAX_MESSAGES = 60;

const STRIPPED = '<binary payload stripped for the snapshot>';

/** @param {unknown} s @param {number} n */
const clip = (s, n) => {
  const str = typeof s === 'string' ? s : JSON.stringify(s ?? '') ?? '';
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
};

/**
 * Shape one callModel args struct into a bounded, binary-free snapshot.
 * Pure and defensive: unknown shapes degrade to clipped JSON, never throw.
 * @param {Record<string, any>} args  pre-wire callModel args
 */
export const shapeModelCall = (args = {}) => {
  const messages = Array.isArray(args.messages) ? args.messages : [];
  const kept = messages.slice(-SNAPSHOT_MAX_MESSAGES);
  return {
    provider: args.provider ?? '',
    model: args.model ?? '',
    system: clip(args.system ?? '', SNAPSHOT_SYSTEM_CHARS),
    systemChars: typeof args.system === 'string' ? args.system.length : 0,
    reasoning: args.reasoning ?? null,
    tools: (Array.isArray(args.tools) ? args.tools : []).map((t) => t?.name ?? '?'),
    droppedMessages: messages.length - kept.length,
    messages: kept.map((m) => ({
      role: m?.role ?? '?',
      content: clip(m?.content ?? '', SNAPSHOT_CONTENT_CHARS),
      ...(m?.toolUses?.length ? {
        toolUses: m.toolUses.map((/** @type {Record<string, any>} */ u) => ({
          name: u?.name ?? '?', input: clip(u?.input, 400),
        })),
      } : {}),
      ...(m?.toolResults?.length ? {
        toolResults: m.toolResults.map((/** @type {Record<string, any>} */ r) => ({
          tool_use_id: r?.tool_use_id, is_error: r?.is_error === true,
          content: clip(r?.content ?? '', SNAPSHOT_CONTENT_CHARS),
          ...(r?.images?.length ? { images: STRIPPED } : {}),
        })),
      } : {}),
      ...(m?.attachments?.length ? {
        attachments: m.attachments.map((/** @type {Record<string, any>} */ a) => ({
          name: a?.name, mediaType: a?.mediaType, size: a?.size,
          ...(a?.data ? { data: STRIPPED } : {}),
        })),
      } : {}),
    })),
  };
};

/**
 * @param {{ capPerSession?: number, maxSessions?: number, now?: () => number }} [opts]
 */
export const createContextSnapshots = ({
  capPerSession = SNAPSHOTS_PER_SESSION,
  maxSessions = SNAPSHOT_MAX_SESSIONS,
  now = Date.now,
} = {}) => {
  /** @type {Map<string, { touched: number, snaps: Array<Record<string, any>> }>} */
  const bySession = new Map();
  let seq = 0;

  const evictIfNeeded = () => {
    // why size-then-evict (not LRU bookkeeping per read): the SW is
    // long-lived and sessions are few; a linear oldest-touched sweep on
    // WRITE keeps the map bounded with zero read-path cost.
    while (bySession.size > maxSessions) {
      let oldestKey = null, oldestTouched = Infinity;
      for (const [key, entry] of bySession) {
        if (entry.touched < oldestTouched) { oldestTouched = entry.touched; oldestKey = key; }
      }
      if (oldestKey == null) return;
      bySession.delete(oldestKey);
    }
  };

  return {
    /**
     * Record one model call. Never throws — capture must not be able to
     * break a turn.
     * @param {{ sessionId?: string, label?: string } & Record<string, any>} call
     */
    record: (call = {}) => {
      try {
        const sessionId = call.sessionId;
        if (!sessionId) return;
        const entry = bySession.get(sessionId) ?? { touched: 0, snaps: [] };
        entry.touched = now();
        if (entry.snaps.length >= capPerSession) entry.snaps.shift();
        entry.snaps.push({
          seq: ++seq,
          when: now(),
          sessionId,
          label: call.label ?? 'main',
          ...shapeModelCall(call),
        });
        bySession.set(sessionId, entry);
        evictIfNeeded();
      } catch { /* capture is best-effort by contract */ }
    },

    /** The live snapshots for one session (copy), oldest first. @param {string} sessionId */
    snapshotsFor: (sessionId) => [...(bySession.get(sessionId)?.snaps ?? [])],

    /** The live snapshots for a session set (root + children), oldest first. @param {string[]} sessionIds */
    snapshotsForMany: (sessionIds) => sessionIds
      .flatMap((id) => bySession.get(id)?.snaps ?? [])
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({ ...s })),

    /** The caps in force — the bundle's provenance block reports them. */
    limits: () => ({ snapshotsPerSession: capPerSession, maxSessions }),

    _size: () => bySession.size,
  };
};
