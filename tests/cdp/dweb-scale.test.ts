import { expect, test } from 'bun:test';
import { connected, prepareAndJoinScale, scaleOptions, SCALE_BUDGETS, startupEvidence, stopScalePeers } from '../../scripts/cdp/run-dweb-scale.mjs';

test('scale arguments expose only explicit fixed sizes and paced/stress modes', () => {
  expect(scaleOptions([])).toEqual({ peers: 16, mode: 'paced' });
  expect(scaleOptions(['--peers=64', '--mode=stress'])).toEqual({ peers: 64, mode: 'stress' });
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
