// @ts-check
// Real consent/status components, controlled read observations, no network IO.
import m from '/vendor/mithril/mithril.js';
import { PeerNetworkStep } from '/sidepanel/components/onboarding-network-step.js';

/** @type {Record<string, object>} */
const scenarios = {
  searching: { running: true, rendezvous: 'up', linkedCount: 0 },
  connected: { running: true, rendezvous: 'up', linkedCount: 2 },
  surviving: { running: true, rendezvous: 'down', linkedCount: 1 },
  disconnected: { running: true, rendezvous: 'down', linkedCount: 0 },
  unavailable: { ok: false },
};
const fixture = { scenario: 'searching', starts: 0 };
Object.assign(window, { peerStatusFixture: fixture });
/** @param {{type:string}} message */
const send = async message => {
  if (message.type === 'bootstrap/ready') return { ok: true,
    featureLeases: { leases: { dweb: { status: 'active' } } } };
  if (message.type === 'dweb/distributed/info') return scenarios[fixture.scenario] ?? { ok: false };
  if (message.type === 'dweb/base/start') { fixture.starts += 1; return { ok: true }; }
  throw new Error('Fixture has no settings or installation authority');
};
m.mount(document.getElementById('app'), { view: () => m(PeerNetworkStep, { send, enabled: true }) });
