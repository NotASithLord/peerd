import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { evalIn, waitFor, openExtPage } from './e2e-harness.mjs';
// Render-only proof. Real composed CSV/WASM execution is in the browser suite.

// The tree under test: a merge-base render names its tree, this branch renders
// its own. why a file probe: the one-flow Discover (a start list, tiles and a
// page per app) ships home/discover-pages.js; an older tree stacks sections.
export const discoverSurface = () => {
  if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') return { base: false, flow: true, tree: null };
  const tree = process.argv.find(arg => arg.startsWith('--extension='))?.slice('--extension='.length);
  if (!tree) throw new Error('base visual render requires an explicit extension tree');
  return { base: true, flow: existsSync(join(tree, 'home/discover-pages.js')), tree };
};

// Every read a Discover frame may send. Any other route is an effect.
const READS = ['apps/list', 'dweb/base/heard', 'bootstrap/ready', 'dweb/distributed/info', 'contacts/list'];
const has = text => `document.body.textContent.includes(${JSON.stringify(text)})`;
const cards = n => `document.querySelectorAll('.disc-card').length === ${n}`;
const focused = selector => `!!document.activeElement?.matches(${JSON.stringify(selector)})`;
const panelButtons = labels => `JSON.stringify([...document.querySelectorAll('.disc-panel button')]
  .map(button => button.textContent.trim())) === ${JSON.stringify(JSON.stringify(labels))}`;
// why a synchronous redraw: tab-heavy headless runs can defer Mithril's
// scheduled redraw after a scripted click; commit it before asserting.
const clickSync = (page, selector, label = null) => evalIn(page, `(async () => {
  const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(node => ${JSON.stringify(label)} === null || node.textContent.trim() === ${JSON.stringify(label)});
  if (!(target instanceof HTMLElement)) throw new Error('missing ' + ${JSON.stringify(`${selector} ${label ?? ''}`)});
  target.click();
  (await import('/vendor/mithril/mithril.js')).default.redraw.sync();
})()`, true);

// [mode, ready on the one-flow Discover, ready on an older tree]
const KEPT_READY = {
  home: [has('Try an included app'), has('Add and open Commons')],
  review: [has('Apply: add local copy'), has('Apply: add local copy')],
  empty: [has('Apps show up as peers share them'), has('No peer Apps discovered yet')],
};

/** Surprise me opens the chosen app's page. It never fetches or installs. */
const surpriseOpensPage = async (page, rec) => {
  // why wait for enabled: Surprise me stays off until the Library read lands.
  const available = await waitFor(() => evalIn(page, `[...document.querySelectorAll('button')]
    .some(button => button.textContent === 'Surprise me' && !button.disabled)`), { budgetMs: 4000, pollMs: 50 });
  if (!available) throw new Error('Surprise me control did not render');
  await clickSync(page, 'button', 'Surprise me');
  const opened = await waitFor(() => evalIn(page, `${focused('.disc-back')}
    && [...document.querySelectorAll('.disc-page .disc-panel button')].some(button => button.textContent === 'Install and share')`),
  { budgetMs: 4000, pollMs: 50 });
  rec.check('Surprise me opens an app page without installing it', !!opened
    && await evalIn(page, `window.__exploreFixtureCalls.every(type => ${JSON.stringify(READS)}.includes(type))`));
};

/** The app page of a saved contact's app, with Technical details open. */
const detailsOpen = async (page, rec) => {
  await clickSync(page, '.disc-tile-open', 'Field notes');
  if (!await waitFor(() => evalIn(page, focused('.disc-back')), { budgetMs: 4000, pollMs: 50 })) throw new Error('App page did not open');
  await clickSync(page, '.disc-tech-toggle');
  rec.check('Technical details offers the full maker key and the share link to copy', !!await waitFor(() => evalIn(page, `(() => {
    const facts = document.querySelector('.disc-facts');
    const copies = [...(facts?.querySelectorAll('button') ?? [])].filter(button => button.textContent === 'Copy');
    return document.querySelector('.disc-tech-toggle')?.getAttribute('aria-expanded') === 'true' && !!facts && !facts.hidden
      && copies.length === 2 && copies.every(button => !button.disabled) && facts.textContent.includes('dwapp://content/');
  })()`), { budgetMs: 4000, pollMs: 50 }));
};

const keptState = (mode, narrow) => ({
  name: `discovery-${mode}${narrow ? '-narrow' : ''}`, kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    const surface = discoverSurface();
    if (surface.base && !existsSync(join(surface.tree, 'tests/fixtures/starters.html'))) {
      rec.observe('merge-base surface', { present:false, reason:'these discovery release scenarios were introduced on this branch' });
      return;
    }
    const fixture = mode === 'home' || mode === 'review'
      ? `tests/fixtures/starters.html${mode === 'review' ? '?starter=wasm-image' : ''}`
      : `tests/fixtures/explore.html${mode === 'empty' ? '?empty=1' : ''}`;
    const page = await openExtPage(ctx, fixture);
    try {
      // why taller for publisher: the open Technical details list runs past 900px.
      await page.send('Emulation.setDeviceMetricsOverride',{width:narrow?320:960,height:narrow?1450:mode === 'publisher' ? 1000 : 900,deviceScaleFactor:1,mobile:false});
      const ready = await waitFor(()=>evalIn(page, (KEPT_READY[mode] ?? [cards(3), cards(3)])[surface.flow ? 0 : 1]),{budgetMs:8000,pollMs:80});
      if (!ready) throw new Error(`Discovery ${mode} did not render`);
      if (mode === 'no-results') await evalIn(page, `(()=>{const input=document.querySelector('input.disc-search');input.value='no-such-app';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      if (mode === 'suggestion' && surface.flow) await surpriseOpensPage(page, rec);
      if (mode === 'suggestion' && !surface.flow) {
        const available = await evalIn(page, `!![...document.querySelectorAll('button')].find(button=>button.textContent==='Surprise me')`);
        if (!available && surface.base) {
          rec.observe('merge-base surface', {present:false,reason:'Surprise me was introduced on this branch'});
        } else {
          if (!available) throw new Error('Surprise me control did not render');
          await evalIn(page, `([...document.querySelectorAll('button')].find(button=>button.textContent==='Surprise me')).click()`);
          const selected = await waitFor(()=>evalIn(page, `document.activeElement?.getAttribute('data-suggested') === 'true' && document.body.textContent.includes('Availability is not checked')`), {budgetMs:4000,pollMs:50});
          rec.check('suggestion focuses an unfamiliar App without installing it', !!selected);
        }
      }
      if (mode === 'publisher' && surface.flow) await detailsOpen(page, rec);
      if (mode === 'publisher' && !surface.flow) {
        await evalIn(page, `document.querySelector('details.disc-publisher').open=true`);
        rec.check('coherent fixture cards expose copyable immutable addresses', await evalIn(page, `(()=>{const buttons=[...document.querySelectorAll('button')].filter(button=>button.textContent==='Copy immutable address');return buttons.length===3&&buttons.every(button=>!button.disabled);})()`));
      }
      if (mode === 'no-results') {
        const filtered = await waitFor(()=>evalIn(page,`${has(surface.flow ? 'No matching apps' : 'No matching Apps')} && ${cards(0)}`),{budgetMs:4000,pollMs:50});
        if (!filtered) throw new Error('No-results state did not settle');
      }
      rec.check('discovery surface fits narrow and wide viewport', await evalIn(page,`document.documentElement.scrollWidth <= innerWidth`));
      if (mode === 'home' || mode === 'review') rec.check('starter review has no install, run or network grant',await evalIn(page,`window.__starterFixtureCalls.every(type=>['apps/list','import/inspect'].includes(type))`));
      if (mode === 'home' && surface.flow) rec.check('network-off Discover sends no message', await evalIn(page, `window.__starterFixtureCalls.length === 0`));
      await rec.visualPage(`discovery-${mode}${narrow ? '-narrow' : ''}`,page);
    } finally { try { page.close(); } catch {} }
  },
});

// 2a screens the merge base never drew: [mode, explore.html frame, ready,
// the only effects the frame may send]. The fixture answers reads plus the
// one effect its frame draws, so anything else throws there.
const FLOW_FRAMES = [
  ['share-link', 'share-off', `${has('Join the peer network first.')}
    && document.querySelector('.disc-start-form input')?.value.startsWith('dwapp://')
    && document.querySelector('.disc-start-form button')?.disabled === true`, []],
  ['connected-empty', 'empty', has('No apps shared yet'), []],
  ['tiles', 'tiles', `${cards(3)} && ${has('Update ready')} && ${has('Can’t run in this browser')}`, []],
  ['offline', 'offline', `${has('Peer network is offline')} && ${cards(1)}`, []],
  ['offline-empty', 'offline-empty', `${has('Peer network is offline')} && ${has('Apps you install from peers show up here.')}`, []],
  // why not the empty line: it claims what the Library holds, so it waits for a good read.
  ['offline-reading', 'offline-reading', `${has('Peer network is offline')} && ${has('Checking your Library…')}
    && !${has('Apps you install from peers')}`, []],
  ['offline-failed', 'offline-failed', `${has('Peer network is offline')} && ${has('Could not read your Library.')}
    && !${has('Apps you install from peers')}`, []],
  ['installing', 'installing', has('You can leave this page. The install keeps going.'), ['dweb/base/install']],
  // why the status line: focus never lands on Open, which runs the app.
  ['installed', 'installed', `${focused('.disc-panel .disc-installed')} && ${has('In your Library.')}`, ['dweb/base/install']],
  ['install-failed', 'failed', has('peerd could not install this app. Try again.'), ['dweb/base/install']],
  ['install-unknown', 'unknown', has('peerd could not confirm whether the install finished.'), ['dweb/base/install']],
  ['update-conflict', 'conflict', has('Locally modified'), ['dweb/base/update-app']],
  // why Open too: the installed version still runs after a failed or unconfirmed update.
  ['update-failed', 'update-failed', `${has('peerd could not update this app. Try again.')} && ${panelButtons(['Try again', 'Open'])}`,
    ['dweb/base/update-app']],
  ['update-unknown', 'update-unknown', `${has('peerd could not confirm whether the update finished.')}
    && ${panelButtons(['Refresh', 'Open'])}`, ['dweb/base/update-app']],
  ['update-ready', 'update', `${focused('.disc-back')} && ${has('Update ready')}`, []],
  ['update-cant-run', 'update-cant-run', `${focused('.disc-back')} && ${has('This update can’t run in this browser.')}`, []],
  ['cant-run', 'cant-run', `${focused('.disc-back')} && ${has('This app can’t run in this browser.')}`, []],
  ['maker', 'maker', `${focused('.disc-back')} && ${has('Saved as a contact on this device')}`, []],
  // The maker of a share link whose apps no peer shares.
  ['maker-empty', 'maker-empty', `${focused('.disc-back')} && ${has('Apps from this maker appear here when your peers share them.')}`,
    ['dweb/base/inspect-address']],
  // why the margins: the line sits in the 24px rhythm of the view, as every other line does.
  ['commons-unknown', 'commons-unknown', `[...document.querySelectorAll('.disc-view > p')]
    .some(line => line.textContent.startsWith('Could not confirm whether Commons was added or opened.')
      && getComputedStyle(line).marginTop === '0px' && getComputedStyle(line).marginBottom === '0px')`, ['dweb/open-commons']],
];

const frameState = ([mode, frame, ready, effects]) => ({
  name: `discovery-${mode}`, kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    if (!discoverSurface().flow) {
      rec.observe('merge-base surface', { present:false, reason:'this Discover screen was introduced on this branch' });
      return;
    }
    const page = await openExtPage(ctx, `tests/fixtures/explore.html?state=${frame}`);
    try {
      await page.send('Emulation.setDeviceMetricsOverride',{width:960,height:900,deviceScaleFactor:1,mobile:false});
      if (!await waitFor(()=>evalIn(page, ready),{budgetMs:8000,pollMs:80})) throw new Error(`Discovery ${mode} did not render`);
      rec.check('discovery surface fits narrow and wide viewport', await evalIn(page,`document.documentElement.scrollWidth <= innerWidth`));
      rec.check('frame sends only reads and the effect it draws', await evalIn(page, `JSON.stringify(window.__exploreFixtureCalls
        .filter(type => !${JSON.stringify(READS)}.includes(type))) === ${JSON.stringify(JSON.stringify(effects))}`));
      await rec.visualPage(`discovery-${mode}`, page);
    } finally { try { page.close(); } catch {} }
  },
});

export const STARTER_VISUAL_STATES = [
  ...[false, true].flatMap(narrow => ['home', 'review', 'empty', 'no-results', 'publisher', 'suggestion'].map(mode => keptState(mode, narrow))),
  ...FLOW_FRAMES.map(frameState),
];
