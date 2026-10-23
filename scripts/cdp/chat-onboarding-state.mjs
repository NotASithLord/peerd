import {
  attach, evalIn, rpc, waitFor, sseText, sseToolCall, sleep, reloadReadyPanel,
} from './e2e-harness.mjs';
import { startOllamaAcceptanceFixture, ACCEPTANCE_MODEL } from './product-acceptance-probes.mjs';

const savedSession = (page, id) => evalIn(page, `(async () => {
  'use strict';
  const { createKernelSessionReader } = await import('/background/kernel-session-reader.js');
  const idb = await import('/peerd-egress/storage/idb.js');
  return createKernelSessionReader(idb).get(${JSON.stringify(id)});
})()`, true);
const tabIds = (page) => evalIn(page, 'chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.id))', true);

export const CHAT_ONBOARDING_STATES = [
  {
    name: 'chat-no-explicit-provider', kind: 'visual', phase: 'post-unlock',
    async run(ctx, rec) {
      try {
        for (const source of ['send', 'starter']) {
          await rpc(ctx.page, { type: 'session/reset' });
          const reset = await rpc(ctx.page, { type: 'settings/reset', keys: ['providerName', 'providerModel'] });
          if (reset?.ok !== true) throw new Error('Provider reset failed');
          const wire = [];
          ctx.setModelResponder((_index, request) => {
            wire.push(JSON.parse(request.postData));
            return { sse: sseText(`NO-CHOICE-${source}-OK`) };
          });
          const ready = await waitFor(async () => {
            const state = await rpc(ctx.page, { type: 'state/get' });
            return state?.state?.settings?.providerName === '' && state.state.composer?.canSend === true
              && state.state.composer.provider === 'ollama' && !state.state.session?.sessionId
              && await evalIn(ctx.page, `!!document.querySelector('.path-card[data-path="ask"]:not(:disabled)')`);
          }, { budgetMs: 20_000 });
          if (!ready) throw new Error('The unchosen Ollama composer did not become ready');
          if (source === 'send') {
            await evalIn(ctx.page, `document.querySelector('form.input-bar textarea').focus()`);
            await ctx.page.send('Input.insertText', { text: 'First send without an explicit provider.' });
            await evalIn(ctx.page, `document.querySelector('form.input-bar').requestSubmit()`);
          } else await evalIn(ctx.page, `document.querySelector('.path-card[data-path="ask"]').click()`);
          const settled = await waitFor(() => evalIn(ctx.page, `document.body.textContent.includes(${JSON.stringify(`NO-CHOICE-${source}-OK`)})
            && !document.querySelector('button.stop')`), { budgetMs: 25_000 });
          if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe(`merge-base first ${source}`, { settled, wireCalls: wire.length });
          else rec.check(`the first ${source} reaches the displayed Ollama provider once`, !!settled
            && wire.length === 1 && wire[0].model === ACCEPTANCE_MODEL, JSON.stringify({ settled, wire }));
          await rec.visual(source === 'send' ? 'chat-no-explicit-provider' : 'chat-no-choice-starter');
          if (!settled && process.env.PEERD_VISUAL_BASE_RENDER !== '1') throw new Error('The first unchosen-provider turn did not finish');
        }
      } finally {
        await rpc(ctx.page, { type: 'settings/update', patch: { providerName: 'ollama', providerModel: ACCEPTANCE_MODEL } });
      }
    },
  },
  {
    name: 'chat-cold-worker-resume', kind: 'visual', phase: 'post-unlock',
    async run(ctx, rec) {
      const prior = (await rpc(ctx.page, { type: 'state/get' }))?.state?.settings;
      if (!prior) throw new Error('The cold-resume fixture has no settings baseline');
      let active;
      const fixture = await startOllamaAcceptanceFixture({ completionDelayMs: 5,
        completionResponse: async ({ requestBody }) => {
          if (!active) throw new Error('No cold-resume case owns this model call');
          const index = active.requests.push(requestBody) - 1;
          if (index === 0 && active.kind === 'tool') return sseToolCall('script', {
            code: 'await new Promise(resolve => setTimeout(resolve, 90000)); return "old tool finished";',
          });
          if (index === 0 && active.kind === 'unknown') return sseToolCall('open_tab', {});
          if (index === 0 && ['model', 'auto-off'].includes(active.kind)
              || index === 1 && active.kind === 'unknown') {
            await active.held;
            return sseText('LATE-OLD-RESPONSE');
          }
          return sseText(`COLD-RECOVERED-${active.kind}`);
        } });
      try {
        // why: the real model fixture must use the port allowed by the extension.
        ctx.setModelResponder((_index, request) => {
          if (request.url !== `${fixture.origin}/v1/chat/completions` || request.method !== 'POST') {
            throw new Error('PROBE-GAP: the cold model request left its owned fixture');
          }
          return { continueRequest: true };
        });
        const configured = await rpc(ctx.page, { type: 'settings/update', patch: {
          ollamaHost: fixture.origin, providerName: 'ollama', providerModel: ACCEPTANCE_MODEL,
          autoMemoryEnabled: false, dwebEnabled: false,
        } });
        if (configured?.ok !== true) throw new Error('The real cold-resume model wire was not configured');
        for (const kind of ['model', 'tool', 'auto-off', 'finished', 'unknown']) {
          await rpc(ctx.page, { type: 'session/reset' });
          await rpc(ctx.page, { type: 'settings/update', patch: { autoResumeInterruptedTurns: kind !== 'auto-off' } });
          let release;
          const held = new Promise((resolve) => { release = resolve; });
          active = { kind, requests: [], held };
          const beforeTabs = new Set(await tabIds(ctx.page));
          try {
            const sent = await rpc(ctx.page, { type: 'agent/send', text: `COLD-WORKER-${kind}` });
            if (sent?.ok !== true) throw new Error(`Cold-resume send refused: ${JSON.stringify(sent)}`);
            // why: send admission returns before the new chat is durable.
            const id = await waitFor(async () => {
              const state = await rpc(ctx.page, { type: 'state/get' });
              const candidate = state?.state?.session?.sessionId;
              if (typeof candidate !== 'string') return null;
              const session = await savedSession(ctx.page, candidate);
              return session?.messages?.some((message) => message.role === 'user'
                && message.synthetic !== true && message.content === `COLD-WORKER-${kind}`) ? candidate : null;
            }, { budgetMs: 30_000 });
            if (!id) throw new Error('PROBE-GAP: the real cold-resume turn has no durable session');
            const pending = await waitFor(async () => {
              const session = await savedSession(ctx.page, id);
              const last = session?.messages?.at(-1);
              if (kind === 'finished') return last?.content === 'COLD-RECOVERED-finished' && last.stopReason === 'end_turn' ? session : null;
              if (kind === 'tool') return last?.role === 'assistant' && last.stopReason === 'tool_use'
                && last.toolUses?.some((tool) => tool.name === 'script') ? session : null;
              return active.requests.length >= (kind === 'unknown' ? 2 : 1) && last?.role === 'assistant' && last.streaming === true ? session : null;
            }, { budgetMs: 30_000 });
            if (!pending) {
              const session = await savedSession(ctx.page, id);
              const last = session?.messages?.at(-1);
              rec.observe('cold phase diagnostics', {
                kind, id, origin: fixture.origin, modelCalls: active.requests.length, wire: fixture.requests,
                last: last && { role: last.role, streaming: last.streaming, stopReason: last.stopReason,
                  error: last.error, content: String(last.content ?? '').slice(0, 1_500) },
                events: [...(ctx.page.events ?? []), ...(ctx.swConn?.events ?? []),
                  ...ctx.extensionTargetEvents().flatMap((target) => target.events)].slice(-20)
                  .map((event) => String(event).slice(0, 3_000)),
              });
              throw new Error(`PROBE-GAP: the actual ${kind} phase was not reached`);
            }
            let unknown;
            if (kind === 'unknown') {
              const opened = (await tabIds(ctx.page)).filter((tab) => !beforeTabs.has(tab));
              if (opened.length !== 1) throw new Error('PROBE-GAP: the unknown control did not perform exactly one real tab effect');
              const closed = await evalIn(ctx.swConn, '(async () => { await chrome.offscreen.closeDocument(); return true; })()', true);
              if (!closed) throw new Error('The real controller host did not close');
              const absent = await waitFor(() => evalIn(ctx.swConn,
                `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((contexts) => contexts.length === 0)`, true), { budgetMs: 5_000 });
              if (!absent) throw new Error('PROBE-GAP: the old controller document is still present');
              unknown = await waitFor(async () => {
                const session = await savedSession(ctx.page, id);
                return session?.messages?.findLast((message) => message.role === 'assistant'
                  && message.outcomeKnown === false && message.retryable === false && message.streaming !== true) ?? null;
              }, { budgetMs: 30_000 });
              if (!unknown) throw new Error('PROBE-GAP: real host loss did not save unknown custody');
            }
            const beforeCalls = active.requests.length;
            // why: record fresh events without changing the native stop check.
            const workerVersions = [];
            const observeWorkerVersion = (method, params) => {
              if (method !== 'ServiceWorker.workerVersionUpdated') return;
              for (const version of params?.versions ?? []) workerVersions.push({
                at: Date.now(), versionId: version.versionId, scriptURL: version.scriptURL,
                runningStatus: version.runningStatus, targetId: version.targetId ?? null,
              });
              if (workerVersions.length > 32) workerVersions.splice(0, workerVersions.length - 32);
            };
            const beforeWorkerTargets = await fetch(`http://127.0.0.1:${ctx.port}/json/list`, {
              signal: AbortSignal.timeout(2_000),
            }).then((reply) => reply.json()).then((targets) => targets
              .filter((target) => target.type === 'service_worker').slice(-32)
              .map((target) => ({ targetId: target.id, scriptURL: target.url })))
              .catch((cause) => ({ diagnosticError: String(cause).slice(0, 1_000) }));
            let old;
            ctx.page.on(observeWorkerVersion);
            try {
              old = await ctx.stopServiceWorker();
            } catch (cause) {
              const afterWorkerTargets = await fetch(`http://127.0.0.1:${ctx.port}/json/list`, {
                signal: AbortSignal.timeout(2_000),
              }).then((reply) => reply.json()).then((targets) => targets
                .filter((target) => target.type === 'service_worker').slice(-32)
                .map((target) => ({ targetId: target.id, scriptURL: target.url })))
                .catch((error) => ({ diagnosticError: String(error).slice(0, 1_000) }));
              rec.observe('cold worker retirement diagnostics', {
                kind, id, beforeWorkerTargets, afterWorkerTargets, workerVersions,
                error: String(cause).slice(0, 3_500),
              });
              throw cause;
            } finally { ctx.page.off(observeWorkerVersion); }
            const next = await ctx.restartServiceWorker(old);
            const authority = await rpc(ctx.page, { type: 'state/get' });
            rec.check(`the ${kind} case uses a stopped worker and a fresh unlocked kernel`,
              old.stoppedRunningStatus === 'stopped' && old.targetId !== next.targetId
              && authority?.state?.vault?.locked === false, JSON.stringify({ old, next, vault: authority?.state?.vault }));
            if (authority?.state?.vault?.locked !== false) throw new Error('PROBE-GAP: cold boot did not restore unlocked custody');
            const resumed = ['model', 'tool'].includes(kind);
            if (resumed) {
              const completed = await waitFor(async () => {
                const session = await savedSession(ctx.page, id);
                return session?.messages?.some((message) => message.role === 'assistant'
                  && message.content === `COLD-RECOVERED-${kind}` && message.streaming !== true) ? session : null;
              }, { budgetMs: process.env.PEERD_VISUAL_BASE_RENDER === '1' ? 12_000 : 30_000 });
              if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe(`merge-base cold ${kind}`, { completed: !!completed, calls: active.requests.length });
              else rec.check(kind === 'tool' ? 'cold worker resumes the saved tool-use interruption once'
                : `cold worker resumes the real ${kind} interruption once`, !!completed
                && active.requests.length === beforeCalls + 1
                && completed.messages.filter((message) => message.role === 'user' && message.content === `COLD-WORKER-${kind}`).length === 1,
              JSON.stringify({ calls: active.requests.length, beforeCalls, last: completed?.messages?.at(-1) }));
              if (completed) {
                const calls = active.requests.length;
                await reloadReadyPanel(ctx, { expectedSessionId: id }); await sleep(1_000);
                rec.check(`reloading the recovered ${kind} chat does not repeat it`, active.requests.length === calls);
              }
            } else {
              await sleep(8_000);
              rec.check(`cold ${kind} cannot make an extra model call`, active.requests.length === beforeCalls,
                JSON.stringify({ calls: active.requests.length, beforeCalls, unknown }));
              if (kind === 'unknown') rec.check('unknown custody keeps its one real effect without automatic replay',
                (await tabIds(ctx.page)).filter((tab) => !beforeTabs.has(tab)).length === 1
                && (await savedSession(ctx.page, id)).messages.some((message) => message.id === unknown.id && message.outcomeKnown === false));
            }
            await rec.visual(kind === 'model' ? 'chat-cold-worker-resume' : `chat-cold-${kind}`);
          } finally {
            await rpc(ctx.page, { type: 'settings/update', patch: { autoResumeInterruptedTurns: false } }).catch(() => {});
            await rpc(ctx.page, { type: 'agent/stop' }).catch(() => {});
            release();
            await evalIn(ctx.page, `(async () => {
              const before = new Set(${JSON.stringify([...beforeTabs])});
              const tabs = await chrome.tabs.query({});
              await Promise.all(tabs.filter((tab) => !before.has(tab.id)).map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
            })()`, true).catch(() => {});
          }
        }
      } catch (cause) {
        rec.observe('cold phase error', { kind: active?.kind, error: String(cause),
          stack: String(cause?.stack ?? '').slice(0, 3_500) });
        throw cause;
      } finally {
        active = null;
        try {
          const restored = await rpc(ctx.page, { type: 'settings/update', patch: {
            ollamaHost: prior.ollamaHost, providerName: prior.providerName, providerModel: prior.providerModel,
            autoResumeInterruptedTurns: prior.autoResumeInterruptedTurns, autoMemoryEnabled: prior.autoMemoryEnabled,
            dwebEnabled: prior.dwebEnabled,
          } });
          if (restored?.ok !== true) throw new Error('The cold-resume settings did not restore');
          if (prior.dwebChoiceMade === false && (await rpc(ctx.page, { type: 'settings/reset', keys: ['dwebEnabled'] }))?.ok !== true) {
            throw new Error('The cold-resume network choice did not restore');
          }
        } finally {
          ctx.setModelResponder();
          await fixture.close();
        }
      }
    },
  },
  {
    name: 'vm-explicit-boot-refusal', kind: 'visual', phase: 'post-unlock',
    async run(ctx, rec) {
      const before = new Set(await tabIds(ctx.page));
      const beforeTargets = new Set((await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((reply) => reply.json())).map((target) => target.id));
      const version = await fetch(`http://127.0.0.1:${ctx.port}/json/version`).then((reply) => reply.json());
      const connection = await attach(version.webSocketDebuggerUrl);
      const jobs = [], faults = [], wire = [];
      let faultError;
      const listener = (method, params, envelope) => {
        if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'page') {
          const session = params.sessionId;
          jobs.push((async () => {
            await connection.send('Fetch.enable', { patterns: [{ urlPattern: '*/vendor/cheerpx/cx.esm.js' }] }, session);
            await connection.send('Runtime.runIfWaitingForDebugger', {}, session);
          })().catch((cause) => { faultError = String(cause); }));
        }
        if (method === 'Fetch.requestPaused' && params.request?.url?.endsWith('/vendor/cheerpx/cx.esm.js')) {
          faults.push({ url: params.request.url, at: Date.now(), sessionId: envelope.sessionId });
          void connection.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' }, envelope.sessionId)
            .catch((cause) => { faultError = String(cause); });
        }
      };
      connection.on(listener);
      await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] });
      await Promise.all(jobs);
      let page;
      let firstCallAt;
      let resultAt;
      ctx.setModelResponder((index, request) => {
        wire.push(JSON.parse(request.postData));
        if (index === 0) { firstCallAt = Date.now(); return { sse: sseToolCall('sandbox_create', { kind: 'webvm', name: 'Boot refusal' }) }; }
        resultAt = Date.now();
        return { sse: sseText('VM-BOOT-REFUSED') };
      });
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Create a WebVM named Boot refusal.' });
        if (sent?.ok !== true) throw new Error('The VM creation turn was not accepted');
        const target = await waitFor(async () => (await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((reply) => reply.json()))
          .find((item) => !beforeTargets.has(item.id) && item.type === 'page' && item.url?.includes('/engine-tabs/vm-tab/index.html#')), { budgetMs: 30_000 });
        if (!target) throw new Error('The real VM tab did not open');
        page = await attach(target.webSocketDebuggerUrl); await page.send('Page.enable');
        const failed = await waitFor(() => evalIn(page, `document.getElementById('vm-boot')?.classList.contains('is-failed')`), { budgetMs: 30_000 });
        const done = await waitFor(() => evalIn(ctx.page, `document.body.textContent.includes('VM-BOOT-REFUSED') && !document.querySelector('button.stop')`), { budgetMs: 40_000 });
        if (process.env.PEERD_REQUIRE_VM_MODULE_FAULT === '1' && faults.length !== 1) throw new Error('PROBE-GAP: the strict VM module fault was not exercised');
        if (!failed || !done || faultError) throw new Error(`The explicit VM boot failure did not settle: ${JSON.stringify({ failed, done, faultError })}`);
        const id = new URL(target.url).hash.slice(1);
        const saved = await evalIn(ctx.page, `(async () => {
          const row = await (await import('/peerd-egress/storage/idb.js')).get('vms', 'webvms.v1');
          return row?.value?.vms?.[${JSON.stringify(id)}] ?? null;
        })()`, true);
        const state = await rpc(ctx.page, { type: 'state/get' });
        const session = await savedSession(ctx.page, state?.state?.session?.sessionId);
        const results = session?.messages?.flatMap((message) => message.toolResults ?? []) ?? [];
        const report = { faults, latencyMs: resultAt - firstCallAt, saved, results,
          isolated: await evalIn(page, 'globalThis.crossOriginIsolated'), body: await evalIn(page, 'document.body.innerText.slice(0, 3000)') };
        const retained = (await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((reply) => reply.json()))
          .some((item) => item.id === target.id && item.url === target.url);
        rec.check('the real failed VM tab stays open for its boot details', failed && retained, JSON.stringify(report));
        if (process.env.PEERD_REQUIRE_VM_MODULE_FAULT === '1') {
          rec.check('strict isolation reaches the actual CheerpX module-wire fault', report.isolated === true && faults.length === 1, JSON.stringify(report));
          if (report.isolated !== true) throw new Error('PROBE-GAP: the strict VM module fault was not exercised');
        }
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('merge-base explicit VM failure result', report);
        else rec.check('explicit boot failure is fast and known and rolls back the new record',
          report.latencyMs < 20_000 && saved === null && results.some((result) => result.is_error === true
            && result.outcomeKnown !== false && /vm_spawn_failed/.test(result.content ?? '')), JSON.stringify(report));
        await rec.visualPage('vm-explicit-boot-failed-tab', page);
        await rec.visual('vm-explicit-boot-refusal');
      } finally {
        connection.off(listener);
        await connection.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
        connection.close();
        try { page?.close(); } catch {}
        await evalIn(ctx.page, `(async () => {
          const before = new Set(${JSON.stringify([...before])});
          const tabs = await chrome.tabs.query({});
          await Promise.all(tabs.filter((tab) => !before.has(tab.id)).map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
        })()`, true).catch(() => {});
      }
    },
  },
];
