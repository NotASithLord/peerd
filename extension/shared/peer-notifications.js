// @ts-check
// shared/peer-notifications.js — the client-side peerd notifications feed.
//
// The offscreen dweb base host broadcasts a runtime `dweb/notify` message when a
// genuinely-new peer connects or a new app shows up to install (offscreen/
// dweb-base.js). This singleton collects them into a bounded, dismissible feed
// the UI reads: the home rail bell (count + dropdown) and an in-chat banner.
// Pure client + harmless on the store build (DWEB_ENABLED false → the offscreen
// never emits, so the feed stays empty).

import browser from '/vendor/browser-polyfill.js';

/**
 * A feed entry. `id`/`ts` are stamped by the offscreen emitter
 * (offscreen/dweb-base.js); the rest ride the broadcast notification.
 * `seen` is the feed's own dismissal/read bit.
 * @typedef {{
 *   id: string,
 *   ts: number,
 *   kind: string,
 *   title: string,
 *   body: string,
 *   link: string,
 *   seen: boolean,
 * }} PeerNotification
 */

const MAX = 30;
/** @type {PeerNotification[]} */
let items = [];
/** @type {Set<() => void>} */
const subs = new Set();
const fire = () => { for (const cb of subs) { try { cb(); } catch { /* listener error */ } } };

browser.runtime?.onMessage?.addListener((/** @type {unknown} */ raw) => {
  const msg = /** @type {{ type?: unknown, notification?: Omit<PeerNotification, 'seen'> } | null} */ (raw);
  if (msg?.type !== 'dweb/notify' || !msg.notification) return;
  // why dedup by (kind+link target body): a flapping peer / re-announced app
  // shouldn't stack identical rows. Newest first; cap the feed.
  const n = { seen: false, ...msg.notification };
  items = [n, ...items.filter((i) => !(i.kind === n.kind && i.body === n.body))].slice(0, MAX);
  fire();
});

export const peerNotifications = {
  list: () => items,
  unseen: () => items.reduce((c, i) => c + (i.seen ? 0 : 1), 0),
  /** @param {() => void} cb */
  subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
  markAllSeen: () => { if (items.some((i) => !i.seen)) { items = items.map((i) => ({ ...i, seen: true })); fire(); } },
  /** @param {string} id */
  dismiss: (id) => { items = items.filter((i) => i.id !== id); fire(); },
  clear: () => { if (items.length) { items = []; fire(); } },
};
