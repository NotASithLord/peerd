// Native loopback transport acceptance, not a WAN or multi-machine benchmark.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPeerd, attach } from './e2e-harness.mjs';
import { createSignalingServer } from '../../signaling-node/bun-server.mjs';
import { BOOTSTRAP_LIMITS } from '../../signaling-node/admission-budget.js';

export const SCALE_BUDGETS = Object.freeze({ runMs: 600_000, commandMs: 10_000,
  convergenceMs: 90_000, operationMs: 30_000, outageMs: 10_000, cleanupMs: 30_000,
  launchMs: 60_000, fixtureMs: 20_000, retirementMs: 20_000,
  pacedJoinMs: 2_000, pollMs: 500 });
// Independently selected acceptance ceilings for the current production defaults.
// Neither default is exported; do not pass these into production constructors.
// A future default increase must earn new measured acceptance, not silently
// move the oracle with its implementation. Native ownership includes pending ICE.
const SCALE_ACCEPTANCE = Object.freeze({ degree: 16, pending: 8, queued: 64 });
export function scaleOptions(args) {
  const options = { peers: 16, mode: 'paced' };
  for (const arg of args) {
    if (/^--peers=(16|32|64)$/.test(arg)) options.peers = Number(arg.slice(8));
    else if (arg === '--mode=paced' || arg === '--mode=stress') options.mode = arg.slice(7);
    else throw new Error(`unsupported scale option: ${arg}`);
  }
  return options;
}
// Connectivity requires reciprocal admitted links. A stale one-sided mesh row
// must not manufacture a path that cannot carry the later application proof.
export function connected(rows) {
  if (!rows.length || rows.some(row => !row?.did)) return false;
  const byDid = new Map(rows.map(row => [row.did, row]));
  if (byDid.size !== rows.length) return false;
  const seen = new Set([rows[0].did]), pending = [rows[0].did];
  for (const did of pending) for (const peer of byDid.get(did).peers) {
    if (byDid.get(peer)?.peers.includes(did) && !seen.has(peer)) { seen.add(peer); pending.push(peer); }
  }
  return seen.size === rows.length;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Keep startup failures separate from routine room warnings. A busy earlier
// peer must not evict the module-load evidence for a later, unready context.
export function startupEvidence(index) {
  const state = { index, phase: 'created', errors: [], lifecycle: [], requests: 0, completed: 0, pending: {}, droppedRequests: 0 };
  const error = value => { if (state.errors.length < 16) state.errors.push(value); };
  const path = value => { try { return new URL(value).pathname.slice(0, 240); } catch { return ''; } };
  return { state, event(method, params) {
    const at = Date.now();
    if (method === 'Runtime.exceptionThrown') error({ at, kind: method, text: String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text).slice(0, 1000) });
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') error({ at, kind: method,
      text: (params.args ?? []).map(arg => String(arg.value ?? arg.description ?? arg.type)).join(' ').slice(0, 1000) });
    if (method === 'Network.requestWillBeSent' && ['Document', 'Script'].includes(params.type)) {
      state.requests++;
      if (Object.keys(state.pending).length < 256) state.pending[params.requestId] = { path: path(params.request?.url), type: params.type };
      else state.droppedRequests++;
    }
    if (method === 'Network.responseReceived' && params.response?.status >= 400) error({ at, kind: method, path: path(params.response.url), status: params.response.status });
    if (method === 'Network.loadingFailed') error({ at, kind: method, request: state.pending[params.requestId], text: String(params.errorText).slice(0, 240), canceled: !!params.canceled });
    if (['Network.loadingFinished', 'Network.loadingFailed'].includes(method) && Object.hasOwn(state.pending, params.requestId)) {
      delete state.pending[params.requestId]; state.completed++;
    }
    if (['Page.lifecycleEvent', 'Runtime.executionContextsCleared', 'Runtime.executionContextDestroyed', 'Inspector.targetCrashed', 'Target.targetCrashed', 'Target.targetDestroyed', 'Target.detachedFromTarget'].includes(method)) {
      state.lifecycle.push({ at, kind: method, name: params.name, contextId: params.executionContextId, status: params.status, errorCode: params.errorCode });
      if (state.lifecycle.length > 16) state.lifecycle.shift();
    }
  } };
}
export async function stopScalePeers(peers, invoke) {
  const initialized = peers.filter(peer => peer.ready);
  const stops = await Promise.allSettled(initialized.map(peer => invoke(peer, 'stop')));
  return { uninitialized: peers.filter(peer => !peer.ready).map(peer => ({ index: peer.index, phase: peer.diagnostic.state.phase, productionStartInvoked: false, nativeCleanup: 'unavailable' })),
    stops: stops.map((result, index) => ({ index: initialized[index].index, productionStartInvoked: initialized[index].diagnostic.state.startInvoked === true,
      ok: result.status === 'fulfilled', error: result.status === 'rejected' ? String(result.reason).slice(0, 400) : undefined })) };
}
// This workload isolates native network joins from browser cold-page creation.
// Preparation failure starts no peer; the caller still owns every ready module.
export async function prepareAndJoinScale(options, { prepare, prepared, start, wait = sleep }) {
  const peers = [];
  for (let index = 0; index < options.peers; index++) peers.push(await prepare(index));
  await prepared(peers);
  for (const peer of peers) {
    await start(peer);
    if (options.mode === 'paced' && peer !== peers.at(-1)) await wait(SCALE_BUDGETS.pacedJoinMs);
  }
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function runScale(options = scaleOptions(process.argv.slice(2))) {
  const output = join(repo, 'artifacts/dweb-scale', `${options.peers}-${options.mode}`);
  mkdirSync(output, { recursive: true });
  const report = { ok: false, options, budgets: SCALE_BUDGETS, acceptance: SCALE_ACCEPTANCE, stage: 'starting', checks: [], samples: [],
    workload: 'All static fixture modules are prepared before paced or stress network joins. Cold-page creation under an active mesh is not measured.',
    limitation: 'One Chrome process on one machine, isolated browser contexts, localhost ICE with no STUN/TURN. No WAN, NAT, multi-machine throughput, or raised-degree claim.',
    observedPeaks: { memberships: 0, sockets: 0 }, resourceViolations: [], startup: [], cleanup: null };
  const save = () => {
    report.population = { ...report.population, prepared: report.startup.filter(row => row.prepared).length,
      startInvoked: report.startup.filter(row => row.startInvoked).length };
    writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
  };
  let failed = false, retiring = false, ctx, browser, signaling, server, signalPort;
  const peers = [], sockets = new Set();
  const cleanupErrors = [];
  const bounded = async (label, operation, ms = SCALE_BUDGETS.commandMs) => {
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms);
    })]); } finally { clearTimeout(timer); }
  };
  const stage = value => { report.stage = value; save(); };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: !!ok, detail }); save();
    if (!ok) throw new Error(name);
  };
  const emergency = () => {
    retiring = true; signaling?.stop(); browser?.close();
    for (const socket of sockets) socket.destroy(); server?.close();
    void ctx?.close();
  };
  const watchdog = setTimeout(() => {
    failed = true; report.error = `whole-run deadline at ${report.stage}`; save(); emergency(); process.exit(1);
  }, SCALE_BUDGETS.runMs);
  const send = (method, params = {}, sessionId, ms = SCALE_BUDGETS.commandMs) => bounded(method, () => browser.send(method, params, sessionId), ms);
  const invoke = async (peer, operation, values = [], ms = SCALE_BUDGETS.operationMs) => bounded(operation, async () => {
    const global = await send('Runtime.evaluate', { expression: 'globalThis' }, peer.sessionId);
    const objectId = global.result?.objectId;
    if (!objectId) throw new Error('fixture context unavailable');
    try {
      const reply = await send('Runtime.callFunctionOn', {
        objectId, functionDeclaration: 'function(op, values) { return globalThis.__DWEB_SCALE__[op](...values); }',
        arguments: [{ value: operation }, { value: values }], returnByValue: true, awaitPromise: true,
      }, peer.sessionId, ms);
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result?.value;
    } finally { await send('Runtime.releaseObject', { objectId }, peer.sessionId); }
  }, ms);
  const serverSnapshot = () => {
    const serverState = signaling.stats();
    report.population = { ...report.population, memberships: serverState.memberships };
    const capped = { connections: 'sockets', rooms: 'rooms', joins: 'processJoins', messages: 'processMessages', ingressBytes: 'processIngressBytes', egressFrames: 'processEgressFrames', egressBytes: 'processEgressBytes' };
    for (const [key, limit] of Object.entries(capped)) if (serverState[key] > BOOTSTRAP_LIMITS[limit] && report.resourceViolations.length < 32) {
      report.resourceViolations.push({ key, actual: serverState[key], limit: BOOTSTRAP_LIMITS[limit] });
    }
    report.observedPeaks.memberships = Math.max(report.observedPeaks.memberships, serverState.memberships);
    report.observedPeaks.sockets = Math.max(report.observedPeaks.sockets, serverState.connections);
    return serverState;
  };
  const snapshots = async () => {
    const rows = await Promise.all(peers.filter(peer => peer.ready).map(peer => invoke(peer, 'report')));
    const serverState = serverSnapshot();
    report.samples.push({ at: Date.now(), stage: report.stage, signaling: serverState, peers: rows });
    if (report.samples.length > 24) report.samples.shift();
    save(); return rows;
  };
  const until = async (name, probe, ms = SCALE_BUDGETS.convergenceMs) => {
    stage(name); const end = performance.now() + ms;
    do { const value = await probe(); if (value) return value; await sleep(SCALE_BUDGETS.pollMs); } while (performance.now() < end);
    throw new Error(`${name} condition deadline`);
  };
  const gossip = async (tag, requireNonNeighbor = false) => {
    const source = peers[0], target = peers.at(-1);
    const before = await snapshots();
    if (requireNonNeighbor) {
      await invoke(source, 'drop', [before.at(-1).did]);
      await invoke(target, 'drop', [before[0].did]);
    }
    const dispatched = await invoke(source, 'publish', [tag, requireNonNeighbor ? before.at(-1).did : undefined]);
    const delivered = await until(`gossip ${tag}`, async () => {
      const rows = await snapshots();
      return rows.slice(1).every(row => row.received.some(([seen, receipt]) => seen === tag && receipt.from === before[0].did)) && rows;
    }, SCALE_BUDGETS.operationMs);
    const receipt = delivered.at(-1).received.find(([seen]) => seen === tag)?.[1];
    check(`all-recipient authenticated gossip ${tag}`, !requireNonNeighbor || (receipt?.via && receipt.via !== dispatched.from), { ...dispatched, targetReceipt: receipt });
  };
  try {
    save();
    signaling = createSignalingServer({ port: 0, hostname: '127.0.0.1' }); signalPort = signaling.server.port;
    const extension = join(repo, 'extension');
    server = createServer((request, response) => {
      try {
        const path = resolve(extension, '.' + new URL(request.url, 'http://localhost').pathname);
        if (!path.startsWith(extension + sep)) { response.writeHead(403); response.end(); return; }
        const bytes = readFileSync(path);
        response.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : 'text/html' }); response.end(bytes);
      } catch { response.writeHead(404); response.end(); }
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await bounded('fixture listen', () => new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); }));
    stage('launch Chrome');
    ctx = await bounded('launch Chrome', async () => {
      const launched = await launchPeerd({ interceptModel: false, enforceWebSecurity: true, webRtcLoopbackAcceptance: true });
      if (retiring) { await launched.close(); throw new Error('launch retired'); } return launched;
    }, SCALE_BUDGETS.launchMs);
    const version = await bounded('browser version', async () => (await fetch(`http://127.0.0.1:${ctx.port}/json/version`)).json());
    report.browser = version.Browser;
    browser = await bounded('browser attach', async () => {
      const attached = await attach(version.webSocketDebuggerUrl);
      if (retiring) { attached.close(); throw new Error('attach retired'); } return attached;
    });
    browser.on((method, params, message) => {
      if (browser.events.length > 64) browser.events.splice(0, browser.events.length - 64);
      const peer = peers.find(value => (message.sessionId && value.sessionId === message.sessionId)
        || (params.targetId && value.targetId === params.targetId)
        || (method === 'Target.detachedFromTarget' && value.sessionId === params.sessionId));
      if (peer) {
        peer.diagnostic.event(method, params);
        // Persist failures immediately; stage saves retain ordinary request
        // progress without turning every signaling message into synchronous IO.
        if (method === 'Runtime.exceptionThrown' || method === 'Network.loadingFailed'
          || method.endsWith('Crashed') || (method === 'Runtime.consoleAPICalled' && params.type === 'error')) save();
      }
    });
    await send('Target.setDiscoverTargets', { discover: true });
    const createPeer = async index => {
      stage(`fixture ${index} context creation`);
      const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
      const diagnostic = startupEvidence(index);
      const peer = { index, browserContextId, diagnostic, ready: false }; peers.push(peer); report.startup.push(diagnostic.state);
      diagnostic.state.startInvoked = false;
      const target = await send('Target.createTarget', { browserContextId, url: 'about:blank' });
      peer.targetId = target.targetId;
      peer.sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
      await send('Runtime.enable', {}, peer.sessionId);
      await send('Inspector.enable', {}, peer.sessionId);
      await send('Page.enable', {}, peer.sessionId);
      await send('Page.setLifecycleEventsEnabled', { enabled: true }, peer.sessionId);
      await send('Network.enable', {}, peer.sessionId);
      diagnostic.state.phase = 'navigating'; stage(`fixture ${index} navigation`);
      const navigation = await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/tests/dweb-scale.html?url=${encodeURIComponent(`ws://127.0.0.1:${signalPort}/rendezvous`)}` }, peer.sessionId);
      diagnostic.state.navigation = navigation;
      if (navigation.errorText) throw new Error(`fixture ${index} navigation: ${navigation.errorText}`);
      await until(`fixture ${index} ready`, async () => {
        const value = await send('Runtime.evaluate', { expression: '({fixtureReady:!!globalThis.__DWEB_SCALE__,documentState:document.readyState,path:location.pathname})', returnByValue: true }, peer.sessionId);
        diagnostic.state.lastProbe = { at: Date.now(), value: value.result?.value, error: value.exceptionDetails?.text };
        return value.result?.value?.fixtureReady === true;
      }, SCALE_BUDGETS.fixtureMs);
      peer.ready = true; diagnostic.state.prepared = true; diagnostic.state.phase = 'prepared'; save();
      return peer;
    };
    await prepareAndJoinScale(options, { prepare: createPeer,
      prepared: async () => {
        stage('all fixtures prepared before network joins');
        const rows = await snapshots();
        check('prepared fixtures have not started native networking', rows.length === options.peers
          && rows.every(row => !row.did && row.constructed === 0 && row.resources.pcs === 0 && row.resources.channels === 0 && row.resources.sockets === 0)
          && signaling.stats().connections === 0 && signaling.stats().memberships === 0);
      },
      start: async peer => {
        peer.diagnostic.state.phase = 'starting'; peer.diagnostic.state.startInvoked = true;
        stage(`peer ${peer.index} network start`);
        await invoke(peer, 'start');
        peer.diagnostic.state.phase = 'started'; peer.diagnostic.state.initial = await invoke(peer, 'report');
        peer.diagnostic.state.signaling = serverSnapshot(); save();
      },
    });
    const joined = await until('full membership and reciprocal connectivity', async () => {
      const rows = await snapshots();
      return signaling.stats().memberships === options.peers && rows.every(row => row.rendezvous === 'up') && connected(rows) && rows;
    });
    check('membership is distinct from active degree', joined.length === options.peers && joined.every(row => row.peers.length <= SCALE_ACCEPTANCE.degree),
      { membership: signaling.stats().memberships, degrees: joined.map(row => row.peers.length) });
    check('every identity uses native data channels', joined.every(row => row.constructed > 0 && row.opened > 0));
    await gossip('initial-non-neighbor', true);
    const published = await invoke(peers[0], 'publishContent');
    const fetchFromNeighbor = async () => {
      const rows = await snapshots();
      const index = rows.findIndex((row, at) => at > 0 && row.peers.includes(rows[0].did) && rows[0].peers.includes(row.did));
      if (index < 1) throw new Error('no distinct native content neighbor');
      return { ...(await invoke(peers[index], 'fetchContent', [published.uri, published.hash])), receiver: rows[index].did, provider: rows[0].did };
    };
    const transfer = await fetchFromNeighbor();
    check('signed content hash and decoded bytes verified', transfer.contentVerified && transfer.hash === published.hash, transfer);
    await invoke(peers.at(-1), 'isolate');
    await until('isolated peer reconnects through production maintenance', async () => {
      const rows = await snapshots(); return rows.at(-1).peers.length > 0 && connected(rows);
    });
    await gossip('after-churn');
    stage('signaling outage'); signaling.stop();
    await until('all rendezvous sessions observe outage', async () => (await snapshots()).every(row => row.rendezvous !== 'up'), SCALE_BUDGETS.retirementMs);
    await gossip('during-outage');
    await sleep(SCALE_BUDGETS.outageMs);
    signaling = createSignalingServer({ port: signalPort, hostname: '127.0.0.1' });
    await until('signaling membership restored', async () => {
      const rows = await snapshots(); return signaling.stats().memberships === options.peers && rows.every(row => row.rendezvous === 'up') && connected(rows);
    });
    await gossip('after-signaling-recovery');
    const recovered = await fetchFromNeighbor();
    check('verified content after outage', recovered.contentVerified && recovered.hash === published.hash, recovered);
    const final = await snapshots();
    check('observed native and governor resource ceilings', final.every(row => row.peaks.degree <= SCALE_ACCEPTANCE.degree && row.peaks.pcs <= SCALE_ACCEPTANCE.degree + SCALE_ACCEPTANCE.pending
      && row.peaks.active <= SCALE_ACCEPTANCE.pending && row.peaks.queued <= SCALE_ACCEPTANCE.queued && row.peaks.outgoingBytes <= row.limits.realmBytes && row.peaks.outgoingFrames <= row.limits.realmFrames),
    final.map(row => ({ did: row.did, observedPeaks: row.peaks })));
    check('bootstrap counters remain bounded', report.resourceViolations.length === 0 && signaling.stats().cleanupErrors === 0);
    stage('checks complete');
  } catch (error) { failed = true; report.failedStage = report.stage; report.error = String(error?.stack ?? error).slice(0, 4000);
    report.browserEvents = browser?.events.slice(-32).map(value => value.slice(0, 1000)) ?? []; save(); }
  finally {
    retiring = true;
    try {
      await bounded('production peer cleanup', async () => {
        report.cleanup = await stopScalePeers(peers, invoke);
        save();
        for (const result of report.cleanup.stops) if (!result.ok) { failed = true; cleanupErrors.push(result.error); }
        await until('production resources released', async () => {
          const rows = await snapshots(); report.cleanup = { ...report.cleanup, peers: rows, signaling: signaling.stats() };
          return rows.every(row => row.resources.pcs === 0 && row.resources.channels === 0 && row.resources.sockets === 0
            && row.resources.admission.active === 0 && row.resources.admission.queued === 0
            && row.resources.outgoing.bytes === 0 && row.resources.outgoing.frames === 0) && signaling.stats().connections === 0;
        }, SCALE_BUDGETS.retirementMs);
      }, SCALE_BUDGETS.cleanupMs);
    } catch (error) { failed = true; cleanupErrors.push(String(error).slice(0, 400)); }
    // Evidence above precedes context disposal/process fallback, which must not
    // turn a leaked production carrier into a successful cleanup assertion.
    try { await bounded('browser process cleanup', async () => {
      browser?.close(); await ctx?.close();
    }, SCALE_BUDGETS.cleanupMs); } catch (error) { failed = true; cleanupErrors.push(String(error).slice(0, 400)); }
    signaling?.stop(); for (const socket of sockets) socket.destroy(); server?.close();
    clearTimeout(watchdog); report.cleanupErrors = cleanupErrors;
    report.ok = !failed; report.stage = failed ? 'failed' : 'complete'; save();
  }
  return report;
}
if (import.meta.main) {
  try { const report = await runScale(); console.log(JSON.stringify({ ok: report.ok, stage: report.stage, options: report.options })); process.exit(report.ok ? 0 : 1); }
  catch (error) { console.error(error); process.exit(1); }
}
