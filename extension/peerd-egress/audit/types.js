// @ts-check
// Audit event types.
//
// The list below is the canonical event-type surface; new types require
// both an entry here AND a corresponding EVENT_META label in
// options/sections/activity.js (the options Activity page).
//
// Audit entries are append-only — once written, never updated. They
// live in IndexedDB (object store `audit_log`). UUIDv7 keys give
// time-sortable cursor reads for free.

/**
 * @typedef {'egress_denied'
 *         | 'denylist_hit'
 *         | 'denylist_added'
 *         | 'denylist_removed'
 *         | 'hook_added'
 *         | 'hook_removed'
 *         | 'hook_enabled'
 *         | 'hook_disabled'
 *         | 'hooks_cleared'
 *         | 'tool_confirmed'
 *         | 'tool_rejected'
 *         | 'tool_executed'
 *         | 'tool_failed'
 *         | 'tool_blocked'
 *         | 'vault_initialized'
 *         | 'vault_unlocked'
 *         | 'vault_locked'
 *         | 'provider_added'
 *         | 'mode_changed'
 *         | 'permission_granted'
 *         | 'permission_revoked'
 *         | 'session_started'
 *         | 'session_ended'
 *         | 'turn_auto_resumed'
 *         | 'provider_failover'
 *         | 'prompt_injection_suspected'
 *         | 'dweb_identity_issued'
 *         | 'dweb_room_joined'
 *         | 'dweb_room_left'
 *         | 'dweb_app_installed'
 *         | 'dweb_seed_installed'
 *         | 'dweb_app_shared'
 *         | 'dweb_bridge_join_denied'
 *         | 'dweb_app_install_denied'
 *         | 'dweb_peer_muted_by_app'} AuditEventType
 */
// why only these dweb types are named: they are the high-signal,
// user-facing dweb (preview-only) events the Activity page labels. The
// internal mesh/gossip diagnostics (dweb_peer_connected, dweb_gossip_*,
// dweb_sync_*, …) carry the `dweb_` prefix too but fall back to a
// raw-label/info row in the Activity UI by design — noise for an
// operator, signal for a debugger reading the log directly. The
// `dweb/audit` SW route accepts any `dweb_`-prefixed type; this union is
// the curated label surface, not an allowlist.

/**
 * The accepted/stored event type. why not just AuditEventType: the union
 * above is the curated LABEL surface, not an allowlist (see the note) — the
 * `dweb/audit` route and the SW legitimately append other strings (dweb_*
 * diagnostics, spend_limit_reached, session_* …). `string & {}` keeps editor
 * autocomplete on the curated labels while accepting any runtime string, so
 * the type matches the documented "not an allowlist" contract.
 * @typedef {AuditEventType | (string & {})} AuditType
 */

/**
 * @typedef {Object} AuditEntry
 * @property {string} id                  UUIDv7 (time-sortable)
 * @property {number} when                ms since epoch
 * @property {AuditType} type
 * @property {string} [sessionId]         present for session-scoped events
 * @property {Record<string, any>} [details]
 */

/**
 * Partial entry passed to `appendAudit` — id and timestamp are filled
 * in by the log factory.
 *
 * @typedef {{ type: AuditType, sessionId?: string, details?: Record<string, any> }} AuditEntryInput
 */

// Empty export keeps this a valid ES module.
export {};
