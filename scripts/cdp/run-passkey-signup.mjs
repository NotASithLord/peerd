#!/usr/bin/env bun
// Cold first-run passkey regression: drive a real WebAuthn PRF ceremony in a
// disposable Chrome profile, then prove the UI leaves the vault gate instead
// of hanging after the authenticator has returned.

import { evalIn, launchPeerd, rpc, waitFor } from './e2e-harness.mjs';

// This lane is a functional cold-start regression, not a CPU benchmark. The
// static import-graph test guards the heavyweight bundle regression; this
// budget distinguishes eventual completion from the former visible dead end.
const STARTUP_BUDGET_MS = 180_000;
const COMPLETION_BUDGET_MS = 30_000;

const buttonCenter = (page) => evalIn(page, `(() => {
  const button = [...document.querySelectorAll('button')].find((candidate) => {
    const text = candidate.textContent || '';
    return /create vault with/i.test(text) && !candidate.disabled;
  });
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`);

async function main() {
  // No model traffic occurs here. Leaving Fetch interception off avoids
  // attaching a debugger to (and pinning) the worker under test.
  const ctx = await launchPeerd({ interceptModel: false });
  try {
    await ctx.page.send('WebAuthn.enable');
    const common = {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    };
    // The capability probe may select either path before CDP installs the
    // fixtures, so make platform and USB authenticators PRF-capable.
    await ctx.page.send('WebAuthn.addVirtualAuthenticator', {
      options: { ...common, transport: 'internal' },
    });
    await ctx.page.send('WebAuthn.addVirtualAuthenticator', {
      options: { ...common, transport: 'usb' },
    });

    await evalIn(ctx.page, `(() => {
      window.__peerdPasskeyTrace = [];
      const record = () => {
        const text = document.body?.innerText || '';
        for (const stage of ['Waiting for passkey…', 'Finishing setup…',
          'Passkey verified. Finishing secure vault setup…']) {
          if (text.includes(stage) && !window.__peerdPasskeyTrace.some((entry) => entry.stage === stage)) {
            window.__peerdPasskeyTrace.push({ stage, at: performance.now() });
          }
        }
      };
      new MutationObserver(record).observe(document.documentElement, {
        subtree: true, childList: true, characterData: true,
      });
      record();
    })()`);

    const center = await waitFor(() => buttonCenter(ctx.page), {
      budgetMs: STARTUP_BUDGET_MS,
      pollMs: 50,
    });
    if (!center) throw new Error('first-run passkey button never became ready');

    const startedAt = performance.now();
    await evalIn(ctx.page, 'window.__peerdPasskeyClickAt = performance.now()');
    await ctx.page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', ...center, button: 'left', clickCount: 1,
    });
    await ctx.page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...center, button: 'left', clickCount: 1,
    });

    const completed = await waitFor(
      () => evalIn(ctx.page, `!document.querySelector('.gate-card')`),
      { budgetMs: COMPLETION_BUDGET_MS, pollMs: 50 },
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    const trace = await evalIn(ctx.page, 'window.__peerdPasskeyTrace || []');
    const state = await rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 10_000 });

    if (!completed) {
      const body = await evalIn(ctx.page, `document.body?.innerText?.slice(0, 800) || ''`);
      throw new Error(`signup did not leave the vault gate in ${COMPLETION_BUDGET_MS}ms\n${body}`);
    }
    if (!state?.state?.vault?.initialized || state.state.vault.locked || !state.state.vault.prfEnrolled) {
      throw new Error(`vault did not reach initialized+unlocked+PRF state: ${JSON.stringify(state?.state?.vault)}`);
    }

    const clickAt = await evalIn(ctx.page, 'window.__peerdPasskeyClickAt');
    const finishing = trace.find((entry) => entry.stage.startsWith('Passkey verified.'));

    console.log(JSON.stringify({
      ok: true,
      elapsedMs,
      ceremonyMs: finishing ? Math.round(finishing.at - clickAt) : null,
      postCredentialMs: finishing ? Math.round(elapsedMs - (finishing.at - clickAt)) : null,
      finishingStatusObserved: !!finishing,
      trace,
      vault: state.state.vault,
    }, null, 2));
  } finally {
    ctx.close();
  }
}

main().catch((error) => {
  console.error('[passkey-signup]', error?.stack || error);
  process.exit(1);
});
