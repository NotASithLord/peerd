// @ts-check
// Controlled catalog, real Discover component. No transport or installation:
// the fake host answers reads, and only the frame that draws an effect
// answers that one effect. ?state= picks a frame; ?empty=1 is its older
// name for "looking". Frames past the root are reached the way a person
// reaches them: an openKey, then the clicks in STEPS.
import m from '/vendor/mithril/mithril.js';
import { encodeDidKey } from '/shared/address/did.js';
import { formatDwappUri } from '/shared/address/dwapp-uri.js';
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
const UNSUPPORTED = { status: 'unsupported', message: 'Unsupported App runtime target: wasi.' };
if (['cant-run', 'tiles'].includes(frame)) Object.assign(garden, { runtimeCompatibility: UNSUPPORTED });
if (frame === 'update-cant-run') Object.assign(notes, { runtimeCompatibility: UNSUPPORTED });

/** @param {string} id @param {typeof orbit} app @param {Record<string, unknown>} [dweb] */
const record = (id, app, dweb = {}) => ({ id, name: app.name, dweb: {
  uri: app.uri, dwapp_id: app.dwapp_id, version_id: app.version_id, seq: app.seq, publisher: app.publisher, ...dweb,
} });
let notesInstalled = false;
const library = () => frame === 'offline-empty' ? [] : [
  record('local-orbit', orbit),
  ...['conflict', 'tiles', 'update', 'update-cant-run'].includes(frame)
    ? [record('local-notes', notes, { version_id: 'local-notes-v1', seq: 1 })] : [],
  ...notesInstalled ? [record('local-notes', notes)] : [],
];
const heard = ['looking', 'empty'].includes(frame) ? [] : apps;

/** @type {Record<string, () => unknown>} */
const EFFECTS = {
  installing: () => new Promise(() => {}),
  installed: () => { notesInstalled = true; return { ok: true, app: { id: 'local-notes' } }; },
  failed: () => ({ ok: false, error: 'fixture failure' }),
  unknown: () => ({ ok: false, outcomeKnown: false }),
};
/** @type {string[]} */ const calls = [];
/** @type {Window & {__exploreFixtureCalls?: string[]}} */ (window).__exploreFixtureCalls = calls;
/** @param {{type:string} & Record<string, unknown>} message */
const send = async message => {
  calls.push(message.type);
  if (message.type === 'dweb/base/heard') return {ok:true,apps:heard};
  if (message.type === 'apps/list') return {ok:true,apps:library()};
  if (message.type === 'contacts/list') return {ok:true,contacts:[{did:notes.publisher,name:'Ana',saved:true}]};
  if (message.type === 'bootstrap/ready') return {ok:true,featureLeases:{leases:{dweb:{status:'active'}}}};
  if (message.type === 'dweb/distributed/info') {
    return {ok:true,running:!['offline', 'offline-empty'].includes(frame),linkedCount:frame === 'looking' ? 0 : 3,did:encodeDidKey(new Uint8Array(32).fill(9))};
  }
  if (message.type === 'dweb/base/install' && EFFECTS[frame]) return EFFECTS[frame]();
  if (message.type === 'dweb/base/update-app' && frame === 'conflict') return {ok:false,error:'local-changes',conflictToken:7};
  throw new Error('Visual fixture has no mutation authority');
};

/** @type {Record<string, [string, string][]>} */
const STEPS = {
  installing: [['.disc-primary', 'Install and share']],
  installed: [['.disc-primary', 'Install and share']],
  failed: [['.disc-primary', 'Install and share']],
  unknown: [['.disc-primary', 'Install and share']],
  conflict: [['.disc-tile-action', 'Update']],
  maker: [['.disc-app-maker', 'Made by Ana']],
  'share-off': [['button', 'Paste link']],
};
const OPEN_KEYS = /** @type {Record<string, string>} */ ({
  app: notes.dwapp_id, installing: notes.dwapp_id, installed: notes.dwapp_id, failed: notes.dwapp_id,
  unknown: notes.dwapp_id, maker: notes.dwapp_id, 'cant-run': garden.dwapp_id, update: notes.dwapp_id,
  'update-cant-run': notes.dwapp_id,
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
  // A real click focuses the control first.
  for (const [selector, label] of STEPS[frame] ?? []) { const target = await reach(selector, label); target.focus(); target.click(); }
  if (frame !== 'share-off') return;
  const input = /** @type {HTMLInputElement} */ (await reach('.disc-start-form input', null));
  input.value = formatDwappUri({ did: notes.publisher, hash: notes.version_id });
  input.dispatchEvent(new Event('input', { bubbles: true }));
})();
