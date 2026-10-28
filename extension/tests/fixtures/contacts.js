// @ts-check
// Controlled contacts, real Contacts component. The fake host answers reads,
// and only the frame that draws an effect answers that one effect.
// ?state=blocked lists two blocked makers, one saved and one not;
// ?state=unblocked unblocks the first, as a person does, and shows the line
// that follows; ?state=unnamed lists people the user has not named and opens
// the activity of one; ?state=empty is a new user's empty list.
// ?state=unblock-failed and ?state=unblock-unknown press Unblock on the first
// row, and its reply fails or is lost; ?state=load-failed cannot read the
// list; ?state=unblocked-last unblocks the only blocked maker.
import m from '/vendor/mithril/mithril.js';
import { encodeDidKey } from '/shared/address/did.js';
import { ContactsSection } from '/home/contacts-section.js';

const frame = new URLSearchParams(location.search).get('state') ?? 'blocked';
const ana = encodeDidKey(new Uint8Array(32).fill(2));
const lone = encodeDidKey(new Uint8Array(32).fill(7));
const bob = encodeDidKey(new Uint8Array(32).fill(3));
// why no event times: the activity line would then name a time relative to now.
/** @param {number} appCount */
const activity = (appCount) => ({
  appsInstalled: appCount ? [{ appId: 'local-budget', name: 'Budget board' }] : [], appCount, installCount: appCount, updateCount: 0,
  eventCount: appCount, firstEventAt: null, lastEventAt: null,
});
const saved = { did: ana, name: 'Ana', notes: '', tags: [], favorite: false, saved: true, createdAt: 1, updatedAt: 1, activity: activity(0) };
/** @param {string} did @param {number} appCount */
const unnamed = (did, appCount) => ({
  did, name: null, notes: '', tags: [], favorite: false, saved: false, createdAt: null, updatedAt: null, activity: activity(appCount),
});
const contacts = frame === 'empty' ? [] : frame === 'unnamed' ? [saved, unnamed(bob, 1), unnamed(lone, 0)] : [saved];
let blocked = ['unnamed', 'empty'].includes(frame) ? [] : frame === 'unblocked-last' ? [ana] : [ana, lone];
/** @type {string[]} */ const calls = [];
/** @type {Window & {__contactsFixtureCalls?: string[]}} */ (window).__contactsFixtureCalls = calls;
/** @param {{type:string} & Record<string, unknown>} message */
const send = async (message) => {
  calls.push(message.type);
  if (message.type === 'contacts/list') return { ok: true, contacts };
  if (message.type === 'dweb/distributed/info') return { ok: true, peers: [] };
  if (message.type === 'dweb/blocked-peers') return frame === 'load-failed' ? { ok: false, error: 'vault-locked' } : { ok: true, blocked };
  if (message.type === 'dweb/peer-unblock' && frame === 'unblock-failed') return { ok: false, error: 'vault-locked' };
  if (message.type === 'dweb/peer-unblock' && frame === 'unblock-unknown') return { ok: false, outcomeKnown: false };
  if (message.type === 'dweb/peer-unblock' && ['unblocked', 'unblocked-last'].includes(frame)) {
    blocked = blocked.filter(did => did !== message.did);
    return { ok: true, durable: true, revision: 2 };
  }
  throw new Error('Visual fixture has no mutation authority');
};

// why a fixed pick: Contacts draws each saved contact a random brand colour,
// and a capture must look the same on every run.
Math.random = () => 0;
m.mount(/** @type {Element} */ (document.getElementById('app')), { view: () => m(ContactsSection, { send }) });

// A step presses what `find` returns once it is on screen.
/** @param {() => Element|null|undefined} find @param {string} label */
const press = async (find, label) => {
  for (let tries = 0; tries < 200; tries++) {
    const target = find();
    // A real click focuses the control first.
    if (target instanceof HTMLButtonElement && !target.disabled) { target.focus(); target.click(); return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Contacts fixture could not reach ${label}`);
};
if (['unblocked', 'unblocked-last', 'unblock-failed', 'unblock-unknown'].includes(frame)) {
  void press(() => document.querySelector('.contacts-blocked-row button'), 'Unblock');
}
// The activity of someone with no app installed from them.
if (frame === 'unnamed') {
  void press(() => [...document.querySelectorAll('.contact-row')]
    .find(row => row.querySelector('.peerd-disc-name')?.textContent === lone.slice(-8))?.querySelector('[aria-expanded]'), 'Activity');
}
