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
      return { ok: true };
    },
    { calls },
  );
  return send;
};

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); m.redraw.sync(); };

/** @param {FakeSend} send @param {number} [requestTimeoutMs] */
const mountView = async (send, requestTimeoutMs) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(ContactsSection, { send, requestTimeoutMs }) });
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
    const { root, unmount } = await mountView(makeSend());
    try {
      const names = [...root.querySelectorAll('.peerd-disc-name')].map((n) => n.textContent);
      expect(names.some((t) => t === 'Alice')).toBe(true);          // the saved overlay name
      // the live-only peer shows as an unnamed "peer …<short did>" (last 8 chars)
      expect(root.textContent).toContain('peer LIVELIVE');
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
    } finally { unmount(); }
  });

  it('naming a peer dispatches contacts/set with the did and name', async () => {
    const send = makeSend();
    const { root, unmount } = await mountView(send);
    try {
      // The live-only peer offers "Name"; the named one offers "Rename".
      clickText(root, 'button', 'Name');
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

  it('empty state when there are no known peers', async () => {
    const send = makeSend({
      'contacts/list': () => ({ ok: true, contacts: [] }),
      'dweb/distributed/info': () => ({ ok: true, peers: [] }),
    });
    const { root, unmount } = await mountView(send);
    try {
      expect(root.textContent).toContain('No known peers yet');
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
      expect(root.textContent.includes('No known peers yet')).toBe(false);
      clickText(root, 'button', 'Retry');
      await flush();
      await flush();
      expect(lists).toBe(2);
      expect(root.textContent).toContain('No known peers yet');
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
      expect(root.textContent).toContain('could not confirm whether updating this favorite finished');
      expect(root.textContent).toContain('read-only contacts refresh to reconcile');
      expect([...root.querySelectorAll('button')].some((button) =>
        button.textContent === 'Retry' || button.textContent === 'Retry update')).toBe(false);
      expect(need(rowWith(root, 'Alice'), '.contact-detail-actions button', HTMLButtonElement).disabled)
        .toBe(true);
      clickText(rowWith(root, 'Alice'), 'button', 'I checked this contact; allow changes');
      await flush();
      expect(need(rowWith(root, 'Alice'), '.contact-detail-actions button', HTMLButtonElement).disabled)
        .toBe(false);
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
      expect(root.textContent).toContain('could not confirm whether forgetting this contact finished');
      expect(root.textContent).toContain('Review the current state before trying again.');
      expect(root.textContent.includes('Loading contacts…')).toBe(false);
    } finally { unmount(); }
  });
});
