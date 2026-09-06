// @ts-check
// home/contacts-section.js — Contacts: your known peers (dweb, preview-only).
//
// Every peer is just an opaque did:key until you name it. This is where you do
// that: a list of KNOWN peers — anyone you've installed an app from, interacted
// with (the audit timeline), saved, or who's on the mesh right now — each one
// nameable, with an expandable summary of your shared history (what they've
// shared with you, when you last met). The personal name (+ notes) persists
// locally, keyed by the did.
//
// Two data sources, merged client-side: `contacts/list` (the DURABLE union —
// saved overlay + App catalog + audit log, with the per-peer activity summary)
// and `dweb/distributed/info` (the LIVE mesh — who's connected, by what path,
// last seen). A pure CLIENT: it never imports the dweb module (the boundary),
// so the brand palette is inlined, same as network-section.js. Mounted only
// when DWEB_ENABLED + dweb-on (home.js), so it ships inert on the store build.

import m from '/vendor/mithril/mithril.js';

export const CONTACTS_REQUEST_TIMEOUT_MS = 35_000;

/**
 * Bound a Home request even if browser messaging never settles while a cold
 * worker is being restarted. Late replies are ignored by this caller.
 * @param {Promise<any>} promise
 * @param {number} timeoutMs
 * @param {boolean} outcomeKnown
 */
const boundedRequest = (promise, timeoutMs, outcomeKnown) => new Promise((resolve) => {
  let settled = false;
  /** @param {any} value */
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => finish({
    ok: false,
    code: 'contacts-ui-timeout',
    outcomeKnown,
    ...(outcomeKnown ? {} : { outcomeKind: 'unknown', retryable: false }),
  }), timeoutMs);
  Promise.resolve(promise).then(finish, () => finish({
    ok: false,
    code: 'contacts-message-rejected',
    outcomeKnown,
    ...(outcomeKnown ? {} : { outcomeKind: 'unknown', retryable: false }),
  }));
});

/** @param {any} result @param {string} action */
const mutationFailureCopy = (result, action) => result?.outcomeKnown !== true
  ? `Peerd could not confirm whether ${action} finished. Peerd requested a read-only contacts refresh to reconcile. Review the current state before trying again.`
  : `Peerd could not ${action}. Review the current contacts and try again if needed.`;

/** @typedef {import('../options/sections/reset-row.js').Send} Send */
/** @typedef {{ linked?: boolean | string, path?: string, lastSeen?: number, name?: string, did?: string }} LivePeer */
/**
 * @typedef {object} Contact
 * @property {string} did
 * @property {string | null} [name]
 * @property {string} [notes]
 * @property {string[]} [tags]
 * @property {boolean} [favorite]
 * @property {boolean} [saved]
 * @property {number | null} [createdAt]
 * @property {number | null} [updatedAt]
 * @property {any} [activity]
 * @property {LivePeer | null} [live]
 */

// p·cyan e·red e·amber r·green d·magenta — a peer's avatar color, random per
// did, cached for the session (the sanctioned "peers ARE the content" accent,
// mirroring network-section.js / the commons participant rail).
const BRAND = ['#00B7EB', '#EF4444', '#F59E0B', '#22C55E', '#D946EF'];
/** @type {Map<string, string>} */
const colorByDid = new Map();
/** @param {string} did */
const colorOf = (did) => {
  if (!colorByDid.has(did)) {
    if (colorByDid.size >= 512) colorByDid.clear();
    colorByDid.set(did, BRAND[Math.floor(Math.random() * BRAND.length)]);
  }
  // why the cast: the key was just ensured present, so it's always a string.
  return /** @type {string} */ (colorByDid.get(did));
};

/** @param {string} did */
const short = (did) => (typeof did === 'string' ? did.slice(-8) : '????????');

/** @param {number} [ms] */
const fmtWhen = (ms) => {
  if (typeof ms !== 'number' || !ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
};

// The live connectivity glance for a peer (honest about a browser mesh — never
// fabricates a path). Returns { label, cls } or null when we have no live read.
/** @param {LivePeer | null | undefined} live */
const liveStatus = (live) => {
  if (!live) return null;
  if (!live.linked) return { label: 'heard · gossip', cls: 'is-gossip' };
  const p = live.path;
  if (!p || p === 'unknown') return { label: 'connecting…', cls: 'is-connecting' };
  if (p === 'direct-ipv6') return { label: 'direct · IPv6', cls: 'is-direct' };
  if (p === 'direct-ipv4') return { label: 'direct · IPv4', cls: 'is-direct' };
  if (p.includes('srflx')) return { label: 'direct · IPv4 (STUN)', cls: 'is-stun' };
  if (p.includes('relay')) return { label: 'relay · TURN', cls: 'is-relay' };
  return { label: p, cls: 'is-stun' };
};

/** @param {Contact} row */
const displayName = (row) => (row.name && row.name.trim() ? row.name.trim() : null);

/** The Contacts section. attrs: { send, requestTimeoutMs? } */
export const ContactsSection = () => {
  /** @type {Contact[] | null} */
  let contacts = null;          // null = loading; else the contacts/list rows
  /** @type {Map<string, LivePeer>} */
  let liveByDid = new Map();    // did -> live peer { linked, path, lastSeen, name }
  /** @type {string | null} */
  let listFailure = null;
  /** @type {string | null} */
  let mutationNotice = null;
  let listPending = false;
  /** @type {Promise<void> | null} */
  let listRequest = null;
  /** @type {string | null} */
  let expandedDid = null;
  /** @type {string | null} */
  let editingDid = null;
  let editValue = '';
  /** @type {string | null} */
  let busyDid = null;
  const unconfirmedDids = new Set();
  /** @type {ReturnType<typeof setInterval> | number} */
  let timer = 0;
  let dead = false;

  /**
   * @param {Send} send
   * @param {number} [timeoutMs]
   * @param {boolean} [afterCurrent] true only for a post-mutation reconciliation
   * @returns {Promise<void>}
   */
  const refresh = (send, timeoutMs = CONTACTS_REQUEST_TIMEOUT_MS, afterCurrent = false) => {
    if (listRequest) {
      // A read that began before an unknown mutation is not reconciliation.
      // Wait for it, then issue one fresh read; ordinary callers share it.
      return afterCurrent
        ? listRequest.then(() => refresh(send, timeoutMs))
        : listRequest;
    }
    listPending = true;
    listRequest = (async () => {
      try {
        const r = await boundedRequest(
          Promise.resolve().then(() => send({ type: 'contacts/list' })), timeoutMs, true,
        );
        if (r?.ok && r?.outcomeKnown !== false) { contacts = r.contacts ?? []; listFailure = null; }
        else listFailure = 'Contacts took too long to load. Nothing was changed.';
      } catch {
        listFailure = 'Contacts took too long to load. Nothing was changed.';
      }
    })().finally(() => {
      listPending = false;
      listRequest = null;
      if (!dead) m.redraw();
    });
    return listRequest;
  };

  // Live presence enrichment — best-effort; a failure just drops the status dot.
  /** @param {Send} send */
  const refreshLive = async (send) => {
    try {
      const r = await send({ type: 'dweb/distributed/info' });
      if (r?.ok && Array.isArray(r.peers)) liveByDid = new Map(r.peers.map((/** @type {LivePeer} */ p) => [p.did, p]));
    } catch { /* best-effort */ }
  };

  // The merged, sorted view: durable contacts first, then any LIVE peer we don't
  // yet have a row for (so a peer you just met is nameable before any history).
  const rows = () => {
    /** @type {Map<string, Contact>} */
    const byDid = new Map((contacts ?? []).map((c) => [c.did, { ...c, live: liveByDid.get(c.did) ?? null }]));
    for (const [did, live] of liveByDid) {
      if (byDid.has(did)) continue;
      byDid.set(did, {
        did, name: null, notes: '', tags: [], favorite: false, saved: false,
        createdAt: null, updatedAt: null,
        activity: { appsInstalled: [], appCount: 0, installCount: 0, updateCount: 0, eventCount: 0, firstEventAt: null, lastEventAt: null },
        live,
      });
    }
    /** @param {Contact} r */
    const recency = (r) => Math.max(r.activity?.lastEventAt ?? 0, r.updatedAt ?? 0, r.live?.lastSeen ?? 0);
    return [...byDid.values()].sort((a, b) =>
      (Number(b.favorite) - Number(a.favorite))
      || (Number(!!b.live?.linked) - Number(!!a.live?.linked))
      || (recency(b) - recency(a))
      || (Number(!!displayName(b)) - Number(!!displayName(a)))
      || a.did.localeCompare(b.did));
  };

  /** @param {Contact} row */
  const startEdit = (row) => { editingDid = row.did; editValue = displayName(row) || ''; };
  /**
   * @param {Send} send
   * @param {Contact} row
   */
  const commitEdit = async (send, row, timeoutMs = CONTACTS_REQUEST_TIMEOUT_MS) => {
    if (editingDid !== row.did) return;
    const name = editValue.trim();
    editingDid = null;
    // No-op if unchanged (and don't create an empty overlay for a live-only peer).
    if (name === (displayName(row) || '')) { m.redraw(); return; }
    busyDid = row.did;
    try {
      const r = await boundedRequest(
        Promise.resolve().then(() => send({ type: 'contacts/set', did: row.did, name })),
        timeoutMs,
        false,
      );
      mutationNotice = r?.ok && r?.outcomeKnown !== false
        ? null : mutationFailureCopy(r, 'saving this name');
      if (!r?.ok && r?.outcomeKnown !== true) unconfirmedDids.add(row.did);
    } catch {
      mutationNotice = mutationFailureCopy({ outcomeKnown: false }, 'saving this name');
      unconfirmedDids.add(row.did);
    } finally {
      busyDid = null;
      await refresh(send, timeoutMs, true); // one post-operation read, never a mutation replay
    }
  };

  /**
   * @param {Send} send
   * @param {Contact} row
   */
  const toggleFavorite = async (send, row, timeoutMs = CONTACTS_REQUEST_TIMEOUT_MS) => {
    busyDid = row.did;
    try {
      const r = await boundedRequest(Promise.resolve().then(() => send({
        type: 'contacts/set', did: row.did, favorite: !row.favorite,
      })), timeoutMs, false);
      mutationNotice = r?.ok && r?.outcomeKnown !== false
        ? null : mutationFailureCopy(r, 'updating this favorite');
      if (!r?.ok && r?.outcomeKnown !== true) unconfirmedDids.add(row.did);
    } catch {
      mutationNotice = mutationFailureCopy({ outcomeKnown: false }, 'updating this favorite');
      unconfirmedDids.add(row.did);
    } finally {
      busyDid = null;
      await refresh(send, timeoutMs, true); // one post-operation read, never a mutation replay
    }
  };

  /**
   * @param {Send} send
   * @param {Contact} row
   */
  const forget = async (send, row, timeoutMs = CONTACTS_REQUEST_TIMEOUT_MS) => {
    busyDid = row.did;
    try {
      const r = await boundedRequest(
        Promise.resolve().then(() => send({ type: 'contacts/forget', did: row.did })),
        timeoutMs,
        false,
      );
      mutationNotice = (r?.ok && r?.outcomeKnown !== false) || r?.error === 'contact-not-found'
        ? null : mutationFailureCopy(r, 'forgetting this contact');
      if (!r?.ok && r?.error !== 'contact-not-found' && r?.outcomeKnown !== true) {
        unconfirmedDids.add(row.did);
      }
    } catch {
      mutationNotice = mutationFailureCopy({ outcomeKnown: false }, 'forgetting this contact');
      unconfirmedDids.add(row.did);
    } finally {
      busyDid = null;
      expandedDid = null;
      await refresh(send, timeoutMs, true); // one post-operation read, never a mutation replay
    }
  };

  /**
   * @param {Send} send
   * @param {Contact} row
   * @param {number} timeoutMs
   */
  const detail = (send, row, timeoutMs) => {
    /** @type {any} */
    const a = row.activity || {};
    return m('.contact-detail', [
      m('.contact-did', { title: row.did }, row.did),
      m('.contact-activity', [
        a.appCount
          ? m('div', [
              m('span.contact-stat-label', `${a.appCount} app${a.appCount === 1 ? '' : 's'} installed from them: `),
              a.appsInstalled.map((/** @type {any} */ app, /** @type {number} */ i) => m('span.contact-app', { key: app.appId || i }, (app.name || 'untitled') + (i < a.appsInstalled.length - 1 ? ', ' : ''))),
            ])
          : m('.muted', 'No apps installed from this peer yet.'),
        (a.installCount || a.updateCount)
          ? m('.muted.contact-counts', `${a.installCount} install${a.installCount === 1 ? '' : 's'} · ${a.updateCount} update${a.updateCount === 1 ? '' : 's'}`)
          : null,
        a.firstEventAt ? m('.muted.contact-counts', `First met ${fmtWhen(a.firstEventAt)} · last activity ${fmtWhen(a.lastEventAt)}`) : null,
      ]),
      m('.contact-detail-actions', [
        m('button.peerd-net-btn', { disabled: busyDid === row.did || unconfirmedDids.has(row.did), onclick: () => toggleFavorite(send, row, timeoutMs) }, row.favorite ? '★ Favorited' : '☆ Favorite'),
        row.saved
          ? m('button.peerd-net-btn', { disabled: busyDid === row.did || unconfirmedDids.has(row.did), onclick: () => forget(send, row, timeoutMs) }, 'Forget')
          : null,
        unconfirmedDids.has(row.did) ? m('button.peerd-net-btn', {
          onclick: () => {
            unconfirmedDids.delete(row.did);
            mutationNotice = null;
            m.redraw();
          },
        }, 'I checked this contact; allow changes') : null,
      ]),
    ]);
  };

  /**
   * @param {Send} send
   * @param {Contact} r
   * @param {number} timeoutMs
   */
  const row = (send, r, timeoutMs) => {
    const name = displayName(r);
    const status = liveStatus(r.live);
    const expanded = expandedDid === r.did;
    const editing = editingDid === r.did;
    const initial = (name || short(r.did)).trim().charAt(0).toUpperCase() || '?';
    return m('li.peerd-disc-row.contact-row', { key: r.did }, [
      m('.contact-avatar', { style: `background:${colorOf(r.did)}`, 'aria-hidden': 'true' }, initial),
      m('.peerd-disc-meta', [
        editing
          ? m('input.contact-name-input', {
              value: editValue,
              placeholder: 'Add a name…',
              oncreate: (/** @type {{ dom: HTMLInputElement }} */ v) => v.dom.focus(),
              oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { editValue = e.target.value; },
              onkeydown: (/** @type {KeyboardEvent} */ e) => {
                if (e.key === 'Enter') commitEdit(send, r, timeoutMs);
                if (e.key === 'Escape') { editingDid = null; m.redraw(); }
              },
              onblur: () => commitEdit(send, r, timeoutMs),
            })
          : m('.contact-name-line', [
              m('span.peerd-disc-name', name || m('span.muted', `peer ${short(r.did)}`)),
              r.favorite ? m('span.contact-fav', { 'aria-label': 'favorite' }, '★') : null,
              status ? m('span.contact-status', { class: status.cls }, status.label) : null,
            ]),
        m('span.peerd-disc-pub', name
          ? `…${short(r.did)}${r.activity?.appCount ? ` · ${r.activity.appCount} app${r.activity.appCount === 1 ? '' : 's'}` : ''}`
          : (r.activity?.appCount ? `${r.activity.appCount} app${r.activity.appCount === 1 ? '' : 's'} · …${short(r.did)}` : `…${short(r.did)}`)),
      ]),
      m('.contact-row-actions', [
        m('button.peerd-net-btn', { title: 'Edit name', disabled: busyDid === r.did || unconfirmedDids.has(r.did), onclick: () => startEdit(r) }, name ? 'Rename' : 'Name'),
        m('button.peerd-net-btn', {
          'aria-expanded': String(expanded),
          title: expanded ? 'Hide activity' : 'Show activity',
          onclick: () => { expandedDid = expanded ? null : r.did; },
        }, expanded ? 'Hide' : 'Activity'),
      ]),
      expanded ? detail(send, r, timeoutMs) : null,
    ]);
  };

  return {
    /** @param {{ attrs: { send: Send, requestTimeoutMs?: number } }} vnode */
    oninit(vnode) {
      refresh(vnode.attrs.send, vnode.attrs.requestTimeoutMs);
      refreshLive(vnode.attrs.send);
    },
    /** @param {{ attrs: { send: Send, requestTimeoutMs?: number } }} vnode */
    oncreate(vnode) {
      timer = setInterval(() => {
        if (document.hidden) return;
        if (!listFailure) refresh(vnode.attrs.send, vnode.attrs.requestTimeoutMs);
        refreshLive(vnode.attrs.send);
      }, 5000);
    },
    onremove() { dead = true; if (timer) clearInterval(timer); },
    /** @param {{ attrs: { send: Send, requestTimeoutMs?: number } }} vnode */
    view(vnode) {
      const send = vnode.attrs.send;
      const timeoutMs = vnode.attrs.requestTimeoutMs ?? CONTACTS_REQUEST_TIMEOUT_MS;
      const list = contacts === null ? [] : rows();
      return m('.peerd-disc.contacts', [
        mutationNotice ? m('p.peerd-disc-err', {
          style: 'padding:8px;', role: 'alert', 'aria-live': 'assertive',
        }, mutationNotice) : null,
        listFailure ? m('.contacts-load-failure', { style: 'padding:8px;' }, [
          m('p.peerd-disc-err', { role: 'alert' }, listFailure),
          m('button.peerd-net-btn', {
            type: 'button', disabled: listPending,
            onclick: () => refresh(send, timeoutMs),
          }, listPending ? 'Retrying…' : 'Retry'),
        ]) : null,
        contacts === null && !listFailure
          ? m('.peerd-net-empty', 'Loading contacts…')
          : contacts === null
            ? null
            : list.length === 0
            ? m('.peerd-net-empty',
                'No known peers yet. Peers you meet on the network — and anyone you '
                + 'install an app from — show up here, ready to name.')
            : m('ul.peerd-disc-list', list.map((r) => row(send, r, timeoutMs))),
      ]);
    },
  };
};
