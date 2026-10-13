import { evalIn, openExtPage, waitFor } from './e2e-harness.mjs';

// State transitions exercise the actual component's read/retry loop. The
// transport observations are fixtures, not evidence of WAN reachability.
export const PEER_NETWORK_STATUS_STATES = [false, true].map(narrow => ({
  name: `peer-network-status${narrow ? '-narrow' : ''}`,
  kind: 'functional', phase: 'post-unlock', responder: null,
  async run(ctx, rec) {
    const page = await openExtPage(ctx, 'tests/fixtures/peer-network-status.html');
    try {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: narrow ? 320 : 960, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      const status = () => evalIn(page, `document.querySelector('.peer-network-status [role="status"]')?.textContent ?? ''`);
      const ready = await waitFor(async () => (await status()).includes('Looking for peers.'), { budgetMs: 8000 });
      rec.check('an introduction-server connection alone is not a peer connection', !!ready);
      rec.check('reading status never starts the network', await evalIn(page, 'window.peerStatusFixture.starts === 0'));
      for (const [scenario, expected] of [
        ['searching', 'Looking for peers. No direct peer connections yet.'],
        ['connected', 'Connected to 2 peers.'],
        ['surviving', 'Connected to 1 peer.'],
        ['disconnected', 'The introduction service is unavailable'],
        ['unavailable', 'Connection status unavailable'],
        ['connected', 'Connected to 2 peers.'],
      ]) {
        await evalIn(page, `(() => {
          window.peerStatusFixture.scenario = ${JSON.stringify(scenario)};
          document.querySelector('.peer-network-status button').click();
        })()`);
        const settled = await waitFor(async () => (await status()).includes(expected), { budgetMs: 8000 });
        rec.check(`status recovers to ${scenario}`, !!settled, await status());
        rec.check(`${scenario} fits the viewport`, await evalIn(page, 'document.documentElement.scrollWidth <= innerWidth'));
        await rec.visualPage(`peer-network-${scenario}${narrow ? '-narrow' : ''}`, page);
      }
      rec.check('only explicit retry clicks requested a start', await evalIn(page, 'window.peerStatusFixture.starts === 6'));
    } finally { page.close(); }
  },
}));
