// @ts-check
// home/discover-model.js - pure presentation rules for the Discover view.
//
// No sends, no DOM, no clock: every function maps reads the section already
// holds (heard cards, the Library catalog, saved contacts, network status) to
// the words and states the 2a design draws. Bun tests pin each rule.

import { matchesWords, searchWords } from './explore-order.js';

/** @typedef {{ dwapp_id?: string, uri?: string, name?: string, slug?: string, seq?: number, publisher?: string, from?: string, version_id?: string, description?: string, size?: number, includes_wasm?: boolean|null, runtimeCompatibility?: {status:string,message:string} }} DwebApp */
/** @typedef {{action:'install'|'update', versionId:string|null, seq:number|null, uri:string|null}} PendingTarget */
/** What an app's own peerd.json asks of peerd (see verifiedDeclared). @typedef {{dweb:boolean, instructions:boolean, observeAct:boolean}} Declared */
/** @typedef {{appId?:string, notice?:string, failure?:string}} LinkOutcome */
/**
 * Effect custody that must outlive one mount of the section: the page says
 * "You can leave this page. The install keeps going." (see createEffects).
 * `commons` fences "Add and open Commons" until a refusal, a failure before
 * the send, or a Library read confirms the outcome. `link` is the share-link
 * install in flight, so a view
 * mounted while it runs follows the same outcome. `reads` counts Library
 * reads as they start. `running` keeps each target across a remount.
 * `committed` holds each committed install or update with that
 * count at its commit, so a read that started earlier cannot bring back the
 * version the update replaced; its `declared` is the reply record's (see
 * verifiedDeclared). `commonsAdded` holds it at a confirmed add,
 * so only a read that started later can say Commons was deleted since.
 * @typedef {{
 *   busy: Record<string, string>,
 *   running: Map<string, {action:'install'|'update', uri:string|undefined}>,
 *   unconfirmed: Map<string, PendingTarget>,
 *   installedId: Record<string, string|null>,
 *   notices: Record<string, string>,
 *   conflicts: Map<string, {token:number, versionId:string|null}>,
 *   commons: 'adding'|'unknown'|null,
 *   link: {address:string, outcome:Promise<LinkOutcome>}|null,
 *   committed: Map<string, {appId:string, version_id:string|null, seq:number, read:number, uri?:string, declared?:unknown}>,
 *   reads: number,
 *   commonsAdded: number|null,
 * }} DiscoverEffects
 */
/** @typedef {'all'|'updates'|'contacts'|'included'} Pill */
/** @typedef {{kind:'connected'|'looking'|'offline', linked:number}} NetworkState */
/** @typedef {{ok?:boolean, featureLeases?:{leases?:{dweb?:{status?:string}}}}} ReadyReply */
/** @typedef {{ok?:boolean, running?:unknown, linkedCount?:unknown}} InfoReply */
/** @typedef {{id?:unknown, name?:unknown, createdAt?:unknown, dweb?:{uri?:unknown, dwapp_id?:unknown, publisher?:unknown, version_id?:unknown, seed?:unknown}}} CatalogRecord */
/** @typedef {{id:string, name:string, toneKey:string}} LibraryApp */
/** @typedef {'start'|'looking'|'empty'|'grid'|'offline'} RootView */
/** @typedef {'review'|'installing'|'installed'|'failed'|'unknown'} InstallState */
/** @typedef {'current'|'pending'|'done'|'working'|'failed'|'unknown'} StepState */

/** A fresh, empty custody record. The section keeps one per page load.
 * @returns {DiscoverEffects} */
export const createEffects = () => ({
  busy: {}, running: new Map(), unconfirmed: new Map(), installedId: {}, notices: {}, conflicts: new Map(), commons: null, link: null,
  committed: new Map(), reads: 0, commonsAdded: null,
});

const IN_FLIGHT = Object.freeze(['installing', 'updating']);
/** A busy value that is not a state word is a failure: FAILED, UNKNOWN, or
 * the reason the host gave for a runtime refusal.
 * @param {string|undefined} busy */
export const isFailure = (busy) => typeof busy === 'string' && busy !== 'installed' && !IN_FLIGHT.includes(busy);
// why markers, not the words: the line names the app ("peerd could not
// install Field notes."), and a name is peer text, so the view builds it.
export const FAILED = 'failed';
export const UNKNOWN = 'unknown';

/**
 * The hint under a failed install or update. A runtime refusal keeps its
 * technical reason for Technical details only.
 * @param {string} busy a failure value (see isFailure)
 * @returns {{hint:string, runtime:string|null}}
 */
export const failureHint = (busy) => (
  busy === FAILED || busy === UNKNOWN
    ? { hint: 'The person who shares it may have gone offline. Try again in a moment.', runtime: null }
    : { hint: 'This browser cannot run it. Technical details says why.', runtime: busy }
);

/**
 * An install or update whose outcome peerd does not know. Neutral words: it
 * may still finish.
 * @param {'install'|'update'} action
 */
export const unknownLines = (action) => ({
  status: `peerd is not sure the ${action} finished. It may still finish by itself.`,
  hint: `Check again before you try to ${action} it again.`,
});

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
export const peerCountLabel = (n) => `Connected to ${n} ${n === 1 ? 'person' : 'people'}`;
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
  // why included: the Comes with peerd pill lists apps that come with peerd,
  // so it needs no peer and no heard app.
  if (heardCount > 0 || included) return 'grid';
  // why: "No shared apps yet" is a claim. Make it only after a good read.
  return net?.kind === 'connected' && !loading && !failed ? 'empty' : 'looking';
};

/**
 * The Library line on the root and the app page. Until one catalog read
 * lands, an installed app looks new, so Install stays off. The offline root
 * offers neither Install nor Surprise me, so its lines name what it shows.
 * @param {{ready:boolean, failed:boolean, offline?:boolean}} library
 * @returns {string|null}
 */
export const libraryStatus = ({ ready, failed, offline = false }) => {
  if (!failed) return ready ? null : 'Checking your Library…';
  if (offline) {
    return ready ? 'Could not refresh your Library. This list may be out of date.'
      : 'peerd could not read your Library. Try again in a moment.';
  }
  return ready ? 'Could not refresh your Library. Surprise me stays off until peerd can read it.'
    : 'Could not read your Library. Install stays off until peerd can read it.';
};

/**
 * Why Surprise me opened no page. Only a filter or a search can be changed to
 * find more, so the line names them only while one is on.
 * @param {{filtered:boolean, allInLibrary:boolean}} grid
 * @returns {string}
 */
export const noSuggestionNote = ({ filtered, allInLibrary }) => {
  if (filtered) return 'No new suggestions match these filters. Change your search or filters.';
  return allInLibrary ? 'No new suggestions. Every app here is already in your Library.' : 'No new suggestions.';
};

/**
 * The share row's words for a link the parser rejects. The parser's own text
 * names retired things ("App address", "dwapp URI", "manifest hash").
 * @param {unknown} message the immutableAppRoot error message
 * @returns {string}
 */
export const shareLinkError = (message) => String(message).startsWith('File paths are not supported')
  ? 'This link points to one file inside an app. Paste the link to the whole app.'
  : 'This is not a share link. Paste the whole link you were sent.';

/**
 * A newer version on offer for an installed app, other than the user's own:
 * 'update', or 'update-cant-run' when the new version needs a feature this
 * browser lacks. The installed version still opens either way.
 * @param {{installed:boolean, updatable:boolean, mine:boolean, incompatible:boolean}} card
 * @returns {'update'|'update-cant-run'|null}
 */
export const updateOffer = ({ installed, updatable, mine, incompatible }) => {
  if (!installed || !updatable || mine) return null;
  return incompatible ? 'update-cant-run' : 'update';
};

// why "cannot run" for an installed app only at this version: the runtime
// flag rides the card. An installed app of another version keeps working, so
// it offers Open. `sameVersion`: the Library holds this card's version.
// why the Library wins over a failure at this version: the install may have
// been done since from a share link or another tab. The failure is then stale,
// and a retry would send an update of the version the Library already holds.
/**
 * First match wins. In-flight tiles carry text and no button; failed and
 * unknown tiles say "Look at it" because the app page carries that state.
 * @param {{incompatible:boolean, busy?:string, uncertain:boolean, installed:boolean, sameVersion:boolean, updatable:boolean, mine:boolean}} card
 * @returns {{kind:'status', text:string}|{kind:'update'|'open'|'review'}}
 */
export const tileAction = (card) => {
  const { incompatible, busy, uncertain, installed, sameVersion } = card;
  if (incompatible && (!installed || sameVersion)) return { kind: 'status', text: 'This browser cannot run it' };
  if (busy === 'installing') return { kind: 'status', text: 'Installing…' };
  if (busy === 'updating') return { kind: 'status', text: 'Updating…' };
  if (uncertain || (isFailure(busy) && !(installed && sameVersion))) return { kind: 'review' };
  if (updateOffer(card) === 'update') return { kind: 'update' };
  if (installed) return { kind: 'open' };
  return { kind: 'review' };
};

/**
 * @param {{incompatible:boolean, conflict:boolean, busy?:string, uncertain:boolean, installed:boolean, sameVersion:boolean}} card
 * @returns {'cant-run'|'conflict'|InstallState}
 */
export const pageState = ({ incompatible, conflict, busy, uncertain, installed, sameVersion }) => {
  const have = installed || busy === 'installed';
  if (incompatible && (!have || sameVersion)) return 'cant-run';
  if (busy === 'installing' || busy === 'updating') return 'installing';
  if (uncertain) return 'unknown';
  if (conflict) return 'conflict';
  if (isFailure(busy) && !(have && sameVersion)) return 'failed';
  return have ? 'installed' : 'review';
};

const STEPS = Object.freeze([
  { title: 'Look at it', sub: 'You are here' },
  { title: 'Install', sub: 'peerd checks every file, then adds the app to your Library' },
  { title: 'Open', sub: 'It opens in its own tab' },
]);
/** @type {Record<InstallState, StepState[]>} */
const STEP_STATES = {
  review: ['current', 'pending', 'pending'],
  installing: ['done', 'working', 'pending'],
  installed: ['done', 'done', 'current'],
  failed: ['done', 'failed', 'pending'],
  unknown: ['done', 'unknown', 'pending'],
};
// why "You are here" only on a current first step: under a done step it
// points at a step the user already left.
/** @param {InstallState} state */
export const installSteps = (state) => STEPS.map((step, i) => {
  const stepState = STEP_STATES[state][i];
  return { title: step.title, sub: i === 0 && stepState !== 'current' ? null : step.sub, state: stepState };
});

/** @type {ReadonlyArray<[keyof Declared, string]>} */
const SAYS = Object.freeze([
  ['dweb', 'Uses the peer network'],
  ['instructions', 'Comes with instructions for peerd'],
  ['observeAct', 'Lets peerd see and use it'],
]);

/**
 * What peerd read from an app's own files, only for the version `version`
 * names: the host binds it to the hash it checked. A value for another
 * version, or of any other shape, is not known.
 * @param {unknown} value a share-link summary's or a Library record's `declared`
 * @param {unknown} version the version the page shows
 * @returns {Declared|null}
 */
export const verifiedDeclared = (value, version) => {
  const flags = /** @type {Record<string, unknown>|null} */ (value && typeof value === 'object' ? value : null);
  if (!flags || typeof version !== 'string' || !version || flags.hash !== version
      || SAYS.some(([key]) => typeof flags[key] !== 'boolean')) return null;
  return { dweb: flags.dweb === true, instructions: flags.instructions === true, observeAct: flags.observeAct === true };
};

/**
 * "The app says it". `checked` names where peerd read the app's own files: a
 * share link it looked at, or the version the Library holds. Unchecked, the
 * page says how peerd finds out, never what an app or a peer claims. Checked
 * with nothing recorded (installed before peerd kept it), no section: "Not
 * known yet" would contradict "peerd checked" in What to know.
 * why strong: the agent can then see and use the app, the furthest reach.
 * why the note says when: an edit on this device can change the files after
 * the check, so the facts belong to that check.
 * @param {{declared:Declared|null, checked:'link'|'installed'|null, action?:'install'|'update'}} input
 * @returns {{kind:'unknown'|'nothing'|'checked', chips:{text:string, strong:boolean}[], line:string|null, note:string|null}|null}
 */
export const saysIt = ({ declared, checked, action = 'install' }) => {
  if (!checked) {
    return { kind: 'unknown', chips: [], note: null,
      line: `Not known yet. peerd reads this from the app itself when it checks it. Paste its link or ${action} it, and peerd checks every file first.` };
  }
  if (!declared) return null;
  const chips = SAYS.filter(([key]) => declared[key]).map(([key, text]) => ({ text, strong: key === 'observeAct' }));
  const note = `From the app’s own files, checked when peerd ${checked === 'link' ? 'looked at it' : 'installed it'}.`;
  return chips.length
    ? { kind: 'checked', chips, line: null, note }
    : { kind: 'nothing', chips, line: 'It does not use the peer network and has no instructions for peerd.', note };
};

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
 * The heard cards the offline grid can still use: the latest read, plus
 * earlier cards that `keep` names (apps in the Library or with an effect in
 * flight). Without it the cache holds every card peers ever announced.
 * @param {ReadonlyMap<string, DwebApp>} cache @param {DwebApp[]} latest
 * @param {(id: string) => boolean} keep
 * @returns {Map<string, DwebApp>}
 */
export const keptCards = (cache, latest, keep) => {
  const next = new Map([...cache].filter(([id]) => keep(id)));
  for (const app of latest) if (app.dwapp_id) next.set(app.dwapp_id, app);
  return next;
};

/**
 * Library records that came from peers, for the offline grid. The catalog
 * carries no description or size, so a card heard earlier this visit fills
 * them, but only a card for the version the Library holds.
 * @param {ReadonlyArray<CatalogRecord>} records the 'apps/list' apps
 * @param {ReadonlyMap<string, DwebApp>} heard last heard card per dwapp_id
 * @returns {DwebApp[]}
 */
export const libraryPeerApps = (records, heard) => records.flatMap(record => {
  const dweb = record?.dweb;
  if (typeof record?.id !== 'string' || typeof dweb?.uri !== 'string') return [];
  const latest = typeof dweb.dwapp_id === 'string' ? heard.get(dweb.dwapp_id) : undefined;
  const card = typeof dweb.version_id === 'string' && latest?.version_id === dweb.version_id ? latest : undefined;
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
 * The search over the apps that come with peerd, by the words of the query
 * (see searchWords).
 * @template {{name?:string, description?:string}} T
 * @param {T[]} items @param {string} query
 */
export const matchQuery = (items, query) => {
  const words = searchWords(query);
  return words.length ? items.filter(item => matchesWords(`${item.name ?? ''} ${item.description ?? ''}`, words)) : items;
};

/** @param {CatalogRecord} record */
const addedAt = (record) => typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : null;

/**
 * The "Your apps" row: the apps the Library holds, the most recently added
 * first. A record with no time keeps its Library place after the dated ones.
 * `total` counts every app, so the row can link to the rest.
 * @param {ReadonlyArray<CatalogRecord>} records the 'apps/list' apps
 * @param {number} max
 * @returns {{apps: LibraryApp[], total: number}}
 */
export const yourApps = (records, max) => {
  /** @type {{record:CatalogRecord, id:string, at:number|null, index:number}[]} */
  const rows = records.flatMap((record, index) => typeof record?.id === 'string' && record.id
    ? [{ record, id: record.id, at: addedAt(record), index }] : []);
  rows.sort((a, b) => (a.at === null || b.at === null
    ? Number(a.at === null) - Number(b.at === null) : b.at - a.at) || a.index - b.index);
  return {
    total: rows.length,
    apps: rows.slice(0, max).map(({ record, id }) => {
      const dweb = record.dweb;
      // why this key: the tone matches the app's tile, which keys Commons by
      // its seed and a peer app by its dwapp_id.
      const key = [dweb?.seed, dweb?.dwapp_id, dweb?.uri].find(value => typeof value === 'string' && value);
      return {
        id, name: typeof record.name === 'string' && record.name.trim() ? record.name : 'Unnamed app',
        toneKey: typeof key === 'string' ? key : id,
      };
    }),
  };
};
