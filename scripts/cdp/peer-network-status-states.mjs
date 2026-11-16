import { evalIn, openExtPage, openWidePage, waitFor } from './e2e-harness.mjs';

// State transitions exercise the actual component's read/retry loop. The
// transport observations are fixtures, not evidence of WAN reachability.
const STATUS_STATES = [false, true].map(narrow => ({
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

// The Network page with people. The fixture answers every read, so the
// picture is the same on each run. On the merge-base render the old page
// draws, so only the Stop button is checked there.
const NETWORK_PEOPLE_STATES = [false, true].map(narrow => ({
  name: `home-network-people${narrow ? '-narrow' : ''}`,
  kind: 'visual', phase: 'post-unlock', responder: null,
  async run(ctx, rec) {
    const page = await openWidePage(ctx, 'tests/fixtures/network.html', {
      metrics: { width: narrow ? 320 : 960, height: 900, deviceScaleFactor: 1, mobile: false }, ready: '.peerd-net',
    });
    try {
      const ready = await waitFor(() => evalIn(page, `[...document.querySelectorAll('.peerd-net-btn')]
        .some(button => button.textContent === 'Stop the network')`), { budgetMs: 8000 });
      rec.check('the Network page shows the Stop button', !!ready);
      if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') {
        const named = await waitFor(() => evalIn(page, `[...document.querySelectorAll('.peerd-net-row')]
          .some(row => row.textContent.includes('Ana'))`), { budgetMs: 8000 });
        rec.check('a saved contact shows by name', !!named);
        rec.check('the status line counts connected people', await evalIn(page,
          `document.querySelector('.peerd-net [role="status"]')?.textContent === 'Connected to 2 people'`));
        rec.check('the list has three people', await evalIn(page,
          `document.querySelectorAll('.peerd-net-row').length === 3`));
        rec.check('the meeting point is not in the list', await evalIn(page,
          `![...document.querySelectorAll('.peerd-net-row')].some(row => row.textContent.includes('bootstrap'))`));
        rec.check('Technical details is closed', await evalIn(page,
          `document.querySelector('details.peerd-net-tech')?.open === false`));
        rec.check('the page fits the viewport', await evalIn(page, 'document.documentElement.scrollWidth <= innerWidth'));
      }
      await rec.visualPage(`home-network-people${narrow ? '-narrow' : ''}`, page);
    } finally { page.close(); }
  },
}));

export const PEER_NETWORK_STATUS_STATES = [...STATUS_STATES, ...NETWORK_PEOPLE_STATES];
