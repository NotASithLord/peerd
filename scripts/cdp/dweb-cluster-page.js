// Browser-only fixture; served by dweb-cluster-node.mjs, never packaged.
import { generateIdentity, joinRoom, sha256hex, unpackTransportBundle } from '/peerd-distributed/index.js';
import { createBaseNetwork } from '/peerd-distributed/base-network.js';
import { makeDhtDialer } from '/peerd-distributed/transport/dht-dialer.js';
import { makeMeshDispatch } from '/peerd-runtime/actor/a2a-dispatch.js';
import { createConversationRegistry } from '/peerd-runtime/actor/conversation-registry.js';

const identity = await generateIdentity();
const topic = 'cluster/validation';
let room, base, dispatch, originalChunk;
let messages = [];
const received = new Map();
const audit = [];
const connections = [];
// why: failed ICE attempts never reach mesh.peers(); retain their native
// candidates too so a failed physical run explains which path was attempted.
class ObservedConnection extends RTCPeerConnection {
  constructor(config) {
    super(config);
    connections.push(this);
    if (connections.length > 20) connections.shift();
  }
}
const recordAudit = (event, data) => {
  audit.push({ event, data });
  if (audit.length > 100) audit.shift();
};

const stop = () => {
  base?.close();
  room?.leave();
  base = room = dispatch = null;
};

window.cluster = {
  async start({ roomId, signaling, name, budget, profile }) {
    stop();
    messages = [];
    // why: only rendezvous crosses SSH. ICE has no STUN/TURN server or tunnel;
    // the selected pair below proves the actual cross-host data path.
    room = await joinRoom({ roomId, identity, url: signaling, iceServers: [], audit: recordAudit,
      RTCPeerConnection: ObservedConnection, budget, profile });
    base = await createBaseNetwork({ identity, mesh: room.mesh, meta: () => ({ name }),
      dial: makeDhtDialer(room), audit: recordAudit });
    originalChunk = base.node.content.getChunk;
    base.node.gossip.subscribe(topic, ({ from, data }) => {
      messages.push({ from, data });
      if (messages.length > 200) messages.shift();
    });
    dispatch = makeMeshDispatch({
      sendDm: async (did, envelope) => {
        try { return { ok: true, ...await base.node.direct.send(did, envelope) }; }
        catch (error) { return { ok: false, error: error.message }; }
      },
      listPeers: async () => base.peers(),
      fetchCard: async () => null,
      publishCard: async () => ({ ok: false }),
      conversations: createConversationRegistry(),
    });
    base.node.direct.onMessage(({ from, data }) => {
      const routed = dispatch.handleInbound(from, data);
      if (routed?.deliver?.kind === 'ask') {
        const { reqId, message, convId } = routed.deliver;
        dispatch.reply(from, reqId, `PONG:${message}`, convId).catch(error => recordAudit('reply-failed', error.message));
      }
    });
    base.start();
    return { did: identity.did };
  },
  stop,
  diagnostics: () => Promise.all(connections.map(async pc => ({
    state: pc.connectionState, ice: pc.iceConnectionState,
    local: pc.localDescription?.sdp, remote: pc.remoteDescription?.sdp,
    stats: [...(await pc.getStats()).values()].filter(stat =>
      ['candidate-pair', 'local-candidate', 'remote-candidate'].includes(stat.type)),
  }))),
  report() {
    return { did: identity.did, online: !!base, rendezvous: room?.rendezvous(),
      peers: base?.snapshot().peers ?? [], messages, cards: base?.heardDwapps() ?? [], audit };
  },
  async paths() {
    return Promise.all(base.mesh.peers().map(async ({ did, channel }) => {
      const stats = await channel.pc.getStats();
      const transport = [...stats.values()].find(stat => stat.type === 'transport' && stat.selectedCandidatePairId);
      const pair = stats.get(transport?.selectedCandidatePairId);
      const candidate = id => {
        const value = stats.get(id);
        return value && { address: value.address ?? value.ip, port: value.port,
          protocol: value.protocol, type: value.candidateType };
      };
      return { did, maxMessageSize: channel.pc.sctp?.maxMessageSize, state: pair?.state, bytesSent: pair?.bytesSent, bytesReceived: pair?.bytesReceived,
        local: candidate(pair?.localCandidateId), remote: candidate(pair?.remoteCandidateId) };
    }));
  },
  gossip: ({ nonce }) => base.node.gossip.publish(topic, { nonce }),
  async conversation({ did, nonce }) {
    const permission = { signs: true, allowed: () => true };
    const first = await dispatch.dispatch('converse', { did, message: nonce, timeoutMs: 8000 }, permission);
    const second = first.convId && await dispatch.dispatch('say', {
      convId: first.convId, message: `${nonce}/followup`, timeoutMs: 8000,
    }, permission);
    return { first, second };
  },
  async publish({ slug }) {
    // why: random bytes resist compression, exercising chunking and SCTP
    // fragmentation instead of accidentally testing a tiny compressed string.
    const bytes = new Uint8Array(768 * 1024);
    for (let offset = 0; offset < bytes.length; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
    const published = await base.publishApp({ name: slug, entry: 'index.html',
      files: { 'index.html': '<!doctype html><title>cluster fixture</title>', 'payload.bin': bytes },
      fileKinds: { 'index.html': 'text', 'payload.bin': 'binary' } });
    const metadata = await base.publishMeta({ slug, name: slug,
      head: { version_id: published.hash, content_addr: published.uri, size: published.packedBytes } });
    const manifest = base.node.content.getManifest(published.hash);
    return { ...published, dwappId: metadata.dwapp_id, digest: await sha256hex(bytes),
      size: bytes.length, chunks: manifest.chunks.length, publisher: identity.did };
  },
  providers: ({ uri }) => base.findProviders(uri),
  drop({ did }) {
    const existed = room.mesh.hasLink(did);
    room.mesh.removeLink(did);
    return { existed, linked: room.mesh.hasLink(did) };
  },
  async fetch({ uri, provider }) {
    // why: this lane qualifies production behavior across real links; a tighter
    // harness-only deadline misclassifies healthy WAN transfer as product loss.
    const result = provider ? await base.mesh.fetchFrom(provider, uri)
      : await base.fetchApp(uri);
    const decoded = await unpackTransportBundle(result);
    received.set(uri, result);
    return { digest: await sha256hex(decoded.files['payload.bin']), size: decoded.files['payload.bin'].length,
      publisher: result.manifest.publisher, chunks: result.manifest.chunks.length };
  },
  async seed({ uri }) {
    const hash = await base.seedApp(received.get(uri));
    // seedApp intentionally announces in the background for product latency;
    // acceptance needs the replacement-provider record durably observed before
    // removing the publisher, rather than racing that background effect.
    const announcement = await base.announceProvider(uri);
    return { hash, announcement };
  },
  fetchMany: ({ uri, count }) => Promise.all(Array.from({ length: count }, () => window.cluster.fetch({ uri }))),
  unshare: ({ hash }) => base.unshareApp({ hash }),
  corrupt({ enabled }) {
    // Fault injection is confined to this fixture's serving store. Verification
    // still happens in the unmodified receiver over the real data channel.
    base.node.content.getChunk = enabled ? hash => {
      const bytes = originalChunk(hash)?.slice();
      if (bytes?.length) bytes[0] ^= 1;
      return bytes;
    } : originalChunk;
  },
};
