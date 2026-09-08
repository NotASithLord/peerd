// @ts-check
// Bounded wire shape and in-memory ring for the context inspector. The sealed
// controller shapes before its advisory observation crosses into the authority
// kernel; the recorder shapes again so a compromised semantic heap cannot
// widen the support surface. The ring remains SW-owned through construction.

export const SNAPSHOTS_PER_SESSION = 10;
export const SNAPSHOT_MAX_SESSIONS = 24;
export const SNAPSHOT_SYSTEM_CHARS = 6000;
export const SNAPSHOT_CONTENT_CHARS = 1500;
export const SNAPSHOT_MAX_MESSAGES = 60;

const STRIPPED = '<binary payload stripped for the snapshot>';

export const mainModelContextLabel = (
  /** @type {{provider:string,model:string}} */ requested,
  /** @type {{provider:string,model:string}} */ candidate,
) => candidate.provider === requested.provider && candidate.model === requested.model
  ? 'main' : 'main:failover';

/** @param {unknown} value @param {number} maxChars */
const clip = (value, maxChars) => {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value ?? '') ?? ''; }
  catch { text = '<unserializable value omitted from the snapshot>'; }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
};

/**
 * Shape one pre-wire model request into a bounded, binary-free snapshot.
 * Idempotence is intentional: both ends of the observation edge apply it.
 * @param {Record<string, any>} args
 */
export const shapeModelCall = (args = {}) => {
  const messages = Array.isArray(args.messages) ? args.messages : [];
  const kept = messages.slice(-SNAPSHOT_MAX_MESSAGES);
  const capList = (/** @type {unknown} */ value, /** @type {number} */ count) =>
    (Array.isArray(value) ? value.slice(0, count) : []);
  const system = clip(args.system ?? '', SNAPSHOT_SYSTEM_CHARS);
  const observedSystemChars = Number(args.systemChars);
  return {
    provider: clip(args.provider ?? '', 200),
    model: clip(args.model ?? '', 200),
    system,
    systemChars: Number.isSafeInteger(observedSystemChars) && observedSystemChars >= system.length
      ? observedSystemChars : typeof args.system === 'string' ? args.system.length : 0,
    reasoning: args.reasoning == null ? null : clip(args.reasoning, 400),
    tools: capList(args.tools, 50).map((tool) => clip(
      typeof tool === 'string' ? tool : tool?.name ?? '?', 120,
    )),
    droppedMessages: Number.isSafeInteger(args.droppedMessages) && args.droppedMessages >= 0
      ? args.droppedMessages + Math.max(0, messages.length - kept.length)
      : messages.length - kept.length,
    messages: kept.map((message) => ({
      role: clip(message?.role ?? '?', 40),
      content: clip(message?.content ?? '', SNAPSHOT_CONTENT_CHARS),
      ...(message?.toolUses?.length ? {
        toolUses: capList(message.toolUses, 50).map((/** @type {Record<string, any>} */ use) => ({
          name: clip(use?.name ?? '?', 120), input: clip(use?.input, 400),
        })),
      } : {}),
      ...(message?.toolResults?.length ? {
        toolResults: capList(message.toolResults, 50).map((/** @type {Record<string, any>} */ result) => ({
          tool_use_id: clip(result?.tool_use_id ?? '', 120),
          is_error: result?.is_error === true,
          content: clip(result?.content ?? '', SNAPSHOT_CONTENT_CHARS),
          ...(result?.images?.length ? { images: STRIPPED } : {}),
        })),
      } : {}),
      ...(message?.attachments?.length ? {
        attachments: capList(message.attachments, 20).map((/** @type {Record<string, any>} */ attachment) => ({
          name: clip(attachment?.name ?? '', 200),
          mediaType: clip(attachment?.mediaType ?? '', 100),
          size: Number.isFinite(attachment?.size) ? attachment.size : 0,
          ...(attachment?.data ? { data: STRIPPED } : {}),
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
    while (bySession.size > maxSessions) {
      let oldestKey = null;
      let oldestTouched = Infinity;
      for (const [key, entry] of bySession) {
        if (entry.touched < oldestTouched) {
          oldestTouched = entry.touched;
          oldestKey = key;
        }
      }
      if (oldestKey == null) return;
      bySession.delete(oldestKey);
    }
  };

  return {
    /**
     * Record one model call. Never throws: capture cannot break a turn.
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
    snapshotsFor: (/** @type {string} */ sessionId) => [
      ...(bySession.get(sessionId)?.snaps ?? []),
    ],
    snapshotsForMany: (/** @type {string[]} */ sessionIds) => sessionIds
      .flatMap((id) => bySession.get(id)?.snaps ?? [])
      .sort((left, right) => left.seq - right.seq)
      .map((snapshot) => ({ ...snapshot })),
    limits: () => ({ snapshotsPerSession: capPerSession, maxSessions }),
    _size: () => bySession.size,
  };
};
