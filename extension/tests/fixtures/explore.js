// @ts-check
// Controlled catalog, real Discover component. No transport or installation:
// the fake host answers reads, and only the frame that draws an effect
// answers that one effect. ?state= picks a frame; ?empty=1 is its older
// name for "looking". Frames past the root are reached the way a person
// reaches them: an openKey, then the clicks in STEPS.
import m from '/vendor/mithril/mithril.js';
import { encodeDidKey } from '/shared/address/did.js';
import { formatDwappUri } from '/shared/address/dwapp-uri.js';
import { immutableAppRoot } from '/shared/address/immutable-app-root.js';
import { DiscoverSection } from '/home/discover-section.js';

const params = new URLSearchParams(location.search);
const frame = params.get('empty') === '1' ? 'looking' : params.get('state') ?? 'grid';
const apps = [
  {name:'Orbit lab',description:'Explore a small physics simulation with a bundled WebAssembly module.',includes_wasm:true},
  {name:'Field notes',description:'A browser notebook for observations and sketches.',includes_wasm:false},
  {name:'Pixel garden',description:'An older shared App without a WebAssembly declaration.'},
].map((app,i)=>{
  const publisher=encodeDidKey(new Uint8Array(32).fill(i+1)), version_id=String(i+1).repeat(64);
  return {...app,dwapp_id:`fixture-${i}`,publisher,version_id,seq:2,size:1024 * (i+1),uri:`peerd://${publisher}/${version_id}`};
});
const [orbit, notes, garden] = apps;
if (frame === 'recent-misses') {
  const observedAt = Date.now();
  for (const app of apps) Object.assign(app, { retrieval: { outcome: 'no-provider-found', observedAt, expiresAt: observedAt + 30_000 } });
}

// The user's own key, and an app they made and shared from their Library.
const self = encodeDidKey(new Uint8Array(32).fill(9));
const own = {name:'Packing list',description:'Pack for a trip, one item at a time.',includes_wasm:false,dwapp_id:'fixture-own',
  publisher:self,version_id:'9'.repeat(64),seq:1,size:2048,uri:`peerd://${self}/${'9'.repeat(64)}`};
// offline-fresh: offline from the start, so peerd heard no card this visit.
// mine-offline: the app the user made and shared, while the peer network is off.
const OFFLINE = ['offline', 'offline-empty', 'offline-reading', 'offline-failed', 'offline-fresh', 'mine-offline'];
// The first Library read lands, and the one Refresh starts fails. Offline,
// that Refresh also finds the peer network gone.
const REFRESH_FAILS = ['refresh-failed', 'offline-refresh-failed'];
let libraryReads = 0;
// A share link from a maker whose apps no peer shares.
const loneLink = formatDwappUri({ did: encodeDidKey(new Uint8Array(32).fill(7)), hash: '7'.repeat(64) });
// A share link to the app the user made.
const ownLink = formatDwappUri({ did: self, hash: own.version_id });
const MINE = ['mine', 'mine-maker', 'mine-link', 'mine-share', 'mine-offline'];
// A share link to an installed app whose copy changed on this device.
const changedLink = immutableAppRoot(loneLink);
const UNSUPPORTED = { status: 'unsupported', message: 'Unsupported App runtime target: wasi.' };
if (['cant-run', 'tiles'].includes(frame)) Object.assign(garden, { runtimeCompatibility: UNSUPPORTED });
if (frame === 'update-cant-run') Object.assign(notes, { runtimeCompatibility: UNSUPPORTED });
// A maker who gave no description: the tile says so.
if (frame === 'no-description') Object.assign(garden, { description: '' });
// why a stub: the copy frames draw what Share says after a copy, and a
// headless page has no clipboard it can write to.
if (['share-copied', 'share-copy-failed'].includes(frame)) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {
    if (frame === 'share-copy-failed') throw new Error('Visual fixture clipboard refuses the write');
  } } });
}

/** @param {string} id @param {typeof orbit} app @param {Record<string, unknown>} [dweb] */
const record = (id, app, dweb = {}) => ({ id, name: app.name, dweb: {
  uri: app.uri, dwapp_id: app.dwapp_id, version_id: app.version_id, seq: app.seq, publisher: app.publisher, ...dweb,
} });
let notesInstalled = false;
// More Library apps than the Your apps row shows, each added a day apart.
const MORE = ['Budget board', 'Reading list', 'Trip planner', 'Chess clock', 'Recipe box', 'Habit tracker', 'Photo frame']
  .map((name, i) => ({ id: `local-more-${i}`, name, createdAt: Date.UTC(2026, 9, 20 - i) }));
// What the host records when it installs a version: here, a version that asks for nothing.
const asksNothing = { hash: orbit.version_id, dweb: false, instructions: false, observeAct: false };
const library = () => frame === 'offline-empty' ? [] : [
  record('local-orbit', orbit, ['says-nothing', 'says-changed'].includes(frame) ? { hash: orbit.version_id, declared: asksNothing } : {}),
  ...['conflict', 'tiles', 'update', 'update-cant-run', 'update-failed', 'update-unknown', 'update-cleanup', 'updating', 'update-done']
    .includes(frame)
    && !notesInstalled
    ? [record('local-notes', notes, { version_id: 'local-notes-v1', seq: 1 })] : [],
  ...notesInstalled ? [record('local-notes', notes)] : [],
  ...['yours', 'yours-open-failed', 'yours-open-unknown'].includes(frame) ? MORE : [],
  ...MINE.includes(frame) ? [record('local-own', own, { local: true })] : [],
  ...frame === 'link-changed' ? [{ id: 'local-trail', name: 'Trail map', dweb: { uri: changedLink.uri, hash: changedLink.hash,
    version_id: changedLink.hash, publisher: changedLink.publisher, declared: { ...asksNothing, hash: changedLink.hash } } }] : [],
  // An earlier add of Chat rooms, under the name it had then.
  ...frame === 'commons-renamed' ? [{ id: 'local-commons', name: 'Peerd-to-Peerd Commons', dweb: { seed: 'commons' } }] : [],
];
// mine-tile and mine-not-installed: peers share an app the user made, and the user's Library no longer holds it.
const heard = ['looking', 'empty', 'offline-fresh'].includes(frame) ? []
  : MINE.includes(frame) || ['mine-tile', 'mine-not-installed'].includes(frame) ? [...apps, own] : apps;
// Makers the user blocked: the blocked frame adds one.
/** @type {string[]} */ const blocked = [];

/** @type {Record<string, () => unknown>} */
const EFFECTS = {
  installing: () => new Promise(() => {}),
  installed: () => { notesInstalled = true; return { ok: true, app: { id: 'local-notes' } }; },
  failed: () => ({ ok: false, error: 'fixture failure' }),
  unknown: () => ({ ok: false, outcomeKnown: false }),
  // The host refuses the files of a maker blocked in another tab.
  'install-blocked': () => ({ ok: false, error: 'publisher-user-blocked' }),
};
/** @type {string[]} */ const calls = [];
/** @type {Window & {__exploreFixtureCalls?: string[]}} */ (window).__exploreFixtureCalls = calls;
let finishTransfer = (/** @type {any} */ _value) => {};
const transferFrame = ['install-progress', 'install-cancelled', 'install-committing'].includes(frame);
/** @param {{type:string} & Record<string, unknown>} message */
const send = async message => {
  calls.push(message.type);
  if (message.type === 'dweb/base/heard') return {ok:true,apps:heard};
  if (message.type === 'apps/list') {
    if (frame === 'offline-reading') return new Promise(() => {});
    if (['offline-failed', 'library-failed'].includes(frame) || (REFRESH_FAILS.includes(frame) && libraryReads++ > 0)) return {ok:false};
    return {ok:true,apps:library()};
  }
  // pill-contacts: a new user, who has not named anyone yet.
  if (message.type === 'contacts/list') return {ok:true,contacts:frame === 'pill-contacts' ? [] : [{did:notes.publisher,name:'Ana',saved:true}]};
  if (message.type === 'dweb/blocked-peers') return {ok:true,blocked:[...blocked]};
  // The says-changed frame: the Library copy was edited on this device after its install.
  if (message.type === 'dweb/app-local-changes') return {ok:true,changed:['says-changed', 'link-changed'].includes(frame)};
  if (message.type === 'dweb/peer-block' && frame === 'blocked') { blocked.push(String(message.did)); return {ok:true,durable:true,revision:1}; }
  if (message.type === 'dweb/peer-block' && frame === 'block-unknown') return EFFECTS.unknown();
  if (message.type === 'dweb/peer-block' && frame === 'block-failed') return EFFECTS.failed();
  if (message.type === 'contacts/set' && frame === 'rename-failed') return EFFECTS.failed();
  if (message.type === 'contacts/set' && frame === 'rename-unknown') return EFFECTS.unknown();
  if (message.type === 'bootstrap/ready') return {ok:true,featureLeases:{leases:{dweb:{status:'active'}}}};
  if (message.type === 'dweb/distributed/info') {
    const running = !OFFLINE.includes(frame) && !(frame === 'offline-refresh-failed' && libraryReads > 1);
    // why no key while it is not running: the host knows none then.
    return {ok:true,running,linkedCount:frame === 'looking' ? 0 : 3,did:running ? self : null};
  }
  if (message.type === 'dweb/base/install-status') return { ok: true, attempt: {
    id: 'fixture-attempt', phase: frame === 'install-committing' ? 'committing' : 'retrieving',
    cancellable: frame !== 'install-committing', progress: { phase: 'chunk', done: 2, total: 8 },
  } };
  if (message.type === 'dweb/base/install' && transferFrame) return new Promise(resolve => { finishTransfer = resolve; });
  if (message.type === 'dweb/base/cancel-install' && transferFrame) {
    if (message.attemptId !== 'fixture-attempt' || message.kind !== 'install'
      || message.address !== formatDwappUri({ did: notes.publisher, hash: notes.version_id })) throw new Error('wrong cancellation target');
    finishTransfer({ ok: false, code: 'install-cancelled', outcomeKnown: true, performed: false, outcomeKind: 'pre-effect-failure' });
    return { ok: true, id: 'fixture-attempt', phase: 'cancelling' };
  }
  if (message.type === 'dweb/base/install' && Object.hasOwn(EFFECTS, frame)) return EFFECTS[frame]();
  if (message.type === 'dweb/base/install' && frame === 'open-unknown') return EFFECTS.installed();
  if (message.type === 'apps/open' && ['open-unknown', 'yours-open-unknown'].includes(frame)) return EFFECTS.unknown();
  if (message.type === 'apps/open' && frame === 'yours-open-failed') return EFFECTS.failed();
  if (message.type === 'dweb/base/update-app' && frame === 'conflict') return {ok:false,error:'local-changes',conflictToken:7};
  if (message.type === 'dweb/base/update-app' && frame === 'update-failed') return EFFECTS.failed();
  if (message.type === 'dweb/base/update-app' && frame === 'update-unknown') return EFFECTS.unknown();
  if (message.type === 'dweb/base/update-app' && frame === 'updating') return EFFECTS.installing();
  if (message.type === 'dweb/base/update-app' && frame === 'update-done') { notesInstalled = true; return {ok:true,app:{id:'local-notes'}}; }
  // The update lands, but the host could not stop sharing the old version's files.
  if (message.type === 'dweb/base/update-app' && frame === 'update-cleanup') {
    notesInstalled = true;
    return {ok:true,app:{id:'local-notes'},warning:'previous-version-cleanup-pending',warnings:['previous-version-cleanup-pending']};
  }
  if (message.type === 'dweb/open-commons' && frame === 'commons-unknown') return EFFECTS.unknown();
  if (message.type === 'dweb/base/inspect-address' && ['maker-empty', 'says-checked', 'link-changed'].includes(frame)) {
    const target = immutableAppRoot(loneLink);
    return {ok:true,summary:{...target,name:'Trail map',decodedBytes:2048,fileCount:1,entryFile:'index.html',containsWasm:false,
      declared:{hash:target.hash,dweb:true,instructions:true,observeAct:true}}};
  }
  // A maker blocked in another tab: the host refuses to check their link.
  if (message.type === 'dweb/base/inspect-address' && frame === 'link-blocked') return { ok: false, error: 'publisher-user-blocked' };
  if (message.type === 'dweb/base/inspect-address' && frame === 'mine-link') {
    const target = immutableAppRoot(ownLink);
    return {ok:true,summary:{...target,name:own.name,decodedBytes:own.size,fileCount:1,entryFile:'index.html',containsWasm:false,
      declared:{hash:target.hash,dweb:false,instructions:false,observeAct:false}}};
  }
  throw new Error('Visual fixture has no mutation authority');
};

// A step clicks the first match, or types `value` into it.
/** @type {Record<string, [string, string|null, string?][]>} */
const STEPS = {
  'install-progress': [['.disc-primary', 'Install and share']],
  'install-committing': [['.disc-primary', 'Install and share']],
  'install-cancelled': [['.disc-primary', 'Install and share'], ['.disc-transfer button', 'Cancel']],
  installing: [['.disc-primary', 'Install and share']],
  installed: [['.disc-primary', 'Install and share']],
  'open-unknown': [['.disc-primary', 'Install and share'], ['.disc-primary', 'Open']],
  failed: [['.disc-primary', 'Install and share']],
  unknown: [['.disc-primary', 'Install and share']],
  conflict: [['.disc-tile-action', 'Update']],
  'update-failed': [['.disc-primary', 'Update']],
  'update-unknown': [['.disc-primary', 'Update']],
  'update-cleanup': [['.disc-primary', 'Update']],
  'update-done': [['.disc-primary', 'Update']],
  updating: [['.disc-primary', 'Update']],
  'refresh-failed': [['.disc-refresh', null]],
  'offline-refresh-failed': [['.disc-refresh', null]],
  'pill-updates': [['.disc-pill', 'Updates']],
  'surprise-filtered': [['.disc-pill', 'Updates'], ['button', 'Surprise me']],
  'pill-contacts': [['.disc-pill', 'From people you know']],
  'mine-maker': [['.disc-app-maker', 'Made by you']],
  'mine-link': [['button', 'Paste link'], ['.disc-start-form input', null, ownLink], ['.disc-start-form button', 'Check link']],
  'mine-share': [['[data-share-open]', 'Share']],
  'link-changed': [['button', 'Paste link'], ['.disc-start-form input', null, loneLink], ['.disc-start-form button', 'Check link']],
  'commons-renamed': [['.disc-pill', 'Comes with peerd']],
  // A search on All that only an app that comes with peerd matches.
  'search-included': [['input.disc-search', null, 'chat']],
  maker: [['.disc-app-maker', 'Made by Ana, someone you know']],
  'maker-menu': [['.disc-app-maker', 'Made by Ana, someone you know'], ['[data-maker-menu]', null]],
  'block-confirm': [['.disc-app-maker', 'Made by Ana, someone you know'], ['[data-maker-menu]', null],
    ['.disc-menu [role="menuitem"]', 'Block Ana']],
  blocked: [['.disc-app-maker', 'Made by Ana, someone you know'], ['[data-maker-menu]', null],
    ['.disc-menu [role="menuitem"]', 'Block Ana'], ['[data-block-confirm]', 'Block Ana']],
  'block-unknown': [['.disc-app-maker', 'Made by Ana, someone you know'], ['[data-maker-menu]', null],
    ['.disc-menu [role="menuitem"]', 'Block Ana'], ['[data-block-confirm]', 'Block Ana']],
  'maker-rename': [['.disc-app-maker', 'Made by Ana, someone you know'], ['[data-maker-menu]', null],
    ['.disc-menu [role="menuitem"]', 'Rename']],
  'rename-failed': [['.disc-app-maker', 'Made by Ana, someone you know'], ['[data-maker-menu]', null],
    ['.disc-menu [role="menuitem"]', 'Rename'], ['.disc-rename input', null, 'Ana Lopez'], ['.disc-rename button[type="submit"]', 'Save']],
  'rename-unknown': [['.disc-app-maker', 'Made by Ana, someone you know'], ['[data-maker-menu]', null],
    ['.disc-menu [role="menuitem"]', 'Rename'], ['.disc-rename input', null, 'Ana Lopez'], ['.disc-rename button[type="submit"]', 'Save']],
  'block-failed': [['.disc-app-maker', 'Made by Ana, someone you know'], ['[data-maker-menu]', null],
    ['.disc-menu [role="menuitem"]', 'Block Ana'], ['[data-block-confirm]', 'Block Ana']],
  'yours-open-failed': [['.disc-yours-open', 'Open']],
  'yours-open-unknown': [['.disc-yours-open', 'Open']],
  'install-blocked': [['.disc-primary', 'Install and share']],
  'link-blocked': [['button', 'Paste link'], ['.disc-start-form input', null, loneLink], ['.disc-start-form button', 'Check link']],
  'maker-empty': [['button', 'Paste link'], ['.disc-start-form input', null, loneLink],
    ['.disc-start-form button', 'Check link'], ['.disc-app-maker', null]],
  'says-checked': [['button', 'Paste link'], ['.disc-start-form input', null, loneLink], ['.disc-start-form button', 'Check link']],
  'commons-unknown': [['.disc-pill', 'Comes with peerd'], ['.disc-tile-action', 'Add and open Chat rooms']],
  share: [['[data-share-open]', 'Share']],
  'share-copied': [['[data-share-open]', 'Share'], ['[data-share-copy]', 'Copy link']],
  'share-copy-failed': [['[data-share-open]', 'Share'], ['[data-share-copy]', 'Copy link']],
  'share-off': [['button', 'Paste link'], ['.disc-start-form input', null, formatDwappUri({ did: notes.publisher, hash: notes.version_id })]],
};
const OPEN_KEYS = /** @type {Record<string, string>} */ ({
  'install-progress': notes.dwapp_id, 'install-committing': notes.dwapp_id, 'install-cancelled': notes.dwapp_id,
  installing: notes.dwapp_id, installed: notes.dwapp_id, failed: notes.dwapp_id,
  'open-unknown': notes.dwapp_id,
  unknown: notes.dwapp_id, maker: notes.dwapp_id, 'cant-run': garden.dwapp_id, update: notes.dwapp_id, share: notes.dwapp_id,
  'update-cant-run': notes.dwapp_id, 'update-failed': notes.dwapp_id, 'update-unknown': notes.dwapp_id,
  'says-unknown': notes.dwapp_id, 'says-nothing': orbit.dwapp_id, 'says-changed': orbit.dwapp_id, mine: own.dwapp_id,
  'mine-share': own.dwapp_id, 'mine-offline': own.dwapp_id, 'mine-not-installed': own.dwapp_id, 'update-done': notes.dwapp_id,
  'mine-maker': own.dwapp_id, 'update-cleanup': notes.dwapp_id, 'library-failed': notes.dwapp_id, updating: notes.dwapp_id,
  'maker-menu': notes.dwapp_id, 'block-confirm': notes.dwapp_id, blocked: notes.dwapp_id,
  'block-unknown': notes.dwapp_id, 'maker-rename': notes.dwapp_id, 'rename-failed': notes.dwapp_id, 'rename-unknown': notes.dwapp_id,
  'block-failed': notes.dwapp_id, 'share-copied': notes.dwapp_id, 'share-copy-failed': notes.dwapp_id, 'install-blocked': notes.dwapp_id,
});
/** @type {string|null} */ let openKey = OPEN_KEYS[frame] ?? null;

m.mount(/** @type {Element} */ (document.getElementById('app')), {view:()=>m(DiscoverSection,{
  send, enabled: frame !== 'share-off', initialSeed: 42, openKey, onOpenKey: () => { openKey = null; },
})});

// why enabled only: Install waits for the first Library read.
/** @param {string} selector @param {string|null} label */
const reach = async (selector, label) => {
  for (let tries = 0; tries < 200; tries++) {
    const target = [...document.querySelectorAll(selector)].find(node => (label === null || node.textContent?.trim() === label)
      && !(node instanceof HTMLButtonElement && node.disabled));
    if (target instanceof HTMLElement) return target;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Explore fixture could not reach ${selector} "${label}"`);
};
(async () => {
  for (const [selector, label, value] of STEPS[frame] ?? []) {
    // why a draw before each step: a control that stays on screen, as Surprise
    // me does, keeps the handler of the last draw.
    m.redraw.sync();
    const target = await reach(selector, label);
    // A real click focuses the control first.
    if (value === undefined) { target.focus(); target.click(); continue; }
    /** @type {HTMLInputElement} */ (target).value = value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
})();
