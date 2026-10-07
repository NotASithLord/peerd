import { readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';

// Diagnostic adapters retain native return values, receiver identity and thrown
// errors. No headers, signaling messages or WebSocket frames enter the report.
export function observedSignalingServe(serve, counters) {
  return options => serve({ ...options,
    fetch(request, server) {
      counters.fetch++;
      const observed = new Proxy(server, { get(target, key) {
        if (key !== 'upgrade') return Reflect.get(target, key, target);
        return (...args) => {
          counters.upgradeAttempts++;
          const accepted = Reflect.apply(target.upgrade, target, args);
          if (accepted) counters.upgraded++;
          else counters.upgradeRefused++;
          return accepted;
        };
      } });
      try {
        const response = Reflect.apply(options.fetch, this, [request, observed]);
        if (response instanceof Response) {
          const status = String(response.status);
          counters.http[status] = (counters.http[status] ?? 0) + 1;
        }
        return response;
      } catch (error) { counters.errors++; throw error; }
    },
    websocket: { ...options.websocket,
      open(socket) {
        counters.open++;
        const result = Reflect.apply(options.websocket.open, this, [socket]);
        if (socket.data.admitted) counters.admitted++;
        return result;
      },
      close(...args) {
        counters.close++;
        return Reflect.apply(options.websocket.close, this, args);
      },
    },
  });
}
export const signalingCounters = () => ({ fetch: 0, upgradeAttempts: 0, upgraded: 0, upgradeRefused: 0,
  open: 0, admitted: 0, close: 0, errors: 0, http: {} });

export function websocketEvidence() {
  const state = { attempts: [], dropped: 0 };
  const requests = new Map();
  return { state, event(method, params) {
    if (method === 'Network.webSocketCreated') {
      let url;
      try { url = new URL(params.url); } catch { return; }
      if (url.pathname !== '/rendezvous') return;
      if (requests.size >= 16) { state.dropped++; return; }
      const attempt = { createdAt: Date.now() };
      requests.set(params.requestId, attempt); state.attempts.push(attempt);
    }
    const attempt = requests.get(params.requestId);
    if (!attempt) return;
    if (method === 'Network.webSocketWillSendHandshakeRequest') attempt.handshakeSentAt = Date.now();
    if (method === 'Network.webSocketHandshakeResponseReceived') {
      attempt.responseAt = Date.now(); attempt.status = params.response?.status;
    }
    if (method === 'Network.webSocketFrameError') {
      attempt.errorAt = Date.now();
      attempt.error = String(params.errorMessage).replace(/wss?:\/\/\S+/g, '[websocket]').slice(0, 240);
    }
    if (method === 'Network.webSocketClosed') attempt.closedAt = Date.now();
  } };
}

const KERNEL_METRIC_BYTES = 16 * 1024;

// why: procfs sizes are often zero, so bound the actual read rather than trusting
// stat metadata. One extra byte distinguishes a complete metric from truncation.
function readKernelMetric(path) {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(KERNEL_METRIC_BYTES + 1);
    const size = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (size > KERNEL_METRIC_BYTES) throw new Error('metric-too-large');
    return buffer.subarray(0, size).toString('utf8');
  } finally { closeSync(descriptor); }
}

export function hostPressureSnapshot({ read = readKernelMetric } = {}) {
  const unavailable = [];
  const metric = (label, path, parse) => {
    try {
      const text = read(path);
      if (typeof text !== 'string' || Buffer.byteLength(text) > KERNEL_METRIC_BYTES) throw new Error('metric-size');
      return parse(text);
    } catch { unavailable.push(label); return null; }
  };
  const integer = value => {
    if (!/^\d+$/.test(value ?? '')) throw new Error('metric-integer');
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('metric-range');
    return number;
  };
  const fields = (text, names, optional = []) => {
    const lines = text.trim().split('\n').map(line => line.trim().split(/\s+/));
    return Object.fromEntries(names.map(name => {
      const matches = lines.filter(line => line[0] === name);
      if (!matches.length && optional.includes(name)) return [name, null];
      if (matches.length !== 1 || matches[0].length !== 2) throw new Error('metric-field');
      return [name, integer(matches[0][1])];
    }));
  };
  const pressure = text => {
    const result = {};
    for (const line of text.trim().split('\n')) {
      const [kind, ...parts] = line.trim().split(/\s+/);
      if (!['some', 'full'].includes(kind) || Object.hasOwn(result, kind) || parts.length !== 4) throw new Error('metric-pressure');
      const values = Object.fromEntries(parts.map(part => part.split('=')));
      const averages = Object.fromEntries(['avg10', 'avg60', 'avg300'].map(key => {
        if (!/^\d+(?:\.\d+)?$/.test(values[key] ?? '')) throw new Error('metric-average');
        const value = Number(values[key]);
        if (!Number.isFinite(value) || value > 100) throw new Error('metric-average-range');
        return [key, value];
      }));
      result[kind] = { ...averages, total: integer(values.total) };
    }
    if (!Object.hasOwn(result, 'some')) throw new Error('metric-pressure-missing');
    return result;
  };
  const systemPressure = Object.fromEntries(['cpu', 'memory', 'io'].map(kind =>
    [kind, metric(`pressure-${kind}`, `/proc/pressure/${kind}`, pressure)]));
  const memoryKiB = metric('memory', '/proc/meminfo', text => {
    const lines = text.trim().split('\n');
    return Object.fromEntries(['MemAvailable', 'MemTotal', 'SwapFree', 'SwapTotal'].map(name => {
      const matches = lines.filter(line => line.startsWith(`${name}:`));
      const match = matches.length === 1 && matches[0].match(/^[A-Za-z]+:\s+(\d+)\s+kB$/);
      if (!match) throw new Error('metric-memory');
      return [name, integer(match[1])];
    }));
  });
  const vmstat = metric('vmstat', '/proc/vmstat', text => fields(text, ['pgmajfault', 'pswpin', 'pswpout']));
  const load = metric('load', '/proc/loadavg', text => {
    const parts = text.trim().split(/\s+/);
    if (parts.length !== 5) throw new Error('metric-load');
    const averages = parts.slice(0, 3).map(value => {
      if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('metric-load-average');
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error('metric-load-range');
      return number;
    });
    const counts = parts[3].split('/');
    if (counts.length !== 2) throw new Error('metric-load-counts');
    const runnable = integer(counts[0]); const tasks = integer(counts[1]);
    integer(parts[4]);
    if (runnable > tasks) throw new Error('metric-load-tasks');
    return { averages, runnable, tasks };
  });
  // why: only the current unified cgroup may supply a metric directory. Never
  // retain its path, and reject traversal before constructing any filesystem read.
  const cgroupPath = metric('cgroup-path', '/proc/self/cgroup', text => {
    const lines = text.replace(/\n$/, '').split('\n');
    if (lines.some(line => !/^\d+:[^:]*:\//.test(line))) throw new Error('metric-cgroup-row');
    const rows = lines.filter(line => line.startsWith('0::'));
    if (rows.length !== 1) throw new Error('metric-cgroup-count');
    const path = rows[0].slice(3);
    if (path.length > 2048 || !path.startsWith('/')) throw new Error('metric-cgroup-path');
    if (path !== '/' && path.slice(1).split('/').some(part => !/^[A-Za-z0-9_.:-]+$/.test(part) || part === '.' || part === '..')) throw new Error('metric-cgroup-segment');
    return `/sys/fs/cgroup${path === '/' ? '' : path}`;
  });
  const cgroup = cgroupPath === null ? null : {
    memoryCurrentBytes: metric('cgroup-memory-current', `${cgroupPath}/memory.current`, text => integer(text.trim())),
    memoryMaxBytes: metric('cgroup-memory-max', `${cgroupPath}/memory.max`, text => text.trim() === 'max' ? 'max' : integer(text.trim())),
    memoryEvents: metric('cgroup-memory-events', `${cgroupPath}/memory.events`, text => fields(text, ['low', 'high', 'max', 'oom', 'oom_kill'])),
    cpu: metric('cgroup-cpu', `${cgroupPath}/cpu.stat`, text => fields(text,
      ['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'],
      ['nr_periods', 'nr_throttled', 'throttled_usec'])),
  };
  return { pressure: systemPressure, memoryKiB, vmstat, load, cgroup, unavailable };
}

// Inspect only this harness and descendants, without reading environments or
// retaining process arguments. Missing /proc evidence stays explicitly unknown.
export function nativeHostSnapshot({ pid = process.pid, read = readFileSync, list = readdirSync, pressureRead = readKernelMetric } = {}) {
  /** @type {{at: number, processes: object[], unavailable: {pid?: number, kind: string}[], truncated: boolean, system: ReturnType<typeof hostPressureSnapshot>}} */
  const result = { at: Date.now(), processes: [], unavailable: [], truncated: false, system: hostPressureSnapshot({ read: pressureRead }) };
  try {
    const ids = list('/proc').filter(name => /^\d+$/.test(name));
    result.truncated = ids.length > 2048;
    const rows = new Map();
    for (const id of ids.slice(0, 2048)) {
      try {
        const status = String(read(`/proc/${id}/status`, 'utf8'));
        const value = name => Number(status.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1]);
        rows.set(Number(id), { pid: Number(id), parent: value('PPid'), rssKiB: value('VmRSS'), threads: value('Threads') });
      } catch { /* unrelated processes can exit during enumeration */ }
    }
    const owned = new Set([pid]);
    for (let pass = 0; pass < 16; pass++) {
      const size = owned.size;
      for (const row of rows.values()) if (owned.has(row.parent)) owned.add(row.pid);
      if (owned.size === size) break;
    }
    if (owned.size > 256) result.truncated = true;
    for (const id of [...owned].slice(0, 256)) {
      const row = rows.get(id);
      if (!row) { result.unavailable.push({ pid: id, kind: 'status' }); continue; }
      let role = id === pid ? 'harness-signaling' : 'child';
      try {
        const command = String(read(`/proc/${id}/cmdline`, 'utf8'));
        if (command.includes('--utility-sub-type=network.mojom.NetworkService')) role = 'chrome-network-service';
        else if (command.includes('--type=renderer')) role = 'chrome-renderer';
        else if (command.includes('--type=gpu-process')) role = 'chrome-gpu';
        else if (/chrome/.test(command.split('\0')[0])) role = 'chrome';
      } catch { result.unavailable.push({ pid: id, kind: 'role' }); }
      const evidence = { ...row, role };
      try { evidence.fds = list(`/proc/${id}/fd`).length; } catch { result.unavailable.push({ pid: id, kind: 'fds' }); }
      try {
        const limits = String(read(`/proc/${id}/limits`, 'utf8'));
        evidence.openFiles = limits.match(/^Max open files\s+(\S+)\s+(\S+)/m)?.slice(1);
        evidence.processLimit = limits.match(/^Max processes\s+(\S+)\s+(\S+)/m)?.slice(1);
      } catch { result.unavailable.push({ pid: id, kind: 'limits' }); }
      result.processes.push(evidence);
    }
  } catch { result.unavailable.push({ kind: 'proc-enumeration' }); }
  return result;
}
