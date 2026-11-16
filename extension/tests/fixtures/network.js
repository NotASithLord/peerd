// @ts-check
// The real Network page with controlled people, no network IO.
import m from '/vendor/mithril/mithril.js';
import { NetworkSection } from '/home/network-section.js';

const ANA = 'did:key:zAnaAAAAhiPpn68X';
const info = {
  running: true, did: 'did:key:zSelfAbcdefgh', lobby: 'peerd/base/1',
  peerCount: 3, linkedCount: 2, presentCount: 3, dhtSize: 4,
  rendezvous: 'up', bootstrapUrl: 'wss://bootstrap.peerd.ai/rendezvous',
  peers: [
    { did: ANA, linked: true, path: 'direct-ipv4' },
    { did: 'did:key:zRelayBBBBq7Tm2LdK', linked: true, path: 'direct-ipv6-relay' },
    { did: 'did:key:zHeardCCCCw9Xc4NvB', linked: false },
  ],
};
// why: a person gets a random brand color, and two renders must match.
let n = 0;
Math.random = () => [0.05, 0.45, 0.65][n++ % 3];
/** @param {{type:string}} message */
const send = async message => {
  if (message.type === 'dweb/distributed/info') return info;
  if (message.type === 'contacts/list') return { ok: true, contacts: [{ did: ANA, name: 'Ana', saved: true }] };
  if (message.type === 'dweb/base/start' || message.type === 'dweb/base/stop') return { ok: true };
  throw new Error('Fixture has no settings or installation authority');
};
m.mount(/** @type {Element} */ (document.getElementById('app')), { view: () => m(NetworkSection, { send }) });
