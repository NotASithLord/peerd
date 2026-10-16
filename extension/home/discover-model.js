// @ts-check
// home/discover-model.js - pure presentation rules for the Discover view.
//
// No sends, no DOM, no clock: every function maps reads the section already
// holds (heard cards, the Library catalog, saved contacts, network status) to
// the words and states the 2a design draws. Bun tests pin each rule.

/** @typedef {{ dwapp_id?: string, uri?: string, name?: string, slug?: string, seq?: number, publisher?: string, from?: string, version_id?: string, description?: string, size?: number, includes_wasm?: boolean|null, runtimeCompatibility?: {status:string,message:string} }} DwebApp */
/** @typedef {{action:'install'|'update', versionId:string|null, seq:number|null, uri:string|null}} PendingTarget */
/**
 * Effect custody that must outlive one mount of the section: the page says
 * "You can leave this page. The install keeps going." (see createEffects).
 * @typedef {{
 *   busy: Record<string, string>,
 *   unconfirmed: Map<string, PendingTarget>,
 *   installedId: Record<string, string|null>,
 *   notices: Record<string, string>,
 *   conflicts: Map<string, {token:number, versionId:string|null}>,
 * }} DiscoverEffects
 */
/** @typedef {'all'|'updates'|'contacts'|'included'} Pill */
/** @typedef {{kind:'connected'|'looking'|'offline', linked:number}} NetworkState */
/** @typedef {{ok?:boolean, featureLeases?:{leases?:{dweb?:{status?:string}}}}} ReadyReply */
/** @typedef {{ok?:boolean, running?:unknown, linkedCount?:unknown}} InfoReply */
/** @typedef {{id?:unknown, name?:unknown, dweb?:{uri?:unknown, dwapp_id?:unknown, publisher?:unknown, version_id?:unknown}}} CatalogRecord */
/** @typedef {'start'|'looking'|'empty'|'grid'|'offline'} RootView */
/** @typedef {'review'|'installing'|'installed'|'failed'|'unknown'} InstallState */
/** @typedef {'current'|'pending'|'done'|'working'|'failed'|'unknown'} StepState */

/** A fresh, empty custody record. The section keeps one per page load.
 * @returns {DiscoverEffects} */
export const createEffects = () => ({
  busy: {}, unconfirmed: new Map(), installedId: {}, notices: {}, conflicts: new Map(),
});

const IN_FLIGHT = Object.freeze(['installing', 'updating']);
/** A busy value that is not a state word is the failure text itself.
 * @param {string|undefined} busy */
export const isFailure = (busy) => typeof busy === 'string' && busy !== 'installed' && !IN_FLIGHT.includes(busy);

// why these five tokens in this order: the shipped hex list hashed dwapp_ids
// into cyan, red, amber, green, magenta. Same hash and order, so every app
// keeps its colour, now from tokens instead of hex.
export const TONES = Object.freeze(['--cyan', '--red', '--amber', '--green', '--magenta']);
/** @param {string} [key] */
export const toneOf = (key) => {
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
};
/** @param {string} [name] */
export const letterOf = (name) => (Array.from(String(name ?? '').trim())[0] ?? '?').toUpperCase();

// why the last 8 characters: every Ed25519 did:key starts with z6Mk, so a
// prefix would show the same text for every maker.
/** @param {string} [did] */
export const shortKey = (did) => (typeof did === 'string' ? did.slice(-8) : '????????');

// why 1000: the design reads 48,213 bytes as "48 KB". A non-empty bundle
// never rounds down to "0 KB".
/** @param {unknown} size */
export const kbLabel = (size) => {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
  return `${Math.max(size > 0 ? 1 : 0, Math.round(size / 1000))} KB`;
};
/** @param {unknown} size */
export const bytesLabel = (size) => {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
  return `${new Intl.NumberFormat().format(size)} ${size === 1 ? 'byte' : 'bytes'}`;
};
/** @param {boolean|null|undefined} includesWasm */
export const wasmLabel = (includesWasm) => includesWasm === true ? 'Includes WebAssembly'
  : includesWasm === false ? 'No detected WebAssembly files' : 'WebAssembly not specified';
/** @param {number} n */
export const peerCountLabel = (n) => `Connected to ${n} ${n === 1 ? 'peer' : 'peers'}`;
/** @param {number} n */
export const appCountLabel = (n) => `${n} ${n === 1 ? 'app' : 'apps'} shared`;

/**
 * The lease decides first: 'starting' is still looking, any other inactive
 * lease is offline. An unreadable reply returns null so the caller keeps the
 * last known state instead of flashing a wrong one.
 * @param {ReadyReply|null|undefined} ready the 'bootstrap/ready' reply
 * @param {InfoReply|null|undefined} info the 'dweb/distributed/info' reply, read only while the lease is active
 * @returns {NetworkState|null}
 */
export const networkState = (ready, info) => {
  if (!ready?.ok) return null;
  const lease = ready.featureLeases?.leases?.dweb?.status;
  if (lease === 'starting') return { kind: 'looking', linked: 0 };
  if (lease !== 'active') return { kind: 'offline', linked: 0 };
  if (!info || info.ok === false || typeof info.running !== 'boolean') return null;
  if (!info.running) return { kind: 'offline', linked: 0 };
  const linked = info.linkedCount;
  if (typeof linked !== 'number' || !Number.isSafeInteger(linked) || linked < 0) return null;
  return linked > 0 ? { kind: 'connected', linked } : { kind: 'looking', linked: 0 };
};

/**
 * @param {{enabled:boolean, net:NetworkState|null, heardCount:number, loading:boolean, failed:boolean, included:boolean}} input
 * @returns {RootView}
 */
export const rootView = ({ enabled, net, heardCount, loading, failed, included }) => {
  if (!enabled) return 'start';
  if (net?.kind === 'offline') return 'offline';
  // why included: the Included pill lists apps that come with peerd, so it
  // needs no peer and no heard app.
  if (heardCount > 0 || included) return 'grid';
  // why: "No apps shared yet" is a claim. Make it only after a good read.
  return net?.kind === 'connected' && !loading && !failed ? 'empty' : 'looking';
};

/**
 * The Library line on the root and the app page. Until one catalog read
 * lands, an installed app looks new, so Install stays off.
 * @param {{ready:boolean, failed:boolean}} library
 * @returns {string|null}
 */
export const libraryStatus = ({ ready, failed }) => {
  if (!failed) return ready ? null : 'Checking your Library…';
  return ready ? 'Could not refresh your Library. Surprise me stays off until peerd can read it.'
    : 'Could not read your Library. Install stays off until peerd can read it.';
};

/**
 * First match wins. In-flight tiles carry text and no button; failed and
 * unknown tiles say Review because the app page carries that state.
 * @param {{incompatible:boolean, busy?:string, uncertain:boolean, installed:boolean, updatable:boolean, mine:boolean}} card
 * @returns {{kind:'status', text:string}|{kind:'update'|'open'|'review'}}
 */
export const tileAction = ({ incompatible, busy, uncertain, installed, updatable, mine }) => {
  if (incompatible) return { kind: 'status', text: 'Can’t run in this browser' };
  if (busy === 'installing') return { kind: 'status', text: 'Installing…' };
  if (busy === 'updating') return { kind: 'status', text: 'Updating…' };
  if (uncertain || isFailure(busy)) return { kind: 'review' };
  if (installed && updatable && !mine) return { kind: 'update' };
  if (installed) return { kind: 'open' };
  return { kind: 'review' };
};

/**
 * @param {{incompatible:boolean, conflict:boolean, busy?:string, uncertain:boolean, installed:boolean}} card
 * @returns {'cant-run'|'conflict'|InstallState}
 */
export const pageState = ({ incompatible, conflict, busy, uncertain, installed }) => {
  if (incompatible) return 'cant-run';
  if (busy === 'installing' || busy === 'updating') return 'installing';
  if (uncertain) return 'unknown';
  if (conflict) return 'conflict';
  if (isFailure(busy)) return 'failed';
  if (installed || busy === 'installed') return 'installed';
  return 'review';
};

const STEPS = Object.freeze([
  { title: 'Review', sub: 'You are here' },
  { title: 'Install and share', sub: 'peerd checks every file, then adds it to your Library' },
  { title: 'Open', sub: 'Opens in its own tab' },
]);
/** @type {Record<InstallState, StepState[]>} */
const STEP_STATES = {
  review: ['current', 'pending', 'pending'],
  installing: ['done', 'working', 'pending'],
  installed: ['done', 'done', 'current'],
  failed: ['done', 'failed', 'pending'],
  unknown: ['done', 'unknown', 'pending'],
};
// why "You are here" only on a current Review step: under a done step it
// points at a step the user already left.
/** @param {InstallState} state */
export const installSteps = (state) => STEPS.map((step, i) => {
  const stepState = STEP_STATES[state][i];
  return { title: step.title, sub: i === 0 && stepState !== 'current' ? null : step.sub, state: stepState };
});

/**
 * Pending and unknown apps stay visible under every pill: unknown is not absent.
 * @template {DwebApp} T
 * @param {T[]} apps @param {Pill} pill
 * @param {{updatable:(app:T)=>boolean, pending:(app:T)=>boolean, contacts:ReadonlyMap<string,string>}} facts
 */
export const pillFilter = (apps, pill, { updatable, pending, contacts }) => {
  if (pill === 'included') return [];
  if (pill === 'all') return apps;
  return apps.filter(app => pending(app) || (pill === 'updates' ? updatable(app)
    : typeof app.publisher === 'string' && contacts.has(app.publisher)));
};

// why saved rows only, keyed by the full did: an unsaved row has no name the
// user chose, and a presence or card name is whatever the peer claims.
/** @param {unknown} rows the 'contacts/list' contacts */
export const savedContactNames = (rows) => {
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (row?.saved === true && typeof row.did === 'string' && name) names.set(row.did, name);
  }
  return names;
};

/**
 * Library records that came from peers, for the offline grid. The catalog
 * carries no description or size, so a card heard earlier this visit fills them.
 * @param {ReadonlyArray<CatalogRecord>} records the 'apps/list' apps
 * @param {ReadonlyMap<string, DwebApp>} heard last heard card per dwapp_id
 * @returns {DwebApp[]}
 */
export const libraryPeerApps = (records, heard) => records.flatMap(record => {
  const dweb = record?.dweb;
  if (typeof record?.id !== 'string' || typeof dweb?.uri !== 'string') return [];
  const card = typeof dweb.dwapp_id === 'string' ? heard.get(dweb.dwapp_id) : undefined;
  return [{
    dwapp_id: typeof dweb.dwapp_id === 'string' ? dweb.dwapp_id : dweb.uri,
    uri: dweb.uri,
    name: typeof record.name === 'string' ? record.name : card?.name,
    publisher: typeof dweb.publisher === 'string' ? dweb.publisher : undefined,
    version_id: typeof dweb.version_id === 'string' ? dweb.version_id : undefined,
    description: card?.description,
    size: card?.size,
  }];
});

/**
 * @template {{name?:string, description?:string}} T
 * @param {T[]} items @param {string} query
 */
export const matchQuery = (items, query) => {
  const search = query.trim().toLowerCase();
  return search ? items.filter(item => `${item.name ?? ''} ${item.description ?? ''}`.toLowerCase().includes(search)) : items;
};
