import { expect, test } from 'bun:test';
import { createSignalingServer } from '../../signaling-node/bun-server.mjs';
import { hostPressureSnapshot, nativeHostSnapshot, observedSignalingServe, signalingCounters, websocketEvidence } from '../../scripts/cdp/native-scale-diagnostics.mjs';

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

function kernelMetrics(): Record<string, string> {
  const psi = 'some avg10=1.25 avg60=2.00 avg300=0.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
  return {
    '/proc/pressure/cpu': psi, '/proc/pressure/memory': psi, '/proc/pressure/io': psi,
    '/proc/meminfo': 'MemAvailable: 100 kB\nMemTotal: 200 kB\nSwapFree: 30 kB\nSwapTotal: 40 kB\nPrivate: not-retained',
    '/proc/vmstat': 'pgmajfault 12\npswpin 3\npswpout 4\nprivate not-retained',
    '/proc/loadavg': '1.25 2.50 3.75 2/100 1234\n',
    '/proc/self/cgroup': '0::/private-scope\n',
    '/sys/fs/cgroup/private-scope/memory.current': '1024\n',
    '/sys/fs/cgroup/private-scope/memory.max': 'max\n',
    '/sys/fs/cgroup/private-scope/memory.events': 'low 1\nhigh 2\nmax 3\noom 4\noom_kill 5\n',
    '/sys/fs/cgroup/private-scope/cpu.stat': 'usage_usec 6\nuser_usec 4\nsystem_usec 2\n',
  };
}
const kernelReader = (files: Record<string, string>) => (path: string) => {
  if (!Object.hasOwn(files, path)) throw new Error('private-error-not-retained');
  return files[path]!;
};

test('host pressure retains bounded numeric metrics and explicitly absent throttle fields', () => {
  const files = kernelMetrics();
  const result = hostPressureSnapshot({ read: kernelReader(files) });
  expect(result.unavailable).toEqual([]);
  expect(result.pressure.cpu).toMatchObject({ some: { avg10: 1.25, total: 123 }, full: { total: 0 } });
  expect(result.memoryKiB).toEqual({ MemAvailable: 100, MemTotal: 200, SwapFree: 30, SwapTotal: 40 });
  expect(result.vmstat).toEqual({ pgmajfault: 12, pswpin: 3, pswpout: 4 });
  expect(result.load).toEqual({ averages: [1.25, 2.5, 3.75], runnable: 2, tasks: 100 });
  expect(result.cgroup).toEqual({ memoryCurrentBytes: 1024, memoryMaxBytes: 'max',
    memoryEvents: { low: 1, high: 2, max: 3, oom: 4, oom_kill: 5 },
    cpu: { usage_usec: 6, user_usec: 4, system_usec: 2, nr_periods: null, nr_throttled: null, throttled_usec: null } });
  expect(JSON.stringify(result)).not.toContain('private');
  files['/sys/fs/cgroup/private-scope/memory.max'] = '2048';
  files['/sys/fs/cgroup/private-scope/cpu.stat'] += 'nr_periods 8\nnr_throttled 9\nthrottled_usec 10\n';
  expect(hostPressureSnapshot({ read: kernelReader(files) }).cgroup).toMatchObject({ memoryMaxBytes: 2048, cpu: { nr_periods: 8, nr_throttled: 9, throttled_usec: 10 } });
});

test('invalid cgroup paths cannot select a filesystem read or leak source text', () => {
  for (const path of ['/../private', '/a/./b', '/a//b', '/a/', 'relative', '/a\0b', '/a b', '/a\nb', '/' + 'a'.repeat(2048)]) {
    const files = kernelMetrics(); files['/proc/self/cgroup'] = `0::${path}`;
    const reads: string[] = [];
    const result = hostPressureSnapshot({ read: path => { reads.push(path); return kernelReader(files)(path); } });
    expect(result.cgroup).toBeNull(); expect(result.unavailable).toContain('cgroup-path');
    expect(reads.some(path => path.startsWith('/sys/'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  }
  const files = kernelMetrics(); files['/proc/self/cgroup'] = '0::/a\n0::/b';
  expect(hostPressureSnapshot({ read: kernelReader(files) }).cgroup).toBeNull();
  files['/proc/self/cgroup'] = '0::/';
  for (const key of Object.keys(files)) if (key.startsWith('/sys/')) files[key.replace('/private-scope', '')] = files[key]!;
  expect(hostPressureSnapshot({ read: kernelReader(files) }).cgroup?.memoryCurrentBytes).toBe(1024);
});

test('malformed, oversized and missing metrics remain unknown rather than healthy zero', () => {
  const files = kernelMetrics();
  files['/proc/pressure/cpu'] = 'some avg10=101 avg60=0 avg300=0 total=0';
  files['/proc/pressure/memory'] = 'some avg10=0 avg60=0 avg300=0 total=9007199254740992';
  files['/proc/pressure/io'] = 'x'.repeat(16385);
  files['/proc/meminfo'] += '\nMemTotal: 200 kB';
  files['/proc/vmstat'] = 'pgmajfault -1\npswpin 0\npswpout 0';
  files['/proc/loadavg'] = '1 2 3 101/100 1';
  delete files['/sys/fs/cgroup/private-scope/memory.current'];
  const result = hostPressureSnapshot({ read: kernelReader(files) });
  expect(result.pressure).toEqual({ cpu: null, memory: null, io: null });
  expect(result.memoryKiB).toBeNull(); expect(result.vmstat).toBeNull(); expect(result.load).toBeNull();
  expect(result.cgroup?.memoryCurrentBytes).toBeNull();
  expect(result.unavailable).toEqual(['pressure-cpu', 'pressure-memory', 'pressure-io', 'memory', 'vmstat', 'load', 'cgroup-memory-current']);
  expect(JSON.stringify(result)).not.toContain('private-error');
});

test('host snapshot embeds independently injected pressure even when process enumeration is unavailable', () => {
  const result = nativeHostSnapshot({ pressureRead: kernelReader(kernelMetrics()), list: (() => { throw new Error('unavailable'); }) as any });
  expect(result.system.load?.tasks).toBe(100);
  expect(result.unavailable).toEqual([{ kind: 'proc-enumeration' }]);
  expect(result.system.unavailable).toEqual([]);
});
