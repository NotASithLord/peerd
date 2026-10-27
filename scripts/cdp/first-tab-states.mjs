// "Keep peerd as the first tab" (background/kernel-first-tab.js, home/first-tab*.js)
// and the side panel close that no longer disables the panel
// (background/kernel-front-door.js), driven in the real extension.
//
// Headless Chrome has no tab strip to photograph, so the tab icon states are
// read from the live Home document, and one fixture shows the three icons.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  evalIn, openWidePage, rpc, sleep, sseText, waitFor, PANEL_METRICS, WIDE_METRICS,
} from './e2e-harness.mjs';

const HINT_KEY = 'peerd.home.firstTabHintSeen';
const VIEW_KEY = 'peerd.home.activeView';

// why: the merge-base build has no first tab yet. Its render supplies only
// the "before" picture, so a state for a new screen stops there.
const absentOnBase = (rec, file) => {
  if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') return false;
  const extension = process.argv.find((arg) => arg.startsWith('--extension='))
    ?.slice('--extension='.length);
  if (!extension) throw new Error('base visual render requires an explicit extension tree');
  if (existsSync(join(extension, file))) return false;
  rec.observe('merge-base surface', { present: false, reason: 'the first tab was introduced on this branch' });
  return true;
};

// why the sync redraw: a long headless run can defer Mithril's redraw after a click.
const clickAndRedraw = (page, selector) => evalIn(page, `(async () => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!(element instanceof HTMLElement)) return false;
  element.click();
  const { default: m } = await import('/vendor/mithril/mithril.js');
  m.redraw.sync();
  return true;
})()`, true);

// Where keyboard focus is once a prompt closes: inside the content, never the body.
const focusInContent = (page) => waitFor(() => evalIn(page, `(() => {
  const active = document.activeElement;
  return active && active !== document.body && !!active.closest('.home-content')
    && !active.closest('.first-tab-offer, .first-tab-hint') ? active.tagName : null;
})()`), { budgetMs: 3_000, pollMs: 50 });

// Every normal window with its tabs, and which tabs are Home.
const windowsWithTabs = (page) => evalIn(page, `(async () => {
  const home = chrome.runtime.getURL('home/home.html');
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return windows.map((window) => ({ id: window.id, tabs: window.tabs.map((tab) => ({
    id: tab.id, index: tab.index, pinned: tab.pinned, active: tab.active,
    home: (tab.url || tab.pendingUrl || '').startsWith(home),
  })) }));
})()`, true);
const pinnedHomes = (window) => (window?.tabs ?? []).filter((tab) => tab.pinned && tab.home);
const keptWindows = (page) => evalIn(page,
  `chrome.storage.local.get('firstTab.kept.v1').then((items) => items['firstTab.kept.v1'] ?? null)`, true);
const tabIds = async (page) => evalIn(page, `chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.id))`, true);
// Close every tab and window that was not open before the state ran.
const closeNewTabs = (page, before, windows = []) => evalIn(page, `(async () => {
  const before = new Set(${JSON.stringify(before)});
  for (const id of ${JSON.stringify(windows)}) await chrome.windows.remove(id).catch(() => {});
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => !before.has(tab.id)).map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
})()`, true);
// Put back what the harness set up: the setting off and the offer answered.
const resetFirstTab = (page) => rpc(page, {
  type: 'settings/update', patch: { firstTabEnabled: false, firstTabOffered: true },
});
// A laptop-sized window, where the chat view scrolls to its composer.
const LAPTOP = Object.freeze({ width: 1366, height: 657, deviceScaleFactor: 1, mobile: false });
// Where an element is on screen, and whether all of it is in view.
const inView = (page, selector) => evalIn(page, `(() => {
  const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
  return rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: innerHeight,
    visible: rect.top >= 0 && rect.bottom <= innerHeight } : null;
})()`);

// Home owns Chat only while no side panel port is connected. Release the panel
// document for a Home scenario, then put the live panel back.
const releasePanel = async (ctx) => {
  await ctx.page.send('Page.navigate', { url: 'about:blank' });
  const released = await waitFor(() => evalIn(ctx.page, `location.href === 'about:blank'`).catch(() => false),
    { budgetMs: 5_000, pollMs: 50 });
  if (!released) throw new Error('the side-panel document did not release its port');
};
const awaitLivePanel = async (ctx) => {
  const live = await waitFor(() => evalIn(ctx.page,
    `document.documentElement.dataset.peerdBootStage === 'app-ready' && !!document.querySelector('.input-bar textarea')`).catch(() => false),
  { budgetMs: 20_000, pollMs: 80 });
  if (!live) throw new Error('the live side panel did not restore');
};
const restorePanel = async (ctx, panelUrl) => {
  await ctx.page.send('Page.navigate', { url: panelUrl });
  await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
  await awaitLivePanel(ctx);
};

// A plain tab in front of a Home tab, in that Home tab's own window.
const openTabInFrontOf = async (page) => {
  const id = await evalIn(page, `chrome.tabs.getCurrent().then((tab) =>
    chrome.tabs.create({ windowId: tab.windowId, url: 'about:blank', active: true })).then((tab) => tab.id)`, true);
  return { close: () => evalIn(page, `chrome.tabs.remove(${id}).catch(() => {})`, true).catch(() => {}) };
};

// What Home's tab shows: its title and icon.
const tabFace = (page) => evalIn(page, `({
  title: document.title,
  icon: document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? null,
  hidden: document.hidden,
})`);
const iconSvg = (face) => (face?.icon?.startsWith('data:image/svg+xml,')
  ? decodeURIComponent(face.icon.slice('data:image/svg+xml,'.length)) : '');

let presenceGate = Promise.resolve();
let releasePresence = () => {};

export const FIRST_TAB_STATES = [
  // --- functional: pinned Home tabs follow the setting, never the user's closes
  {
    name: 'first-tab-pinning', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      const before = await tabIds(ctx.page);
      const opened = [];
      const openWindow = async () => {
        const id = await evalIn(ctx.page, `chrome.windows.create({ url: 'about:blank' }).then((window) => window.id)`, true);
        opened.push(id);
        return id;
      };
      const windowById = async (id) => (await windowsWithTabs(ctx.page)).find((window) => window.id === id);
      const oneAtStart = (window) => pinnedHomes(window).length === 1 && pinnedHomes(window)[0].index === 0;
      try {
        const on = await rpc(ctx.page, { type: 'settings/update', patch: { firstTabEnabled: true } });
        rec.check('Settings turns the first tab on', on?.ok === true && on.settings?.firstTabEnabled === true,
          JSON.stringify(on?.settings?.firstTabEnabled ?? on));
        const covered = await waitFor(async () => {
          const windows = await windowsWithTabs(ctx.page);
          return windows.length > 0 && windows.every(oneAtStart) ? windows : null;
        }, { budgetMs: 10_000, pollMs: 100 });
        rec.check('every open window gets one pinned Home tab at the start', !!covered,
          JSON.stringify(covered ?? await windowsWithTabs(ctx.page)));
        // Asking again adds nothing: each window keeps the tab it has.
        await rpc(ctx.page, { type: 'settings/update', patch: { firstTabEnabled: true } });
        await sleep(1_000);
        const again = await windowsWithTabs(ctx.page);
        rec.check('turning it on again adds no second tab', again.every(oneAtStart), JSON.stringify(again));

        const second = await openWindow();
        const added = await waitFor(async () => {
          const window = await windowById(second);
          return window && pinnedHomes(window).length > 0 ? window : null;
        }, { budgetMs: 10_000, pollMs: 100 });
        rec.check('a new window gets one pinned Home tab at the start, in the background',
          !!added && oneAtStart(added) && added.tabs.find((tab) => tab.active)?.home === false,
          JSON.stringify(added));

        // The user closes it. peerd does not put it back.
        if (added) await evalIn(ctx.page, `chrome.tabs.remove(${pinnedHomes(added)[0].id})`, true);
        const third = await openWindow();
        const thirdAdded = await waitFor(async () => oneAtStart(await windowById(third)),
          { budgetMs: 10_000, pollMs: 100 });
        await sleep(1_000);
        const closed = await windowById(second);
        rec.check('a tab the user closed stays closed, and later windows still get theirs',
          !!thirdAdded && !!closed && pinnedHomes(closed).length === 0, JSON.stringify(closed));
        // An update puts tabs back only in the windows on this list.
        const kept = await waitFor(async () => {
          const ids = await keptWindows(ctx.page);
          return Array.isArray(ids) && ids.includes(third) && !ids.includes(second) ? ids : null;
        }, { budgetMs: 5_000, pollMs: 100 });
        rec.check('the window where the user closed the tab leaves the list an update reads',
          !!kept, JSON.stringify(kept ?? await keptWindows(ctx.page)));
        // An import or a sync can send "on" again. That is not a new request.
        await rpc(ctx.page, { type: 'settings/update', patch: { firstTabEnabled: true } });
        await sleep(1_000);
        const stillClosed = await windowById(second);
        rec.check('"on" sent again does not put back the tab the user closed',
          !!stillClosed && pinnedHomes(stillClosed).length === 0, JSON.stringify(stillClosed));

        const off = await rpc(ctx.page, { type: 'settings/update', patch: { firstTabEnabled: false } });
        const fourth = await openWindow();
        await sleep(1_500);
        const plain = await windowById(fourth);
        rec.check('with the setting off a new window gets no tab',
          off?.ok === true && !!plain && pinnedHomes(plain).length === 0, JSON.stringify(plain));
      } finally {
        await resetFirstTab(ctx.page).catch(() => {});
        await closeNewTabs(ctx.page, before, opened).catch(() => {});
      }
    },
  },

  // --- functional: the side panel closes without being disabled -----------
  // Chrome 141+ has sidePanel.close. The old path disabled the panel for 250 ms,
  // and a toolbar click in that time opened nothing.
  {
    name: 'side-panel-close', kind: 'functional', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      let page = null;
      try {
        page = await openWidePage(ctx, 'home/home.html', { ready: '#app > *' });
        const api = await evalIn(page, 'typeof chrome.sidePanel?.close');
        rec.check('this Chrome has sidePanel.close', api === 'function', api);
        const before = await rpc(page, { type: 'surfaces/get' });
        rec.check('the side panel is open before the close', before?.sidePanelOpen === true, JSON.stringify(before));
        const closed = await rpc(page, { type: 'sidepanel/close' });
        const options = await evalIn(page, 'chrome.sidePanel.getOptions({})', true);
        rec.check('closing keeps the panel enabled, so the toolbar can open it at once',
          closed?.ok === true && options?.enabled === true, JSON.stringify({ closed, options }));
        const gone = await waitFor(async () => (await rpc(page, { type: 'surfaces/get' }))?.sidePanelOpen === false,
          { budgetMs: 8_000, pollMs: 80 });
        rec.check('the side panel closes', !!gone);
      } finally {
        try { page?.close(); } catch { /* */ }
        const panelAlive = await evalIn(ctx.page, 'true').then(() => true, () => false);
        if (!panelAlive) {
          await ctx.reopenNativePanel();
          await awaitLivePanel(ctx);
        }
      }
    },
  },

  // --- functional: Home's tab icon and title show what peerd is doing ------
  // Two Home tabs in two windows, both out of view: each shows the reply dot,
  // and looking at one clears the other.
  {
    name: 'home-tab-presence', kind: 'functional', phase: 'post-unlock',
    responder: async () => {
      await presenceGate;
      return { sse: sseText('The reply is here.') };
    },
    async run(ctx, rec) {
      if (absentOnBase(rec, 'home/first-tab.js')) return;
      presenceGate = new Promise((resolve) => { releasePresence = resolve; });
      const panelUrl = await evalIn(ctx.page, 'location.href');
      let home = null;
      let other = null;
      const fronts = [];
      try {
        await rpc(ctx.page, { type: 'settings/update', patch: { dwebEnabled: false } });
        await releasePanel(ctx);
        home = await openWidePage(ctx, 'home/home.html#chat', { ready: '.home-shell' });
        other = await openWidePage(ctx, 'home/home.html#chat', { ready: '.home-shell', newWindow: true });
        const idle = await tabFace(home);
        for (const page of [home, other]) fronts.push(await openTabInFrontOf(page));
        const hidden = await waitFor(async () => (await tabFace(home))?.hidden === true
          && (await tabFace(other))?.hidden === true, { budgetMs: 5_000, pollMs: 50 });
        rec.check('another tab in front puts both Home tabs out of view', !!hidden);
        const sent = await rpc(home, { type: 'agent/send', text: 'Say hello when you are done.' });
        rec.check('Home sends the turn', sent?.ok === true, JSON.stringify(sent));
        const working = await waitFor(async () => {
          const face = await tabFace(home);
          return face?.title === 'peerd is working…' && iconSvg(face).includes('stroke="#00b7eb"') ? face : null;
        }, { budgetMs: 15_000, pollMs: 80 });
        rec.check('while peerd works, the tab shows the ring and says so', !!working,
          JSON.stringify(working ?? await tabFace(home)));
        releasePresence();
        const replied = (face) => face?.title === 'peerd has a reply' && iconSvg(face).includes('class="d"');
        const reply = await waitFor(async () => {
          const faces = [await tabFace(home), await tabFace(other)];
          return faces.every(replied) ? faces : null;
        }, { budgetMs: 20_000, pollMs: 80 });
        rec.check('a reply that comes while Home is out of view puts a dot on each Home tab', !!reply,
          JSON.stringify(reply ?? [await tabFace(home), await tabFace(other)]));
        await home.send('Page.bringToFront');
        const atRest = (face, hidden) => face?.hidden === hidden && face.icon === '/icons/icon32.png'
          && face.title === idle.title;
        const seen = await waitFor(async () => {
          const face = await tabFace(home);
          return atRest(face, false) ? face : null;
        }, { budgetMs: 5_000, pollMs: 50 });
        rec.check('looking at Home clears the dot and the title', !!seen, JSON.stringify(seen ?? await tabFace(home)));
        const elsewhere = await waitFor(async () => {
          const face = await tabFace(other);
          return atRest(face, true) ? face : null;
        }, { budgetMs: 5_000, pollMs: 50 });
        rec.check('the Home tab in the other window clears its dot too, still out of view', !!elsewhere,
          JSON.stringify(elsewhere ?? await tabFace(other)));
      } finally {
        releasePresence();
        for (const front of fronts) await front.close();
        try { home?.close(); } catch { /* */ }
        try { other?.close(); } catch { /* */ }
        await restorePanel(ctx, panelUrl);
      }
    },
  },

  // --- visual: the three tab icons, large and at their real size -----------
  // A fixture on the real Home page: headless Chrome draws no tab strip.
  {
    name: 'home-tab-presence-icons', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      if (absentOnBase(rec, 'home/first-tab.js')) return;
      await rpc(ctx.page, { type: 'settings/update', patch: { dwebEnabled: false } });
      const page = await openWidePage(ctx, 'home/home.html', { ready: '#app > *' });
      try {
        const icons = await evalIn(page, `(async () => {
          const { presenceIcon, presenceTitle } = await import('/home/first-tab.js');
          const host = document.createElement('div');
          host.id = 'e2e-presence-icons';
          host.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--bg);color:var(--fg);'
            + 'display:flex;gap:56px;align-items:center;justify-content:center;font:14px var(--sans);';
          const rows = ['idle', 'working', 'reply'].map((presence) => {
            const cell = document.createElement('figure');
            cell.style.cssText = 'margin:0;display:flex;flex-direction:column;align-items:center;gap:14px;';
            const strip = document.createElement('div');
            strip.style.cssText = 'display:flex;align-items:center;gap:14px;padding:10px 16px;border-radius:10px;background:var(--elev2);';
            for (const size of [16, 64]) {
              const img = document.createElement('img');
              img.src = presenceIcon(presence);
              img.width = size; img.height = size; img.alt = '';
              strip.append(img);
            }
            const caption = document.createElement('figcaption');
            caption.textContent = presenceTitle(presence, 'peerd - home');
            cell.append(strip, caption);
            host.append(cell);
            return presenceIcon(presence);
          });
          document.body.append(host);
          await Promise.all([...host.querySelectorAll('img')].map((img) => img.decode().catch(() => null)));
          return { rows, drawn: [...host.querySelectorAll('img')].every((img) => img.naturalWidth > 0) };
        })()`, true);
        rec.check('each state has its own icon, and every icon draws',
          icons?.drawn === true && new Set(icons.rows).size === 3, JSON.stringify(icons?.rows?.map((href) => href.slice(0, 40))));
        await rec.visualPage('home-tab-presence-icons', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // --- visual: the one-time offer, after the last setup step ---------------
  // An existing profile that still owes its network choice gets that one setup
  // step on Home. Answering it lifts the gate in the same document, which is
  // what makes Home offer the first tab. The chat view on a laptop-sized window
  // scrolls to its composer, so the offer must stay in view.
  {
    name: 'home-first-tab-offer', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      if (absentOnBase(rec, 'home/first-tab-prompts.js')) return;
      const networkShips = await evalIn(ctx.page, `import('/shared/channel-config.js').then((config) => config.DWEB_ENABLED)`, true);
      if (!networkShips) {
        rec.observe('first tab offer', { skipped: 'this build has no network step to finish' });
        return;
      }
      const before = await tabIds(ctx.page);
      const panelUrl = await evalIn(ctx.page, 'location.href');
      // why: the voice card must be able to show here, and later states keep theirs.
      const voiceDismissed = (await rpc(ctx.page, { type: 'state/get' }))?.state?.settings?.voiceOnboardingDismissed === true;
      let page = null;
      try {
        const reset = await rpc(ctx.page, {
          type: 'settings/reset', keys: ['dwebEnabled', 'firstTabEnabled', 'firstTabOffered', 'voiceOnboardingDismissed'],
        });
        if (reset?.ok !== true) throw new Error(`fixture reset failed: ${JSON.stringify(reset)}`);
        await evalIn(ctx.page, `localStorage.removeItem(${JSON.stringify(HINT_KEY)})`);
        await releasePanel(ctx);
        page = await openWidePage(ctx, 'home/home.html#chat', { ready: '[data-network-choice="skip"]', metrics: LAPTOP });
        await clickAndRedraw(page, '[data-network-choice="skip"]');
        const offer = await waitFor(() => evalIn(page, `(() => {
          const section = document.querySelector('.home-shell .first-tab-offer');
          return section && document.querySelector('.input-bar textarea') ? {
            name: document.getElementById(section.getAttribute('aria-labelledby'))?.textContent,
            text: [...section.querySelectorAll('p')].map((p) => p.textContent),
            buttons: [...section.querySelectorAll('button')].map((button) => button.textContent),
          } : null;
        })()`), { budgetMs: 10_000, pollMs: 80 });
        rec.check('after the last setup step, Home offers the first tab in plain words',
          offer?.name === 'Keep peerd as the first tab?'
            && JSON.stringify(offer.text) === JSON.stringify([
              'It stays at the start of your tabs in every window, so peerd is one click away.',
              'You can turn this on later in Settings.',
            ])
            && JSON.stringify(offer.buttons) === JSON.stringify(['Keep it', 'Not now']), JSON.stringify(offer));
        // The composer takes focus at the bottom of the chat and scrolls it.
        await sleep(800);
        const placed = await inView(page, '.first-tab-offer');
        rec.check('on a laptop-sized window the offer stays in view while the chat scrolls',
          placed?.visible === true, JSON.stringify(placed));
        rec.check('one first-run card at a time: no voice card under the offer',
          await evalIn(page, `!document.querySelector('.chat-view .onboarding-card')`), '');
        await rec.visualPage('home-first-tab-offer', page);

        const thisTab = await evalIn(page, `chrome.tabs.getCurrent().then((tab) => tab.id)`, true);
        await clickAndRedraw(page, '.first-tab-keep');
        const kept = await waitFor(async () => {
          const view = await evalIn(page, `(async () => {
            const tab = await chrome.tabs.getCurrent();
            const home = chrome.runtime.getURL('home/home.html');
            const homes = (await chrome.tabs.query({ windowId: tab.windowId }))
              .filter((item) => (item.url || item.pendingUrl || '').startsWith(home));
            return {
              offer: !!document.querySelector('.first-tab-offer'),
              hint: !!document.querySelector('.first-tab-hint'),
              homes: homes.map((item) => ({ id: item.id, index: item.index, pinned: item.pinned })),
            };
          })()`, true);
          return !view.offer && view.hint ? view : null;
        }, { budgetMs: 10_000, pollMs: 100 });
        rec.check('"Keep it" pins this Home tab at the start, with no second Home tab in this window',
          JSON.stringify(kept?.homes) === JSON.stringify([{ id: thisTab, index: 0, pinned: true }]), JSON.stringify(kept));
        rec.check('the result shows here: the hint says where peerd lives', kept?.hint === true, JSON.stringify(kept));
        const state = await rpc(page, { type: 'state/get' });
        rec.check('"Keep it" saves the answer and turns the setting on',
          state?.state?.settings?.firstTabEnabled === true && state.state.settings.firstTabOffered === true,
          JSON.stringify(state?.state?.settings));
        const focused = await focusInContent(page);
        rec.check('keyboard focus moves into the page once the offer closes', !!focused, String(focused));
        await clickAndRedraw(page, '.first-tab-hint-ok');
        const voice = await waitFor(() => evalIn(page, `!!document.querySelector('.chat-view .onboarding-card')`),
          { budgetMs: 5_000, pollMs: 80 });
        rec.check('once no first-run prompt is left, the voice card shows', !!voice);
      } finally {
        try { page?.close(); } catch { /* */ }
        await restorePanel(ctx, panelUrl).catch(() => {});
        await rpc(ctx.page, { type: 'settings/update', patch: { voiceOnboardingDismissed: voiceDismissed } }).catch(() => {});
        await resetFirstTab(ctx.page).catch(() => {});
        await rpc(ctx.page, { type: 'settings/update', patch: { dwebEnabled: false } }).catch(() => {});
        await evalIn(ctx.page, `localStorage.removeItem(${JSON.stringify(HINT_KEY)})`).catch(() => {});
        await closeNewTabs(ctx.page, before).catch(() => {});
      }
    },
  },

  // --- visual: the offer's error line, rendered on the real Home page ------
  {
    name: 'home-first-tab-offer-error', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      if (absentOnBase(rec, 'home/first-tab-prompts.js')) return;
      await rpc(ctx.page, { type: 'settings/update', patch: { dwebEnabled: false } });
      const page = await openWidePage(ctx, 'home/home.html#library', { ready: '.home-shell' });
      try {
        const shown = await evalIn(page, `(async () => {
          const { default: m } = await import('/vendor/mithril/mithril.js');
          const { FirstTabOffer } = await import('/home/first-tab-prompts.js');
          const content = document.querySelector('.home-content');
          const host = document.createElement('div');
          host.id = 'e2e-first-tab-offer';
          content.prepend(host);
          m.mount(host, { view: () => m(FirstTabOffer, {
            send: async () => ({ ok: false, error: 'kernel-route-unauthorized' }), onAnswered: () => {},
          }) });
          host.querySelector('.first-tab-keep').click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          m.redraw.sync();
          return host.querySelector('p.error')?.textContent ?? null;
        })()`, true);
        rec.check('a refused "Keep it" says what failed, then what to do',
          shown === 'peerd could not turn this on. Try again, or turn it on in Settings.', String(shown));
        await rec.visualPage('home-first-tab-offer-error', page);
      } finally { try { page.close(); } catch { /* */ } }
    },
  },

  // --- visual: the one-time hint in the pinned tab -------------------------
  // The tab is pinned while it is open: the hint shows once the tab comes back
  // into view. A rail click lands in the view, "Got it" hides the hint in every
  // Home tab, and with chat in the side panel the pinned tab shows the apps.
  {
    name: 'home-first-tab-hint', kind: 'visual', phase: 'post-unlock',
    responder: () => ({ sse: sseText('noted') }),
    async run(ctx, rec) {
      if (absentOnBase(rec, 'home/first-tab-prompts.js')) return;
      await rpc(ctx.page, { type: 'settings/update', patch: { dwebEnabled: false } });
      await evalIn(ctx.page, `localStorage.removeItem(${JSON.stringify(HINT_KEY)})`);
      // why: rail clicks store the view, and later states open Home on it.
      const storedView = await evalIn(ctx.page, `localStorage.getItem(${JSON.stringify(VIEW_KEY)})`);
      const panelUrl = await evalIn(ctx.page, 'location.href');
      let page = null;
      let second = null;
      let front = null;
      let panelBack = false;
      const hint = (target) => evalIn(target, `(() => {
        const section = document.querySelector('.home-shell .first-tab-hint');
        return section ? {
          name: document.getElementById(section.getAttribute('aria-labelledby'))?.textContent,
          text: section.querySelector('p')?.textContent,
          button: section.querySelector('button')?.textContent,
        } : null;
      })()`);
      const pin = (target) => evalIn(target, `chrome.tabs.getCurrent().then((tab) => chrome.tabs.update(tab.id, { pinned: true }))`, true);
      try {
        await releasePanel(ctx);
        page = await openWidePage(ctx, 'home/home.html#chat', { ready: '.input-bar textarea', metrics: LAPTOP });
        await sleep(500);
        rec.check('a Home tab that is not pinned shows no hint', await hint(page) === null);
        await pin(page);
        front = await openTabInFrontOf(page);
        await front.close();
        await page.send('Page.bringToFront');
        const shown = await waitFor(() => hint(page), { budgetMs: 15_000, pollMs: 80 });
        rec.check('pinned while open, the tab shows the hint once it is back in view, in plain words',
          shown?.name === 'peerd lives here.' && shown.text === 'Click P anytime to ask peerd or open your apps.'
            && shown.button === 'Got it', JSON.stringify(shown));
        await sleep(800);
        const placed = await inView(page, '.first-tab-hint');
        rec.check('on a laptop-sized window the hint stays in view while the chat scrolls',
          placed?.visible === true, JSON.stringify(placed));
        rec.check('one first-run card at a time: no voice card under the hint',
          await evalIn(page, `!document.querySelector('.chat-view .onboarding-card')`), '');
        await rec.visualPage('home-first-tab-hint', page);

        // Actors opens with a heading, so a view change has a place to land.
        await clickAndRedraw(page, '[data-home-view="actors"]');
        const landed = await waitFor(() => evalIn(page, `(() => {
          const active = document.activeElement;
          return active && active.closest('.home-content') && !active.closest('.first-tab-hint')
            ? active.tagName + ':' + active.textContent.trim().slice(0, 40) : null;
        })()`), { budgetMs: 3_000, pollMs: 50 });
        rec.check('with the hint on screen, a rail click puts focus in the new view, not on the hint',
          landed === 'H1:Actors', String(landed ?? await evalIn(page, `document.activeElement?.outerHTML?.slice(0, 120)`)));

        second = await openWidePage(ctx, 'home/home.html#library', { ready: '.home-shell' });
        await pin(second);
        await second.send('Page.reload');
        const secondHint = await waitFor(() => hint(second), { budgetMs: 15_000, pollMs: 80 });
        await page.send('Page.bringToFront');
        await clickAndRedraw(page, '.first-tab-hint-ok');
        const focused = await focusInContent(page);
        rec.check('keyboard focus moves into the page once the hint closes', !!focused, String(focused));
        // The other tab redraws when it is back in view, with no reload.
        await second.send('Page.bringToFront');
        const elsewhere = await waitFor(async () => await hint(second) === null, { budgetMs: 5_000, pollMs: 80 });
        rec.check('"Got it" hides the hint in the other pinned Home tab too', !!secondHint && !!elsewhere,
          JSON.stringify({ secondHint: !!secondHint }));
        await page.send('Page.bringToFront');
        const stored = await evalIn(page, `localStorage.getItem(${JSON.stringify(HINT_KEY)})`);
        await page.send('Page.reload');
        await waitFor(() => evalIn(page, `!!document.querySelector('.home-shell')`).catch(() => false), { budgetMs: 15_000, pollMs: 80 });
        await sleep(500);
        rec.check('"Got it" hides the hint for good', stored === '1' && await hint(page) === null, JSON.stringify({ stored }));

        // Back on the chat, then the side panel takes it.
        await clickAndRedraw(page, '[data-home-view="chat"]');
        await restorePanel(ctx, panelUrl);
        panelBack = true;
        const besidePanel = await waitFor(() => evalIn(page, `(() => {
          const content = document.querySelector('.home-content');
          return content?.classList.contains('home-content--library') && !!document.querySelector('.home-panel-bar')
            ? content.className : null;
        })()`), { budgetMs: 10_000, pollMs: 80 });
        rec.check('with chat in the side panel, the pinned Home tab shows the apps, not the actor map',
          !!besidePanel, String(besidePanel ?? await evalIn(page, `document.querySelector('.home-content')?.className`)));
        await page.send('Emulation.setDeviceMetricsOverride', WIDE_METRICS);
        await rec.visualPage('home-first-tab-beside-panel', page);
      } finally {
        try { page?.close(); } catch { /* */ }
        try { second?.close(); } catch { /* */ }
        if (!panelBack) await restorePanel(ctx, panelUrl).catch(() => {});
        await evalIn(ctx.page, `localStorage.removeItem(${JSON.stringify(HINT_KEY)})`).catch(() => {});
        await evalIn(ctx.page, storedView === null
          ? `localStorage.removeItem(${JSON.stringify(VIEW_KEY)})`
          : `localStorage.setItem(${JSON.stringify(VIEW_KEY)}, ${JSON.stringify(storedView)})`).catch(() => {});
      }
    },
  },

  // --- functional: the live panel that showed the first vault setup asks once
  // The harness set the vault up in this panel, through the vault shell, and
  // run-e2e-verify.mjs runs this state before any state reloads the panel.
  // A keyboard answer must leave focus where the user types next.
  {
    name: 'sidepanel-first-tab-first-run', kind: 'functional', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      if (absentOnBase(rec, 'home/first-tab-prompts.js')) return;
      const enter = (type) => ctx.page.send('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}),
      });
      try {
        const marked = await evalIn(ctx.page, 'document.documentElement.dataset.peerdFirstSetup ?? null');
        rec.check('this panel showed the first vault setup', marked === 'true', String(marked));
        const reset = await rpc(ctx.page, { type: 'settings/update', patch: { firstTabOffered: false } });
        if (reset?.ok !== true) throw new Error(`fixture reset failed: ${JSON.stringify(reset)}`);
        const offer = await waitFor(() => evalIn(ctx.page, `(() => {
          const section = document.querySelector('.app-shell .body > .first-tab-offer');
          return section && section.parentElement.firstElementChild === section
            ? document.getElementById(section.getAttribute('aria-labelledby'))?.textContent ?? null : null;
        })()`), { budgetMs: 10_000, pollMs: 80 });
        rec.check('once peerd can answer, the panel offers the first tab at the top of the chat',
          offer === 'Keep peerd as the first tab?', String(offer));
        await evalIn(ctx.page, `document.querySelector('.first-tab-offer .first-tab-later')?.focus()`);
        const before = await evalIn(ctx.page, 'document.activeElement?.textContent ?? null');
        await enter('keyDown');
        await enter('keyUp');
        const landed = await waitFor(() => evalIn(ctx.page, `(() => {
          const active = document.activeElement;
          return !document.querySelector('.first-tab-offer') && active?.matches('.input-bar textarea')
            ? active.getAttribute('aria-label') ?? 'textarea' : null;
        })()`), { budgetMs: 5_000, pollMs: 50 });
        rec.check('"Not now" by keyboard hides the offer and puts focus in the composer',
          before === 'Not now' && !!landed, JSON.stringify({ before, landed,
            active: landed ?? await evalIn(ctx.page, `document.activeElement?.tagName ?? null`) }));
        const saved = await waitFor(async () => {
          const settings = (await rpc(ctx.page, { type: 'state/get' }))?.state?.settings;
          return settings?.firstTabOffered === true ? settings : null;
        }, { budgetMs: 5_000, pollMs: 100 });
        rec.check('"Not now" saves the answer and leaves the setting off',
          !!saved && saved.firstTabEnabled === false, JSON.stringify(saved
            ? { firstTabOffered: saved.firstTabOffered, firstTabEnabled: saved.firstTabEnabled } : null));
      } finally {
        await resetFirstTab(ctx.page).catch(() => {});
      }
    },
  },

  // --- visual: the offer in the side panel, where most people set peerd up --
  // The two panel screens, as a render fixture: the real panel App with the
  // real offer over the live panel, then taken away. The live panel's own
  // offer is driven by sidepanel-first-tab-first-run.
  {
    name: 'sidepanel-first-tab-offer', kind: 'visual', phase: 'post-unlock',
    responder: null,
    async run(ctx, rec) {
      if (absentOnBase(rec, 'home/first-tab-prompts.js')) return;
      try {
        const mounted = await evalIn(ctx.page, `(async () => {
          const { default: m } = await import('/vendor/mithril/mithril.js');
          const { App } = await import('/sidepanel/components/app.js');
          const { INITIAL_STATE, reduceChat } = await import('/sidepanel/chat-reducer.js');
          const { makePanelFirstTab } = await import('/home/first-tab-prompts.js');
          const reply = await chrome.runtime.sendMessage({ type: 'state/get' });
          const live = reduceChat(INITIAL_STATE, { type: 'state', state: reply.state });
          const state = { ...live, session: { ...live.session, messages: [] },
            settings: { ...live.settings, firstTabEnabled: false, firstTabOffered: false, voiceOnboardingDismissed: false } };
          const sent = [];
          const prompt = makePanelFirstTab({ send: async (message) => { sent.push(message); return { ok: true }; } });
          const shown = { prompt: true };
          const host = document.createElement('div');
          host.id = 'e2e-first-tab-panel';
          host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:var(--bg);overflow:auto;';
          document.body.append(host);
          m.mount(host, { view: () => m(App, {
            state, send: async () => ({ ok: true }), voiceManager: null, uiActions: {}, view: 'chat',
            optionsActive: false, firstTabPrompt: shown.prompt ? prompt.view(state) : null,
          }) });
          globalThis.__e2eFirstTab = { m, host, sent, shown };
          await new Promise((resolve) => setTimeout(resolve, 300));
          m.redraw.sync();
          const offer = host.querySelector('.body > .first-tab-offer');
          return {
            offer: !!offer, first: host.querySelector('.body')?.firstElementChild === offer,
            voice: !!host.querySelector('.chat-view .onboarding-card'),
          };
        })()`, true);
        rec.check('the panel shows the offer at the top of the chat, and no voice card under it',
          mounted?.offer === true && mounted.first === true && mounted.voice === false, JSON.stringify(mounted));
        await rec.visual('sidepanel-first-tab-offer');
        const kept = await evalIn(ctx.page, `(async () => {
          const { m, host, sent } = globalThis.__e2eFirstTab;
          host.querySelector('.first-tab-keep').click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          m.redraw.sync();
          return { line: host.querySelector('.first-tab-kept')?.textContent ?? null, sent };
        })()`, true);
        rec.check('after "Keep it" the panel says what changed in one line',
          kept?.line === 'peerd is now the first tab in every window.'
            && kept.sent?.[0]?.patch?.firstTabEnabled === true, JSON.stringify(kept));
        await rec.visual('sidepanel-first-tab-kept');
        const voice = await evalIn(ctx.page, `(() => {
          const { m, host, shown } = globalThis.__e2eFirstTab;
          shown.prompt = false;
          m.redraw.sync();
          return !!host.querySelector('.chat-view .onboarding-card');
        })()`);
        rec.check('with no first tab prompt, the same panel shows the voice card', voice === true, String(voice));
      } finally {
        await evalIn(ctx.page, `(() => {
          const holder = globalThis.__e2eFirstTab;
          if (holder) { holder.m.mount(holder.host, null); holder.host.remove(); }
          delete globalThis.__e2eFirstTab;
        })()`).catch(() => {});
      }
    },
  },
];
