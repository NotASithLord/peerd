// Exercise the shipped Notebook host, not a test reimplementation of its relay.
// The harness intercepts only the final network response; browser sender identity,
// executable admission, the worker seal, and the host's request envelope stay real.
import { evalIn, openWidePage, rpc, sseText, waitFor } from './e2e-harness.mjs';

export const NOTEBOOK_FETCH_STATE = {
  name: 'notebook-owned-fetch', kind: 'functional', phase: 'post-unlock',
  responder: () => ({ sse: sseText('noted') }),
  async run(ctx, rec) {
    const notebookId = 'e2e-owned-fetch';
    const url = 'https://remote-module.test/store-policy-canary.js';
    const page = await openWidePage(ctx, `engine-tabs/notebook-tab/index.html#${notebookId}`,
      { ready: '#notebook-app:not([hidden])' });
    const command = (message) => evalIn(ctx.swConn, `(async () => {
      const tab = (await chrome.tabs.query({})).find((candidate) =>
        candidate.url?.endsWith(${JSON.stringify(`#${notebookId}`)}));
      if (!tab?.id) return null;
      return chrome.tabs.sendMessage(tab.id, ${JSON.stringify({ notebookId, ...message })});
    })()`, true);
    try {
      const ready = await waitFor(async () => {
        const reply = await command({ type: 'js/list-files' }).catch(() => null);
        return reply?.ok === true;
      }, { budgetMs: 10_000, pollMs: 50 });
      if (!ready) throw new Error('Notebook command host did not become ready');

      // Observe, but never replace, the shipped transport or its response.
      await evalIn(page, `(async () => {
        const browser = (await import('/shared/browser-api.js')).default;
        const original = browser.runtime.sendMessage.bind(browser.runtime);
        globalThis.__ownedFetchEnvelopes = [];
        browser.runtime.sendMessage = (message, ...args) => {
          if (message?.type === 'sw/web-fetch') {
            globalThis.__ownedFetchEnvelopes.push({ ...message });
          }
          return original(message, ...args);
        };
      })()`, true);
      const outcome = await command({
        type: 'js/eval', timeoutMs: 10_000,
        code: `const response = await peerd.egress.fetch(${JSON.stringify(url)});
          return { ok: response.ok, text: await response.text() };`,
      });
      rec.check('ordinary Notebook fetch reaches the real audited route and returns data',
        outcome?.result?.value?.ok === true
          && outcome.result.value.text === "export const value = 'remote-canary-executed';",
        JSON.stringify(outcome));
      const envelopes = await evalIn(page, 'globalThis.__ownedFetchEnvelopes');
      rec.check('the shipped host supplies its own Notebook identity',
        envelopes?.length === 1 && envelopes[0]?.notebookId === notebookId
          && envelopes[0]?.url === url, JSON.stringify(envelopes));

      // A real extension sender alone is insufficient: the instance must match
      // the browser-owned document. These requests must stop before egress.
      for (const [label, message] of [
        ['missing', { type: 'sw/web-fetch', url }],
        ['foreign', { type: 'sw/web-fetch', url, notebookId: 'another-notebook' }],
      ]) {
        const reply = await rpc(page, message);
        rec.check(`${label} Notebook identity remains rejected`,
          reply?.ok === false && reply?.error === 'kernel-route-unauthorized', JSON.stringify(reply));
      }
      const panelReply = await rpc(ctx.page, { type: 'sw/web-fetch', url, notebookId });
      rec.check('the panel cannot impersonate the Notebook host',
        panelReply?.ok === false && panelReply?.error === 'kernel-route-unauthorized', JSON.stringify(panelReply));

      const forged = await command({
        type: 'js/eval', timeoutMs: 10_000,
        code: `return await new Promise((resolve) => {
          addEventListener('message', (event) => {
            if (event.data?.type === 'fetch-response' && event.data.rid === 'forged-id') {
              resolve({ ok: event.data.ok, status: event.data.status });
            }
          });
          postMessage({ type: 'fetch-request', rid: 'forged-id',
            url: ${JSON.stringify(url)}, method: 'GET', notebookId: 'another-notebook' });
        });`,
      });
      const lastEnvelope = await evalIn(page, 'globalThis.__ownedFetchEnvelopes.at(-1)');
      rec.check('worker-supplied identity cannot replace the trusted host identity',
        forged?.result?.value?.ok === true && forged.result.value.status === 200
          && lastEnvelope?.notebookId === notebookId, JSON.stringify({ forged, lastEnvelope }));
      await rec.shotPage('owned-fetch', page);
    } finally { try { page.close(); } catch { /* already detached */ } }
  },
};
