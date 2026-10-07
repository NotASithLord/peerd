import { expect, test } from 'bun:test';
import { acquireScaleOwner, closeScaleHosts, connected, gossipArrangement, prepareAndJoinScale, scaleOptions, SCALE_BUDGETS, startupEvidence, stopScalePeers } from '../../scripts/cdp/run-dweb-scale.mjs';

test('scale arguments expose only explicit fixed sizes and paced/stress modes', () => {
  expect(scaleOptions([])).toEqual({ peers: 16, mode: 'paced', browsers: 1 });
  expect(scaleOptions(['--peers=64', '--mode=stress'])).toEqual({ peers: 64, mode: 'stress', browsers: 1 });
  expect(scaleOptions(['--peers=64', '--browsers=4'])).toEqual({ peers: 64, mode: 'paced', browsers: 4 });
  expect(() => scaleOptions(['--peers=32', '--browsers=4'])).toThrow('four browsers require 64 peers');
  for (const flag of ['--peers=17', '--degree=64', '--timeout=900000', '--url=wss://other', '--mode=retry']) {
    expect(() => scaleOptions([flag])).toThrow('unsupported scale option');
  }
});
test('connectivity requires reciprocal paths and unique participating identities', () => {
  const a = { did: 'a', peers: ['b'] }, b = { did: 'b', peers: ['a', 'c'] }, c = { did: 'c', peers: ['b'] };
  expect(connected([a, b, c])).toBe(true);
  expect(connected([a, b, { ...c, peers: [] }])).toBe(false);
  expect(connected([a, b, a])).toBe(false);
  expect(connected([])).toBe(false);
});
test('gossip keeps a sparse leaf attached and chooses an existing nonneighbor', () => {
  const rows = [{ did: 'a', peers: ['b', 'c', 'leaf'] }, { did: 'b', peers: ['a', 'c'] },
    { did: 'c', peers: ['a', 'b'] }, { did: 'leaf', peers: ['a'] }];
  expect(gossipArrangement(rows)).toEqual({ source: 1, target: 3, removeEdge: false });
  expect(rows[3]!.peers).toEqual(['a']);
  expect(connected(rows)).toBe(true);
});
test('gossip can select two leaves when the first identity is the star center', () => {
  const rows = [{ did: 'center', peers: ['a', 'b', 'c'] },
    ...['a', 'b', 'c'].map(did => ({ did, peers: ['center'] }))];
  expect(gossipArrangement(rows)).toEqual({ source: 1, target: 2, removeEdge: false });
});
test('only complete reciprocal graphs may lose a nonbridge edge for gossip proof', () => {
  const ids = ['a', 'b', 'c'];
  const rows = ids.map(did => ({ did, peers: ids.filter(other => other !== did) }));
  expect(gossipArrangement(rows)).toEqual({ source: 0, target: 2, removeEdge: true });
  const removed = rows.map(row => ({ ...row, peers: row.peers.filter(did =>
    !((row.did === 'a' && did === 'c') || (row.did === 'c' && did === 'a'))) }));
  expect(connected(removed)).toBe(true);
  expect(gossipArrangement([{ did: 'a', peers: ['b'] }, { did: 'b', peers: ['a'] }])).toBeNull();
  expect(gossipArrangement([{ did: 'a', peers: ['b', 'c'] }, { did: 'b', peers: ['a', 'c'] }, { did: 'c', peers: ['b'] }])).toBeNull();
  expect(gossipArrangement([{ did: 'a', peers: [] }, { did: 'b', peers: [] }])).toBeNull();
});
test('startup evidence retains module failure and crash independently of room warning traffic', () => {
  const ledger = startupEvidence(29);
  ledger.event('Network.requestWillBeSent', { requestId: 'module', type: 'Script', request: { url: 'http://127.0.0.1/tests/dweb-scale.js?private=omitted' } });
  ledger.event('Network.loadingFailed', { requestId: 'module', errorText: 'net::ERR_FAILED' });
  ledger.event('Runtime.exceptionThrown', { exceptionDetails: { text: 'module initialization failed' } });
  for (let index = 0; index < 100; index++) ledger.event('Runtime.consoleAPICalled', { type: 'warning', args: [{ value: 'room admission refused' }] });
  ledger.event('Target.targetCrashed', { status: 'crashed', errorCode: 5 });
  expect(ledger.state.errors).toHaveLength(2);
  expect(ledger.state.errors[0]).toMatchObject({ request: { path: '/tests/dweb-scale.js' } });
  expect(ledger.state.pending).toEqual({});
  expect(ledger.state.lifecycle[0]).toMatchObject({ kind: 'Target.targetCrashed', errorCode: 5 });
  for (let index = 0; index < 300; index++) ledger.event('Network.requestWillBeSent', { requestId: String(index), type: 'Script', request: { url: 'http://127.0.0.1/module.js' } });
  expect(Object.keys(ledger.state.pending)).toHaveLength(256);
  expect(ledger.state.droppedRequests).toBe(44);
  for (let index = 0; index < 100; index++) {
    ledger.event('Runtime.exceptionThrown', { exceptionDetails: { text: 'later failure' } });
    ledger.event('Page.lifecycleEvent', { name: 'load' });
  }
  expect(ledger.state.errors).toHaveLength(16);
  expect(ledger.state.errors[0]).toMatchObject({ request: { path: '/tests/dweb-scale.js' } });
  expect(ledger.state.lifecycle).toHaveLength(16);
});
test('partial startup stops all initialized peers and retains failures without invoking an absent fixture', async () => {
  const peers = [true, false, true].map((ready, index) => ({ index, ready, diagnostic: { state: { phase: ready ? 'started' : 'navigating' } } }));
  const calls: number[] = [];
  const receipt = await stopScalePeers(peers, async (peer: typeof peers[number], operation: string) => {
    expect(operation).toBe('stop'); calls.push(peer.index);
    if (peer.index === 0) throw new Error('retired context');
  });
  expect(calls).toEqual([0, 2]);
  expect(receipt.uninitialized).toEqual([{ index: 1, phase: 'navigating', productionStartInvoked: false, nativeCleanup: 'unavailable' }]);
  expect(receipt.stops).toEqual([{ index: 0, productionStartInvoked: false, ok: false, error: 'Error: retired context' }, { index: 2, productionStartInvoked: false, ok: true, error: undefined }]);
});
test('native network starts only after every fixture is prepared and retains paced spacing', async () => {
  const trace: string[] = [];
  await prepareAndJoinScale({ peers: 3, mode: 'paced' }, {
    prepare: async (index: number) => { trace.push(`prepare${index}`); return { index }; },
    prepared: async () => { trace.push('zero-network-barrier'); },
    start: async (peer: { index: number }) => { trace.push(`start${peer.index}`); },
    wait: async (ms: number) => { expect(ms).toBe(SCALE_BUDGETS.pacedJoinMs); trace.push('pace'); },
  });
  expect(trace).toEqual(['prepare0', 'prepare1', 'prepare2', 'zero-network-barrier', 'start0', 'pace', 'start1', 'pace', 'start2']);
});
test('failed static preparation starts no network and cleanup still stops ready unstarted modules', async () => {
  const peers: { index: number; ready: boolean; diagnostic: { state: { phase: string; startInvoked: boolean } } }[] = [];
  let starts = 0, barriers = 0;
  await expect(prepareAndJoinScale({ peers: 3, mode: 'paced' }, {
    prepare: async (index: number) => {
      const peer = { index, ready: index === 0, diagnostic: { state: { phase: index === 0 ? 'prepared' : 'navigating', startInvoked: false } } };
      peers.push(peer);
      if (index === 1) throw new Error('navigation deadline');
      return peer;
    },
    prepared: async () => { barriers++; },
    start: async () => { starts++; },
  })).rejects.toThrow('navigation deadline');
  expect(starts).toBe(0); expect(barriers).toBe(0);
  const stopped: number[] = [];
  const cleanup = await stopScalePeers(peers, async (peer: typeof peers[number]) => { stopped.push(peer.index); });
  expect(stopped).toEqual([0]);
  expect(cleanup.stops[0]).toMatchObject({ ok: true, productionStartInvoked: false });
  expect(cleanup.uninitialized[0]).toMatchObject({ index: 1, nativeCleanup: 'unavailable' });
});

test('late browser acquisition remains owned and is closed after retirement', async () => {
  let resolve!: (value: { close: () => Promise<void> }) => void;
  const host: Record<string, unknown> = {};
  let retired = false, closed = 0;
  const pending = acquireScaleOwner(host, 'ctx', () => new Promise(yes => { resolve = yes; }), () => retired);
  retired = true;
  const value = { close: async () => { closed++; } }; resolve(value);
  await expect(pending).rejects.toThrow('ctx retired');
  expect(host.ctx).toBe(value); expect(closed).toBe(1);
});

test('partial browser launch cleanup attempts every owner even when one close fails', async () => {
  const calls: string[] = [];
  await expect(closeScaleHosts([
    { browser: { close() { calls.push('cdp0'); throw new Error('close failed'); } }, ctx: { async close() { calls.push('process0'); } } },
    { ctx: { async close() { calls.push('process1'); } } },
    {},
  ])).rejects.toThrow('close failed');
  expect(calls).toEqual(['cdp0', 'process0', 'process1']);
});
