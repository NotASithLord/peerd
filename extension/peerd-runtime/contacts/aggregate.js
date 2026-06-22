// @ts-check
// Contacts — the pure read-time aggregation.
//
// "Known peers" is a UNION over everything durable that mentions a did: the
// saved overlay (store.js), the App catalog (apps installed FROM a peer carry
// their publisher did), and the audit log (install/update events tied to a
// publisher). For each did we fold a small activity summary — what they've
// shared with us and when we last interacted. No network call: this is all
// local, durable state, so it works the same whether the mesh is up or not
// (the UI layers LIVE presence — linked/lastSeen — on top separately).
//
// Pure: inputs in, rows out. The SW feeds it (savedContacts, installedApps,
// auditEntries); tests feed plain arrays.

import { peerDidFromUri } from './contact.js';

// Audit event types that represent an interaction WITH a specific peer (the
// publisher whose app we installed/updated). Shares (dweb_app_shared) are OUR
// outbound action, not tied to one peer, so they're excluded here.
const INSTALL_TYPES = new Set(['dweb_app_installed', 'dweb_seed_installed']);
const UPDATE_TYPES = new Set(['dweb_app_updated']);

/**
 * An audit-log row, as fed by the SW. `details` is the per-event-type
 * payload — schemaless here, read defensively.
 * @typedef {{ when: number, type: string, details?: any }} AuditEntry
 */

// The did an audit entry is about, if any: an explicit publisher wins, else the
// peer parsed out of a peerd:// content uri.
/** @param {AuditEntry} entry @returns {string | null} */
const auditDid = (entry) => {
  const d = entry?.details;
  if (!d) return null;
  if (typeof d.publisher === 'string' && d.publisher.startsWith('did:key:')) return d.publisher;
  return peerDidFromUri(d.uri);
};

/**
 * @typedef {{
 *   appsInstalled: Array<{ appId: string, name: string|null, versionId: string|null, slug: string|null }>,
 *   appCount: number,
 *   installCount: number,
 *   updateCount: number,
 *   eventCount: number,
 *   firstEventAt: number|null,
 *   lastEventAt: number|null,
 * }} ContactActivity
 */

/**
 * @typedef {{
 *   did: string,
 *   name: string|null,
 *   notes: string,
 *   tags: string[],
 *   favorite: boolean,
 *   saved: boolean,
 *   createdAt: number|null,
 *   updatedAt: number|null,
 *   activity: ContactActivity,
 * }} ContactRow
 */

/**
 * Fold durable state into per-peer contact rows.
 *
 * @param {{
 *   saved?: import('./contact.js').ContactRecord[],
 *   installedApps?: Array<{ id: string, name?: string, dweb?: any }>,
 *   auditEntries?: AuditEntry[],
 * }} [input]
 * @returns {ContactRow[]} contact rows, sorted favorite → most-recent → named → did
 */
export const mergeContacts = ({ saved = [], installedApps = [], auditEntries = [] } = {}) => {
  /** @type {Map<string, ContactRow>} */
  const rows = new Map();

  /** @param {string} did @returns {ContactRow} */
  const ensure = (did) => {
    let r = rows.get(did);
    if (!r) {
      /** @type {ContactRow} */
      const fresh = {
        did,
        name: null, notes: '', tags: [], favorite: false,
        saved: false, createdAt: null, updatedAt: null,
        activity: {
          appsInstalled: [], appCount: 0,
          installCount: 0, updateCount: 0, eventCount: 0,
          firstEventAt: null, lastEventAt: null,
        },
      };
      r = fresh;
      rows.set(did, r);
    }
    return r;
  };

  // 1. The saved overlay — the user's name/notes/tags for the peer.
  for (const c of saved) {
    if (!c?.did) continue;
    const r = ensure(c.did);
    r.name = c.name ?? null;
    r.notes = c.notes ?? '';
    r.tags = Array.isArray(c.tags) ? c.tags : [];
    r.favorite = !!c.favorite;
    r.saved = true;
    r.createdAt = c.createdAt ?? null;
    r.updatedAt = c.updatedAt ?? null;
  }

  // 2. Apps we've installed from a peer (durable in the catalog, names + all).
  for (const app of installedApps) {
    const pub = app?.dweb?.publisher;
    if (typeof pub !== 'string' || !pub.startsWith('did:key:')) continue;
    const r = ensure(pub);
    r.activity.appsInstalled.push({
      appId: app.id,
      name: app.name ?? null,
      versionId: app.dweb.version_id ?? app.dweb.hash ?? null,
      slug: app.dweb.slug ?? null,
    });
    r.activity.appCount += 1;
  }

  // 3. The audit timeline — counts + first/last interaction per peer.
  for (const entry of auditEntries) {
    const did = auditDid(entry);
    if (!did) continue;
    const r = ensure(did);
    const a = r.activity;
    a.eventCount += 1;
    if (INSTALL_TYPES.has(entry.type)) a.installCount += 1;
    else if (UPDATE_TYPES.has(entry.type)) a.updateCount += 1;
    const when = typeof entry.when === 'number' ? entry.when : null;
    if (when != null) {
      if (a.firstEventAt == null || when < a.firstEventAt) a.firstEventAt = when;
      if (a.lastEventAt == null || when > a.lastEventAt) a.lastEventAt = when;
    }
  }

  // Sort: favorites first, then most-recent interaction (or save), then named,
  // then by did for a stable tail.
  /** @param {ContactRow} r */
  const recency = (r) => Math.max(r.activity.lastEventAt ?? 0, r.updatedAt ?? 0);
  return [...rows.values()].sort((a, b) =>
    (Number(b.favorite) - Number(a.favorite))
    || (recency(b) - recency(a))
    || (Number(!!b.name) - Number(!!a.name))
    || a.did.localeCompare(b.did));
};
