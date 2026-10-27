// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ContactsSection } from '/home/contacts-section.js';

const DID_A = 'did:key:z6MkAAAAAAAAAAAAAAAAAAAA';
const DID_LIVE = 'did:key:z6MkLIVELIVELIVELIVELIVE';

// A durable contact (named, with one installed app) + a separate live-only peer
// returned by dweb/distributed/info (currently connected, no saved overlay yet).
const CONTACTS = [
  {
    did: DID_A, name: 'Alice', notes: '', tags: [], favorite: false, saved: true,
    createdAt: 1, updatedAt: 10,
    activity: { appsInstalled: [{ appId: 'app-1', name: 'Chess', versionId: 'v1', slug: 'chess' }], appCount: 1, installCount: 1, updateCount: 0, eventCount: 1, firstEventAt: 5, lastEventAt: 8 },
  },
];
const LIVE_PEERS = [{ did: DID_LIVE, name: null, linked: true, path: 'direct-ipv6', lastSeen: 999 }];
// The empty list says who shows up here and what the user can do, in Discover's words.
const EMPTY = 'Nobody here yet. People you install an app from, and people you meet on the peer network, show up here. '
  + 'You can add a name for each one.';

/** @typedef {{ type: string } & Record<string, any>} Msg */
/** @typedef {Record<string, (msg: Msg) => any>} Overrides */
/** @typedef {((msg: Msg) => Promise<any>) & { calls: Msg[] }} FakeSend */

/** @param {Overrides} [overrides] */
const makeSend = (overrides = {}) => {
  /** @type {Msg[]} */
  const calls = [];
  /** @type {FakeSend} */
  const send = Object.assign(
    /** @param {Msg} msg */
    async (msg) => {
      calls.push(msg);
      if (overrides[msg.type]) return overrides[msg.type](msg);
      if (msg.type === 'contacts/list') return { ok: true, contacts: structuredClone(CONTACTS) };
      if (msg.type === 'dweb/distributed/info') return { ok: true, peers: structuredClone(LIVE_PEERS) };
      if (msg.type === 'dweb/blocked-peers') return { ok: true, blocked: [] };
      return { ok: true };
    },
    { calls },
  );
  return send;
};

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); m.redraw.sync(); };

/** @param {FakeSend} send @param {number} [requestTimeoutMs] @param {number} [pollMs] */
const mountView = async (send, requestTimeoutMs, pollMs) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(ContactsSection, { send, requestTimeoutMs, pollMs }) });
  await flush();
  await flush();          // second tick — live-info promise resolves after list
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

// byText + click, asserting presence — mirrors the old `.find(...).click()`.
/**
 * @param {ParentNode} root
 * @param {string} sel
 * @param {string} text
 */
const clickText = (root, sel, text) => {
  const el = /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)])
    .find((b) => b.textContent === text);
  if (!el) throw new Error(`missing ${sel} with text: ${text}`);
  el.click();
};

// The contact row whose text includes `needle` (rows aren't in fixture order —
// linked live peers sort above saved ones); throws if absent.
/**
 * @param {ParentNode} root
 * @param {string} needle
 * @returns {HTMLElement}
 */
const rowWith = (root, needle) => {
  const el = [...root.querySelectorAll('.contact-row')]
    .find((r) => r.textContent?.includes(needle));
  if (!el) throw new Error(`missing contact-row: ${needle}`);
  return /** @type {HTMLElement} */ (el);
};

// Query that asserts presence — a null here is a real test failure.
/**
 * @template {HTMLElement} [T=HTMLElement]
 * @param {ParentNode} root
 * @param {string} sel
 * @param {new () => T} [_ctor]
 * @returns {T}
 */
const need = (root, sel, _ctor) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return /** @type {T} */ (el);
};

describe('home.contacts', () => {
  it('lists known peers — a named contact and a live-only peer', async () => {
    const UNNAMED = 'did:key:z6MkUNNAMEDUNNAMED';
    const send = makeSend({ 'contacts/list': () => ({ ok: true, contacts: [...structuredClone(CONTACTS), {
      did: UNNAMED, name: null, notes: '', tags: [], favorite: false, saved: false, createdAt: null, updatedAt: null,
      activity: { appsInstalled: [{ appId: 'app-2', name: 'Kanban' }], appCount: 1, installCount: 1, updateCount: 0, eventCount: 1,
        firstEventAt: null, lastEventAt: null },
    }] }) });
    const { root, unmount } = await mountView(send);
    try {
      const names = [...root.querySelectorAll('.peerd-disc-name')].map((n) => n.textContent);
      expect(names.some((t) => t === 'Alice')).toBe(true);          // the saved overlay name
      // The live-only peer shows its short key alone (the last 8 characters), as
      // Discover and Blocked makers show a person, and the line under it does not repeat it.
      const live = rowWith(root, 'LIVELIVE');
      expect(need(live, '.peerd-disc-name').textContent).toBe('LIVELIVE');
      expect(live.querySelector('.peerd-disc-pub')).toBe(null);
      expect(root.textContent.includes('peer LIVELIVE')).toBe(false);
      // Someone unnamed with an app: the line under the key names the app count only.
      expect(need(rowWith(root, 'UNNAMED'), '.peerd-disc-pub').textContent).toBe('1 app');
      // Under a name, the key shows the same way, and only the key is a code.
      const alice = need(rowWith(root, 'Alice'), '.peerd-disc-pub');
      expect(alice.textContent).toBe('AAAAAAAA · 1 app');
      expect(need(alice, 'bdi.contact-key').textContent).toBe('AAAAAAAA');
      // its live status is rendered honestly
      expect(root.textContent).toContain('direct · IPv6');
    } finally { unmount(); }
  });

  it('expanding a contact shows the historic activity summary', async () => {
    const { root, unmount } = await mountView(makeSend());
    try {
      // Expand ALICE's row specifically (the live peer sorts first).
      const alice = rowWith(root, 'Alice');
      clickText(alice, 'button', 'Activity');
      await flush();
      expect(root.textContent).toContain('1 app installed from them');
      expect(root.textContent).toContain('Chess');
      // Someone with no apps yet is "them", as in Discover, never "this peer".
      clickText(rowWith(root, 'LIVELIVE'), 'button', 'Activity');
      await flush();
      expect(root.textContent).toContain('No apps installed from them yet.');
      expect(root.textContent.includes('this peer')).toBe(false);
      // The full key is a code, so it waits behind Technical details, as in Discover.
      const tech = need(rowWith(root, 'LIVELIVE'), 'details.contact-tech', HTMLDetailsElement);
      expect([need(tech, 'summary').textContent, tech.open]).toEqual(['Technical details', false]);
      expect(need(tech, '.contact-did').textContent).toBe(DID_LIVE);
    } finally { unmount(); }
  });

  it('naming a peer dispatches contacts/set with the did and name', async () => {
    const send = makeSend();
    const { root, unmount } = await mountView(send);
    try {
      // The live-only peer offers "Add a name", as Discover does; the named one offers "Rename".
      clickText(root, 'button', 'Add a name');
      await flush();
      const input = need(root, '.contact-name-input', HTMLInputElement);
      expect(input).toBeTruthy();
      input.value = 'Bob';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flush();
      const call = send.calls.find((c) => c.type === 'contacts/set');
      expect(call?.did).toBe(DID_LIVE);
      expect(call?.name).toBe('Bob');
    } finally { unmount(); }
  });

  it('skips the live refresh while a name is being typed (a re-sort would blur and save a partial name)', async () => {
    // A second linked peer whose recency flips on the second live read: the row
    // being named would move above the first one, and the keyed move blurs its input.
    const DID_LIVE_B = 'did:key:z6MkBBBBBBBBBBBBBBBBBBBB';
    let liveReads = 0;
    const send = makeSend({
      'dweb/distributed/info': () => {
        liveReads += 1;
        const peerB = { did: DID_LIVE_B, name: null, linked: true, path: 'direct-ipv6', lastSeen: liveReads === 1 ? 500 : 1500 };
        return { ok: true, peers: [...structuredClone(LIVE_PEERS), peerB] };
      },
    });
    // Capture the 5 s poll so the test can fire it on demand.
    let tick = /** @type {(() => void) | null} */ (null);
    const realSetInterval = window.setInterval;
    window.setInterval = /** @type {typeof window.setInterval} */ ((/** @type {TimerHandler} */ handler, /** @type {number | undefined} */ timeout) => {
      tick = /** @type {() => void} */ (handler);
      return realSetInterval(() => {}, timeout);
    });
    let mounted;
    try { mounted = await mountView(send); } finally { window.setInterval = realSetInterval; }
    const { root, unmount } = mounted;
    try {
      clickText(rowWith(root, 'BBBBBBBB'), 'button', 'Add a name');
      await flush();
      const input = need(root, '.contact-name-input', HTMLInputElement);
      input.value = 'Bo';
      input.dispatchEvent(new Event('input'));
      tick?.();
      await flush();
      await flush();
      expect(liveReads).toBe(1);
      expect(send.calls.some((c) => c.type === 'contacts/set')).toBe(false);
      expect(root.querySelector('.contact-name-input')).toBe(input);
      expect(document.activeElement).toBe(input);
    } finally { unmount(); }
  });

  it('empty state when there are no known peers', async () => {
    const send = makeSend({
      'contacts/list': () => ({ ok: true, contacts: [] }),
      'dweb/distributed/info': () => ({ ok: true, peers: [] }),
    });
    const { root, unmount } = await mountView(send);
    try {
      expect(root.textContent).toContain(EMPTY);
    } finally { unmount(); }
  });

  it('turns a cold-host list timeout into bounded Retry without a loading wedge', async () => {
    let lists = 0;
    const send = makeSend({
      'contacts/list': () => {
        lists += 1;
        return lists === 1
          ? { ok: false, code: 'semantic-demand-timeout', outcomeKnown: true }
          : { ok: true, contacts: [] };
      },
      'dweb/distributed/info': () => ({ ok: true, peers: [] }),
    });
    const { root, unmount } = await mountView(send, 20);
    try {
      expect(root.textContent).toContain('Contacts took too long to load. Nothing was changed.');
      expect(root.textContent).toContain('Retry');
      expect(root.textContent.includes('Loading contacts…')).toBe(false);
      expect(root.textContent.includes(EMPTY)).toBe(false);
      clickText(root, 'button', 'Retry');
      await flush();
      await flush();
      expect(lists).toBe(2);
      expect(root.textContent).toContain(EMPTY);
      expect(root.textContent.includes('Retry')).toBe(false);
    } finally { unmount(); }
  });

  it('bounds a runtime message that never settles and leaves explicit Retry', async () => {
    const send = makeSend({
      'contacts/list': () => new Promise(() => {}),
      'dweb/distributed/info': () => ({ ok: true, peers: [] }),
    });
    const { root, unmount } = await mountView(send, 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      m.redraw.sync();
      expect(root.textContent).toContain('Nothing was changed.');
      expect(root.textContent).toContain('Retry');
      expect(root.textContent.includes('Loading contacts…')).toBe(false);
      expect(send.calls.filter((call) => call.type === 'contacts/list').length).toBe(1);
    } finally { unmount(); }
  });

  it('reconciles but never replays a host-lost contacts/set mutation', async () => {
    const send = makeSend({
      'contacts/set': () => ({
        ok: false, code: 'semantic-demand-channel-lost',
        outcomeKnown: false, outcomeKind: 'unknown', retryable: false,
      }),
      'dweb/distributed/info': () => ({ ok: true, peers: [] }),
    });
    const { root, unmount } = await mountView(send, 20);
    try {
      clickText(rowWith(root, 'Alice'), 'button', 'Activity');
      await flush();
      clickText(rowWith(root, 'Alice'), 'button', '☆ Favorite');
      await flush();
      await flush();
      expect(send.calls.filter((call) => call.type === 'contacts/set').length).toBe(1);
      expect(send.calls.filter((call) => call.type === 'contacts/list').length).toBe(2);
      // Neutral words: the change may have happened, and peerd reads the list again.
      expect(need(root, '.peerd-disc-err[role="alert"]').textContent)
        .toBe('peerd is not sure the favorite changed. Check the list before you try again.');
      expect([...root.querySelectorAll('button')].some((button) =>
        button.textContent === 'Retry' || button.textContent === 'Retry update')).toBe(false);
      expect(need(rowWith(root, 'Alice'), '.contact-detail-actions button', HTMLButtonElement).disabled)
        .toBe(true);
      clickText(rowWith(root, 'Alice'), 'button', 'Allow changes again');
      await flush();
      expect(need(rowWith(root, 'Alice'), '.contact-detail-actions button', HTMLButtonElement).disabled)
        .toBe(false);
    } finally { unmount(); }
  });

  it('a name that peerd could not save says what failed, then what to do', async () => {
    const send = makeSend({
      'contacts/set': () => ({ ok: false, error: 'contact-store-unavailable', outcomeKnown: true }),
      'dweb/distributed/info': () => ({ ok: true, peers: [] }),
    });
    const { root, unmount } = await mountView(send, 20);
    try {
      clickText(rowWith(root, 'Alice'), 'button', 'Rename');
      await flush();
      const input = need(root, '.contact-name-input', HTMLInputElement);
      input.value = 'Alicia';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flush();
      await flush();
      expect(need(root, '.peerd-disc-err[role="alert"]').textContent).toBe('peerd could not save the name. Try again.');
      expect(send.calls.filter((call) => call.type === 'contacts/set').length).toBe(1);
    } finally { unmount(); }
  });

  it('reconciles but never replays a rejected contacts/forget mutation', async () => {
    const send = makeSend({
      'contacts/forget': () => Promise.reject(new Error('event page discarded')),
      'dweb/distributed/info': () => ({ ok: true, peers: [] }),
    });
    const { root, unmount } = await mountView(send, 20);
    try {
      clickText(rowWith(root, 'Alice'), 'button', 'Activity');
      await flush();
      clickText(rowWith(root, 'Alice'), 'button', 'Forget');
      await flush();
      await flush();
      expect(send.calls.filter((call) => call.type === 'contacts/forget').length).toBe(1);
      expect(send.calls.filter((call) => call.type === 'contacts/list').length).toBe(2);
      expect(root.textContent).toContain('peerd is not sure the contact was forgotten. Check the list before you try again.');
      expect(root.textContent.includes('Peerd')).toBe(false);
      expect(root.textContent.includes('Loading contacts…')).toBe(false);
    } finally { unmount(); }
  });
});

describe('home.contacts blocked makers', () => {
  const LONE = 'did:key:z6MkLONELONELONE2nYtLs6D';
  /** @param {FakeSend} send @param {string} type */
  const sent = (send, type) => send.calls.filter((call) => call.type === type);

  it('lists each blocked maker by saved name or short key, and stays hidden while nobody is blocked', async () => {
    const send = makeSend({ 'dweb/blocked-peers': () => ({ ok: true, blocked: [DID_A, LONE] }) });
    const { root, unmount } = await mountView(send);
    try {
      const section = need(root, 'section.contacts-blocked');
      expect(need(section, 'h2').textContent).toBe('Blocked makers');
      expect(section.getAttribute('aria-labelledby')).toBe(need(section, 'h2').id);
      expect(section.textContent).toContain('Their apps are hidden in Discover, and peerd does not connect to them.');
      const rows = [...section.querySelectorAll('.contacts-blocked-row')];
      expect(rows.map((row) => row.querySelector('.contacts-blocked-name')?.textContent)).toEqual(['Alice', '2nYtLs6D']);
      expect(rows.map((row) => row.querySelector('.contacts-blocked-avatar')?.textContent)).toEqual(['A', '2n']);
      expect(rows.every((row) => row.querySelector('.contacts-blocked-meta')?.textContent === 'Blocked.')).toBe(true);
      expect([...section.querySelectorAll('button')].map((button) => [button.textContent, button.getAttribute('aria-label')]))
        .toEqual([['Unblock', 'Unblock Alice'], ['Unblock', 'Unblock 2nYtLs6D']]);
      expect(sent(send, 'dweb/peer-unblock')).toEqual([]);
    } finally { unmount(); }
    const nobody = await mountView(makeSend());
    try {
      expect(nobody.root.querySelector('section.contacts-blocked')).toBe(null);
    } finally { nobody.unmount(); }
  });

  it('Unblock sends one unblock for the full did, drops the row, and says when their apps come back, with focus on that line', async () => {
    let blocked = [DID_A];
    const send = makeSend({
      'dweb/blocked-peers': () => ({ ok: true, blocked }),
      'dweb/peer-unblock': (msg) => { blocked = blocked.filter((did) => did !== msg.did); return { ok: true, durable: true, revision: 2 }; },
    });
    const { root, unmount } = await mountView(send);
    try {
      const unblock = need(root, '.contacts-blocked-row button', HTMLButtonElement);
      unblock.focus();
      unblock.click();
      await flush();
      await flush();
      expect(sent(send, 'dweb/peer-unblock')).toEqual([{ type: 'dweb/peer-unblock', did: DID_A }]);
      expect(root.querySelector('.contacts-blocked-row')).toBe(null);
      const line = need(root, '.contacts-unblocked');
      expect([line.textContent, line.getAttribute('role')])
        .toEqual(['After you unblock someone, their apps show up again the next time peerd hears from them.', 'status']);
      // Nobody is left, so the list says so, and the line about what a block does goes.
      expect(root.textContent).toContain('Nobody is blocked now.');
      expect(root.textContent.includes('Their apps are hidden')).toBe(false);
      expect(document.activeElement).toBe(line);
    } finally { unmount(); }
  });

  it('a failed unblock says so in its row; an unknown one stays neutral, and Check again reads the list, never unblocks again', async () => {
    /** @type {unknown[]} */ const replies = [{ ok: false, error: 'vault-locked' }, { ok: false, outcomeKnown: false }, { ok: false, outcomeKnown: false }];
    let blocked = [DID_A];
    const send = makeSend({ 'dweb/blocked-peers': () => ({ ok: true, blocked }), 'dweb/peer-unblock': () => replies.shift() });
    const { root, unmount } = await mountView(send);
    const row = () => need(root, '.contacts-blocked-row');
    const press = async (/** @type {string} */ label) => { clickText(row(), 'button', label); await flush(); await flush(); };
    try {
      await press('Unblock');
      const alert = need(row(), '[role="alert"]');
      expect([alert.textContent, alert.classList.contains('error')]).toEqual(['peerd could not unblock Alice. Try again.', true]);
      await press('Unblock');
      const status = need(row(), 'p[role="status"]');
      expect([status.textContent, status.classList.contains('error')])
        .toEqual(['peerd is not sure Alice is unblocked. Check again before you try again.', false]);
      expect(row().querySelector('[role="alert"]')).toBe(null);
      // The unblock may be done, so the row claims neither outcome.
      expect(row().querySelector('.contacts-blocked-meta')).toBe(null);
      expect(need(row(), 'button').textContent).toBe('Check again');
      // The list still names them, so the unblock did not happen.
      await press('Check again');
      expect(need(row(), '[role="alert"]').textContent).toBe('peerd could not unblock Alice. Try again.');
      await press('Unblock');
      // This time it was stored after all: the list is the receipt.
      blocked = [];
      await press('Check again');
      expect(root.querySelector('.contacts-blocked-row')).toBe(null);
      expect(root.textContent).toContain('After you unblock someone, their apps show up again the next time peerd hears from them.');
      expect(sent(send, 'dweb/peer-unblock').length).toBe(3);
    } finally { unmount(); }
  });

  it('an unblock waits for a list read already in flight, so that read cannot bring the row back', async () => {
    let blocked = [DID_A];
    let reads = 0;
    const gate = { release: /** @type {(() => void) | null} */ (null) };
    const send = makeSend({
      'dweb/blocked-peers': () => {
        reads += 1;
        // The poll's first read is slow, and it answers from before the unblock.
        if (reads === 2) return new Promise((resolve) => { gate.release = () => resolve({ ok: true, blocked: [DID_A] }); });
        return { ok: true, blocked };
      },
      'dweb/peer-unblock': () => { blocked = []; return { ok: true, durable: true, revision: 2 }; },
    });
    const { root, unmount } = await mountView(send, undefined, 20);
    try {
      for (let tries = 0; tries < 200 && !gate.release; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(typeof gate.release).toBe('function');
      clickText(root, '.contacts-blocked-row button', 'Unblock');
      await flush();
      expect(sent(send, 'dweb/peer-unblock')).toEqual([]);
      gate.release?.();
      await flush();
      await flush();
      expect(sent(send, 'dweb/peer-unblock')).toEqual([{ type: 'dweb/peer-unblock', did: DID_A }]);
      expect(root.querySelector('.contacts-blocked-row')).toBe(null);
      // Later polls read the stored list, which no longer names them.
      await new Promise((resolve) => setTimeout(resolve, 80));
      m.redraw.sync();
      expect(root.querySelector('.contacts-blocked-row')).toBe(null);
    } finally { unmount(); }
  });

  it('Check again after an unknown unblock waits for a list read already in flight, then decides on a read sent after the click', async () => {
    let blocked = [DID_A];
    /** @type {(() => void)[]} */ const held = [];
    let holdNext = false;
    const send = makeSend({
      'dweb/blocked-peers': () => {
        if (!holdNext) return { ok: true, blocked };
        holdNext = false;
        // A read sent before the host stored the unblock, still in flight.
        return new Promise((resolve) => { held.push(() => resolve({ ok: true, blocked: [DID_A] })); });
      },
      'dweb/peer-unblock': () => ({ ok: false, outcomeKnown: false }),
    });
    const { root, unmount } = await mountView(send, undefined, 20);
    try {
      clickText(root, '.contacts-blocked-row button', 'Unblock');
      await flush();
      await flush();
      expect(need(root, '.contacts-blocked-row button').textContent).toBe('Check again');
      holdNext = true;
      for (let tries = 0; tries < 200 && !held.length; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(held.length).toBe(1);
      blocked = [];
      const reads = sent(send, 'dweb/blocked-peers').length;
      clickText(root, '.contacts-blocked-row button', 'Check again');
      await flush();
      expect(sent(send, 'dweb/blocked-peers').length).toBe(reads);
      held[0]();
      await flush();
      await flush();
      expect(root.querySelector('.contacts-blocked-row')).toBe(null);
      expect(root.textContent).toContain('After you unblock someone, their apps show up again the next time peerd hears from them.');
      expect(sent(send, 'dweb/peer-unblock').length).toBe(1);
    } finally { for (const release of held) release(); unmount(); }
  });

  it('after an unblock, focus moves to the line that says so only when it was lost, never from a control the user moved to', async () => {
    let blocked = [DID_A];
    /** @type {(value: unknown) => void} */ let release = () => {};
    const send = makeSend({
      'dweb/blocked-peers': () => ({ ok: true, blocked }),
      'dweb/peer-unblock': () => new Promise((resolve) => { release = resolve; }),
    });
    const { root, unmount } = await mountView(send);
    try {
      const unblock = need(root, '.contacts-blocked-row button', HTMLButtonElement);
      unblock.focus();
      unblock.click();
      await flush();
      // The user moves on while the unblock runs.
      const activity = need(rowWith(root, 'Alice'), 'button', HTMLButtonElement);
      activity.focus();
      blocked = [];
      release({ ok: true, durable: true, revision: 2 });
      await flush();
      await flush();
      expect(root.querySelector('.contacts-blocked-row')).toBe(null);
      expect(document.activeElement).toBe(activity);
    } finally { release({ ok: false }); unmount(); }
  });

  it('the poll reads no blocked list while an unblock runs, so no read can race it', async () => {
    /** @type {(value: unknown) => void} */ let release = () => {};
    const send = makeSend({
      'dweb/blocked-peers': () => ({ ok: true, blocked: [DID_A] }),
      'dweb/peer-unblock': () => new Promise((resolve) => { release = resolve; }),
    });
    const { root, unmount } = await mountView(send, undefined, 20);
    try {
      clickText(root, '.contacts-blocked-row button', 'Unblock');
      await flush();
      const reads = sent(send, 'dweb/blocked-peers').length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(sent(send, 'dweb/blocked-peers').length).toBe(reads);
      release({ ok: false, error: 'vault-locked' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(sent(send, 'dweb/blocked-peers').length > reads).toBe(true);
    } finally { release({ ok: false }); unmount(); }
  });

  it('a blocked list that cannot load says so, with Try again', async () => {
    let fail = true;
    const send = makeSend({ 'dweb/blocked-peers': () => (fail ? { ok: false, error: 'vault-locked' } : { ok: true, blocked: [DID_A] }) });
    const { root, unmount } = await mountView(send);
    try {
      const section = need(root, 'section.contacts-blocked');
      expect(need(section, '[role="alert"]').textContent).toBe('peerd could not load your blocked makers. Try again.');
      fail = false;
      clickText(section, 'button', 'Try again');
      await flush();
      await flush();
      expect(root.querySelectorAll('.contacts-blocked-row').length).toBe(1);
      expect(root.querySelector('section.contacts-blocked [role="alert"]')).toBe(null);
    } finally { unmount(); }
  });
});
