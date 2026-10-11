import { attach, evalIn, rpc, sseText, sseToolCall, waitFor } from './e2e-harness.mjs';

const descriptor = (runtime) => JSON.stringify({
  schema: 1, kind: 'app', entry: 'index.html',
  agent: { kind: 'bound-app', profile: 'developer', surface: 'code' },
  capabilities: [], ...(runtime ? { runtime } : {}),
});
const core = { schema: 1, target: 'browser-app', requires: ['wasm-core'] };
const unsupported = { ...core, requires: ['future-runtime-feature'] };

// This deliberately loads the production App host, not just runner.html: the
// host must withhold app-body after its private runner capability handshake.
export const APP_RUNTIME_STATES = ['legacy', 'core', 'unsupported'].map((variant) => ({
  name: `app-runtime-${variant}`, kind: 'functional', phase: 'post-unlock',
  responder: (callIndex) => ({ sse: callIndex === 0 ? sseToolCall('sandbox_create', {
    kind: 'app', name: `Runtime ${variant}`, files: {
      'peerd.json': descriptor(variant === 'legacy' ? undefined : variant === 'core' ? core : unsupported),
      'index.html': '<!doctype html><title>Runtime canary</title><script>parent.postMessage({runtimeCanary:"executed"},"*")</script>',
    },
  }) : sseText('RUNTIME-READY') }),
  async run(ctx, rec) {
    let page;
    try {
      const previous = new Set((await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then(reply => reply.json())).map(target => target.id));
      const created = await rpc(ctx.page, { type: 'agent/send', text: `Create an App named Runtime ${variant}.` });
      rec.check('runtime fixture creation accepted', created?.ok === true, JSON.stringify(created));
      const target = await waitFor(async () => {
        const targets = await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then(reply => reply.json());
        return targets.find(candidate => candidate.type === 'page' && !previous.has(candidate.id)
          && candidate.url?.includes('/engine-tabs/app-tab/index.html#'));
      }, { budgetMs: 30_000, pollMs: 100 });
      if (!target) throw new Error('Runtime fixture App host did not open');
      page = await attach(target.webSocketDebuggerUrl);
      await page.send('Page.enable');
      // Install before a fresh navigation, so all delivery/execution in the
      // tested document is observed, including an unexpectedly early delivery.
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        globalThis.__runtimeProbe = { bodies: 0, executions: 0 };
        const original = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function(message, ...rest) {
          if (message?.type === 'app-body') globalThis.__runtimeProbe.bodies += 1;
          return original.call(this, message, ...rest);
        };
        addEventListener('message', event => {
          if (event.data?.runtimeCanary === 'executed') globalThis.__runtimeProbe.executions += 1;
        });
      ` });
      const inspect = async (blocked) => {
        await page.send('Page.reload');
        const settled = await waitFor(() => evalIn(page, `(() => {
          const probe = globalThis.__runtimeProbe;
          const failed = document.getElementById('boot')?.classList.contains('is-failed');
          if (!probe || !(${blocked} ? failed : probe.executions > 0)) return null;
          return { ...probe, failed, message: document.getElementById('boot')?.textContent ?? '' };
        })()`).catch(() => null), { budgetMs: 15_000, pollMs: 100 });
        rec.check(blocked ? 'unsupported App never receives bytes or executes publisher script'
          : 'compatible App receives bytes and executes publisher script',
        blocked ? settled?.failed === true && settled.bodies === 0 && settled.executions === 0
            && settled.message.includes('future-runtime-feature')
          : settled?.failed === false && settled.bodies === 1 && settled.executions === 1,
        JSON.stringify(settled));
      };
      await inspect(variant === 'unsupported');
      if (variant === 'core') {
        const appId = new URL(target.url).hash.slice(1).split('?')[0];
        // Use the same owner-authorized write boundary as the local editor;
        // the next host document must read the edited descriptor, not a cached
        // installation declaration or the preceding runner's successful probe.
        const edited = await rpc(page, { type: 'app/editor-write', appId,
          path: 'peerd.json', content: descriptor(unsupported) });
        rec.check('local descriptor edit accepted', edited?.ok === true, JSON.stringify(edited));
        await inspect(true);
      }
    } finally { try { page?.close(); } catch { /* already closed */ } }
  },
}));
