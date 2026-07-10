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
import { utf8, toHex, fromHex } from '/shared/bundle/bytes.js';
import { createMatchDriver } from '/peerd-runtime/game/match-driver.js';
import { isGameMessage } from '/peerd-runtime/game/match-reducer.js';
import { runNotebook } from '/web/notebook-host.js';

const GAMES_TOPIC = 'peerd/demo/arena/games/v1';
const RESULTS_TOPIC = 'peerd/demo/arena/results/v1';
const RULES_SOURCE_URL = '/web/games/puzzle-race.js';
const MAX_BUNDLE_BYTES = 256 * 1024;   // a game bundle rides one DM at demo size
const MAX_GAMES = 64;
const SERVE_PER_MIN = 4;               // bundle serves per requesting did
// Demo pacing: the pow race needs a real solve window; everything else default.
const DEMO_DEADLINES = { solving: 90_000 };
const SOLVE_RUN_TIMEOUT_MS = 60_000;   // sealed-worker cap for one solve run

const sha256Hex = async (text) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text))));
const bundleHash = (files) => sha256Hex(canonicalize(files));
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
  /** live + finished match snapshots by matchId (driver events), newest last */
  const matchOrder = [];
  const matchViews = new Map();
  /** leaderboard: did → { w, l, d } — co-signed, sig-verified results only */
  const scores = new Map();
  const seenResults = new Set();
  const serveBuckets = new Map();
  /** pending installs: dwapp_id → { resolve, reject, timer, from } */
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
    // The demo's auto-player: the dwapp's reference solver, in the sealed
    // worker. A competitor with a better solver (or a model) just brings it.
    solve: async (challenge, info) => {
      const g = installedByHash(info.rulesHash);
      if (!g) throw new Error('rules not installed');
      const answer = await runRules(g.files['rules.js'], 'solve', [challenge], SOLVE_RUN_TIMEOUT_MS);
      if (typeof answer !== 'string' || !answer) throw new Error('solver found no answer');
      return { answer };
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
      if (!matchViews.has(evt.matchId)) matchOrder.push(evt.matchId);
      matchViews.set(evt.matchId, evt.state);
      if (evt.type === 'challenge-received') activity(`challenge from ${shortDid(evt.state.players.challenger)}`);
      if (evt.type === 'done') onMatchDone(evt.state);
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

  const tallyResult = (resultString) => {
    let r;
    try { r = JSON.parse(resultString); } catch { return; }
    if (seenResults.has(r.matchId)) return;
    seenResults.add(r.matchId);
    const bump = (did, k) => {
      const s = scores.get(did) ?? { w: 0, l: 0, d: 0 };
      s[k] += 1;
      scores.set(did, s);
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
      activity(`discovered "${g.name}" by ${shortDid(g.publisher)}`);
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
    // both PLAYERS' signatures, over these exact bytes — else it's just a claim
    for (const did of [r.challenger, r.acceptor]) {
      const sig = entry.sigs?.[did];
      if (typeof sig !== 'string') return;
      if (!(await verifySignature(did, fromHex(sig), utf8(entry.result)).catch(() => false))) return;
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
      pendingFetch.set(id, { resolve, reject, timer, from: holder });
      direct.send(holder, { __gamestore: 1, type: 'fetch', id }).catch((e) => {
        clearTimeout(timer); pendingFetch.delete(id); reject(e);
      });
    });
    if (!files || typeof files !== 'object' || typeof files['rules.js'] !== 'string') throw new Error('malformed bundle');
    if (canonicalize(files).length > MAX_BUNDLE_BYTES) throw new Error('bundle too large');
    // THE trust step: bytes must hash to the version the publisher signed.
    if (await bundleHash(files) !== g.hash) throw new Error('bundle hash does not match the signed card');
    g.files = files;
    activity(`installed "${g.name}" (${g.hash.slice(0, 12)}… verified)`);
    emitChange();
    return g;
  };

  /** Share the built-in puzzle-race game: build the dwapp bundle from this
   * page's own source, sign its card, announce it on the lobby. */
  let myCard = null;
  const sharePuzzleRace = async () => {
    const existing = [...games.values()].find((g) => g.publisher === selfDid && g.files);
    if (existing) return existing;
    // eslint-disable-next-line no-restricted-globals -- same-origin read of the page's OWN served asset (the bundled rules source), not egress; the page shell has no safeFetch wiring
    const rulesSource = await (await fetch(RULES_SOURCE_URL)).text();
    const files = {
      'rules.js': rulesSource,
      // the dwapp-actor manifest: installed in the EXTENSION, this same bundle
      // becomes a specialized actor (games are dwapps are actors).
      'peerd.actor.json': JSON.stringify({
        name: 'Puzzle Race',
        description: 'A trustless head-to-head puzzle race between agents over the mesh.',
        skills: [{ name: 'puzzle-race', description: 'derive, solve, and verify seed-derived race puzzles' }],
        tools: [],
      }, null, 2),
    };
    const hash = await bundleHash(files);
    const card = await buildMeta({
      slug: 'puzzle-race',
      name: 'Puzzle Race',
      description: 'Two agents, one seed-derived puzzle, first correct commit wins — commit-reveal fair, co-signed, replayable.',
      seq: Date.now(),
      head: { version_id: hash, content_addr: formatPeerdUri({ did: selfDid, hash }), size: canonicalize(files).length },
    }, identity);
    const g = await upsertCard(card, selfDid);
    if (!g) throw new Error('could not register the shared game');
    g.files = files;
    myCard = card;
    await gossip.publish(GAMES_TOPIC, { card });
    activity(`shared "Puzzle Race" on the lobby (${hash.slice(0, 12)}…)`);
    emitChange();
    return g;
  };

  // Late joiners never heard our announce — re-beacon our card when a peer
  // joins (throttled; gossip publish is cheap in the small demo lobby).
  let lastReannounce = 0;
  presence.onJoin(() => {
    if (!myCard || Date.now() - lastReannounce < 10_000) return;
    lastReannounce = Date.now();
    gossip.publish(GAMES_TOPIC, { card: myCard }).catch(() => {});
  });

  /** Challenge a peer to an installed game (default: any installed one). */
  const challenge = async (peerDid, gameId = null) => {
    const g = gameId
      ? [...games.values()].find((x) => x.files && (x.id === gameId || x.card.salt === gameId))
      : [...games.values()].find((x) => x.files);
    if (!g) throw new Error('no installed game to play — share or install one first');
    activity(`challenging ${shortDid(peerDid)} to "${g.name}"…`);
    return await driver.challenge(peerDid, { gameId: g.card.salt, rulesHash: g.hash, deadlines: DEMO_DEADLINES });
  };

  return {
    selfDid,
    sharePuzzleRace,
    install,
    challenge,
    whenDone: (matchId) => driver.whenDone(matchId),
    games: () => [...games.values()].map((g) => ({
      id: g.id, name: g.name, description: g.description, publisher: g.publisher,
      hash: g.hash, installed: !!g.files, mine: g.publisher === selfDid, holders: g.holders.size,
    })),
    matches: () => matchOrder.map((id) => matchViews.get(id)).filter(Boolean),
    scores: () => [...scores.entries()].map(([did, s]) => ({ did, ...s }))
      .sort((a, b) => (b.w - a.w) || (a.l - b.l)),
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

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function mountArenaUI(panel, { arena, roster }) {
  panel.innerHTML = `
    <div class="arena">
      <div class="nb-section">games on the mesh <span class="hint">— dwapps: shared, discovered, installed p2p</span></div>
      <div class="arena-games" data-slot="games"><span class="hint">none discovered yet — share one, or open peerd-lite in a second tab and share from there</span></div>
      <div class="nb-bar">
        <button class="run" data-act="share">◈ Share Puzzle Race</button>
        <label class="hint"><input type="checkbox" data-act="auto" checked> auto-accept challenges</label>
      </div>
      <div class="nb-section">agents online</div>
      <div class="arena-roster" data-slot="roster"><span class="hint">joining the lobby…</span></div>
      <div class="nb-section">matches</div>
      <div class="arena-matches" data-slot="matches"><span class="hint">no matches yet</span></div>
      <div class="nb-section">leaderboard <span class="hint">— co-signed results only, signatures verified locally</span></div>
      <div class="arena-board" data-slot="board"><span class="hint">no verified results yet</span></div>
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

  const renderGames = () => {
    const gs = arena.games();
    slot('games').innerHTML = gs.length === 0
      ? '<span class="hint">none discovered yet — share one, or open peerd-lite in a second tab and share from there</span>'
      : gs.map((g) => `
        <div class="arena-card">
          <span class="ic k-dweb">◈</span>
          <span class="arena-card-name">${esc(g.name)}</span>
          <span class="hint">by ${g.mine ? 'you' : esc(shortDid(g.publisher))} · ${esc(g.hash.slice(0, 10))}…</span>
          ${g.installed ? '<span class="arena-tag">installed</span>' : `<button class="install-btn" data-install="${esc(g.id)}">⬇ install</button>`}
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
      const o = m.outcome;
      const verdict = !o ? '' : o.kind === 'win'
        ? `<div class="arena-verdict ${o.winner === arena.selfDid ? 'won' : 'lost'}">${o.winner === arena.selfDid ? '● you win' : '● you lose'} — ${esc(o.reason)}${m.coSigned ? ' · co-signed ✓' : ''}</div>`
        : `<div class="arena-verdict">● ${esc(o.kind)} — ${esc(o.reason)}${m.coSigned ? ' · co-signed ✓' : ''}</div>`;
      return `
        <div class="arena-match">
          <div class="hint">vs ${esc(shortDid(opp))} · ${esc(m.gameId)} · ${esc(m.matchId)}</div>
          <div class="arena-pills">${pills}</div>
          ${verdict}
        </div>`;
    }).join('');
  };

  const renderBoard = () => {
    const rows = arena.scores();
    slot('board').innerHTML = rows.length === 0
      ? '<span class="hint">no verified results yet</span>'
      : `<table class="nb-table"><tr><th>agent</th><th>w</th><th>l</th><th>d</th></tr>${rows.map((r) => `
          <tr><td>${r.did === arena.selfDid ? 'you' : esc(shortDid(r.did))}</td><td>${r.w}</td><td>${r.l}</td><td>${r.d}</td></tr>`).join('')}</table>`;
  };

  const renderAll = () => { renderGames(); renderRoster(); renderMatches(); renderBoard(); };
  const offChange = arena.onChange(renderAll);
  const offActivity = arena.onActivity(log);
  renderAll();
  const rosterTimer = setInterval(renderRoster, 3000);   // presence has no single change hook here

  panel.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-install],[data-challenge]');
    if (!t) return;
    try {
      if (t.dataset.act === 'share') { t.disabled = true; await arena.sharePuzzleRace(); t.textContent = '◈ shared'; }
      else if (t.dataset.act === 'auto') arena.setAutoAccept(t.checked);
      else if (t.dataset.install) { t.disabled = true; await arena.install(t.dataset.install); }
      else if (t.dataset.challenge) { t.disabled = true; await arena.challenge(t.dataset.challenge); t.disabled = false; }
    } catch (err) {
      log(`error: ${err?.message || err}`);
      t.disabled = false;
    }
  });

  return () => { offChange(); offActivity(); clearInterval(rosterTimer); };
}
