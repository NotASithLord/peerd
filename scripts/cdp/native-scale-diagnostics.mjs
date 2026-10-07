import { readFileSync, readdirSync } from 'node:fs';

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

// Inspect only this harness and descendants, without reading environments or
// retaining process arguments. Missing /proc evidence stays explicitly unknown.
export function nativeHostSnapshot({ pid = process.pid, read = readFileSync, list = readdirSync } = {}) {
  /** @type {{at: number, processes: object[], unavailable: {pid?: number, kind: string}[], truncated: boolean}} */
  const result = { at: Date.now(), processes: [], unavailable: [], truncated: false };
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
