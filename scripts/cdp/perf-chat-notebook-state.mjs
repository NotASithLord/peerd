import { evalIn, rpc, waitFor, sseText, sseToolCall, sleep, openWidePage, attach, PANEL_METRICS, WIDE_METRICS, resetSession } from './e2e-harness.mjs';
import { NOTEBOOK_PROBE_TIMEOUT_MS, withNotebookProbeDeadline } from './notebook-probe-deadline.mjs';

const markdownCalls = async (page, witness) => {
  const realm = await evalIn(page, `({ href: location.href, timeOrigin: performance.timeOrigin })`);
  if (realm.href !== witness.href || realm.timeOrigin !== witness.timeOrigin) {
    throw new Error('PROBE-GAP: the calibrated Markdown document changed');
  }
  const { result } = await page.send('Profiler.takePreciseCoverage');
  const script = result.find((entry) => entry.scriptId === witness.scriptId);
  if (script && script.url !== witness.url) throw new Error('PROBE-GAP: the calibrated Markdown script changed');
  const fn = script?.functions.find((entry) => entry.functionName === 'renderMarkdown'
    && entry.ranges.some((range) => range.startOffset === witness.startOffset && range.endOffset === witness.endOffset));
  return fn?.ranges.find((range) => range.startOffset === witness.startOffset && range.endOffset === witness.endOffset)?.count ?? 0;
};
const startCoverage = async (page) => {
  await page.send('Profiler.enable');
  await page.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
};
const calibrateMarkdown = async (page, surface, rec) => {
  const before = await evalIn(page, 'performance.timeOrigin');
  await startCoverage(page);
  await page.send('Page.reload', { ignoreCache: true });
  await page.send('Page.bringToFront');
  const ready = await waitFor(() => evalIn(page, `performance.timeOrigin !== ${JSON.stringify(before)}
    && document.querySelectorAll('.message-assistant .md h2').length === 40
    && !!document.querySelector('form.input-bar textarea')`), { budgetMs: 30_000 });
  if (!ready) throw new Error('PROBE-GAP: the real saved chat did not reload for coverage calibration');
  const realm = await evalIn(page, `({ href: location.href, timeOrigin: performance.timeOrigin })`);
  const { result } = await page.send('Profiler.takePreciseCoverage');
  const script = result.find((entry) => entry.url.endsWith('/shared/markdown.js'));
  const fn = script?.functions.find((entry) => entry.functionName === 'renderMarkdown');
  const range = fn?.ranges?.[0];
  rec.observe('actual Markdown positive witness', {
    surface, before, ...realm, scriptId: script?.scriptId, url: script?.url,
    functionName: fn?.functionName, range,
  });
  if (!range || range.count <= 0) throw new Error('PROBE-GAP: the real saved-chat reload did not prove Markdown coverage');
  return { ...realm, scriptId: script.scriptId, url: script.url,
    startOffset: range.startOffset, endOffset: range.endOffset };
};
const stopCoverage = async (page) => {
  await page.send('Profiler.stopPreciseCoverage').catch(() => {});
  await page.send('Profiler.disable').catch(() => {});
};
const layoutCount = async (page) => {
  const { metrics } = await page.send('Performance.getMetrics');
  const metric = metrics.find((item) => item.name === 'LayoutCount');
  if (!metric) throw new Error('PROBE-GAP: actual layout metrics are absent');
  return metric.value;
};

export const PERF_CHAT_NOTEBOOK_STATES = [
  {
    name: 'perf-chat-markdown', kind: 'visual', phase: 'post-unlock',
    async run(ctx, rec) {
      const prior = (await rpc(ctx.page, { type: 'state/get' }))?.state?.settings;
      if (!prior) throw new Error('The chat benchmark settings are unavailable');
      const panelUrl = await evalIn(ctx.page, 'location.href');
      let home;
      let reply = 0;
      ctx.setModelResponder(() => ({ sse: sseText(`## PERF-REPLY-${reply}\n\n`
        + Array.from({ length: 40 }, (_, row) => `- **Row ${row}**: ${'one two three four five six seven eight nine ten '}`).join('\n')) }));
      try {
        if ((await rpc(ctx.page, { type: 'settings/update', patch: { autoMemoryEnabled: false, dwebEnabled: false } }))?.ok !== true) {
          throw new Error('The chat benchmark settings did not apply');
        }
        for (reply = 0; reply < 40; reply += 1) {
          const sent = await rpc(ctx.page, { type: 'agent/send', text: `PERF-CHAT-TURN-${reply}` });
          if (sent?.ok !== true) throw new Error('The real chat benchmark turn was refused');
          const done = await waitFor(() => evalIn(ctx.page, `!![...document.querySelectorAll('.message-assistant .md h2')]
            .find((node) => node.textContent === ${JSON.stringify(`PERF-REPLY-${reply}`)}) && !document.querySelector('button.stop')`), { budgetMs: 30_000 });
          if (!done) throw new Error('The real chat benchmark reply did not finish');
        }
        const state = await rpc(ctx.page, { type: 'state/get' });
        const id = state?.state?.session?.sessionId;
        const saved = await evalIn(ctx.page, `(async () => {
          'use strict';
          const { createKernelSessionReader } = await import('/background/kernel-session-reader.js');
          const idb = await import('/peerd-egress/storage/idb.js');
          return createKernelSessionReader(idb).get(${JSON.stringify(id)});
        })()`, true);
        rec.check('the long chat contains forty actual saved model replies', saved?.messages?.filter((message) =>
          message.role === 'assistant' && message.content?.startsWith('## PERF-REPLY-')).length === 40);
        for (const surface of ['panel', 'home']) {
          if (surface === 'home') {
            await ctx.page.send('Page.navigate', { url: 'about:blank' });
            const away = await waitFor(() => evalIn(ctx.page, `location.href === 'about:blank'`), { budgetMs: 5_000 });
            if (!away) throw new Error('The panel did not release Home chat custody');
            home = await openWidePage(ctx, 'home/home.html#chat', { ready: '.home-chat form.input-bar textarea' });
          }
          const page = home ?? ctx.page;
          const ready = await waitFor(() => evalIn(page, `document.querySelectorAll('.message-assistant .md h2').length === 40`), { budgetMs: 20_000 });
          if (!ready) throw new Error('The real long chat did not mount on this surface');
          try {
            const witness = await calibrateMarkdown(page, surface, rec);
            await evalIn(page, `document.querySelector('form.input-bar textarea').focus()`);
            for (const char of 'abcdefghijklmnopqrstuvwxyz1234') {
              await page.send('Input.insertText', { text: char });
              await sleep(20);
            }
            await sleep(120);
            const calls = await markdownCalls(page, witness);
            const typed = await evalIn(page, `document.querySelector('form.input-bar textarea').value`);
            rec.check(`real keys remain in the ${surface} composer`, typed === 'abcdefghijklmnopqrstuvwxyz1234', typed);
            if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe(`merge-base ${surface} Markdown calls while typing`, calls);
            else rec.check(`unchanged ${surface} replies do not parse Markdown while typing`, calls === 0, String(calls));
            await evalIn(page, `document.querySelector('form.input-bar textarea').value = '';
              document.querySelector('form.input-bar textarea').dispatchEvent(new Event('input', { bubbles: true }));`);
            if (surface === 'panel') await rec.visual('perf-chat-markdown');
            else await rec.visualPage('perf-chat-markdown-home', page);
          } finally { await stopCoverage(page); }
        }
      } finally {
        try {
          if (home) {
            await home.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
            home.close();
            await ctx.page.send('Page.navigate', { url: panelUrl });
            await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
            const restored = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('form.input-bar textarea')`), { budgetMs: 20_000 });
            if (!restored) throw new Error('The chat benchmark did not restore the panel');
          }
        } finally {
          try {
            // why: Reset with memory extraction off. The next state must own the first model reply.
            await resetSession(ctx);
          } finally {
            const restoredSettings = await rpc(ctx.page, { type: 'settings/update', patch: {
              autoMemoryEnabled: prior.autoMemoryEnabled, dwebEnabled: prior.dwebEnabled,
            } });
            if (restoredSettings?.ok !== true) throw new Error('The chat benchmark settings did not restore');
            if (prior.dwebChoiceMade === false && (await rpc(ctx.page, { type: 'settings/reset', keys: ['dwebEnabled'] }))?.ok !== true) {
              throw new Error('The chat benchmark network choice did not restore');
            }
          }
        }
      }
    },
  },
  {
    name: 'notebook-output-layout', kind: 'visual', phase: 'post-unlock',
    async run(ctx, rec) {
      const targets = () => fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((response) => response.json());
      const before = new Set((await targets()).map((target) => target.id));
      const previousActive = await evalIn(ctx.swConn, 'chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]?.id)', true);
      ctx.setModelResponder((index) => ({ sse: index === 0
        ? sseToolCall('sandbox_create', { kind: 'notebook', name: 'Output performance' })
        : sseText('NOTEBOOK-PERF-READY') }));
      let page;
      let tabId;
      let targetId;
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Create a Notebook named Output performance.' });
        if (sent?.ok !== true) throw new Error('The real Notebook creation turn was refused');
        const target = await waitFor(async () => (await targets()).find((item) =>
          !before.has(item.id) && item.url.includes('/engine-tabs/notebook-tab/index.html#')), { budgetMs: 30_000 });
        if (!target) throw new Error('The real Notebook did not open');
        targetId = target.id;
        const id = new URL(target.url).hash.slice(1).split(/[?&]/)[0];
        page = await attach(target.webSocketDebuggerUrl); await page.send('Page.enable'); await page.send('Runtime.enable');
        await page.send('Emulation.setDeviceMetricsOverride', WIDE_METRICS);
        const ready = await waitFor(() => evalIn(page, `!!document.querySelector('#notebook-app:not([hidden])')`), { budgetMs: 30_000 });
        if (!ready) throw new Error('The real Notebook did not become ready');
        const settled = await waitFor(() => evalIn(ctx.page, `document.body.textContent.includes('NOTEBOOK-PERF-READY') && !document.querySelector('button.stop')`), { budgetMs: 30_000 });
        if (!settled) throw new Error('The real Notebook creation receipt did not settle');
        tabId = (await evalIn(ctx.swConn, 'chrome.tabs.query({})', true)).find((tab) => tab.url === target.url)?.id;
        if (!Number.isInteger(tabId)) throw new Error('The exact Notebook tab id is absent');
        const run = async (lines) => withNotebookProbeDeadline(async (step) => {
          await step(() => page.send('Performance.enable'));
          const beforeLayouts = await step(() => layoutCount(page));
          const code = `for (let index = 0; index < ${lines}; index += 1) console.log('PERF-LINE-' + index); peerd.self.display('DISPLAY-END'); return 'RETURN-END';`;
          const started = Date.now();
          const result = await step(() => evalIn(ctx.swConn, `chrome.tabs.sendMessage(${tabId}, {
            type: 'js/eval', notebookId: ${JSON.stringify(id)}, code: ${JSON.stringify(code)}, timeoutMs: ${NOTEBOOK_PROBE_TIMEOUT_MS},
          }).then((reply) => ({ ok: reply?.ok, error: reply?.result?.error, value: reply?.result?.value,
            count: reply?.result?.consoleOutput?.length, first: reply?.result?.consoleOutput?.[0],
            last: reply?.result?.consoleOutput?.at(-1) }))`, true));
          await step(() => sleep(100));
          return { ...result, elapsedMs: Date.now() - started, layouts: (await step(() => layoutCount(page))) - beforeLayouts,
            children: await step(() => evalIn(page, `document.getElementById('console-output').childElementCount`)),
            outputTail: await step(() => evalIn(page, `document.getElementById('console-output').textContent.slice(-300)`)) };
        });
        const repeated = [];
        for (let index = 0; index < 3; index += 1) repeated.push(await run(1_000));
        rec.check('repeated real Notebook runs retain their full raw result', repeated.every((result) =>
          result.ok === true && !result.error && result.value === 'RETURN-END' && result.count === 1_000), JSON.stringify(repeated));
        await rec.visualPage('notebook-output-repeated', page);
        await page.send('Page.reload');
        const reloaded = await waitFor(() => evalIn(page, `!!document.querySelector('#notebook-app:not([hidden])')`), { budgetMs: 30_000 });
        if (!reloaded) throw new Error('The Notebook reload did not finish');
        if (Number.isInteger(previousActive)) await evalIn(ctx.swConn, `chrome.tabs.update(${previousActive}, { active: true })`, true);
        const background = await evalIn(ctx.swConn, `chrome.tabs.get(${tabId}).then((tab) => tab.active === false)`, true);
        rec.check('the real flood runs in a background Notebook tab', background === true);
        const flood = await run(20_000);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('merge-base real Notebook flood', flood);
        else {
          rec.check('the real Notebook flood avoids per-line layouts', flood.layouts < 200 && flood.elapsedMs < 15_000, JSON.stringify(flood));
          rec.check('the real Notebook flood keeps its complete raw result and both rich output paths', flood.ok === true
            && !flood.error && flood.value === 'RETURN-END' && flood.count === 20_000
            && flood.outputTail.includes('DISPLAY-END') && flood.outputTail.includes('RETURN-END'), JSON.stringify(flood));
        }
        // why: separate the background flood measurement from the active reader and resize check.
        await page.send('Page.bringToFront');
        await rec.visualPage('notebook-output-layout', page);
        const children = await evalIn(page, `document.getElementById('console-output').childElementCount`);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('merge-base output children', children);
        else rec.check('the painted output keeps at most five thousand children', children <= 5_000, String(children));
        rec.check('output pruning has no ResizeObserver feedback error', !page.events.some((event) => /ResizeObserver loop/.test(event)), JSON.stringify(page.events));
        const notebookActive = await evalIn(ctx.swConn, `chrome.tabs.get(${tabId}).then((tab) => tab.active)`, true);
        const notebookVisibility = await evalIn(page, 'document.visibilityState');
        if (notebookActive !== true || notebookVisibility !== 'visible') throw new Error('PROBE-GAP: the Notebook is not active and visible before the DOM reader check');
        await sleep(300);
        const reader = await evalIn(page, `(() => {
          'use strict';
          const pane = document.getElementById('output-pane');
          const scrollHeight = pane.scrollHeight, clientHeight = pane.clientHeight;
          pane.scrollTop = scrollHeight;
          const endScrollTop = pane.scrollTop;
          pane.scrollTop = 0;
          return { scrollHeight, clientHeight, endScrollTop, startScrollTop: pane.scrollTop };
        })()`);
        rec.observe('actual Notebook DOM reader range', { notebookActive, notebookVisibility, ...reader });
        if (!(reader.scrollHeight > reader.clientHeight && reader.endScrollTop > 0 && reader.startScrollTop === 0)) throw new Error('PROBE-GAP: the Notebook DOM reader position did not cross a real scroll range');
        const scrolled = await waitFor(() => evalIn(page, `document.getElementById('output-pane').scrollTop === 0`), { budgetMs: 5_000 });
        if (!scrolled) throw new Error('PROBE-GAP: the Notebook DOM reader did not reach the output start');
        await page.send('Emulation.setDeviceMetricsOverride', { ...WIDE_METRICS, width: 1100 });
        await sleep(300);
        rec.check('a width-only resize does not move the reader without new output', await evalIn(page, `document.getElementById('output-pane').scrollTop === 0`));
        await page.send('Emulation.setDeviceMetricsOverride', WIDE_METRICS);
        rec.observe('remaining Notebook scope', { scrollUpDuringNewOutputChanged: false,
          actorLedgerCovered: false, longClientTimeoutCovered: false, children });
      } finally {
        // why the browser endpoint: a saturated renderer cannot service its
        // own cleanup. Bound teardown too, so a failed baseline stays reviewable.
        if (targetId) await fetch(`http://127.0.0.1:${ctx.port}/json/close/${targetId}`,
          { signal: AbortSignal.timeout(5_000) }).catch(() => {});
        try { page?.close(); } catch {}
      }
    },
  },
];
