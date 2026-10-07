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
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function runScale(options = scaleOptions(process.argv.slice(2))) {
  const output = join(repo, 'artifacts/dweb-scale', `${options.peers}-${options.mode}`);
  mkdirSync(output, { recursive: true });
  const report = { ok: false, options, budgets: SCALE_BUDGETS, acceptance: SCALE_ACCEPTANCE, stage: 'starting', checks: [], samples: [],
    limitation: 'One Chrome process on one machine, isolated browser contexts, localhost ICE with no STUN/TURN. No WAN, NAT, multi-machine throughput, or raised-degree claim.',
    observedPeaks: { memberships: 0, sockets: 0 }, resourceViolations: [], cleanup: null };
  const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
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
  const snapshots = async () => {
    const rows = await Promise.all(peers.map(peer => invoke(peer, 'report')));
    const serverState = signaling.stats();
    const capped = { connections: 'sockets', rooms: 'rooms', joins: 'processJoins', messages: 'processMessages', ingressBytes: 'processIngressBytes', egressFrames: 'processEgressFrames', egressBytes: 'processEgressBytes' };
    for (const [key, limit] of Object.entries(capped)) if (serverState[key] > BOOTSTRAP_LIMITS[limit] && report.resourceViolations.length < 32) {
      report.resourceViolations.push({ key, actual: serverState[key], limit: BOOTSTRAP_LIMITS[limit] });
    }
    report.observedPeaks.memberships = Math.max(report.observedPeaks.memberships, serverState.memberships);
    report.observedPeaks.sockets = Math.max(report.observedPeaks.sockets, serverState.connections);
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
    browser.on(() => { if (browser.events.length > 64) browser.events.splice(0, browser.events.length - 64); });
    const createPeer = async index => {
      const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
      const peer = { index, browserContextId }; peers.push(peer);
      const target = await send('Target.createTarget', { browserContextId, url: 'about:blank' });
      peer.targetId = target.targetId;
      peer.sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
      await send('Runtime.enable', {}, peer.sessionId);
      await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/tests/dweb-scale.html?url=${encodeURIComponent(`ws://127.0.0.1:${signalPort}/rendezvous`)}` }, peer.sessionId);
      await until(`fixture ${index} ready`, async () => {
        const value = await send('Runtime.evaluate', { expression: '!!globalThis.__DWEB_SCALE__', returnByValue: true }, peer.sessionId);
        return value.result?.value === true;
      }, SCALE_BUDGETS.fixtureMs);
      await invoke(peer, 'start');
    };
    stage('joining paced native peers');
    for (let index = 0; index < options.peers; index++) {
      await createPeer(index);
      if (options.mode === 'paced' && index + 1 < options.peers) await sleep(SCALE_BUDGETS.pacedJoinMs);
    }
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
        await Promise.all(peers.filter(peer => peer.sessionId).map(peer => invoke(peer, 'stop')));
        await until('production resources released', async () => {
          const rows = await snapshots(); report.cleanup = { peers: rows, signaling: signaling.stats() };
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
