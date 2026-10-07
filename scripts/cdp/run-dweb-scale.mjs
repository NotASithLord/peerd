// Native loopback transport acceptance, not a WAN or multi-machine benchmark.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPeerd, attach } from './e2e-harness.mjs';
import { createSignalingServer } from '../../signaling-node/bun-server.mjs';
import { BOOTSTRAP_LIMITS } from '../../signaling-node/admission-budget.js';
import { nativeHostSnapshot, observedSignalingServe, signalingCounters, websocketEvidence } from './native-scale-diagnostics.mjs';

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
  const options = { peers: 16, mode: 'paced', browsers: 1 };
  for (const arg of args) {
    if (/^--peers=(16|32|64)$/.test(arg)) options.peers = Number(arg.slice(8));
    else if (/^--browsers=(1|4)$/.test(arg)) options.browsers = Number(arg.slice(11));
    else if (arg === '--mode=paced' || arg === '--mode=stress') options.mode = arg.slice(7);
    else throw new Error(`unsupported scale option: ${arg}`);
  }
  if (options.browsers === 4 && options.peers !== 64) throw new Error('four browsers require 64 peers');
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
export function gossipArrangement(rows) {
  if (!connected(rows)) return null;
  for (let source = 0; source < rows.length; source++) for (let target = source + 1; target < rows.length; target++) {
    if (!rows[source].peers.includes(rows[target].did) && !rows[target].peers.includes(rows[source].did)) return { source, target, removeEdge: false };
  }
  // Only a complete reciprocal graph needs modification. Sparse leaves and
  // stars already have non-neighbors; cutting their sole route is not gossip.
  if (!rows.every(row => rows.every(other => row === other || row.peers.includes(other.did)))) return null;
  const source = 0, target = rows.length - 1;
  const without = rows.map((row, index) => ({ ...row, peers: row.peers.filter(did =>
    !((index === source && did === rows[target].did) || (index === target && did === rows[source].did))) }));
  return source !== target && connected(without) ? { source, target, removeEdge: true } : null;
}
// Register ownership as soon as acquisition returns, including after a deadline.
export async function acquireScaleOwner(host, key, acquire, isRetiring) {
  const value = await acquire();
  host[key] = value;
  if (isRetiring()) { await value.close(); throw new Error(`${key} retired`); }
  return value;
}
export async function closeScaleHosts(hosts) {
  const results = await Promise.allSettled(hosts.map(async host => {
    try { host.browser?.close(); } finally { await host.ctx?.close(); }
  }));
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
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
  const output = join(repo, 'artifacts/dweb-scale', `${options.peers}-${options.mode}-${options.browsers ?? 1}browser`);
  mkdirSync(output, { recursive: true });
  const report = { ok: false, options, budgets: SCALE_BUDGETS, acceptance: SCALE_ACCEPTANCE, stage: 'starting', checks: [], samples: [],
    workload: 'All static fixture modules are prepared before paced or stress network joins. Cold-page creation under an active mesh is not measured.',
    limitation: `${options.browsers ?? 1} independent Chrome browser process(es) on one machine, isolated browser contexts, localhost ICE with no STUN/TURN. No WAN, NAT, multi-machine throughput, or raised-degree claim.`,
    observedPeaks: { memberships: 0, sockets: 0 }, resourceViolations: [], startup: [], hosts: [], gossipProofs: [], cleanup: null };
  const boundary = signalingCounters(); report.signalingBoundary = boundary;
  const serve = observedSignalingServe(options => Bun.serve(options), boundary);
  const save = () => {
    report.population = { ...report.population, prepared: report.startup.filter(row => row.prepared).length,
      startInvoked: report.startup.filter(row => row.startInvoked).length };
    writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
  };
  let failed = false, retiring = false, signaling, server, signalPort;
  const hosts = [];
  const peers = [], sockets = new Set();
  const cleanupErrors = [];
  let contentSelection = null;
  const bounded = async (label, operation, ms = SCALE_BUDGETS.commandMs) => {
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms);
    })]); } finally { clearTimeout(timer); }
  };
  const stage = value => { report.stage = value; save(); };
  const hostSnapshot = () => { report.hosts.push({ stage: report.stage, ...nativeHostSnapshot() }); save(); };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: !!ok, detail }); save();
    if (!ok) throw new Error(name);
  };
  const emergency = () => {
    retiring = true; signaling?.stop();
    void closeScaleHosts(hosts).catch(() => {});
    for (const socket of sockets) socket.destroy(); server?.close();
  };
  const watchdog = setTimeout(() => {
    failed = true; report.error = `whole-run deadline at ${report.stage}`; save(); emergency(); process.exit(1);
  }, SCALE_BUDGETS.runMs);
  const send = (host, method, params = {}, sessionId, ms = SCALE_BUDGETS.commandMs) => bounded(method, () => host.browser.send(method, params, sessionId), ms);
  const invoke = async (peer, operation, values = [], ms = SCALE_BUDGETS.operationMs) => bounded(operation, async () => {
    const global = await send(peer.host, 'Runtime.evaluate', { expression: 'globalThis' }, peer.sessionId);
    const objectId = global.result?.objectId;
    if (!objectId) throw new Error('fixture context unavailable');
    try {
      const reply = await send(peer.host, 'Runtime.callFunctionOn', {
        objectId, functionDeclaration: 'function(op, values) { return globalThis.__DWEB_SCALE__[op](...values); }',
        arguments: [{ value: operation }, { value: values }], returnByValue: true, awaitPromise: true,
      }, peer.sessionId, ms);
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result?.value;
    } finally { await send(peer.host, 'Runtime.releaseObject', { objectId }, peer.sessionId); }
  }, ms);
  const serverSnapshot = () => {
    const serverState = { ...signaling.stats(), boundary: { ...boundary, http: { ...boundary.http } } };
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
    let before = await snapshots(), arrangement = { source: 0, target: peers.length - 1, removeEdge: false };
    if (requireNonNeighbor) {
      const ready = await until(`arrange gossip ${tag}`, async () => {
        before = await snapshots(); const selected = gossipArrangement(before);
        return selected && { selected };
      });
      arrangement = ready.selected;
    }
    const source = peers[arrangement.source], target = peers[arrangement.target];
    const sourceDid = before[arrangement.source].did, targetDid = before[arrangement.target].did;
    const topology = rows => rows.map(row => ({ did: row.did, peers: [...row.peers] }));
    const proof = { tag, source: sourceDid, target: targetDid, removeEdge: arrangement.removeEdge, before: topology(before) };
    report.gossipProofs.push(proof); save();
    if (arrangement.removeEdge) {
      await invoke(source, 'drop', [targetDid]);
      await invoke(target, 'drop', [sourceDid]);
      const after = await until(`alternate gossip path ${tag}`, async () => {
        const rows = await snapshots();
        return connected(rows) && !rows[arrangement.source].peers.includes(targetDid)
          && !rows[arrangement.target].peers.includes(sourceDid) && rows;
      });
      proof.afterRemoval = topology(after); save();
    }
    const dispatched = await invoke(source, 'publish', [tag, requireNonNeighbor ? targetDid : undefined]);
    proof.dispatched = dispatched; save();
    const delivered = await until(`gossip ${tag}`, async () => {
      const rows = await snapshots();
      return rows.every((row, index) => index === arrangement.source || row.received.some(([seen, receipt]) => seen === tag && receipt.from === sourceDid)) && rows;
    }, SCALE_BUDGETS.operationMs);
    const receipt = delivered[arrangement.target].received.find(([seen]) => seen === tag)?.[1];
    proof.targetReceipt = receipt; save();
    check(`all-recipient authenticated gossip ${tag}`, !requireNonNeighbor || (receipt?.via && receipt.via !== dispatched.from), { ...dispatched, targetReceipt: receipt });
  };
  try {
    save();
    signaling = createSignalingServer({ port: 0, hostname: '127.0.0.1', serve }); signalPort = signaling.server.port;
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
    for (let index = 0; index < (options.browsers ?? 1); index++) {
      const host = { index, ctx: undefined, browser: undefined }; hosts.push(host);
      stage(`launch Chrome ${index}`);
      await bounded('launch Chrome', () => acquireScaleOwner(host, 'ctx',
        () => launchPeerd({ interceptModel: false, enforceWebSecurity: true, webRtcLoopbackAcceptance: true, nativeScaleNetLog: { record: value => {
          report.netlogs ??= []; report.netlogs[index] = { index, ...value }; save();
        } } }),
        () => retiring), SCALE_BUDGETS.launchMs);
      const version = await bounded('browser version', async () => (await fetch(`http://127.0.0.1:${host.ctx.port}/json/version`)).json());
      report.browsers ??= []; const provenance = { index, version: version.Browser, pid: null }; report.browsers.push(provenance);
      hostSnapshot();
      await bounded('browser attach', () => acquireScaleOwner(host, 'browser',
        () => attach(version.webSocketDebuggerUrl), () => retiring));
      const processInfo = await send(host, 'SystemInfo.getProcessInfo');
      provenance.pid = processInfo.processInfo?.find(process => process.type === 'browser')?.id ?? null;
      if (provenance.pid === null) throw new Error(`browser ${index} process identity unavailable`);
      save();
      host.browser.on((method, params, message) => {
        if (host.browser.events.length > 64) host.browser.events.splice(0, host.browser.events.length - 64);
        const peer = peers.find(value => value.host === host && ((message.sessionId && value.sessionId === message.sessionId)
          || (params.targetId && value.targetId === params.targetId)
          || (method === 'Target.detachedFromTarget' && value.sessionId === params.sessionId)));
        if (peer) {
          peer.diagnostic.event(method, params);
          peer.websockets.event(method, params);
          // Persist failures immediately; stage saves retain ordinary request
          // progress without turning every signaling message into synchronous IO.
          if (method === 'Runtime.exceptionThrown' || method === 'Network.loadingFailed' || method === 'Network.webSocketFrameError'
            || method.endsWith('Crashed') || (method === 'Runtime.consoleAPICalled' && params.type === 'error')) save();
        }
      });
      await send(host, 'Target.setDiscoverTargets', { discover: true });
    }
    if (new Set(report.browsers.map(host => host.pid)).size !== (options.browsers ?? 1)) throw new Error('browser process identities are not distinct');
    const createPeer = async index => {
      const host = hosts[Math.floor(index / (options.peers / hosts.length))];
      stage(`fixture ${index} context creation`);
      const { browserContextId } = await send(host, 'Target.createBrowserContext', { disposeOnDetach: true });
      const diagnostic = startupEvidence(index);
      const websockets = websocketEvidence(); diagnostic.state.websockets = websockets.state;
      diagnostic.state.browserIndex = host.index;
      const peer = { index, host, browserContextId, diagnostic, websockets, ready: false }; peers.push(peer); report.startup.push(diagnostic.state);
      diagnostic.state.startInvoked = false;
      const target = await send(host, 'Target.createTarget', { browserContextId, url: 'about:blank' });
      peer.targetId = target.targetId;
      peer.sessionId = (await send(host, 'Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
      await send(host, 'Runtime.enable', {}, peer.sessionId);
      await send(host, 'Inspector.enable', {}, peer.sessionId);
      await send(host, 'Page.enable', {}, peer.sessionId);
      await send(host, 'Page.setLifecycleEventsEnabled', { enabled: true }, peer.sessionId);
      await send(host, 'Network.enable', {}, peer.sessionId);
      diagnostic.state.phase = 'navigating'; stage(`fixture ${index} navigation`);
      const navigation = await send(host, 'Page.navigate', { url: `http://127.0.0.1:${server.address().port}/tests/dweb-scale.html?url=${encodeURIComponent(`ws://127.0.0.1:${signalPort}/rendezvous`)}` }, peer.sessionId);
      diagnostic.state.navigation = navigation;
      if (navigation.errorText) throw new Error(`fixture ${index} navigation: ${navigation.errorText}`);
      await until(`fixture ${index} ready`, async () => {
        const value = await send(host, 'Runtime.evaluate', { expression: '({fixtureReady:!!globalThis.__DWEB_SCALE__,documentState:document.readyState,path:location.pathname})', returnByValue: true }, peer.sessionId);
        diagnostic.state.lastProbe = { at: Date.now(), value: value.result?.value, error: value.exceptionDetails?.text };
        return value.result?.value?.fixtureReady === true;
      }, SCALE_BUDGETS.fixtureMs);
      peer.ready = true; diagnostic.state.prepared = true; diagnostic.state.phase = 'prepared'; save();
      return peer;
    };
    await prepareAndJoinScale(options, { prepare: createPeer,
      prepared: async () => {
        stage('all fixtures prepared before network joins');
        hostSnapshot();
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
    stage('all network starts invoked'); hostSnapshot();
    const joined = await until('full membership and reciprocal connectivity', async () => {
      const rows = await snapshots();
      return signaling.stats().memberships === options.peers && rows.every(row => row.rendezvous === 'up') && connected(rows) && rows;
    });
    check('membership is distinct from active degree', joined.length === options.peers && joined.every(row => row.peers.length <= SCALE_ACCEPTANCE.degree),
      { membership: signaling.stats().memberships, degrees: joined.map(row => row.peers.length) });
    check('every identity uses native data channels', joined.every(row => row.constructed > 0 && row.opened > 0));
    await gossip('initial-non-neighbor', true);
    stage('content publish');
    const published = await invoke(peers[0], 'publishContent');
    const fetchFromNeighbor = async label => {
      stage(`content ${label} selection`);
      const rows = await snapshots();
      const index = rows.findIndex((row, at) => at > 0 && row.peers.includes(rows[0].did) && rows[0].peers.includes(row.did));
      if (index < 1) throw new Error('no distinct native content neighbor');
      contentSelection = { providerIndex: 0, receiverIndex: index, providerBrowser: peers[0].host.index, receiverBrowser: peers[index].host.index,
        provider: rows[0].did, receiver: rows[index].did, hash: published.hash,
        providerState: rows[0], receiverState: rows[index] };
      report.contentSelection = contentSelection;
      stage(`content ${label} fetch`);
      return { ...(await invoke(peers[index], 'fetchContent', [published.uri, published.hash])), receiver: rows[index].did, provider: rows[0].did };
    };
    const transfer = await fetchFromNeighbor('initial');
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
    signaling = createSignalingServer({ port: signalPort, hostname: '127.0.0.1', serve });
    await until('signaling membership restored', async () => {
      const rows = await snapshots(); return signaling.stats().memberships === options.peers && rows.every(row => row.rendezvous === 'up') && connected(rows);
    });
    await gossip('after-signaling-recovery');
    const recovered = await fetchFromNeighbor('recovery');
    check('verified content after outage', recovered.contentVerified && recovered.hash === published.hash, recovered);
    const final = await snapshots();
    check('observed native and governor resource ceilings', final.every(row => row.peaks.degree <= SCALE_ACCEPTANCE.degree && row.peaks.pcs <= SCALE_ACCEPTANCE.degree + SCALE_ACCEPTANCE.pending
      && row.peaks.active <= SCALE_ACCEPTANCE.pending && row.peaks.queued <= SCALE_ACCEPTANCE.queued && row.peaks.outgoingBytes <= row.limits.realmBytes && row.peaks.outgoingFrames <= row.limits.realmFrames),
    final.map(row => ({ did: row.did, observedPeaks: row.peaks })));
    check('bootstrap counters remain bounded', report.resourceViolations.length === 0 && signaling.stats().cleanupErrors === 0);
    stage('checks complete');
  } catch (error) { failed = true; report.failedStage = report.stage; report.error = String(error?.stack ?? error).slice(0, 4000);
    report.browserEvents = hosts.map(host => ({ index: host.index, events: host.browser?.events.slice(-32).map(value => value.slice(0, 1000)) ?? [] })); hostSnapshot(); }
  finally {
    // Capture selected endpoints before stop mutates their native/transfer state.
    // Failure here is diagnostic only and never replaces the original failure.
    if (failed && contentSelection) {
      report.contentFailure = await Promise.all([contentSelection.providerIndex, contentSelection.receiverIndex].map(async index => {
        try { return { index, snapshot: await invoke(peers[index], 'report', [], SCALE_BUDGETS.commandMs) }; }
        catch (error) { return { index, unavailable: String(error).slice(0, 400) }; }
      }));
      save();
    }
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
    hostSnapshot();
    // Evidence above precedes context disposal/process fallback, which must not
    // turn a leaked production carrier into a successful cleanup assertion.
    try { await bounded('browser process cleanup', async () => {
      await closeScaleHosts(hosts);
    }, SCALE_BUDGETS.cleanupMs); } catch (error) { failed = true; cleanupErrors.push(String(error).slice(0, 400)); }
    if (report.netlogs?.some(row => row.rawCleanup === 'failed')) { failed = true; cleanupErrors.push('raw NetLog deletion failed'); }
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
