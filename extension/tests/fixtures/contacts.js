// @ts-check
// Controlled contacts, real Contacts component. The fake host answers reads,
// and only the frame that draws an effect answers that one effect.
// ?state=blocked lists two blocked makers, one saved and one not;
// ?state=unblocked unblocks the first, as a person does, and shows the line
// that follows.
import m from '/vendor/mithril/mithril.js';
import { encodeDidKey } from '/shared/address/did.js';
import { ContactsSection } from '/home/contacts-section.js';

const frame = new URLSearchParams(location.search).get('state') ?? 'blocked';
const ana = encodeDidKey(new Uint8Array(32).fill(2));
const lone = encodeDidKey(new Uint8Array(32).fill(7));
const contacts = [{
  did: ana, name: 'Ana', notes: '', tags: [], favorite: false, saved: true, createdAt: 1, updatedAt: 1,
  activity: { appsInstalled: [], appCount: 0, installCount: 0, updateCount: 0, eventCount: 0, firstEventAt: null, lastEventAt: null },
}];
let blocked = [ana, lone];
/** @type {string[]} */ const calls = [];
/** @type {Window & {__contactsFixtureCalls?: string[]}} */ (window).__contactsFixtureCalls = calls;
/** @param {{type:string} & Record<string, unknown>} message */
const send = async (message) => {
  calls.push(message.type);
  if (message.type === 'contacts/list') return { ok: true, contacts };
  if (message.type === 'dweb/distributed/info') return { ok: true, peers: [] };
  if (message.type === 'dweb/blocked-peers') return { ok: true, blocked };
  if (message.type === 'dweb/peer-unblock' && frame === 'unblocked') {
    blocked = blocked.filter(did => did !== message.did);
    return { ok: true, durable: true, revision: 2 };
  }
  throw new Error('Visual fixture has no mutation authority');
};

// why a fixed pick: Contacts draws each saved contact a random brand colour,
// and a capture must look the same on every run.
Math.random = () => 0;
m.mount(/** @type {Element} */ (document.getElementById('app')), { view: () => m(ContactsSection, { send }) });

if (frame === 'unblocked') {
  (async () => {
    for (let tries = 0; tries < 200; tries++) {
      const target = document.querySelector('.contacts-blocked-row button');
      // A real click focuses the control first.
      if (target instanceof HTMLButtonElement && !target.disabled) { target.focus(); target.click(); return; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Contacts fixture could not reach Unblock');
  })();
}
