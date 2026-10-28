// Harness-only observers. Never retain carrier objects, wire payloads, identities, or SDP.
export function installPeerTransportDiagnostics() {
  const Native = globalThis.RTCPeerConnection;
  const records = [];
  globalThis.__DWEB_TRANSPORT__ = records;
  if (typeof Native !== 'function') return;
  const seen = new WeakSet();
  let nextPeer = 0;
  let nextChannel = 0;
  const record = (entry) => {
    records.push({ at: Date.now(), ...entry });
    if (records.length > 128) records.shift();
  };
  const frame = (data) => typeof data === 'string'
    ? /"__t"\s*:\s*"(HELLO_PROOF|HELLO)"/.exec(data.slice(0, 128))?.[1] ?? 'other'
    : 'other';
  const watch = (dc, peer) => {
    if (seen.has(dc)) return;
    seen.add(dc);
    const channel = ++nextChannel;
    const note = (stage, extra = {}) => record({ peer, channel, stage,
      state: dc.readyState, bufferedAmount: dc.bufferedAmount, ...extra });
    note('observed');
    for (const stage of ['open', 'closing', 'close', 'error', 'bufferedamountlow']) {
      dc.addEventListener(stage, () => note(stage));
    }
    dc.addEventListener('message', event => note('receive', { frame: frame(event.data) }));
    const send = dc.send;
    dc.send = function (...args) {
      const kind = frame(args[0]);
      note('send-call', { frame: kind });
      try {
        const result = Reflect.apply(send, this, args);
        // Native asynchronous failure may still follow this JavaScript return.
        note('send-return', { frame: kind });
        return result;
      } catch (error) {
        note('send-throw', { frame: kind });
        throw error;
      }
    };
  };
  globalThis.RTCPeerConnection = new Proxy(Native, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget);
      const peer = ++nextPeer;
      const choice = (value, allowed) => allowed.includes(value) ? value : 'unknown';
      const snapshot = async () => {
        try {
          const stats = await pc.getStats();
          const candidates = [];
          const pairs = [];
          stats.forEach(stat => {
            if (['local-candidate', 'remote-candidate'].includes(stat.type) && candidates.length < 16) {
              candidates.push({ side: stat.type, type: choice(stat.candidateType, ['host', 'srflx', 'prflx', 'relay']),
                protocol: choice(stat.protocol, ['udp', 'tcp']),
                addressKind: typeof stat.address !== 'string' ? 'unknown' : stat.address.endsWith('.local') ? 'mdns'
                  : stat.address.includes(':') ? 'ipv6' : /^\d+\.\d+\.\d+\.\d+$/.test(stat.address) ? 'ipv4' : 'unknown' });
            }
            if (stat.type === 'candidate-pair' && pairs.length < 16) {
              const counts = {};
              for (const key of ['requestsSent', 'responsesReceived', 'requestsReceived', 'responsesSent', 'bytesSent', 'bytesReceived']) {
                if (Number.isSafeInteger(stat[key]) && stat[key] >= 0) counts[key] = stat[key];
              }
              pairs.push({ state: choice(stat.state, ['frozen', 'waiting', 'in-progress', 'failed', 'succeeded']),
                nominated: stat.nominated === true, ...counts });
            }
          });
          record({ peer, stage: 'ice-stats', candidates, pairs });
        } catch { record({ peer, stage: 'ice-stats-unavailable' }); }
      };
      for (const stage of ['connectionstatechange', 'iceconnectionstatechange', 'signalingstatechange']) {
        pc.addEventListener(stage, () => record({ peer, stage, connection: pc.connectionState,
          ice: pc.iceConnectionState, signaling: pc.signalingState }));
      }
      pc.addEventListener('connectionstatechange', () => {
        if (['connected', 'disconnected', 'failed'].includes(pc.connectionState)) void snapshot();
      });
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') void snapshot();
      });
      pc.addEventListener('icecandidateerror', event => record({ peer, stage: 'ice-candidate-error',
        code: Number.isInteger(event.errorCode) ? event.errorCode : null }));
      pc.addEventListener('datachannel', event => watch(event.channel, peer));
      const create = pc.createDataChannel;
      pc.createDataChannel = function (...channelArgs) {
        const dc = Reflect.apply(create, this, channelArgs);
        watch(dc, peer);
        return dc;
      };
      return pc;
    },
  });
}
