import {
  attach, capturePage, evalIn, launchPeerd, openWidePage, PANEL_METRICS, rpc, unlockAndReady, waitFor,
} from './e2e-harness.mjs';

const click = (page, selector) => evalIn(page, `(() => {
  const button = document.querySelector(${JSON.stringify(selector)});
  if (!button) throw new Error('The requested control is unavailable');
  button.click();
  return true;
})()`);
const declineNetwork = async (page) => {
  await page.send('Page.bringToFront');
  await waitFor(() => evalIn(page, '!!document.querySelector(".home-shell, button[data-network-choice=skip]")'), { budgetMs: 15_000, pollMs: 50 });
  if (await evalIn(page, '!!document.querySelector("button[data-network-choice=skip]")')) await click(page, 'button[data-network-choice="skip"]');
};
const keepDraft = async (page, text) => {
  if (!await waitFor(() => evalIn(page, '!!document.querySelector("form.input-bar textarea")'), { budgetMs: 15_000, pollMs: 50 })) {
    throw new Error('The real composer did not mount');
  }
  await page.send('Page.bringToFront');
  await evalIn(page, 'globalThis.__workspaceComposer = document.querySelector("form.input-bar textarea"); globalThis.__workspaceComposer.focus()');
  await page.send('Input.insertText', { text });
};

const runCustody = async (mode, parent, rec) => {
  const baseRender = process.env.PEERD_VISUAL_BASE_RENDER === '1';
  const draft = mode === 'home' ? 'Keep this draft while I open the side panel.' : 'Keep this panel draft while I open Home.';
  let child, worker, browser, panel, home, otherHome, standbyHome, nativeSession, standbySession;
  const modelRequests = [];
  try {
    child = await launchPeerd({ extensionDir: parent.extensionDir,
      panelPath: mode === 'home' ? 'home/home.html' : 'sidepanel/sidepanel.html',
      interceptModel: false, enforceWebSecurity: true });
    worker = await attach(child.sw.wsUrl);
    await worker.send('Network.enable');
    worker.on((method, params) => {
      if (method === 'Network.requestWillBeSent' && /\/v1\/(?:chat\/completions|messages|responses)|\/api\/chat/.test(params.request?.url ?? '')) {
        modelRequests.push({ url: params.request.url, method: params.request.method });
      }
    });
    await unlockAndReady(child.page);
    const window = await evalIn(child.page, 'chrome.windows.getCurrent()', true);
    if (mode === 'home') {
      home = child.page;
      await declineNetwork(home);
      const homeTab = await evalIn(home, 'chrome.tabs.getCurrent()', true);
      await keepDraft(home, draft);
      const sharedSessionId = (await rpc(home, { type: 'state/get' }))?.state?.session?.sessionId ?? null;
      otherHome = await openWidePage(child, 'home/home.html#chat', { newWindow: true, ready: '.home-shell, button[data-network-choice=skip]' });
      await declineNetwork(otherHome);
      if (!await waitFor(() => evalIn(otherHome, '!!document.querySelector("form.input-bar textarea")'), { budgetMs: 15_000, pollMs: 50 })) {
        throw new Error('The second real Home window did not mount its own composer');
      }
      const otherTab = await evalIn(otherHome, 'chrome.tabs.getCurrent()', true);
      rec.check('Two Home tabs use distinct actual browser windows', otherTab.windowId !== window.id && otherTab.id !== homeTab.id, JSON.stringify({ first: homeTab, second: otherTab }));
      await evalIn(worker, `chrome.tabs.create({windowId:${window.id},url:"about:blank",active:true})`, true);
      const opened = await home.send('Runtime.evaluate', {
        expression: `chrome.sidePanel.open({windowId:${window.id}}).then(()=>true)`,
        awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (opened.result?.value !== true) throw new Error('The native panel did not open');
      const version = await (await fetch(`http://127.0.0.1:${child.port}/json/version`)).json();
      browser = await attach(version.webSocketDebuggerUrl);
      const target = await waitFor(async () => (await browser.send('Target.getTargets')).targetInfos.find((entry) =>
        entry.url.startsWith(`chrome-extension://${child.sw.id}/sidepanel/sidepanel.html`)), { budgetMs: 15_000, pollMs: 25 });
      if (!target) throw new Error('The native panel target did not appear');
      ({ sessionId: nativeSession } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
      panel = { send: (method, params = {}) => browser.send(method, params, nativeSession) };
      await panel.send('Runtime.enable');
      await panel.send('Page.enable');
      await panel.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
      const ready = await waitFor(() => evalIn(panel, baseRender
        ? '!!document.querySelector("form.input-bar textarea")'
        : 'document.querySelector(".home-chat-status")?.textContent.includes("This chat is open in the Home tab")'), { budgetMs: 15_000, pollMs: 50 });
      if (!ready) throw new Error('The Home-owned panel did not settle');
      const status = await evalIn(panel, '({text:document.querySelector(".home-chat-status")?.textContent,composers:document.querySelectorAll("form.input-bar").length,approvals:document.querySelectorAll("[data-confirm-reject]").length})');
      if (baseRender) rec.observe('merge-base Home and native panel custody', status);
      else rec.check('Home-first native panel shows status without a second composer or approval control', status.composers === 0 && status.approvals === 0, JSON.stringify(status));
      if (!baseRender) {
        const firstOwner = await rpc(home, { type: 'surfaces/get' });
        const secondOwner = await rpc(otherHome, { type: 'surfaces/get' });
        rec.check('A panel in the first window leaves both Home owners independent',
          firstOwner?.chatOwner === 'home' && firstOwner.homeTabId === homeTab.id && firstOwner.sidePanelOpen === true
            && secondOwner?.chatOwner === 'home' && secondOwner.homeTabId === otherTab.id && secondOwner.sidePanelOpen === false,
          JSON.stringify({ firstOwner, secondOwner }));
        const bindings = await Promise.all([home, otherHome].map(async page => (await rpc(page, { type: 'state/get' }))?.state?.session?.sessionId ?? null));
        rec.check('Both window layouts keep the same real active-chat binding', bindings.every(id => id === sharedSessionId), JSON.stringify({ before: sharedSessionId, after: bindings }));
        const origin = await evalIn(otherHome, 'globalThis.__movedComposer = document.querySelector("form.input-bar textarea"); performance.timeOrigin');
        const moved = await evalIn(worker, `chrome.windows.create({tabId:${otherTab.id},focused:true})`, true);
        const movedOwner = await waitFor(() => evalIn(worker, `chrome.storage.session.get('workspace.windows.v1').then(saved =>
          saved['workspace.windows.v1']?.find(row => row.windowId === ${moved.id} && row.homeTabId === ${otherTab.id} && row.chatOwner === 'home') ?? null)`, true),
        { budgetMs: 10_000, pollMs: 50 });
        rec.check('A moved Home owner follows the actual new browser window without a manual registration', !!movedOwner, JSON.stringify(movedOwner));
        const movedDocument = await evalIn(otherHome, `(async () => ({same:document.querySelector('form.input-bar textarea') === globalThis.__movedComposer,
          sameDocument:performance.timeOrigin === ${origin},window:await chrome.tabs.getCurrent()}))()`, true);
        rec.check('Moving Home to another window preserves its real document and textarea', movedDocument.same && movedDocument.sameDocument
          && movedDocument.window.windowId === moved.id, JSON.stringify(movedDocument));
        const oldOwner = await evalIn(worker, `chrome.storage.session.get('workspace.windows.v1').then(saved =>
          saved['workspace.windows.v1']?.find(row => row.windowId === ${otherTab.windowId}) ?? null)`, true);
        rec.check('The previous window no longer claims the moved Home tab', oldOwner?.homeTabId !== otherTab.id, JSON.stringify(oldOwner));
        const movedBinding = (await rpc(otherHome, { type: 'state/get' }))?.state?.session?.sessionId ?? null;
        rec.check('Moving a Home window does not change the shared active chat', movedBinding === sharedSessionId, JSON.stringify({ before: sharedSessionId, after: movedBinding }));
        const previousTargets = new Set((await browser.send('Target.getTargets')).targetInfos.map(target => target.targetId));
        const standbyTab = await evalIn(worker, `chrome.tabs.create({windowId:${moved.id},url:${JSON.stringify(`chrome-extension://${child.sw.id}/home/home.html#chat`)},active:true})`, true);
        const standbyTarget = await waitFor(async () => (await browser.send('Target.getTargets')).targetInfos.find(target =>
          !previousTargets.has(target.targetId) && target.url.startsWith(`chrome-extension://${child.sw.id}/home/home.html`)), { budgetMs: 10_000, pollMs: 25 });
        if (!standbyTarget) throw new Error('The real standby Home target did not appear');
        ({ sessionId: standbySession } = await browser.send('Target.attachToTarget', { targetId: standbyTarget.targetId, flatten: true }));
        standbyHome = { send: (method, params = {}) => browser.send(method, params, standbySession) };
        await standbyHome.send('Runtime.enable');
        await standbyHome.send('Page.enable');
        await standbyHome.send('Page.bringToFront');
        const standbyReady = await waitFor(() => evalIn(standbyHome,
          'document.querySelector(".home-panel-bar button")?.textContent === "Go to chat" && !document.querySelector("form.input-bar textarea")'),
        { budgetMs: 15_000, pollMs: 50 });
        rec.check('A second Home in the moved window stays visible without a second composer', !!standbyReady
          && await evalIn(standbyHome, 'document.visibilityState === "visible"'));
        const standbyOrigin = await evalIn(standbyHome, 'performance.timeOrigin');
        await evalIn(worker, `chrome.tabs.remove(${otherTab.id})`, true);
        const claimed = await waitFor(() => evalIn(standbyHome,
          'document.visibilityState === "visible" && !!document.querySelector("form.input-bar textarea")'), { budgetMs: 10_000, pollMs: 50 });
        const standbyOwner = await evalIn(worker, `chrome.storage.session.get('workspace.windows.v1').then(saved =>
          saved['workspace.windows.v1']?.find(row => row.windowId === ${moved.id}) ?? null)`, true);
        rec.check('Closing the Home owner lets its visible standby claim the same window without a toolbar action', !!claimed
          && standbyOwner?.chatOwner === 'home' && standbyOwner.homeTabId === standbyTab.id, JSON.stringify(standbyOwner));
        rec.check('The standby gains exactly one composer without reloading its document', await evalIn(standbyHome,
          `performance.timeOrigin === ${standbyOrigin} && document.querySelectorAll('form.input-bar textarea').length === 1`));
        const standbyBinding = (await rpc(standbyHome, { type: 'state/get' }))?.state?.session?.sessionId ?? null;
        rec.check('Closing an owner preserves the shared active chat in its standby', standbyBinding === sharedSessionId,
          JSON.stringify({ before: sharedSessionId, after: standbyBinding }));
      }
      // why: a resized native panel can retain its old raster tiles for one frame.
      await capturePage(panel);
      await rec.visualPage('workspace-home-custody', panel, { beforeShot: page => evalIn(page,
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true) });
      if (!baseRender) {
        await click(panel, '.home-chat-status button');
        const active = await waitFor(async () => (await evalIn(worker, `chrome.tabs.get(${homeTab.id})`, true)).active === true, { budgetMs: 5_000, pollMs: 25 });
        rec.check('Go to chat activates the exact Home tab in this window', !!active);
        const kept = await evalIn(home, '({same:document.querySelector("form.input-bar textarea")===globalThis.__workspaceComposer,draft:document.querySelector("form.input-bar textarea")?.value})');
        rec.check('Home-first panel open and return keep the original composer and real draft', kept.same && kept.draft === draft, JSON.stringify(kept));
      }
    } else {
      panel = child.page;
      await keepDraft(panel, draft);
      home = await openWidePage(child, 'home/home.html#chat', { ready: '.home-shell, button[data-network-choice=skip]' });
      await declineNetwork(home);
      if (!await waitFor(() => evalIn(home, '!!document.querySelector(".home-panel-bar")'), { budgetMs: 15_000, pollMs: 50 })) {
        throw new Error('Home did not retain the panel-first owner');
      }
      const kept = await evalIn(panel, '({same:document.querySelector("form.input-bar textarea")===globalThis.__workspaceComposer,draft:document.querySelector("form.input-bar textarea")?.value,statusOnly:!!document.querySelector(".home-chat-status")})');
      rec.check('Panel-first Home open keeps the original panel composer and real draft', kept.same && !kept.statusOnly && kept.draft === draft, JSON.stringify(kept));
      const visible = await evalIn(home, '[...document.querySelectorAll("form.input-bar textarea")].filter(node=>node.checkVisibility()).length');
      rec.check('Panel-first Home has no second interactive composer', visible === 0, String(visible));
      await rec.visualPage('workspace-panel-custody', panel);
    }
    const contexts = await evalIn(worker, 'chrome.runtime.getContexts({contextTypes:["SIDE_PANEL"]})', true);
    rec.check('The custody check uses a real browser-owned native panel', contexts.length === 1, JSON.stringify(contexts));
    rec.check('The custody check makes no model request', modelRequests.length === 0, JSON.stringify(modelRequests));
    rec.observe('credential-gated attachment retention', { tested: false, reason: 'No test-only credential is authorized.' });
  } finally {
    if (nativeSession) await browser.send('Target.detachFromTarget', { sessionId: nativeSession }).catch(() => {});
    if (standbySession) await browser.send('Target.detachFromTarget', { sessionId: standbySession }).catch(() => {});
    if (home && home !== child?.page) home.close();
    otherHome?.close();
    worker?.close();
    browser?.close();
    await child?.close();
  }
};

export const WORKSPACE_CUSTODY_STATES = ['home', 'panel'].map((mode) => ({
  name: `workspace-${mode}-custody`, kind: 'visual', phase: 'post-unlock', responder: null,
  run: (ctx, rec) => runCustody(mode, ctx, rec),
}));
