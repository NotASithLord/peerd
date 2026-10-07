// @ts-check
// One identity and production protocol stack per isolated browser context.
import { generateIdentity } from '/peerd-distributed/identity/keypair.js';
import { joinRoom } from '/peerd-distributed/transport/rooms.js';
import { PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE } from '/peerd-distributed/transport/rendezvous-profile.js';
import { roomAdmission } from '/peerd-distributed/transport/admission.js';
import { outgoingGovernor, OUTGOING_LIMITS } from '/peerd-distributed/transport/outgoing.js';
import { createBaseNetwork } from '/peerd-distributed/base-network.js';
import { manifestHash, verifyManifest } from '/peerd-distributed/content/manifest.js';
import { unpackTransportBundle } from '/peerd-distributed/content/bundle.js';
import { twoPeerEndpoint } from './dweb-twopeer-endpoint.js';

const endpoint = twoPeerEndpoint(new URLSearchParams(location.search).get('url'));
const topic = 'native-sparse-scale';
const fixtureText = '<!doctype html><h1>Native sparse content proof</h1>';
const Native = globalThis.RTCPeerConnection;
/** @type {Set<RTCPeerConnection>} */ const pcs = new Set();
/** @type {Set<RTCDataChannel>} */ const channels = new Set();
/** @type {Set<WebSocket>} */ const sockets = new Set();
/** @type {any[]} */ const errors = [];
/** @type {Map<string, {from:string,via:string}>} */ const received = new Map();
/** @type {Map<string, string[]>} */ const dispatches = new Map();
let constructed = 0, opened = 0, closed = 0;
/** @type {any} */ let room = null;
/** @type {any} */ let base = null;
/** @type {any} */ let identity = null;
let phase = 'ready', stopped = false;
const peaks = { pcs: 0, degree: 0, active: 0, queued: 0, outgoingBytes: 0, outgoingFrames: 0 };
/** @param {string} name @param {any} value */
const record = (name, value) => { errors.push({ name, value: String(value).slice(0, 180) }); if (errors.length > 32) errors.shift(); };
/** @param {RTCDataChannel} channel */
const observeChannel = channel => {
  if (channels.has(channel)) return;
  channels.add(channel);
  let countedOpen = false;
  const noteOpen = () => { if (!countedOpen) { countedOpen = true; opened++; } };
  if (channel.readyState === 'open') noteOpen();
  channel.addEventListener('open', noteOpen, { once: true });
  channel.addEventListener('close', () => { closed++; channels.delete(channel); });
  const send = channel.send;
  channel.send = function (/** @type {any} */ data) {
    const result = Reflect.apply(send, this, [data]);
    // Observe the accepted native send, after signing and writer backpressure.
    // Only this fixture's small gossip tags are decoded; no payload is retained.
    if (typeof data === 'string' && data.length < 32_768) {
      try {
        const frame = JSON.parse(data), tag = frame.body?.data?.tag;
        if (frame.from === identity?.did && frame.body?.topic === topic && typeof tag === 'string'
            && tag.length < 80 && !dispatches.has(tag) && dispatches.size < 16) {
          dispatches.set(tag, room.peers().map((/** @type {any} */ peer) => peer.did));
        }
      } catch { /* unrelated native frame */ }
    }
    return result;
  };
};
// Transparent native carrier instrumentation; do not replace SDP, frames or ICE.
const CountedPeer = new Proxy(Native, { construct(target, args, newTarget) {
  const pc = Reflect.construct(target, args, newTarget);
  if (!Array.isArray(args[0]?.iceServers) || args[0].iceServers.length) throw new Error('non-loopback ICE configuration');
  pcs.add(pc); constructed++;
  const close = pc.close;
  pc.close = function () { const result = Reflect.apply(close, this, []); pcs.delete(pc); return result; };
  pc.addEventListener('datachannel', (/** @type {RTCDataChannelEvent} */ event) => observeChannel(event.channel));
  const create = pc.createDataChannel;
  pc.createDataChannel = function (/** @type {any[]} */ ...values) { const channel = Reflect.apply(create, this, values); observeChannel(channel); return channel; };
  sample();
  return pc;
} });
class CountedSocket extends WebSocket {
  /** @param {string} url */
  constructor(url) { super(url); sockets.add(this); this.addEventListener('close', event => { sockets.delete(this); if (event.code !== 1000 && event.code !== 1001) record('socket-close', event.code); }); }
}
const sample = () => {
  const admission = roomAdmission.stats(), outgoing = outgoingGovernor.stats();
  peaks.pcs = Math.max(peaks.pcs, pcs.size); peaks.degree = Math.max(peaks.degree, room?.peers().length ?? 0);
  peaks.active = Math.max(peaks.active, admission.active); peaks.queued = Math.max(peaks.queued, admission.queued);
  peaks.outgoingBytes = Math.max(peaks.outgoingBytes, outgoing.bytes); peaks.outgoingFrames = Math.max(peaks.outgoingFrames, outgoing.frames);
  return { admission, outgoing };
};
const sampler = setInterval(sample, 200);
const report = () => ({ phase, did: identity?.did, peers: room?.peers().map((/** @type {any} */ peer) => peer.did) ?? [],
  rendezvous: room?.rendezvous(), resources: { pcs: pcs.size, channels: channels.size, sockets: sockets.size, ...sample() },
  constructed, opened, closed, peaks: { ...peaks }, errors: [...errors], received: [...received], limits: OUTGOING_LIMITS });
const start = async () => {
  if (stopped || room) throw new Error('fixture already started or stopped');
  phase = 'identity'; identity = await generateIdentity();
  phase = 'joining';
  room = await joinRoom({ identity, roomId: PUBLIC_ROOM, profile: SPARSE_PUBLIC_PROFILE,
    url: endpoint, iceServers: [], RTCPeerConnection: CountedPeer, WebSocket: CountedSocket,
    awaitInitialRendezvous: false, audit: (name, details) => record(name, details?.reason ?? '') });
  base = await createBaseNetwork({ identity, mesh: room.mesh });
  base.node.gossip.subscribe(topic, (/** @type {any} */ message) => {
    if (typeof message.data?.tag === 'string' && message.data.tag.length < 80) {
      received.set(message.data.tag, { from: message.from, via: message.via });
      const oldest = received.keys().next().value;
      if (received.size > 16 && oldest !== undefined) received.delete(oldest);
    }
  });
  base.start(); phase = 'running'; return report();
};
/** @type {any} */ (globalThis).__DWEB_SCALE__ = {
  report, start,
  /** @param {string} did */
  drop(did) { room.mesh.removeLink(did, 'scale-fixture-churn'); return report(); },
  isolate() { for (const peer of room.peers()) room.mesh.removeLink(peer.did, 'scale-fixture-churn'); return report(); },
  /** @param {string} tag @param {string} [nonNeighbor] */
  async publish(tag, nonNeighbor) {
    if (nonNeighbor && room.mesh.hasLink(nonNeighbor)) throw new Error('non-neighbor proof lost before dispatch');
    await base.node.gossip.publish(topic, { tag });
    const neighbors = dispatches.get(tag);
    if (!neighbors || (nonNeighbor && neighbors.includes(nonNeighbor))) throw new Error('native dispatch non-neighbor proof lost');
    return { neighbors, tag, from: identity.did };
  },
  async publishContent() { return base.publishApp({ name: 'Scale proof', files: { 'index.html': fixtureText }, entry: 'index.html' }); },
  /** @param {string} uri @param {string} expectedHash */
  async fetchContent(uri, expectedHash) {
    const fetched = await base.fetchApp(uri);
    const actual = await manifestHash(fetched.manifest), verified = await verifyManifest(fetched.manifest);
    const { files } = await unpackTransportBundle(fetched);
    const content = new TextDecoder().decode(files['index.html']);
    if (!verified.ok || actual !== expectedHash || content !== fixtureText) throw new Error('verified content mismatch');
    return { hash: actual, publisher: fetched.manifest.publisher, bytes: fetched.payload.byteLength, contentVerified: true };
  },
  stop() { stopped = true; phase = 'stopped'; clearInterval(sampler); room?.leave(); base?.close(); return report(); },
};
