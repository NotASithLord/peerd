import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sleep, waitFor } from './e2e-harness.mjs';

// Use the isolated game driver. It sends rendezvous traffic to loopback.
const [portFile] = process.argv.slice(2);
const port = Number((await readFile(portFile, 'utf8')).trim());
assert.ok(port > 0 && port < 65536);
const call = async (op, data = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/${op}`, {
    method: 'POST', body: JSON.stringify(data),
  }).then(reply => reply.json());
  assert.equal(response.ok, true, `${op}: ${response.error}`);
  return response.value;
};
const rpc = (peer, message) => call('rpc', { peer, message, timeoutMs: 60_000 });
const run = (peer, expr, target = 'home') => call('eval', { peer, target, expr, timeoutMsOp: 20_000 });
const eventually = (fn, budgetMs = 30_000) => waitFor(fn, { budgetMs, pollMs: 200 });

const importGame = async (peer, name, declare) => {
  const files = {
    'index.html': '<!doctype html><title>Peer game check</title><script src="game.js"></script>',
    'next.html': '<!doctype html><title>Second game page</title>',
    'game.js': `globalThis.check = { id: crypto.randomUUID(), raw: typeof globalThis.__peerdNetRaw };
      addEventListener('pageshow', event => { check.persisted = event.persisted; check.restoredRaw = typeof globalThis.__peerdNetRaw; });
      if (globalThis.peerd?.net) {
        check.messages = [];
        peerd.net.onMessage(message => check.messages.push(message));
        peerd.net.onStatus(status => { check.status = status; });
      }`,
    ...(declare ? { 'peerd-host.json': JSON.stringify({ v: 1, net: { v: 1, protocol: 1 } }) } : {}),
  };
  const result = await run(peer, `(async () => {
    const { prepareFileTreeFolder, stageFileTreeFolder } = await import('/peerd-engine/app-file-tree-upload.js');
    const list = Object.entries(${JSON.stringify(files)}).map(([name, data]) => new File([data], name));
    const uploadId = await stageFileTreeFolder(await prepareFileTreeFolder(list));
    return chrome.runtime.sendMessage({ type: 'apps/import-files', uploadId, name: ${JSON.stringify(name)}, format: 'file-tree-v1' });
  })()`);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.id;
};

const open = async (peer, appId) => {
  const result = await rpc(peer, { type: 'apps/open', appId });
  assert.equal(result.ok, true, JSON.stringify(result));
  const origin = `https://${appId}.localhost/`;
  assert.ok(await eventually(async () => (await call('targets', { peer }))
    .some(tab => tab.url.startsWith(origin) && tab.title === 'Peer game check')));
  return origin;
};

try {
  for (const peer of ['Alpha', 'Beta']) {
    await call('launch', { name: peer, profile: `${peer}-${Date.now()}` });
    assert.equal((await call('setupVault', { peer })).vault, true);
    assert.equal((await rpc(peer, { type: 'settings/update', patch: { dwebEnabled: true } })).ok, true);
    assert.ok(await eventually(async () => (await rpc(peer, { type: 'dweb/base/status' })).running));
  }
  const alphaId = await importGame('Alpha', 'Peer game check', true);
  const alpha = await open('Alpha', alphaId);
  assert.equal(await run('Alpha', 'peerd.net.join().then(() => "joined", error => error.code)', alpha), 'not-published');
  console.log('Local folder join refused.');

  const share = await rpc('Alpha', { type: 'dweb/base/share-app', appId: alphaId, slug: 'peer-game-check' });
  assert.equal(share.ok, true, JSON.stringify(share));
  const card = await eventually(async () => (await rpc('Beta', { type: 'dweb/base/heard' })).apps
    ?.find(app => app.slug === 'peer-game-check'), 45_000);
  assert.ok(card, 'Signed game did not appear in Discover.');
  const install = await rpc('Beta', {
    type: 'dweb/base/install', uri: card.uri, name: card.name, dwappId: card.dwapp_id,
    slug: card.slug, seq: card.seq,
  });
  assert.equal(install.ok, true, JSON.stringify(install));
  console.log('The signed fixture appeared in Discover and installed on Beta.');
  const betaId = install.app.id;
  assert.notEqual(alphaId, betaId);
  const beta = await open('Beta', betaId);
  const join = peer => run(peer, 'peerd.net.join().then(value => (check.self = value.self), error => ({ code: error.code }))',
    peer === 'Alpha' ? alpha : beta);
  const [first, second] = await Promise.all([join('Alpha'), join('Beta')]);
  assert.match(first, /^[\w-]{22}$/);
  assert.match(second, /^[\w-]{22}$/);
  assert.notEqual(first, second);
  console.log('Both game pages joined the signed world.');
  const linked = (peer, origin, id) => eventually(() => run(peer, `peerd.net.peers().some(peer => peer.id === "${id}" && peer.linked)`, origin));
  assert.ok(await linked('Alpha', alpha, second));
  assert.ok(await linked('Beta', beta, first));

  await run('Alpha', `peerd.net.publish(JSON.parse('{"__proto__":{"test":true},"text":"</script>"}')); true`, alpha);
  assert.equal(await run('Beta', `peerd.net.send(["${first}", "invalid", "${first}"], { text: "direct" })`, beta), 1);
  assert.ok(await eventually(() => run('Beta', `check.messages.some(({ from, kind, data }) =>
    from === "${first}" && kind === 'publish' && data.text === '</script>' &&
    Object.hasOwn(data, '__proto__') && Object.getPrototypeOf(data) === Object.prototype)`, beta)));
  assert.ok(await eventually(() => run('Alpha', `check.messages.some(({ from, kind, data }) =>
    from === "${second}" && kind === 'send' && data.text === 'direct')`, alpha)));
  console.log('Both profiles exchanged data over peerd.');

  await run('Alpha', `for (let i = 0; i < 100; i += 1) peerd.net.publish({ sequence: i }); true`, alpha);
  const burstCount = () => run('Beta', 'check.messages.filter(message => Number.isInteger(message.data.sequence)).length', beta);
  assert.ok(await eventually(burstCount));
  await sleep(1000);
  const count = await burstCount();
  assert.ok(count > 0 && count <= 5);
  console.log(`Burst delivery stayed within the limit (${count}).`);

  const transitions = await run('Alpha', `(async () => {
    const { net } = peerd;
    const firstLeave = net.leave();
    const cancelledJoin = net.join();
    const secondLeave = net.leave();
    return (await Promise.allSettled([firstLeave, cancelledJoin, secondLeave]))
      .map(result => result.status === 'fulfilled' ? 'fulfilled' : result.reason.code);
  })()`, alpha);
  assert.deepEqual(transitions, ['fulfilled', 'cancelled', 'fulfilled']);
  assert.equal(await join('Alpha'), first);
  console.log('Rapid leave and join calls settled.');

  const initial = await run('Alpha', 'check.id', alpha);
  assert.equal(await run('Alpha', 'check.raw', alpha), 'undefined');
  await run('Alpha', 'location.href = "/next.html"; true', alpha);
  assert.ok(await eventually(async () => (await call('targets', { peer: 'Alpha' }))
    .some(tab => tab.url === alpha + 'next.html')));
  await run('Alpha', 'history.back(); true', alpha);
  const restored = await eventually(() => run('Alpha', 'globalThis.check?.restoredRaw ? check : null', alpha).catch(() => null));
  assert.equal(restored.restoredRaw, 'undefined');
  if (restored.persisted) assert.equal(restored.id, initial);
  console.log(`History returned with the raw binding hidden (persisted=${restored.persisted}).`);
  assert.equal(await join('Alpha'), first);
  assert.ok(await linked('Alpha', alpha, second));
  await run('Alpha', 'peerd.net.publish({ text: "history" }); true', alpha);
  assert.ok(await eventually(() => run('Beta', 'check.messages.some(message => message.data.text === "history")', beta)));

  const solo = await open('Beta', await importGame('Beta', 'Solo game check', false));
  assert.deepEqual(await run('Beta', '[typeof globalThis.peerd?.net, typeof globalThis.__peerdNetRaw]', solo),
    ['undefined', 'undefined']);
  console.log('The game without a net declaration had no bridge.');
  const net = await call('net');
  assert.ok(net.tunnels >= 2);
  console.log(`The local rendezvous proxy handled ${net.tunnels} tunnels.`);
} finally {
  await call('quit');
}
