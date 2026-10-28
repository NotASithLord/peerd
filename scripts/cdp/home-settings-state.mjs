import {
  evalIn, rpc, waitFor, sseText, sseToolCalls, openWidePage, PASSPHRASE, PANEL_METRICS,
} from './e2e-harness.mjs';

// why: observe actual requests and receipts without changing their result.
const observeRequests = (page) => evalIn(page, `(async () => {
  const browser = (await import('/shared/browser-api.js')).default;
  const original = globalThis.__homeSettingsProofOriginal ??= browser.runtime.sendMessage.bind(browser.runtime);
  globalThis.__homeSettingsProof = { messages: [], armed: false, timeOrigin: performance.timeOrigin };
  browser.runtime.sendMessage = async (message, ...args) => {
    const entry = { type: message?.type, body: message?.body, patch: message?.patch, armed: globalThis.__homeSettingsProof.armed };
    globalThis.__homeSettingsProof.messages.push(entry);
    const reply = await original(message, ...args);
    entry.reply = reply;
    return reply;
  };
})()`, true);
const restoreRequests = (page) => evalIn(page, `(async () => {
  const browser = (await import('/shared/browser-api.js')).default;
  if (globalThis.__homeSettingsProofOriginal) browser.runtime.sendMessage = globalThis.__homeSettingsProofOriginal;
  delete globalThis.__homeSettingsProofOriginal;
  delete globalThis.__homeSettingsProof;
})()`, true);

const sandboxes = [
  { kind: 'webvm', label: 'WebVM', name: 'Named shell', store: 'vms', key: 'webvms.v1', collection: 'vms', path: 'vm-tab' },
  { kind: 'notebook', label: 'Notebook', name: 'Named notebook', store: 'notebooks', key: 'notebooks.v1', collection: 'notebooks', path: 'notebook-tab' },
  { kind: 'pod', label: 'Pod', name: 'Named pod', store: 'pods', key: 'pods.v1', collection: 'pods', path: 'pod-tab' },
  { kind: 'app', label: 'App', name: 'Named App', store: 'apps', key: 'apps.v1', collection: 'apps', path: 'app-tab' },
];

export const HOME_SETTINGS_STATES = [
  {
    name: 'engine-task-tab-names', kind: 'visual', phase: 'post-unlock',
    isolatedWebSecurity: true,
    responder: (index) => ({ sse: index === 0 ? sseToolCalls(sandboxes.map(({ kind, name }) => ({
      name: 'sandbox_create', args: { kind, name, ...(kind === 'app'
        ? { files: { 'index.html': '<!doctype html><title>Named App</title><h1>Named App</h1>' } } : {}) },
    }))) : sseText('NAMED-TABS-READY') }),
    async run(ctx, rec) {
      const before = await evalIn(ctx.page, `chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.id))`, true);
      try {
        const sent = await rpc(ctx.page, { type: 'agent/send', text: 'Create a WebVM, Notebook, Pod and App with the supplied names.' });
        if (sent?.ok !== true) throw new Error(`Sandbox turn refused: ${JSON.stringify(sent)}`);
        const done = await waitFor(() => evalIn(ctx.page, `document.body.textContent.includes('NAMED-TABS-READY')
          && document.querySelectorAll('.agent-tab-notice').length === 4
          && !document.querySelector('button.stop')`), { budgetMs: 120_000, pollMs: 100 });
        if (!done) throw new Error('The four real sandbox creations did not settle');
        const records = await evalIn(ctx.page, `(async () => {
          const idb = await import('/peerd-egress/storage/idb.js');
          return Promise.all(${JSON.stringify(sandboxes)}.map(async (spec) => {
            const row = await idb.get(spec.store, spec.key);
            const record = Object.values(row?.value?.[spec.collection] ?? {}).find((item) => item.name === spec.name);
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find((item) => item.url?.includes('/engine-tabs/' + spec.path + '/index.html#' + record?.id));
            return { ...spec, id: record?.id, savedName: record?.name, tabId: tab?.id, url: tab?.url };
          }));
        })()`, true);
        rec.check('all four names are saved in their real registries and have live tabs',
          records.length === 4 && records.every((item) => item.id && item.savedName === item.name && Number.isInteger(item.tabId)), JSON.stringify(records));
        if (records.some((item) => !Number.isInteger(item.tabId))) throw new Error('A saved sandbox has no real tab');
        const cards = await evalIn(ctx.page, `[...document.querySelectorAll('.agent-tab-notice')].map((row) => ({
          label: row.querySelector('.agent-tab-notice-label')?.textContent,
          aria: row.querySelector('.agent-tab-notice-go')?.getAttribute('aria-label') }))`);
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('merge-base task card labels', cards);
        else rec.check('each task card has its saved name and distinct Go name', records.every((item) => cards.some((card) =>
          card.label === item.label + ' · ' + item.name && card.aria === 'Go to task tab: ' + item.label + ' · ' + item.name)), JSON.stringify(cards));
        const focused = [];
        for (const [index, item] of records.entries()) {
          const rowIndex = process.env.PEERD_VISUAL_BASE_RENDER === '1' ? index
            : cards.findIndex((card) => card.label === item.label + ' · ' + item.name);
          if (rowIndex < 0) throw new Error(`The named card is missing: ${item.name}`);
          await ctx.page.send('Page.bringToFront');
          await evalIn(ctx.page, `document.querySelectorAll('.agent-tab-notice')[${rowIndex}].scrollIntoView({ block: 'center' })`);
          await rec.visual(item.kind === 'notebook' ? 'engine-task-tab-names' : `engine-task-card-${item.kind}`);
          await evalIn(ctx.page, `document.querySelectorAll('.agent-tab-notice-go')[${rowIndex}].click()`);
          const active = await waitFor(() => evalIn(ctx.page, `chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) =>
            tabs.find((tab) => ${process.env.PEERD_VISUAL_BASE_RENDER === '1' ? JSON.stringify(records.map((entry) => entry.tabId)) + '.includes(tab.id)' : 'tab.id === ' + item.tabId}) ?? null)`, true),
          { budgetMs: 5_000, pollMs: 50 });
          focused.push(active?.id);
          rec.check(process.env.PEERD_VISUAL_BASE_RENDER === '1' ? `Go control ${index + 1} opens a created task tab` : `Go opens the exact ${item.label} task tab`, !!active && active.url === (process.env.PEERD_VISUAL_BASE_RENDER === '1'
            ? records.find((entry) => entry.tabId === active.id)?.url : item.url), JSON.stringify(active));
        }
        rec.check('the four Go controls reach four distinct created tabs', new Set(focused).size === 4, JSON.stringify(focused));
      } finally {
        await evalIn(ctx.page, `(async () => {
          const before = new Set(${JSON.stringify(before)});
          const tabs = await chrome.tabs.query({});
          await Promise.all(tabs.filter((tab) => !before.has(tab.id)).map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
        })()`, true).catch(() => {});
        await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
      }
    },
  },
  {
    name: 'home-network-stop-state', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const supported = await evalIn(ctx.page, `(async () => (await import('/shared/channel-config.js')).DWEB_ENABLED)()`, true);
      if (!supported) { rec.check('this host has no peer network controls', true); return; }
      const off = await rpc(ctx.page, { type: 'settings/update', patch: { dwebEnabled: false } });
      if (off?.ok !== true) throw new Error('The network OFF control did not settle');
      const readWindow = (surface) => surface ? Promise.race([
        evalIn(surface, `(async () => {
          'use strict';
          const tab = await chrome.tabs.getCurrent();
          const ownerWindow = await chrome.windows.getCurrent();
          return { tabId: tab?.id ?? null, windowId: tab?.windowId ?? ownerWindow.id,
            href: location.href, timeOrigin: performance.timeOrigin, visibility: document.visibilityState,
            history: globalThis.__homeSettingsVisibility ?? [] };
        })()`, true).catch((cause) => ({ error: String(cause) })),
        new Promise((resolve) => setTimeout(() => resolve({ error: 'Window read timed out' }), 2_000)),
      ]) : Promise.resolve(null);
      const panelBefore = await readWindow(ctx.page);
      const tabsBefore = await evalIn(ctx.page, `chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.id))`, true);
      const visibilitySource = `(() => {
        'use strict';
        const rows = globalThis.__homeSettingsVisibility = [{ at: Date.now(), visibility: document.visibilityState }];
        document.addEventListener('visibilitychange', () => {
          rows.push({ at: Date.now(), visibility: document.visibilityState });
          if (rows.length > 16) rows.shift();
        });
      })()`;
      // why: native window creation can briefly cover another window before the
      // requested bounds settle. Prepare both blank shells before loading Homes.
      const windowBounds = (offset) => evalIn(ctx.page, `({
        left: screen.availLeft + Math.min(${offset}, Math.floor(screen.availWidth / 4)),
        top: screen.availTop + Math.min(${offset}, Math.floor(screen.availHeight / 4)),
        width: Math.min(1000, Math.floor(screen.availWidth / 2)),
        height: Math.min(900, Math.floor(screen.availHeight / 2)),
      })`);
      const ownedHomes = [];
      let page;
      let other;
      let dialog;
      let dialogFailure;
      let vaultLocked = false;
      const checkWindows = async (label) => {
        const views = await Promise.all([ctx.page, page, other].map(readWindow));
        rec.check(`${label}: both owned Home documents and the original native panel stay live`,
          String(panelBefore.href ?? '').split('#')[0] === `chrome-extension://${ctx.sw.id}/sidepanel/sidepanel.html`
          && views[0]?.timeOrigin === panelBefore.timeOrigin && views[0]?.windowId === panelBefore.windowId
          && ownedHomes.length === 2 && views.slice(1).every((view, index) => view?.timeOrigin === ownedHomes[index].timeOrigin
            && view?.tabId === ownedHomes[index].tabId && view?.windowId === ownedHomes[index].windowId
            && view?.visibility === 'visible' && view.history.every((row) => row.visibility === 'visible')),
          JSON.stringify({ panelBefore, ownedHomes, views }));
      };
      const onDialog = (method, params) => {
        if (method !== 'Page.javascriptDialogOpening') return;
        dialog = params;
        void page.send('Page.handleJavaScriptDialog', { accept: params.type === 'confirm'
          && params.message.startsWith('Shut down all peer-to-peer networking?') }).catch((cause) => { dialogFailure = String(cause); });
      };
      try {
        // why: A tab switch inside one Home window intentionally closes a nonsticky panel.
        page = await openWidePage(ctx, 'home/home.html#discover', { newWindow: true, windowBounds: await windowBounds(80), deferNavigation: true });
        other = await openWidePage(ctx, 'home/home.html#discover', { newWindow: true, windowBounds: await windowBounds(160), deferNavigation: true });
        await page.navigate();
        await evalIn(page, visibilitySource);
        ownedHomes.push(await readWindow(page));
        const choice = await waitFor(() => evalIn(page, `!!document.querySelector('[data-network-choice="enable"]:not(:disabled)')`), { budgetMs: 15_000 });
        if (!choice) throw new Error('The real network opt-in did not render');
        await observeRequests(page);
        await evalIn(page, `document.querySelector('[data-network-choice="enable"]').click()`);
        const enabled = await waitFor(() => evalIn(page, `globalThis.__homeSettingsProof.messages.find((entry) => entry.type === 'settings/update' && entry.patch?.dwebEnabled === true && entry.reply?.ok === true)`), { budgetMs: 30_000 });
        if (!enabled) throw new Error('The real network opt-in did not receive a successful receipt');
        // Opt-in already starts the host. Discover offers Try again only when
        // offline, so a healthy connection has no retry control to click.
        // Exercise the real idempotent Start route after the actual UI opt-in.
        const started = await rpc(page, { type: 'dweb/base/start' });
        rec.check('real opt-in and the Start route receive successful receipts', enabled.reply?.ok === true
          && started?.ok === true, JSON.stringify({ enabled, started }));
        if (started?.ok !== true) throw new Error('The real network Start did not settle');
        await other.navigate();
        await evalIn(other, visibilitySource);
        ownedHomes.push(await readWindow(other));
        rec.check('the native panel and both real Home pages own three distinct windows',
          Number.isInteger(panelBefore.windowId) && ownedHomes.every((home) => Number.isInteger(home.tabId) && Number.isInteger(home.windowId))
          && new Set([panelBefore.windowId, ...ownedHomes.map((home) => home.windowId)]).size === 3
          && new Set(ownedHomes.map((home) => home.tabId)).size === 2, JSON.stringify({ panelBefore, ownedHomes }));
        // A healthy Discover looking view has no status row until a peer is
        // connected. The enabled rail plus mounted non-opt-in view is the
        // positive readiness witness; peer availability is not this test.
        const enabledDiscover = `!!document.querySelector('[data-home-view="network"]')
          && !!document.querySelector('.peer-network-status, .disc-view:not(.disc-start-view)')
          && !document.querySelector('[data-network-choice="enable"]')`;
        const bothReady = await waitFor(async () => await evalIn(page, enabledDiscover)
          && await evalIn(other, enabledDiscover), { budgetMs: 15_000 });
        if (!bothReady) throw new Error('Both real Home pages did not receive the enabled state');
        await observeRequests(other);
        await observeRequests(ctx.page);
        await page.send('Page.bringToFront');
        await evalIn(page, `document.querySelector('[data-home-view="network"]').click()`);
        const live = await waitFor(() => evalIn(page, `[...document.querySelectorAll('.peerd-net-btn')].some((button) => button.textContent === 'Stop the network' && !button.disabled)`), { budgetMs: 15_000 });
        if (!live) throw new Error('The real Network page did not reach its running view');
        await rec.visualPage('home-network-running', page);
        await checkWindows('After the running captures');
        for (const surface of [page, other, ctx.page]) await evalIn(surface, `globalThis.__homeSettingsProof.armed = true`);
        page.on(onDialog);
        await evalIn(page, `[...document.querySelectorAll('.peerd-net-btn')].find((button) => button.textContent === 'Stop the network').click()`);
        const receipt = await waitFor(() => evalIn(page, `globalThis.__homeSettingsProof.messages.find((entry) => entry.armed && entry.type === 'dweb/base/stop' && entry.reply)`), { budgetMs: 30_000 });
        rec.check('Stop uses the native confirm and its real route succeeds', dialog?.type === 'confirm'
          && !dialogFailure && receipt?.reply?.ok === true && receipt.reply.running === false, JSON.stringify({ dialog, dialogFailure, receipt }));
        if (receipt?.reply?.ok !== true) throw new Error('The real network Stop did not settle');
        const readHomes = () => Promise.all([page, other].map((surface) => evalIn(surface, `({
          railOff: !document.querySelector('[data-home-view="network"], [data-home-view="contacts"]'),
          active: document.querySelector('[data-home-view].is-active')?.dataset.homeView,
          enable: !!document.querySelector('[data-network-choice="enable"]'),
          stop: [...document.querySelectorAll('button')].some((button) => button.textContent === 'Stop the network'),
          timeOrigin: performance.timeOrigin })`)));
        const changed = await waitFor(async () => {
          const homes = await readHomes();
          return homes.every((home) => home.railOff) && homes[0].stop === false && homes[1].enable ? homes : null;
        }, { budgetMs: 8_000, pollMs: 100 });
        const beforeRead = await readHomes();
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('merge-base Home state before any state read', beforeRead);
        else rec.check('Stop updates both Home rails and the other Home choice without a read', !!changed, JSON.stringify(beforeRead));
        await rec.visualPage('home-network-stop-state', page);
        await rec.visualPage('home-network-other-home-off', other);
        await checkWindows('After Stop and both stopped captures');
        const logs = await Promise.all([page, other, ctx.page].map((surface) => evalIn(surface, 'globalThis.__homeSettingsProof')));
        rec.check('no state/get read can cause the observed Home update', logs.every((log) => !log.messages.some((entry) => entry.armed && entry.type === 'state/get')), JSON.stringify(logs));
        for (const surface of [page, other, ctx.page]) await evalIn(surface, `globalThis.__homeSettingsProof.armed = false`);
        const state = await rpc(page, { type: 'state/get' });
        const refusedStart = await rpc(page, { type: 'dweb/base/start' });
        rec.check('Stop persists OFF and a stale Start cannot opt in again', state?.state?.settings?.dwebEnabled === false
          && refusedStart?.ok === false && refusedStart.error === 'dweb-disabled', JSON.stringify({ settings: state?.state?.settings, refusedStart }));
        const lock = await rpc(ctx.page, { type: 'vault/lock' });
        vaultLocked = lock?.ok === true;
        const unlock = await rpc(ctx.page, { type: 'vault/unlock', passphrase: PASSPHRASE }, { timeoutMs: 120_000 });
        if (unlock?.ok === true) vaultLocked = false;
        const after = await rpc(ctx.page, { type: 'state/get' });
        const host = await rpc(ctx.page, { type: 'bootstrap/ready' });
        rec.check('unlock cannot restart a network that the user stopped', lock?.ok === true && unlock?.ok === true
          && after?.state?.settings?.dwebEnabled === false && !['starting', 'active'].includes(host?.featureLeases?.leases?.dweb?.status), JSON.stringify({ settings: after?.state?.settings, lease: host?.featureLeases?.leases?.dweb }));
        await checkWindows('After the real lock and unlock');
      } catch (cause) {
        rec.observe('Home window original error before cleanup', {
          error: String(cause), views: await Promise.all([ctx.page, page, other].map(readWindow)),
        });
        throw cause;
      } finally {
        page?.off(onDialog);
        try {
          if (vaultLocked) await rpc(ctx.page, { type: 'vault/unlock', passphrase: PASSPHRASE }, { timeoutMs: 120_000 });
          await restoreRequests(ctx.page);
        } finally {
          try { await other?.close(); } catch {}
          try { await page?.close(); } catch {}
          await rpc(ctx.page, { type: 'settings/update', patch: { dwebEnabled: false } }).catch(() => {});
          let remaining;
          const retired = await waitFor(async () => {
            remaining = await evalIn(ctx.page, `(async () => {
              'use strict';
              return { tabs: (await chrome.tabs.query({})).map((tab) => tab.id),
                windows: (await chrome.windows.getAll()).map((ownerWindow) => ownerWindow.id) };
            })()`, true);
            return ownedHomes.every((home) => !remaining.tabs.includes(home.tabId)
              && !remaining.windows.includes(home.windowId));
          }, { budgetMs: 5_000, pollMs: 50 });
          const panelAfter = await readWindow(ctx.page);
          rec.check('cleanup closes only the two owned Home windows and keeps the original panel',
            !!retired && ownedHomes.length === 2 && tabsBefore.every((id) => remaining.tabs.includes(id))
            && panelAfter?.timeOrigin === panelBefore.timeOrigin && panelAfter?.windowId === panelBefore.windowId,
            JSON.stringify({ ownedHomes, remaining, tabsBefore, panelBefore, panelAfter }));
        }
      }
    },
  },
  {
    name: 'settings-memory-locked-save', kind: 'visual', phase: 'post-unlock', responder: null,
    async run(ctx, rec) {
      const baseline = '# User memory\n\n- Keep the saved baseline.';
      const draft = '# User memory\n\n- Keep this exact draft after unlock: café ✓';
      let page;
      let prior;
      let seedAttempted = false;
      let locked = false;
      try {
        // why: Memory routes accept only the real Options document.
        page = await openWidePage(ctx, 'options/options.html#!/behavior');
        const before = await rpc(page, { type: 'memory/export' });
        if (before?.ok !== true || !Array.isArray(before.payload?.docs)) throw new Error(`Memory baseline read failed: ${JSON.stringify(before)}`);
        prior = before.payload.docs.find((doc) => doc.kind === 'user');
        seedAttempted = true;
        const written = await rpc(page, { type: 'memory/write', scope: { kind: 'user' }, body: baseline });
        if (written?.ok !== true) throw new Error(`Memory baseline write failed: ${JSON.stringify(written)}`);
        await evalIn(page, `location.hash = '!/memory'`);
        const ready = await waitFor(() => evalIn(page, `[...document.querySelectorAll('.memory-card')].some((card) => card.querySelector('.memory-scope')?.textContent === 'User · global')`), { budgetMs: 15_000 });
        if (!ready) throw new Error('The real user Memory editor did not mount');
        await observeRequests(page);
        await observeRequests(ctx.page);
        await evalIn(page, `(() => {
          const card = [...document.querySelectorAll('.memory-card')].find((item) => item.querySelector('.memory-scope')?.textContent === 'User · global');
          globalThis.__memoryProofEditor = card.querySelector('textarea.memory-editor');
          globalThis.__memoryProofEditor.focus(); globalThis.__memoryProofEditor.select();
        })()`);
        await page.send('Input.insertText', { text: draft });
        await rec.visualPage('settings-memory-private-draft', page);
        const lock = await rpc(ctx.page, { type: 'vault/lock' });
        if (lock?.ok !== true) throw new Error('Vault lock failed');
        locked = true;
        await evalIn(page, `globalThis.__memoryProofEditor.closest('.memory-card').querySelector('.memory-card-actions button').click()`);
        // why the painted message too: Mithril renders the reply on its next animation frame.
        const refusal = await waitFor(() => evalIn(page, `globalThis.__memoryProofEditor.closest('.memory-card').querySelector('.key-msg:not(:empty)') && globalThis.__homeSettingsProof.messages.find((entry) => entry.type === 'memory/write' && entry.reply)`), { budgetMs: 10_000 });
        const view = await evalIn(page, `({
          draft: globalThis.__memoryProofEditor?.value,
          sameEditor: globalThis.__memoryProofEditor === document.querySelector('textarea.memory-editor'),
          text: globalThis.__memoryProofEditor.closest('.memory-card').querySelector('.key-msg.err')?.textContent,
          retryEnabled: !globalThis.__memoryProofEditor.closest('.memory-card').querySelector('.memory-card-actions button').disabled,
          timeOrigin: performance.timeOrigin })`);
        const stored = await evalIn(page, `(async () => (await (await import('/peerd-egress/storage/idb.js')).get('agents_memory', 'user'))?.body)()`, true);
        rec.check('the real locked save keeps the same draft and leaves durable memory unchanged',
          refusal?.reply?.ok === false && refusal.reply.error === 'vault-locked' && refusal.body === draft
          && view.draft === draft && view.sameEditor && view.retryEnabled && stored === baseline, JSON.stringify({ refusal, view, stored }));
        if (process.env.PEERD_VISUAL_BASE_RENDER === '1') rec.observe('merge-base locked Memory guidance', view.text);
        else rec.check('known locked Memory copy gives the unlock step without dropping the draft',
          view.text === 'Vault is locked. Unlock it in the peerd panel, then try again.', view.text);
        await rec.visualPage('settings-memory-locked-save', page);
        await ctx.page.send('Page.bringToFront');
        const unlockReady = await waitFor(() => evalIn(ctx.page, `!!document.querySelector('#pass:not(:disabled)')`), { budgetMs: 15_000 });
        if (!unlockReady) throw new Error('The real panel unlock control did not mount');
        await evalIn(ctx.page, `document.getElementById('pass').focus()`);
        await ctx.page.send('Input.insertText', { text: PASSPHRASE });
        await evalIn(ctx.page, `document.getElementById('pass').closest('form').requestSubmit()`);
        const unlocked = await waitFor(() => evalIn(ctx.page, `globalThis.__homeSettingsProof.messages.find((entry) => entry.type === 'vault/unlock' && entry.reply?.ok === true)`), { budgetMs: 120_000 });
        if (!unlocked) throw new Error('The user Unlock control did not succeed');
        locked = false;
        await page.send('Page.bringToFront');
        const kept = await waitFor(() => evalIn(page, `globalThis.__memoryProofEditor?.isConnected && globalThis.__memoryProofEditor.value === ${JSON.stringify(draft)}`), { budgetMs: 15_000 });
        rec.check('user Unlock and return keep the original Settings draft', !!kept);
        if (!kept) throw new Error('The draft was lost after unlock');
        await evalIn(page, `globalThis.__memoryProofEditor.closest('.memory-card').querySelector('.memory-card-actions button').click()`);
        const saved = await waitFor(async () => {
          const memory = await rpc(page, { type: 'memory/export' });
          return memory?.ok === true && memory.payload?.docs?.find((doc) => doc.kind === 'user')?.body === draft
            && await evalIn(page, `globalThis.__memoryProofEditor.closest('.memory-card').querySelector('.key-msg.ok')?.textContent === 'Saved.'`);
        }, { budgetMs: 15_000, pollMs: 100 });
        const writes = await evalIn(page, `globalThis.__homeSettingsProof.messages.filter((entry) => entry.type === 'memory/write')`);
        rec.check('an explicit retry saves the exact draft once after unlock', !!saved && writes.length === 2
          && writes[0].reply?.error === 'vault-locked' && writes[1].reply?.ok === true && writes.every((entry) => entry.body === draft), JSON.stringify(writes));
        await rec.visualPage('settings-memory-unlocked-saved', page);
      } finally {
        try {
          try {
            if (locked) await rpc(ctx.page, { type: 'vault/unlock', passphrase: PASSPHRASE }, { timeoutMs: 120_000 });
          } finally {
            try { await restoreRequests(ctx.page); }
            finally {
              if (seedAttempted) {
                const restored = await rpc(page, { type: 'memory/write', scope: { kind: 'user' }, body: prior?.body ?? '' });
                if (restored?.ok !== true) throw new Error(`Memory fixture cleanup failed: ${JSON.stringify(restored)}`);
              }
            }
          }
        } finally { try { await page?.close(); } catch {} }
      }
    },
  },
];
