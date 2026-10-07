import { expect, test } from 'bun:test';
import { createSignalingServer } from '../../signaling-node/bun-server.mjs';
import { nativeHostSnapshot, observedSignalingServe, signalingCounters, websocketEvidence } from '../../scripts/cdp/native-scale-diagnostics.mjs';

test('diagnostic serve adapter preserves production upgrade and refusal behavior', () => {
  let options: any;
  const counters = signalingCounters();
  const shell = { port: 1, stop() {} };
  const server = createSignalingServer({ log() {}, limits: { processJoins: 1 },
    serve: observedSignalingServe((value: any) => { options = value; return shell; }, counters) as any });
  let socket: any;
  const native = { upgrade(request: Request, args: any) {
    expect(this).toBe(native); expect(request.url).toContain('/rendezvous');
    socket = { data: args.data, send: () => 1, close() {}, readyState: 1 }; return true;
  } };
  const request = new Request('http://127.0.0.1/rendezvous?key=test', { headers: { Upgrade: 'websocket', Authorization: 'not-retained' } });
  expect(options.fetch(request, native)).toBeUndefined();
  options.websocket.open(socket);
  expect(server.stats().memberships).toBe(1);
  const refusal = options.fetch(request, native);
  expect(refusal.status).toBe(503);
  expect(counters).toMatchObject({ fetch: 2, upgraded: 1, upgradeAttempts: 1, open: 1, admitted: 1, http: { '503': 1 } });
  options.websocket.close(socket, 1000, 'not-retained');
  expect(server.stats().connections).toBe(0); expect(counters.close).toBe(1);
  expect(JSON.stringify(counters)).not.toContain('not-retained');
  const failure = new Error('native failure');
  observedSignalingServe((value: any) => { options = value; }, counters)({ fetch() { throw failure; }, websocket: {} });
  try { options.fetch(request, native); throw new Error('expected failure'); } catch (error) { expect(error).toBe(failure); }
});

test('websocket metadata is bounded and excludes URLs, headers and frame payloads', () => {
  const ledger = websocketEvidence();
  for (let index = 0; index < 20; index++) {
    const requestId = String(index);
    ledger.event('Network.webSocketCreated', { requestId, url: 'ws://127.0.0.1/rendezvous?key=not-retained' });
    ledger.event('Network.webSocketWillSendHandshakeRequest', { requestId, request: { headers: { Authorization: 'not-retained' } } });
    ledger.event('Network.webSocketHandshakeResponseReceived', { requestId, response: { status: 503, headers: { secret: 'not-retained' } } });
    ledger.event('Network.webSocketFrameError', { requestId, errorMessage: 'Failed ws://127.0.0.1/rendezvous?key=not-retained' });
    ledger.event('Network.webSocketFrameReceived', { requestId, response: { payloadData: 'not-retained' } });
    ledger.event('Network.webSocketClosed', { requestId });
  }
  expect(ledger.state.attempts).toHaveLength(16); expect(ledger.state.dropped).toBe(4);
  expect(ledger.state.attempts[0]).toMatchObject({ status: 503, error: 'Failed [websocket]' });
  expect(JSON.stringify(ledger.state)).not.toContain('not-retained');
});

test('host evidence selects only owned processes and never retains command arguments', () => {
  const files: Record<string, string> = {};
  for (const [pid, parent, command] of [[10, 1, 'bun\0private=not-retained'], [11, 10, '/bin/chrome\0--utility-sub-type=network.mojom.NetworkService\0secret=not-retained'], [12, 1, 'unrelated\0not-retained']] as const) {
    files[`/proc/${pid}/status`] = `PPid:\t${parent}\nVmRSS:\t24 kB\nThreads:\t3\n`;
    files[`/proc/${pid}/cmdline`] = command;
    files[`/proc/${pid}/limits`] = 'Max open files            1024                 2048                 files\nMax processes             512                  1024                 processes';
  }
  const result = nativeHostSnapshot({ pid: 10,
    read: ((path: string) => { if (!(path in files)) throw new Error('unavailable'); return files[path]; }) as any,
    list: ((path: string) => path === '/proc' ? ['10', '11', '12', 'self'] : ['0', '1']) as any });
  expect(result.processes.map((row: any) => row.pid)).toEqual([10, 11]);
  expect(result.processes[1]).toMatchObject({ role: 'chrome-network-service', rssKiB: 24, threads: 3, fds: 2, openFiles: ['1024', '2048'] });
  expect(JSON.stringify(result)).not.toContain('not-retained');
  expect(nativeHostSnapshot({ list: (() => { throw new Error('denied'); }) as any }).unavailable).toEqual([{ kind: 'proc-enumeration' }]);
});
