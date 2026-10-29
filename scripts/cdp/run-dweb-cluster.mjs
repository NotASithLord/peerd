#!/usr/bin/env bun
// Usage: bun run test:cluster /absolute/private-config.json [--local]
// --local is explicitly a rehearsal and never reports a physical-Mac pass.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createSignalingServer } from '../../signaling-node/bun-server.mjs';
import { validateHosts, validateMesh, pathsReady, repairableEdge } from './dweb-cluster-checks.mjs';
import { sourceFingerprint, gitMetadata } from './dweb-cluster-source.mjs';
import { sshArguments } from './dweb-cluster-ssh.mjs';
import {validateCapacityConfig, validateCapacityHosts, capacityTopology, capacityPathsReady} from './dweb-capacity-evidence.mjs';
import {validateConversations} from './dweb-conversation-evidence.mjs';
import { soakOptions, runSoak } from './dweb-cluster-soak.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = process.argv[2];
if (!configPath || configPath.startsWith('--')) throw new Error('Pass a private cluster JSON config; see scripts/cdp/CLUSTER.md');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const local = process.argv.includes('--local');
const capacity = process.argv.includes('--capacity');
assert(!(local && capacity), 'Capacity placement cannot be a local rehearsal');
const transferSlots = config.transferSlots ?? 0;
assert(Number.isSafeInteger(transferSlots) && transferSlots >= 0 && transferSlots < (config.budget ?? 16), 'invalid transfer reserve');
const soak = soakOptions(config.soak);
const output = resolve(config.output ?? join(root, 'scripts/cdp/artifacts/cluster-result.json'));
// why: remote agreement alone could certify identical but stale staged trees.
const expectedSource = sourceFingerprint(root);
const coordinator = { ...gitMetadata(root), source: expectedSource, runtime: Bun.version };
const report = { ok: false, lane: capacity ? 'shared-host-capacity-preflight' : local ? 'local-rehearsal' : 'physical-macs',
  startedAt: new Date().toISOString(), coordinator,
  hosts: [], checks: [], skipped: [], capacity: {total: config.budget ?? 16, transferSlots, routing: (config.budget ?? 16) - transferSlots} };
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const workers = [];
let signaling;
// why: distinguish bootstrap refusals from overlay failures without retaining
// signaling payloads or changing the production server's admission budgets.
report.signalingClosures = {};
report.signalingSnapshots = [];
const openSignaling = port => createSignalingServer({ hostname: '127.0.0.1', port, log: () => {},
  serve: options => Bun.serve({ ...options, websocket: { ...options.websocket,
    close(ws, code, reason) {
      const category = [1000, 1001, 1006, 1008, 1009, 1013].includes(code) ? String(code) : 'other';
      report.signalingClosures[category] = (report.signalingClosures[category] ?? 0) + 1;
      options.websocket.close(ws, code, reason);
    },
  } }),
});
const recordSignaling = phase => {
  if (signaling) report.signalingSnapshots.push({phase, at:Date.now(), ...signaling.stats()});
};
const waitUntil = async (read, accept, label, budget = 30_000) => {
  const deadline = Date.now() + budget;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`${label} deadline: ${JSON.stringify(value)}`);
};
const check = async (name, run) => {
  const start = Date.now();
  try {
    const evidence = await run();
    report.checks.push({ name, ok: true, ms: Date.now() - start, evidence });
    console.log(`[cluster] PASS ${name}`);
    return evidence;
  } catch (error) {
    report.checks.push({ name, ok: false, ms: Date.now() - start, error: error.message });
    throw error;
  }
};

const startWorker = (target, port) => {
  const remotePort = target.signalingPort ?? port;
  const forwarding = `127.0.0.1:${remotePort}:127.0.0.1:${port}`;
  const ssh = sshArguments(target.sshOptions);
  const command = [target.bun ?? 'bun', join(target.directory ?? root, 'scripts/cdp/dweb-cluster-node.mjs')];
  const child = target.ssh ? spawn('ssh', [...ssh, '-R', forwarding, target.ssh, command.map(quote).join(' ')], { stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0;
  let stderr = '';
  let dead = false;
  child.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-4000); });
  const rejectAll = error => { dead = true; for (const settle of pending.values()) settle({ error: error.message }); pending.clear(); };
  child.on('error', rejectAll);
  child.stdin.on('error', rejectAll);
  child.on('exit', code => rejectAll(new Error(`${target.name} worker exited (${code}): ${stderr}`)));
  createInterface({ input: child.stdout }).on('line', line => {
    try { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); }
    catch { rejectAll(new Error(`Invalid worker output: ${line.slice(0, 200)}`)); }
  });
  const worker = { target, child, forwarding, ssh, signaling: `ws://127.0.0.1:${target.ssh ? remotePort : port}/rendezvous`,
    call(method, args = {}) {
      if (dead) return Promise.reject(new Error(`${target.name} worker is unavailable: ${stderr}`));
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`${target.name} ${method} timed out`)); }, 60_000);
        pending.set(requestId, message => {
          clearTimeout(timeout);
          if (message.error) reject(new Error(`${target.name}: ${message.error}`));
          else resolve(message.result);
        });
        child.stdin.write(`${JSON.stringify({ id: requestId, method, args })}\n`);
      });
    },
  };
  workers.push(worker);
  return worker;
};

const cleanup = async () => {
  recordSignaling('cleanup');
  signaling?.stop();
  signaling = null;
  await Promise.allSettled(workers.map(async worker => {
    worker.child.stdin.end();
    if (worker.child.exitCode === null) {
      const force = setTimeout(() => worker.child.kill('SIGTERM'), 5000);
      await new Promise(resolve => worker.child.once('exit', resolve));
      clearTimeout(force);
    }
  }));
};
process.once('SIGINT', async () => { await cleanup(); process.exit(130); });
process.once('SIGTERM', async () => { await cleanup(); process.exit(143); });

try {
  assert(Array.isArray(config.hosts) && config.hosts.length >= 2, 'Configure at least two hosts');
  assert.equal(new Set(config.hosts.map(host => host.name)).size, config.hosts.length, 'Host names must be unique');
  const topology = config.topology ?? 'all-pairs';
  if (capacity) {
    validateCapacityConfig(config);
    report.capacityQualification = {complete:false, missing:['paired degree comparisons', 'whole-browser resource metrics', 'adversarial workloads', 'sustained finalist and overnight runs']};
  }
  assert(['all-pairs', 'connected'].includes(topology), 'topology must be all-pairs or connected');
  signaling = openSignaling(0);
  for (const target of config.hosts) startWorker(target, signaling.server.port);
  report.hosts = await Promise.all(workers.map(async worker => ({ name: worker.target.name,
    ...await worker.call('launch', { chrome: worker.target.chrome, mdns: config.mdns !== false,
      allInterfaces: config.allInterfaces === true }) })));
  await check(capacity ? 'shared-host browser placement and identical source' : local ? 'matching source and browser (rehearsal)' : 'identical source on distinct Macs', async () => {
    const options = {local, expectedSource, expectedRuntime:coordinator.runtime};
    if (capacity) report.placement = validateCapacityHosts(report.hosts, options);
    else validateHosts(report.hosts, options);
    return report.hosts;
  });
  const roomId = config.roomId ?? `cluster-${crypto.randomUUID()}`;
  assert(typeof roomId === 'string' && roomId.length > 0, 'roomId must be a non-empty string');
  const start = (worker, id = roomId) => worker.call('start', { roomId: id, signaling: worker.signaling,
    name: worker.target.name, budget: config.budget, profile: config.profile, transferSlots });
  const identities = await Promise.all(workers.map(worker => start(worker)));
  const dids = identities.map(identity => identity.did);
  assert.equal(new Set(dids).size, workers.length, 'Each browser must own a distinct identity');
  const reports = () => Promise.all(workers.map(worker => worker.call('report')));
  let adjacency;
  const meshReady = () => waitUntil(reports, states => {
    try {
      adjacency = validateMesh(states, dids, { topology });
      if (capacity) report.placement = capacityTopology(report.hosts, states, dids, config.budget ?? 16);
      return true;
    }
    catch { return false; }
  }, 'authenticated mesh').then(states => ({ states, adjacency }));
  await check(`authenticated ${topology} mesh`, meshReady);
  const paths = async () => {
    // why: the authenticated channel may carry application bytes before the
    // selected ICE pair's stats transition from in-progress to succeeded.
    const evidence = await waitUntil(async () => {
      const states = await reports();
      let expected;
      try { expected = validateMesh(states, dids, { topology }); } catch { return null; }
      return { values: await Promise.all(workers.map(worker => worker.call('paths'))), expected };
    }, value => value && (capacity ? capacityPathsReady(value.values, value.expected, report.hosts, dids) : pathsReady(value.values, value.expected, { local })), 'selected direct UDP paths');
    adjacency = evidence.expected;
    return evidence.values;
  };
  const gossip = async () => {
    const nonce = crypto.randomUUID();
    await Promise.all(workers.map(worker => worker.call('gossip', { nonce })));
    await waitUntil(reports, states => states.every((state, index) => dids.filter(did => did !== dids[index])
      .every(did => state.messages.some(message => message.from === did && message.data.nonce === nonce))), 'fresh gossip delivery');
    return { nonce, senders: dids };
  };
  await check('fresh gossip from every peer', gossip);
  await check('selected direct UDP paths', paths);
  await check('two-turn A2A conversations in both directions', async () => {
    const results = [];
    report.conversations = results;
    for (const [index, worker] of workers.entries()) for (const did of adjacency[index]) {
      const nonce = crypto.randomUUID();
      const result = await worker.call('conversation', { did, nonce });
      results.push({ from: dids[index], to: did, nonce, ...result });
      if(result.skipped==='retired-before-start')continue;
      assert.equal(result.first.ok, true);
      assert.equal(result.first.reply, `PONG:${nonce}`);
      assert.equal(result.second?.reply, `PONG:${nonce}/followup`);
      assert.equal(result.second.convId, result.first.convId);
    }
    report.conversationCoverage=validateConversations(results,dids);
    return results;
  });
  const seederIndex = dids.indexOf(adjacency[0][0]);
  assert(seederIndex > 0, 'Publisher needs a directly linked seeder');
  const published = await check('publish a signed multi-chunk app', async () => {
    const value = await workers[0].call('publish', { slug: `cluster-${crypto.randomUUID()}` });
    assert(value.chunks > 1, 'Payload must exercise multiple chunks');
    return value;
  });
  await check('discovery and DHT provider records cross hosts', async () => {
    await waitUntil(reports, states => states.slice(1).every(state => state.cards.some(card => card.dwapp_id === published.dwappId)), 'discovery');
    return waitUntil(() => workers[seederIndex].call('providers', { uri: published.uri }), providers => providers.includes(dids[0]), 'DHT provider');
  });
  const verify = value => {
    assert.equal(value.digest, published.digest);
    assert.equal(value.size, published.size);
    assert.equal(value.publisher, published.publisher);
    assert.equal(value.chunks, published.chunks);
    return value;
  };
  if (transferSlots > 0) await check('nonadjacent provider fetch uses and releases a temporary carrier', async () => {
    const before = await reports();
    const candidates = before.map((state, index) => ({state,index})).filter(({state,index}) =>
      index !== 0 && !state.peers.some(peer => peer.linked && peer.did === dids[0]));
    assert(candidates.length > 0, 'Need a nonadjacent reader to exercise temporary transfer');
    const {state,index} = candidates[0];
    const value = verify(await workers[index].call('fetch', {uri:published.uri}));
    const after = await workers[index].call('report');
    assert(after.contentDials.succeeded > state.contentDials.succeeded, 'Fetch did not exercise a temporary content lease');
    assert.equal(after.dissemination.mesh.transferDegree, 0, 'Completed fetch leaked a temporary carrier');
    assert(after.dissemination.mesh.peerDegree <= (config.budget ?? 16) - transferSlots);
    return {reader:index, value, before:state.contentDials, after:after.contentDials, degrees:after.dissemination.mesh};
  });
  await check('signed multi-chunk download verifies every byte', async () => verify(await workers[seederIndex].call('fetch', { uri: published.uri })));
  await check('parallel downloads verify every byte', async () =>
    (await workers[seederIndex].call('fetchMany', { uri: published.uri, count: 3 })).map(verify));
  await check('corrupt serving peer is rejected', async () => {
    await workers[0].call('corrupt', { enabled: true });
    try {
      await assert.rejects(workers[seederIndex].call('fetch', { uri: published.uri, provider: dids[0] }), /chunk hash mismatch/);
      return { rejected: true };
    } finally { await workers[0].call('corrupt', { enabled: false }); }
  });
  await check('healthy transfer recovers after corruption', async () => verify(await workers[seederIndex].call('fetch', { uri: published.uri })));
  await check('unsharing stops remote content serving', async () => {
    await workers[seederIndex].call('seed', { uri: published.uri });
    await workers[0].call('unshare', { hash: published.hash });
    await assert.rejects(workers[seederIndex].call('fetch', { uri: published.uri, provider: dids[0] }), /peer does not hold/);
    return { rejected: true };
  });
  await check('peer leave removes authenticated links', async () => {
    // Preserve the first lifetime's counters before this worker recreates its
    // mesh. Keep fixed checkpoints rather than an unbounded polling history.
    report.preRestartStates = await reports();
    await workers[0].call('stop');
    return waitUntil(reports, states => states.slice(1).every(state => !state.peers.some(peer => peer.did === dids[0] && peer.linked)), 'peer departure');
  });
  await check('separate rendezvous rooms stay isolated', async () => {
    await start(workers[0], `${roomId}-isolated`);
    await workers[0].call('gossip', { nonce: 'isolated' });
    await sleep(1500);
    const states = await reports();
    assert.equal(states[0].peers.length, 0);
    assert(states.slice(1).every(state => !state.messages.some(message => message.from === dids[0] && message.data.nonce === 'isolated')));
    return { isolated: true };
  });
  await check('same identity rejoins and exchanges fresh traffic', async () => {
    assert.equal((await start(workers[0])).did, dids[0]);
    await meshReady();
    return gossip();
  });
  await check('original bytes remain available from another seeder', async () =>
    verify(await workers[0].call('fetch', { uri: published.uri })));
  await check('mesh survives signaling outage and recovery', async () => {
    const port = signaling.server.port;
    recordSignaling('intentional-outage');
    signaling.stop();
    signaling = null;
    await waitUntil(reports, states => states.every(state => state.rendezvous !== 'up'), 'signaling disconnect');
    await gossip();
    adjacency = validateMesh(await reports(), dids, { topology });
    const edge = repairableEdge(adjacency, dids);
    const repairCheck = 'peer-link repair while signaling offline';
    if (edge) {
      await check(repairCheck, async () => {
        const { from, to, broker } = edge;
        const dropped = await workers[from].call('drop', { did: dids[to] });
        assert.deepEqual(dropped, { existed: true, linked: false });
        await waitUntil(reports, states => states[from].peers.some(peer => peer.did === dids[to] && peer.linked)
          && states[to].peers.some(peer => peer.did === dids[from] && peer.linked), 'offline peer-link repair');
        return { from: dids[from], to: dids[to], broker };
      });
    } else {
      report.skipped.push({ name: repairCheck,
        reason: 'No triangle edge with a surviving common relay broker; offline repair is not qualified.' });
    }
    verify(await workers[0].call('fetch', { uri: published.uri }));
    const outagePaths = await paths();
    signaling = openSignaling(port);
    await waitUntil(reports, states => states.every(state => state.rendezvous === 'up'), 'signaling recovery');
    return { outagePaths, recovered: await gossip() };
  });
  if (soak) await check('sustained authenticated traffic and verified content', async () =>
    runSoak({ options: soak, now: () => performance.now(), sleep,
      probe: async () => {
        await meshReady();
        await gossip();
        verify(await workers[0].call('fetch', { uri: published.uri }));
        await paths();
      },
      save: async evidence => {
        report.soak = evidence;
        // Preserve an incomplete receipt if the coordinator or host is lost.
        // report.ok stays false until all checks have completed.
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(`${output}.pending`, `${JSON.stringify(report, null, 2)}\n`);
        renameSync(`${output}.pending`, output);
      },
    }));
  report.finalStates = await reports();
  report.ok = true;
} catch (error) {
  report.error = error.stack;
  console.error(`[cluster] FAIL ${error.message}`);
  report.diagnostics = await Promise.all(workers.map(async worker => ({ name: worker.target.name,
    results: await Promise.allSettled([worker.call('report'), worker.call('diagnostics')]) })));
} finally {
  await cleanup();
  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[cluster] ${report.lane}: ${report.ok ? 'PASS' : 'FAIL'}; ${output}`);
}
process.exitCode = report.ok ? 0 : 1;
