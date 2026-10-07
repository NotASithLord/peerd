#!/usr/bin/env bun
// Usage: bun run test:cluster /absolute/private-config.json [--local]
// --local is explicitly a rehearsal and never reports a physical-Mac pass.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createSignalingServer } from '../../signaling-node/bun-server.mjs';
import { validateHosts, validatePaths } from './dweb-cluster-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = process.argv[2];
if (!configPath || configPath.startsWith('--')) throw new Error('Pass a private cluster JSON config; see scripts/cdp/CLUSTER.md');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const local = process.argv.includes('--local');
const output = resolve(config.output ?? join(root, 'scripts/cdp/artifacts/cluster-result.json'));
// why: a cluster node may run a staged source snapshot without Git metadata.
// Its content fingerprint remains the authority; never invent a revision.
let revision = null;
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
catch { /* staged snapshot */ }
const report = { ok: false, lane: local ? 'local-rehearsal' : 'physical-macs',
  startedAt: new Date().toISOString(), revision,
  hosts: [], checks: [] };
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const workers = [];
let signaling;
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
  const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', ...(target.sshOptions ?? [])];
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
  signaling?.stop();
  signaling = null;
  await Promise.allSettled(workers.map(async worker => {
    worker.child.stdin.end();
    if (worker.child.exitCode === null) {
      const force = setTimeout(() => worker.child.kill('SIGTERM'), 5000);
      await new Promise(resolve => worker.child.once('exit', resolve));
      clearTimeout(force);
    }
    // why: a shared ControlMaster can retain a forward after its child exits.
    // Cancel our exact forward, never the shared master.
    if (worker.target.ssh) {
      try { execFileSync('ssh', [...worker.ssh, '-O', 'cancel', '-R', worker.forwarding, worker.target.ssh], { stdio: 'ignore', timeout: 5000 }); }
      catch { /* non-multiplexed SSH already removed its own forward */ }
    }
  }));
};
process.once('SIGINT', async () => { await cleanup(); process.exit(130); });
process.once('SIGTERM', async () => { await cleanup(); process.exit(143); });

try {
  assert(Array.isArray(config.hosts) && config.hosts.length >= 2, 'Configure at least two hosts');
  assert.equal(new Set(config.hosts.map(host => host.name)).size, config.hosts.length, 'Host names must be unique');
  signaling = createSignalingServer({ hostname: '127.0.0.1', port: 0, log: () => {} });
  for (const target of config.hosts) startWorker(target, signaling.server.port);
  report.hosts = await Promise.all(workers.map(async worker => ({ name: worker.target.name,
    ...await worker.call('launch', { chrome: worker.target.chrome, mdns: config.mdns !== false,
      allInterfaces: config.allInterfaces === true }) })));
  await check(local ? 'matching source and browser (rehearsal)' : 'identical source on distinct Macs', async () => { validateHosts(report.hosts, { local }); return report.hosts; });
  const roomId = `cluster-${crypto.randomUUID()}`;
  const start = (worker, id = roomId) => worker.call('start', { roomId: id, signaling: worker.signaling, name: worker.target.name });
  const identities = await Promise.all(workers.map(worker => start(worker)));
  const dids = identities.map(identity => identity.did);
  assert.equal(new Set(dids).size, workers.length, 'Each browser must own a distinct identity');
  const reports = () => Promise.all(workers.map(worker => worker.call('report')));
  const meshReady = () => waitUntil(reports, states => states.every((state, index) =>
    dids.filter(did => did !== dids[index]).every(did => state.peers.some(peer => peer.did === did && peer.linked))), 'authenticated mesh');
  await check('authenticated all-pairs mesh', meshReady);
  const paths = async () => {
    const values = await Promise.all(workers.map(worker => worker.call('paths')));
    values.forEach((value, index) => validatePaths(value, dids.filter(did => did !== dids[index]), { local }));
    return values;
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
    for (const [index, worker] of workers.entries()) for (const did of dids.filter(did => did !== dids[index])) {
      const nonce = crypto.randomUUID();
      const result = await worker.call('conversation', { did, nonce });
      assert.equal(result.first.ok, true);
      assert.equal(result.first.reply, `PONG:${nonce}`);
      assert.equal(result.second?.reply, `PONG:${nonce}/followup`);
      assert.equal(result.second.convId, result.first.convId);
      results.push({ from: dids[index], to: did, ...result });
    }
    return results;
  });
  const published = await check('publish a signed multi-chunk app', async () => {
    const value = await workers[0].call('publish', { slug: `cluster-${crypto.randomUUID()}` });
    assert(value.chunks > 1, 'Payload must exercise multiple chunks');
    return value;
  });
  await check('discovery and DHT provider records cross hosts', async () => {
    await waitUntil(reports, states => states.slice(1).every(state => state.cards.some(card => card.dwapp_id === published.dwappId)), 'discovery');
    return waitUntil(() => workers[1].call('providers', { uri: published.uri }), providers => providers.includes(dids[0]), 'DHT provider');
  });
  const verify = value => {
    assert.equal(value.digest, published.digest);
    assert.equal(value.size, published.size);
    assert.equal(value.publisher, published.publisher);
    assert.equal(value.chunks, published.chunks);
    return value;
  };
  await check('signed multi-chunk download verifies every byte', async () => verify(await workers[1].call('fetch', { uri: published.uri })));
  await check('parallel downloads verify every byte', async () =>
    (await workers[1].call('fetchMany', { uri: published.uri, count: 3 })).map(verify));
  await check('corrupt serving peer is rejected', async () => {
    await workers[0].call('corrupt', { enabled: true });
    try {
      await assert.rejects(workers[1].call('fetch', { uri: published.uri, provider: dids[0] }), /chunk hash mismatch/);
      return { rejected: true };
    } finally { await workers[0].call('corrupt', { enabled: false }); }
  });
  await check('healthy transfer recovers after corruption', async () => verify(await workers[1].call('fetch', { uri: published.uri })));
  await check('unsharing stops remote content serving', async () => {
    await workers[1].call('seed', { uri: published.uri });
    await workers[0].call('unshare', { hash: published.hash });
    await assert.rejects(workers[1].call('fetch', { uri: published.uri, provider: dids[0] }), /peer does not hold/);
    return { rejected: true };
  });
  await check('peer leave removes authenticated links', async () => {
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
    verify(await workers[0].call('fetch', { uri: published.uri, provider: dids[1] })));
  await check('mesh survives signaling shutdown', async () => {
    signaling.stop();
    signaling = null;
    await waitUntil(reports, states => states.every(state => state.rendezvous !== 'up'), 'signaling disconnect');
    await gossip();
    verify(await workers[0].call('fetch', { uri: published.uri, provider: dids[1] }));
    return paths();
  });
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
