// web/arena.js — the GAME ARENA: trustless agent-vs-agent puzzle races over
// the demo lobby (docs/specs/PEERD-GAME-ARENA.md).
//
// This is the demo's host wiring for the REAL core framework
// (peerd-runtime/game/): the pure match reducer + IO-injected driver run
// unmodified; this file supplies the IO — the room's signed direct channel as
// the match wire, gossip as the game-store announce + leaderboard fan-out, the
// did:key identity as the result co-signer, and the SEALED notebook worker as
// the only place game rules (peer-authored content!) ever execute. The game
// itself is a dwapp: a content-addressed file bundle (rules.js + manifest)
// shared → discovered → installed over the mesh, hash-verified against its
// signed card before a byte of it runs.
//
// Isolation: everything rides the agent mesh's demo lobby (peerd/demo/1),
// never the production base network.

import { verifyMeta, buildMeta, metaDwappId } from '/peerd-distributed/apps/meta.js';
import { verifySignature } from '/peerd-distributed/identity/keypair.js';
import { formatPeerdUri } from '/peerd-distributed/content/uri.js';
import { canonicalize } from '/shared/bundle/canonical.js';
import { sha256hex } from '/shared/bundle/chunk.js';
import { utf8, toHex, fromHex } from '/shared/bundle/bytes.js';
import { createMatchDriver } from '/peerd-runtime/game/match-driver.js';
import { isGameMessage } from '/peerd-runtime/game/match-reducer.js';
import { resultSigningBytes } from '/peerd-runtime/game/match-log.js';
import { runNotebook } from '/web/notebook-host.js';
import { renderActorGraph } from '/web/actor-graph-view.js';

const GAMES_TOPIC = 'peerd/demo/arena/games/v1';
const RESULTS_TOPIC = 'peerd/demo/arena/results/v1';
const RULES_SOURCE_URL = '/web/games/puzzle-race.js';
const MAX_BUNDLE_BYTES = 256 * 1024;   // a game bundle rides one DM at demo size
const MAX_GAMES = 64;
const SERVE_PER_MIN = 4;               // bundle serves per requesting did
// Demo pacing: a FIXED mining window — long enough to feel the race build,
// short enough to stay snappy; everything else default.
const DEMO_DEADLINES = { solving: 20_000 };
const MINE_BURST_MS = 1_100;           // one sealed-worker search burst
const MINE_COMMIT_MARGIN_MS = 3_500;   // stop mining this long before the deadline
const SOLVE_RUN_TIMEOUT_MS = 10_000;   // sealed-worker cap for one burst run

const bundleHash = (files) => sha256hex(utf8(canonicalize(files)));
const shortDid = (did) => `…${String(did).slice(-6)}`;

/**
 * Start the arena on an already-joined agent mesh (startAgentMesh's return —
 * its `raw` seams carry the identity, direct channel, gossip, and presence).
 * Headless: the UI subscribes via onChange/onActivity; the agent tools call
 * the same API the buttons do.
 */
export async function createArena({ mesh }) {
  const { identity, direct, gossip, presence } = mesh.raw;
  const selfDid = identity.did;

  /** games by dwapp_id: { id, card, name, description, publisher, hash, size,
   *  holders:Set<did>, files|null (null = not installed) } */
  const games = new Map();
  /** live + finished match snapshots by matchId — a Map is insertion-ordered,
   *  so first-seen order IS the display order */
  const matchViews = new Map();
  /** OUR live mining progress per match (best answer/score/hash/tries) — the
   *  UI's live race readout; the opponent's stays sealed until reveal. */
  const mining = new Map();
  /** leaderboards, ONE PER GAME: rulesHash → (did → { w, l, d }). why scoped:
   * co-signing proves both players agreed to a result under THOSE rules — a
   * rigged game's rules happily co-sign its author's wins, so merging games
   * into one board would let any peer-authored game poison the standings of
   * every other. A game can only ever poison its own board. */
  const boardsByHash = new Map();
  const seenResults = new Set();
  const serveBuckets = new Map();
  /** pending installs: dwapp_id → { resolve, timer, from } */
  const pendingFetch = new Map();

  let autoAccept = true;
  const changeCbs = new Set();
  const activityCbs = new Set();
  const emitChange = () => { for (const cb of [...changeCbs]) { try { cb(); } catch { /* UI */ } } };
  const activity = (line) => { for (const cb of [...activityCbs]) { try { cb(line); } catch { /* UI */ } } };

  // ---- sealed-worker execution of game rules (the ONLY place they run) ----
  // The rules file is a plain script whose last binding is `const rules`; we
  // append the one call and read the structured return value. outputEl is a
  // detached node — rules run headless, they never touch the page.
  const runRules = async (source, op, args, timeoutMs = 20_000) => {
    const code = `${source}\nreturn rules[${JSON.stringify(op)}](${args.map((a) => JSON.stringify(a)).join(',')});`;
    const r = await runNotebook(code, { outputEl: document.createElement('div'), timeoutMs });
    if (r.error) throw new Error(`rules.${op}: ${r.error}`);
    return r.value;
  };

  const installedByHash = (hash) => [...games.values()].find((g) => g.files && g.hash === hash) ?? null;

  // ---- the match driver: the real framework, demo IO injected --------------
  const driver = createMatchDriver({
    selfDid,
    send: (to, msg) => direct.send(to, msg),
    rules: {
      derive: (seed, info) => {
        const g = installedByHash(info.rulesHash);
        if (!g) throw new Error('rules not installed');
        return runRules(g.files['rules.js'], 'derive', [seed]);
      },
      check: (seed, answer, info) => {
        const g = installedByHash(info.rulesHash);
        if (!g) throw new Error('rules not installed');
        return runRules(g.files['rules.js'], 'check', [seed, answer]);
      },
    },
    // The demo's auto-player: the dwapp's reference solver, run as SHORT
    // sealed-worker bursts in a loop until just before the commit deadline —
    // the best answer so far surfaces live (mining map → UI) while the
    // opponent's stays sealed until reveal. A competitor with a better solver
    // (or a model) just brings it; the rules only judge the final answer.
    solve: async (challenge, info) => {
      const g = installedByHash(info.rulesHash);
      if (!g) throw new Error('rules not installed');
      let best = null;
      while (Date.now() < info.deadlineAt - MINE_COMMIT_MARGIN_MS) {
        const burst = await runRules(
          g.files['rules.js'], 'solve',
          [challenge, MINE_BURST_MS, best?.answer ?? null],
          SOLVE_RUN_TIMEOUT_MS,
        ).catch(() => null);
        if (burst && typeof burst.answer === 'string'
            && (!best || (burst.score ?? 0) > (best.score ?? 0))) {
          best = { ...burst, tries: (best?.tries ?? 0) + (burst.tries ?? 0) };
        } else if (burst && best) {
          best.tries += burst.tries ?? 0;
        }
        if (best) { mining.set(info.matchId, { ...best, at: Date.now() }); emitChange(); }
      }
      if (!best) throw new Error('solver found no answer');
      return { answer: best.answer };
    },
    signResult: async (result) => toHex(await identity.sign(utf8(result))),
    verifyResultSig: (did, sigHex, result) => verifySignature(did, fromHex(sigHex), utf8(result)),
    // Auto-accept makes the two-tab demo self-driving — and if the challenged
    // game isn't installed yet, try to install it BY HASH from the mesh first:
    // the dwapp trades itself on demand. Fail closed on any miss.
    acceptPolicy: async ({ from, rulesHash, gameId }) => {
      if (!autoAccept) return false;
      if (installedByHash(rulesHash)) return true;
      const card = [...games.values()].find((g) => g.hash === rulesHash);
      if (!card) { activity(`declined ${shortDid(from)}: unknown game ${gameId}`); return false; }
      try { await install(card.id); activity(`auto-installed "${card.name}" to accept the challenge`); return true; }
      catch { activity(`declined ${shortDid(from)}: could not install ${card.name}`); return false; }
    },
    onEvent: (evt) => {
      matchViews.set(evt.matchId, evt.state);
      if (evt.type === 'challenge-received') activity(`challenge from ${shortDid(evt.state.players.challenger)}`);
      if (evt.type === 'done') { mining.delete(evt.matchId); onMatchDone(evt.state); }
      emitChange();
    },
  });

  const onMatchDone = (state) => {
    const o = state.outcome;
    if (!o) return;
    const line = o.kind === 'win' ? `match ${state.matchId}: ${shortDid(o.winner)} wins (${o.reason})`
      : `match ${state.matchId}: ${o.kind} (${o.reason})`;
    activity(line);
    // Only a CO-SIGNED result is leaderboard material — publish ours; peers
    // verify both signatures before tallying (never trust the tally, verify
    // the result).
    if (state.coSigned && state.resultString) {
      tallyResult(state.resultString);
      gossip.publish(RESULTS_TOPIC, { entry: { result: state.resultString, sigs: state.sigs } }).catch(() => {});
    }
  };

  // First write wins per matchId (a co-signed result is immutable; replays and
  // duplicates are dropped). Only games in OUR store tally — an unknown
  // rulesHash has no board to land on.
  const tallyResult = (resultString) => {
    let r;
    try { r = JSON.parse(resultString); } catch { return; }
    if (typeof r.rulesHash !== 'string' || !r.rulesHash) return;
    if (![...games.values()].some((g) => g.hash === r.rulesHash)) return;
    if (seenResults.has(r.matchId)) return;
    seenResults.add(r.matchId);
    let board = boardsByHash.get(r.rulesHash);
    if (!board) { board = new Map(); boardsByHash.set(r.rulesHash, board); }
    const bump = (did, k) => {
      const s = board.get(did) ?? { w: 0, l: 0, d: 0 };
      s[k] += 1;
      board.set(did, s);
    };
    if (r.outcome?.kind === 'win' && r.outcome.winner) {
      bump(r.outcome.winner, 'w');
      bump(r.outcome.winner === r.challenger ? r.acceptor : r.challenger, 'l');
    } else if (r.outcome?.kind === 'draw') {
      bump(r.challenger, 'd'); bump(r.acceptor, 'd');
    }
    emitChange();
  };

  // ---- the game store: share → discover → install over the mesh ------------
  const upsertCard = async (card, holderDid) => {
    if (!(await verifyMeta(card))) return null;
    const id = await metaDwappId(card);
    let g = games.get(id);
    if (!g) {
      if (games.size >= MAX_GAMES) return null;
      g = {
        id, card, publisher: card.publisher, holders: new Set(), files: null,
        name: card.value.name, description: card.value.description,
        hash: card.value.head.version_id, size: card.value.head.size,
      };
      games.set(id, g);
      // our own share announces itself with a "shared …" line; only a card
      // from ELSEWHERE is a discovery
      if (g.publisher !== selfDid) activity(`discovered "${g.name}" by ${shortDid(g.publisher)}`);
    } else if (card.seq > g.card.seq) {
      // a newer signed amendment replaces the card (and outdates our bundle)
      Object.assign(g, { card, name: card.value.name, description: card.value.description });
      if (g.hash !== card.value.head.version_id) { g.hash = card.value.head.version_id; g.files = null; }
    }
    g.holders.add(holderDid);
    g.holders.add(card.publisher);
    emitChange();
    return g;
  };

  gossip.subscribe(GAMES_TOPIC, ({ from, data }) => { upsertCard(data?.card, from).catch(() => {}); });

  gossip.subscribe(RESULTS_TOPIC, async ({ data }) => {
    const entry = data?.entry;
    if (!entry || typeof entry.result !== 'string' || !entry.sigs) return;
    let r;
    try { r = JSON.parse(entry.result); } catch { return; }
    // both PLAYERS' signatures, over the context-wrapped result bytes (the
    // framework's domain separation) — else it's just a claim
    for (const did of [r.challenger, r.acceptor]) {
      const sig = entry.sigs?.[did];
      if (typeof sig !== 'string') return;
      if (!(await verifySignature(did, fromHex(sig), utf8(resultSigningBytes(entry.result))).catch(() => false))) return;
    }
    tallyResult(entry.result);
  });

  // Serve our installed games' bundles to installers (rate-capped per did).
  const allowServe = (did) => {
    const t = Date.now();
    let b = serveBuckets.get(did);
    if (!b || t - b.windowStart > 60_000) { b = { count: 0, windowStart: t }; serveBuckets.set(did, b); }
    if (b.count >= SERVE_PER_MIN) return false;
    b.count += 1;
    return true;
  };

  direct.onMessage(({ from, data }) => {
    if (isGameMessage(data)) { driver.handleInbound(from, data); return; }
    if (!data || data.__gamestore !== 1) return;
    if (data.type === 'fetch') {
      const g = games.get(String(data.id ?? ''));
      if (!g?.files || !allowServe(from)) return;
      direct.send(from, { __gamestore: 1, type: 'bundle', id: g.id, files: g.files }).catch(() => {});
      activity(`served "${g.name}" to ${shortDid(from)}`);
      return;
    }
    if (data.type === 'bundle') {
      const pending = pendingFetch.get(String(data.id ?? ''));
      if (!pending || pending.from !== from) return;   // unsolicited bundle: drop
      pendingFetch.delete(String(data.id));
      clearTimeout(pending.timer);
      pending.resolve(data.files);
    }
  });

  /** Install a discovered game: fetch the bundle from a holder, then verify
   * the bytes against the SIGNED card's content hash before keeping them. */
  const install = async (id) => {
    const g = games.get(id);
    if (!g) throw new Error('unknown game');
    if (g.files) return g;
    const holder = [...g.holders].find((d) => d !== selfDid);
    if (!holder) throw new Error('no online holder to fetch from');
    if (pendingFetch.has(id)) throw new Error('install already in flight');
    const files = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingFetch.delete(id); reject(new Error('bundle fetch timed out')); }, 15_000);
      pendingFetch.set(id, { resolve, timer, from: holder });
      direct.send(holder, { __gamestore: 1, type: 'fetch', id }).catch((e) => {
        clearTimeout(timer); pendingFetch.delete(id); reject(e);
      });
    });
    // shape only — a bundle is ANY flat map of text files (a game, an app,
    // data); the SIGNED HASH below is the real gate.
    const paths = files && typeof files === 'object' && !Array.isArray(files) ? Object.keys(files) : [];
    if (paths.length === 0 || paths.length > 32
        || !paths.every((k) => k.length <= 128 && typeof files[k] === 'string')) throw new Error('malformed bundle');
    if (canonicalize(files).length > MAX_BUNDLE_BYTES) throw new Error('bundle too large');
    // THE trust step: bytes must hash to the version the publisher signed.
    if (await bundleHash(files) !== g.hash) throw new Error('bundle hash does not match the signed card');
    g.files = files;
    activity(`installed "${g.name}" (${g.hash.slice(0, 12)}… verified)`);
    emitChange();
    return g;
  };

  /** Share ANY dwapp bundle onto the lobby: sign its card, register it as
   * ours, announce. THE general trade primitive — games are one kind of
   * bundle on the same shelf. Sharing the same slug again with new files is
   * a signed AMENDMENT (seq bumps; peers see the new version). */
  const myCards = [];
  const shareDwapp = async ({ slug, name, description = '', files }) => {
    const hash = await bundleHash(files);
    const card = await buildMeta({
      slug, name, description,
      seq: Date.now(),
      head: { version_id: hash, content_addr: formatPeerdUri({ did: selfDid, hash }), size: canonicalize(files).length },
    }, identity);
    const g = await upsertCard(card, selfDid);
    if (!g) throw new Error('could not register the shared dwapp');
    g.files = files;
    myCards.push(card);
    await gossip.publish(GAMES_TOPIC, { card });
    activity(`shared "${name}" on the lobby (${hash.slice(0, 12)}…)`);
    emitChange();
    return g;
  };

  /** The built-in game, built from this page's own served source. */
  const sharePuzzleRace = async () => {
    const existing = [...games.values()].find((g) => g.publisher === selfDid && g.files?.['rules.js']);
    if (existing) return existing;
    // eslint-disable-next-line no-restricted-globals -- same-origin read of the page's OWN served asset (the bundled rules source), not egress; the page shell has no safeFetch wiring
    const rulesSource = await (await fetch(RULES_SOURCE_URL)).text();
    return await shareDwapp({
      slug: 'puzzle-race',
      name: 'Puzzle Race',
      description: 'Two agents, one seed, a fixed window: lowest hash wins — commit-reveal fair, co-signed, replayable.',
      files: {
        'rules.js': rulesSource,
        // the dwapp-actor manifest: installed in the EXTENSION, this same bundle
        // becomes a specialized actor (games are dwapps are actors).
        'peerd.actor.json': JSON.stringify({
          name: 'Puzzle Race',
          description: 'A trustless head-to-head mining race between agents over the mesh.',
          skills: [{ name: 'puzzle-race', description: 'derive, solve, and verify seed-derived race puzzles' }],
          tools: [],
        }, null, 2),
      },
    });
  };

  // Late joiners never heard our announces — re-beacon our cards when a peer
  // joins (throttled; gossip publish is cheap in the small demo lobby).
  let lastReannounce = 0;
  presence.onJoin(() => {
    if (myCards.length === 0 || Date.now() - lastReannounce < 10_000) return;
    lastReannounce = Date.now();
    for (const card of myCards) gossip.publish(GAMES_TOPIC, { card }).catch(() => {});
  });

  // A bundle's KIND, from what's in it: rules.js = a playable game; an
  // index.html = a runnable app; else opaque data. Only knowable once the
  // bytes are local — an un-installed card is just a card.
  const kindOf = (files) => (files?.['rules.js'] ? 'game' : files?.['index.html'] ? 'app' : files ? 'data' : null);

  /** Challenge a peer to the first installed GAME. @param {string} peerDid */
  const challenge = async (peerDid) => {
    const g = [...games.values()].find((x) => kindOf(x.files) === 'game');
    if (!g) throw new Error('no installed game to play — share or install one first');
    activity(`challenging ${shortDid(peerDid)} to "${g.name}"…`);
    return await driver.challenge(peerDid, { gameId: g.card.salt, rulesHash: g.hash, deadlines: DEMO_DEADLINES });
  };

  return {
    selfDid,
    shareDwapp,
    sharePuzzleRace,
    install,
    challenge,
    whenDone: (matchId) => driver.whenDone(matchId),
    games: () => [...games.values()].map((g) => ({
      id: g.id, name: g.name, description: g.description, publisher: g.publisher,
      hash: g.hash, installed: !!g.files, kind: kindOf(g.files), mine: g.publisher === selfDid, holders: g.holders.size,
    })),
    /** The installed bundle (for the host to open/run). @param {string} id */
    bundle: (id) => {
      const g = games.get(id);
      return g?.files ? { name: g.name, files: g.files, kind: kindOf(g.files) } : null;
    },
    matches: () => [...matchViews.values()],
    mining: (matchId) => mining.get(matchId) ?? null,
    // One board per game (rules-hash scoped — see boardsByHash). Ordered like
    // the store list; only games with at least one tallied result appear.
    boards: () => [...games.values()]
      .filter((g) => boardsByHash.has(g.hash))
      .map((g) => ({
        rulesHash: g.hash,
        name: g.name,
        rows: [...(boardsByHash.get(g.hash) ?? new Map()).entries()]
          .map(([did, s]) => ({ did, ...s }))
          .sort((a, b) => (b.w - a.w) || (a.l - b.l)),
      })),
    setAutoAccept: (on) => { autoAccept = !!on; emitChange(); },
    autoAccept: () => autoAccept,
    onChange: (cb) => { changeCbs.add(cb); return () => changeCbs.delete(cb); },
    onActivity: (cb) => { activityCbs.add(cb); return () => activityCbs.delete(cb); },
    close: () => driver.close(),
  };
}

// ---------------------------------------------------------------------------
// UI — the arena tab. Grayscale like the rest of the shell; the magenta ◈
// marks the dweb-carried pieces, win/lose reuse the existing status colors.

const PHASES = ['proposed', 'seeding', 'solving', 'revealing', 'scoring', 'signing', 'done'];

// Protocol reasons → human verdicts (fallback: the raw reason).
const REASON_LABELS = {
  'committed-first': 'first correct commit',
  correctness: 'the only valid answer',
  score: 'found the lower hash',
  simultaneous: 'dead heat — both committed at once',
  'order-disputed': 'commit order disputed',
  'neither-correct': 'neither found a valid answer',
  resigned: 'resignation',
};
const reasonLabel = (r) => REASON_LABELS[r] ?? (String(r).endsWith('-timeout') ? 'deadline passed' : r);

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (s, n) => { const t = String(s ?? ''); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };

export function mountArenaUI(panel, { arena, roster, localActors = () => [], openBundle = null, makePad = null }) {
  panel.innerHTML = `
    <div class="arena">
      <div class="nb-section">the agent web <span class="hint">— you · your actors · agents on the mesh</span></div>
      <div class="arena-graph" data-slot="graph"></div>
      <div class="nb-section">the dwapp store <span class="hint">— apps and games, created + traded peer-to-peer, run sandboxed</span></div>
      <div class="arena-games" data-slot="games"><span class="hint">nothing on the shelf yet — make or share something, or open this page in a second tab</span></div>
      <div class="nb-bar">
        ${makePad ? '<button class="run" data-act="make">✎ Make a pixel pad</button>' : ''}
        <button class="run" data-act="share">◈ Share Puzzle Race</button>
        <label class="hint"><input type="checkbox" data-act="auto" checked> auto-accept challenges</label>
      </div>
      <div class="nb-section">matches</div>
      <div class="arena-matches" data-slot="matches"><span class="hint">no matches yet</span></div>
      <div class="nb-section">leaderboard <span class="hint">— co-signed results only, signatures verified locally</span></div>
      <div class="arena-board" data-slot="board"><span class="hint">no verified results yet</span></div>
      <div class="nb-section">agents online</div>
      <div class="arena-roster" data-slot="roster"><span class="hint">joining the lobby…</span></div>
      <div class="nb-section">activity</div>
      <div class="nb-console arena-log" data-slot="log"></div>
      <p class="substrate">mounts: peerd-runtime/game (match reducer + driver) · peerd-distributed meta/gossip/direct · rules run SEALED in the notebook worker · lobby peerd/demo/1</p>
    </div>`;

  const slot = (name) => panel.querySelector(`[data-slot="${name}"]`);
  const log = (line) => {
    const el = slot('log');
    const d = document.createElement('div');
    d.className = 'nbline log-info';
    d.textContent = `${new Date().toLocaleTimeString()} ${line}`;
    el.appendChild(d);
    while (el.childElementCount > 60) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  };

  const KIND_BADGE = { game: '⛏ game', app: '◇ app', data: '· data' };
  const renderGames = () => {
    const gs = arena.games();
    slot('games').innerHTML = gs.length === 0
      ? '<span class="hint">nothing on the shelf yet — make or share something, or open this page in a second tab</span>'
      : gs.map((g) => `
        <div class="arena-card">
          <span class="ic k-dweb">◈</span>
          <span class="arena-card-name">${esc(g.name)}</span>
          <span class="hint">${g.kind ? `${KIND_BADGE[g.kind] ?? g.kind} · ` : ''}by ${g.mine ? 'you' : esc(shortDid(g.publisher))} · ${esc(g.hash.slice(0, 10))}…</span>
          ${g.installed
    ? `${g.kind === 'app' && openBundle ? `<button class="install-btn" data-open="${esc(g.id)}">▶ open</button>` : ''}${
      g.kind === 'game' && roster().length > 0 ? '<button class="install-btn arena-race-btn" data-race="1">⚡ race</button>' : ''
    }<span class="arena-tag">installed</span>`
    : `<button class="install-btn" data-install="${esc(g.id)}">⬇ install</button>`}
        </div>`).join('');
  };

  const renderRoster = () => {
    const peers = roster();
    slot('roster').innerHTML = peers.length === 0
      ? '<span class="hint">no other agents online — open peerd-lite in a second tab to add one</span>'
      : peers.map((p) => `
        <div class="arena-card">
          <span class="ic k-dweb">◈</span>
          <span class="arena-card-name">${esc(p.card?.name || 'agent')}</span>
          <span class="hint">${esc(shortDid(p.did))}</span>
          <button class="install-btn" data-challenge="${esc(p.did)}">◆ challenge</button>
        </div>`).join('');
  };

  const renderMatches = () => {
    const ms = arena.matches();
    if (ms.length === 0) { slot('matches').innerHTML = '<span class="hint">no matches yet</span>'; return; }
    slot('matches').innerHTML = ms.slice(-6).reverse().map((m) => {
      const meIdx = m.players.challenger === arena.selfDid ? 'challenger' : 'acceptor';
      const opp = meIdx === 'challenger' ? m.players.acceptor : m.players.challenger;
      const phaseIdx = PHASES.indexOf(m.phase);
      const pills = PHASES.map((p, i) => `<span class="arena-pill${i < phaseIdx ? ' on' : ''}${i === phaseIdx ? ' now' : ''}">${p}</span>`).join('');
      // The puzzle itself — the thing being raced. Rules output is
      // peer-derived content: escaped and clamped, never trusted markup.
      const prompt = m.challenge?.prompt
        ? `<div class="hint arena-prompt">◇ ${esc(clamp(m.challenge.prompt, 220))}</div>` : '';
      // THE LIVE RACE: our best hash improving in real time; the opponent's is
      // sealed until reveal (that's not a UI choice — it's the commit-reveal).
      const hexOf = (score) => `0x${(4294967296 - score).toString(16).padStart(8, '0')}`;
      let race = '';
      if (m.phase === 'solving') {
        const left = Math.max(0, Math.ceil((m.phaseAt + (m.deadlines?.solving ?? 0) - Date.now()) / 1000));
        const mine = arena.mining(m.matchId);
        race = `<div class="arena-race">⛏ mining · <b>${left}s</b> left
          <span class="arena-best">${mine ? `your best: <b>${hexOf(mine.score)}</b> · ${Number(mine.tries).toLocaleString()} tries` : 'searching…'}</span>
          <span class="arena-sealed">opponent: ▓▓▓▓▓▓ sealed</span></div>`;
      } else if (m.phase === 'revealing' || m.phase === 'scoring' || m.phase === 'signing') {
        race = `<div class="arena-race">⛏ window closed — revealing committed answers…</div>`;
      }
      const v = m.verdicts ?? {};
      const showdown = m.outcome && v[arena.selfDid] && v[opp]
        ? `<div class="hint">you: <b>${hexOf(v[arena.selfDid].score)}</b> · ${esc(shortDid(opp))}: <b>${hexOf(v[opp].score)}</b> — lower hash wins</div>` : '';
      const o = m.outcome;
      const verdict = !o ? '' : o.kind === 'win'
        ? `<div class="arena-verdict ${o.winner === arena.selfDid ? 'won' : 'lost'}">${o.winner === arena.selfDid ? '● you win' : '● you lose'} — ${esc(reasonLabel(o.reason))}${m.coSigned ? ' · co-signed ✓' : ''}</div>`
        : `<div class="arena-verdict">● ${esc(o.kind)} — ${esc(reasonLabel(o.reason))}${m.coSigned ? ' · co-signed ✓' : ''}</div>`;
      return `
        <div class="arena-match">
          <div class="hint">vs ${esc(shortDid(opp))} · ${esc(m.gameId)} · ${esc(m.matchId)}</div>
          ${prompt}
          <div class="arena-pills">${pills}</div>
          ${race}
          ${showdown}
          ${verdict}
        </div>`;
    }).join('');
  };

  const renderBoard = () => {
    const boards = arena.boards();
    slot('board').innerHTML = boards.length === 0
      ? '<span class="hint">no verified results yet</span>'
      : boards.map((b) => `
        <div class="hint">${esc(b.name)} · ${esc(b.rulesHash.slice(0, 10))}…</div>
        <table class="nb-table"><tr><th>agent</th><th>w</th><th>l</th><th>d</th></tr>${b.rows.map((r) => `
          <tr><td>${r.did === arena.selfDid ? 'you' : esc(shortDid(r.did))}</td><td>${r.w}</td><td>${r.l}</td><td>${r.d}</td></tr>`).join('')}</table>`).join('');
  };

  // The agent web, from what the arena already knows: installed game dwapps
  // are ACTOR nodes; live matches light the edge to the opponent and to the
  // game being played; a peer that holds a game gets a faint serving edge.
  const renderGraph = () => {
    const games = arena.games();
    const peers = roster();
    const matches = arena.matches();
    const live = matches.filter((m) => m.phase !== 'done');
    const activeHashes = new Set(live.map((m) => m.rulesHash));
    const opponentOf = (m) => (m.players.challenger === arena.selfDid ? m.players.acceptor : m.players.challenger);
    renderActorGraph(slot('graph'), {
      selfLabel: 'you',
      actors: [
        ...localActors(),
        ...games.filter((g) => g.installed).map((g) => ({ type: 'app', handle: g.id, name: g.name, live: true, isActor: true })),
      ],
      edges: [
        ...localActors().map((a) => ({ to: String(a.handle), live: !!a.live })),
        ...games.filter((g) => g.installed).map((g) => ({ to: g.id, live: activeHashes.has(g.hash) })),
        ...matches.map((m) => ({ to: opponentOf(m), live: m.phase !== 'done' })),
        // who PUBLISHED which dwapp — the trade provenance (a publisher who
        // isn't on the graph right now just yields a dropped dangling edge)
        ...games.filter((g) => g.installed).map((g) => ({ from: g.publisher, to: g.id, live: false })),
      ],
      peers: peers.map((p) => ({ did: p.did, label: p.card?.name || undefined })),
    });
  };

  const renderAll = () => { renderGraph(); renderGames(); renderRoster(); renderMatches(); renderBoard(); };
  const offChange = arena.onChange(renderAll);
  const offActivity = arena.onActivity(log);
  renderAll();
  // 1s ticker: the live-race countdown needs it; roster/graph only every 3rd
  // tick (presence has no single change hook here).
  let tick = 0;
  const rosterTimer = setInterval(() => {
    renderMatches();
    if (++tick % 3 === 0) { renderRoster(); renderGraph(); }
  }, 1000);

  panel.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-install],[data-challenge],[data-open],[data-race]');
    if (!t) return;
    try {
      if (t.dataset.act === 'share') { t.disabled = true; await arena.sharePuzzleRace(); t.textContent = '◈ shared'; }
      else if (t.dataset.act === 'make' && makePad) { await makePad(); }
      else if (t.dataset.act === 'auto') arena.setAutoAccept(t.checked);
      else if (t.dataset.install) { t.disabled = true; await arena.install(t.dataset.install); }
      else if (t.dataset.open && openBundle) { openBundle(t.dataset.open); }
      else if (t.dataset.race) {
        // race = challenge the first agent online with the installed game
        const peer = roster()[0];
        if (!peer) throw new Error('no agents online — open this page in a second tab');
        t.disabled = true;
        await arena.challenge(peer.did);
        t.disabled = false;
      }
      else if (t.dataset.challenge) { t.disabled = true; await arena.challenge(t.dataset.challenge); t.disabled = false; }
    } catch (err) {
      log(`error: ${err?.message || err}`);
      t.disabled = false;
    }
  });

  return () => { offChange(); offActivity(); clearInterval(rosterTimer); };
}
