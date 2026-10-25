import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalIn, waitFor, openExtPage, openWidePage } from './e2e-harness.mjs';
// Render-only proof. Real composed CSV/WASM execution is in the browser suite.

// The tree under test: a merge-base render names its tree, this branch renders
// its own. why a file probe: the one-flow Discover (a start list, tiles and a
// page per app) ships home/discover-pages.js; an older tree stacks sections.
// why a content probe for phase 2: it adds no file of its own, and the share
// dialog is its first new view piece. `says`: The app says it is the next.
// `blocks`: the block confirm (blocking a maker) after that. `mine`: the page
// of the user's own app. `added`: a starter fixture that answers an add.
export const discoverSurface = () => {
  if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') {
    return { base: false, flow: true, phase2: true, says: true, blocks: true, mine: true, added: true, tree: null };
  }
  const tree = process.argv.find(arg => arg.startsWith('--extension='))?.slice('--extension='.length);
  if (!tree) throw new Error('base visual render requires an explicit extension tree');
  const pages = join(tree, 'home/discover-pages.js');
  const flow = existsSync(pages);
  const source = flow ? readFileSync(pages, 'utf8') : '';
  const starters = join(tree, 'tests/fixtures/starters.js');
  return {
    base: true, flow, phase2: source.includes('export const shareDialog'), says: source.includes('export const saysItSection'),
    blocks: source.includes('export const blockDialog'), mine: source.includes('You made this app.'),
    added: existsSync(starters) && readFileSync(starters, 'utf8').includes("=== 'added'"), tree,
  };
};

// Every read a Discover frame may send. Any other route is an effect.
const READS = ['apps/list', 'dweb/base/heard', 'bootstrap/ready', 'dweb/distributed/info', 'contacts/list', 'dweb/blocked-peers'];
const has = text => `document.body.textContent.includes(${JSON.stringify(text)})`;
// why the tree's own words: changed screens also render on the merge-base
// tree, in its words, and a check that took either would not prove the new ones.
const PHASE2 = discoverSurface().phase2;
const byTree = (now, before) => has(PHASE2 ? now : before);
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
  home: [byTree('Try an app that comes with peerd', 'Try an included app'), has('Add and open Commons')],
  review: [byTree('Add to Library', 'Apply: add local copy'), has('Apply: add local copy')],
  empty: [byTree('Looking for people who share apps…', 'Apps show up as peers share them'), has('No peer Apps discovered yet')],
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
// the only effects the frame may send, options]. The fixture answers reads
// plus the one effect its frame draws, so anything else throws there.
// `phase2`: a screen the phase-1 tree does not draw; `says`: one a tree
// without The app says it does not draw; `blocks`: one a tree that cannot
// block a maker does not draw; `mine`: one a tree without the own-app line
// does not draw; `narrow`: also at 320px; `narrowCheck`: a [name, check]
// that holds at 320px only.
const FLOW_FRAMES = [
  ['share-link', 'share-off', `${byTree('Turn on the peer network first.', 'Join the peer network first.')}
    && document.querySelector('.disc-start-form input')?.value.startsWith('dwapp://')
    && document.querySelector('.disc-start-form button')?.disabled === true`, []],
  ['connected-empty', 'empty', byTree('No shared apps yet', 'No apps shared yet'), []],
  ['tiles', 'tiles', `${cards(3)} && ${byTree('new version ready', 'Update ready')}
    && ${byTree('This browser cannot run it', 'Can’t run in this browser')}`, []],
  ['offline', 'offline', `${has('Peer network is offline')} && ${cards(1)}`, []],
  ['offline-empty', 'offline-empty', `${has('Peer network is offline')}
    && ${byTree('You can still open the apps in your Library.', 'Apps you install from peers show up here.')}`, []],
  // why not the empty line: it claims what the Library holds, so it waits for a good read.
  ['offline-reading', 'offline-reading', `${has('Peer network is offline')} && ${has('Checking your Library…')}
    && !${has('You can still open the apps')} && !${has('Apps you install from peers')}`, []],
  ['offline-failed', 'offline-failed', `${has('Peer network is offline')} && ${byTree('peerd could not read your Library.', 'Could not read your Library.')}
    && !${has('You can still open the apps')} && !${has('Apps you install from peers')}`, []],
  ['installing', 'installing', has('You can leave this page. The install keeps going.'), ['dweb/base/install']],
  // why the status line: focus never lands on Open, which runs the app.
  ['installed', 'installed', `${focused('.disc-panel .disc-installed')} && ${byTree('is now in your Library.', 'In your Library.')}`,
    ['dweb/base/install']],
  ['open-unknown', 'open-unknown', `[...document.querySelectorAll('.disc-panel [role="status"]')]
    .some(line => line.textContent === ${JSON.stringify(PHASE2 ? 'peerd is not sure the app opened. Check your tabs.'
    : 'peerd could not confirm whether the app opened. Check your tabs.')} && !line.classList.contains('error'))`,
  ['dweb/base/install', 'apps/open']],
  ['install-failed', 'failed', byTree('peerd could not install Field notes.', 'peerd could not install this app. Try again.'), ['dweb/base/install']],
  ['install-unknown', 'unknown', byTree('peerd is not sure the install finished.', 'peerd could not confirm whether the install finished.'),
    ['dweb/base/install']],
  ['update-conflict', 'conflict', byTree('Changed on this device', 'Locally modified'), ['dweb/base/update-app']],
  // why Open too: the installed version still runs after a failed or unconfirmed update.
  ['update-failed', 'update-failed', `${byTree('peerd could not update Field notes.', 'peerd could not update this app. Try again.')}
    && ${panelButtons(['Try again', 'Open'])}`, ['dweb/base/update-app']],
  ['update-unknown', 'update-unknown', PHASE2 ? `${has('peerd is not sure the update finished.')} && ${panelButtons(['Check again', 'Open'])}`
    : `${has('peerd could not confirm whether the update finished.')} && ${panelButtons(['Refresh', 'Open'])}`, ['dweb/base/update-app']],
  ['update-ready', 'update', `${focused('.disc-back')} && ${has('Update ready')}`, []],
  ['update-cant-run', 'update-cant-run', `${focused('.disc-back')}
    && ${byTree('This browser cannot run the new version.', 'This update can’t run in this browser.')}`, []],
  ['cant-run', 'cant-run', `${focused('.disc-back')} && ${byTree('This browser cannot run this app.', 'This app can’t run in this browser.')}`, []],
  ['maker', 'maker', `${focused('.disc-back')}
    && ${byTree('Someone you know. You saved this name on this device.', 'Saved as a contact on this device')}`, []],
  // The maker of a share link whose apps no peer shares.
  ['maker-empty', 'maker-empty', `${focused('.disc-back')} && ${byTree('This maker’s apps show up here when the people you are connected to share them.',
    'Apps from this maker appear here when your peers share them.')}`, ['dweb/base/inspect-address']],
  // why the margins: the line sits in the 24px rhythm of the view, as every other line does.
  ['commons-unknown', 'commons-unknown', `[...document.querySelectorAll('.disc-view > p')]
    .some(line => line.textContent.startsWith(${JSON.stringify(PHASE2 ? 'peerd is not sure Commons was added or opened.'
    : 'Could not confirm whether Commons was added or opened.')})
      && getComputedStyle(line).marginTop === '0px' && getComputedStyle(line).marginBottom === '0px')`, ['dweb/open-commons']],
  // The share dialog, open over an app page: focus is inside, on its action.
  ['share', 'share', `!!document.querySelector('.disc-share[role="dialog"]') && ${focused('[data-share-copy]')}
    && document.querySelector('.disc-share input')?.value.startsWith('dwapp://')`, [], { phase2: true, narrow: true }],
  // The Your apps row with more Library apps than it shows. On a narrow
  // column it stays one line that scrolls sideways, so browsing starts near the top.
  ['your-apps', 'yours', `document.querySelectorAll('.disc-yours-item').length === 6 && ${has('See all in Library')} && ${cards(3)}`, [],
    { phase2: true, narrow: true, narrowCheck: ['Your apps stays one line that scrolls sideways on a narrow column', `(() => {
      const list = document.querySelector('.disc-yours-list');
      const tops = new Set([...document.querySelectorAll('.disc-yours-item')].map(item => Math.round(item.getBoundingClientRect().top)));
      return !!list && tops.size === 1 && list.scrollWidth > list.clientWidth;
    })()`] }],
  // The app says it: an app peerd only heard about, a share link it checked
  // (every fact, the strongest last), and an installed version that asks for none.
  ['says-unknown', 'says-unknown', `${focused('.disc-back')} && ${has('Not known yet. peerd reads this from the app itself when it checks it.')}`,
    [], { says: true }],
  ['says-checked', 'says-checked', `${focused('.disc-back')} && document.querySelectorAll('.disc-says li').length === 3
    && document.querySelector('.disc-says li:last-child')?.classList.contains('is-strong') && ${has('checked when peerd looked at it.')}`,
  ['dweb/base/inspect-address'], { says: true, narrow: true }],
  ['says-nothing', 'says-nothing', `${focused('.disc-back')} && ${has('It does not use the peer network and has no instructions for peerd.')}`,
    [], { says: true }],
  // The user's own app, made and shared from their Library: What to know says
  // they made it, never that an install checked it against its maker.
  ['mine', 'mine', `${focused('.disc-back')} && ${has('You made this app.')} && !${has('peerd checked')}`, [], { mine: true }],
  // Block a maker: the maker menu open, its confirm open on Cancel, and the
  // maker page after the block, with focus on the line that says so.
  ['maker-menu', 'maker-menu', `${focused('.disc-menu [role="menuitem"]')}
    && document.querySelectorAll('.disc-menu [role="menuitem"]').length === 2`, [], { blocks: true }],
  ['block-confirm', 'block-confirm', `!!document.querySelector('.disc-block[role="dialog"]') && ${focused('[data-block-cancel]')}`,
    [], { blocks: true, narrow: true }],
  ['blocked', 'blocked', `${focused('.disc-blocked')} && ${has('Ana is blocked. You can undo this in Contacts.')}`,
    ['dweb/peer-block'], { blocks: true }],
  // A block whose reply was lost: neutral words, and Check again in place of Block.
  ['block-unknown', 'block-unknown', `${focused('[data-block-check]')}
    && ${has('peerd is not sure Ana is blocked. Check again before you try again.')}`, ['dweb/peer-block'], { blocks: true }],
  // Rename from the maker menu: the form opens with the saved name and focus in it.
  ['maker-rename', 'maker-rename', `${focused('.disc-rename input')} && document.querySelector('.disc-rename input')?.value === 'Ana'`,
    [], { blocks: true, narrow: true }],
];

const frameState = ([mode, frame, ready, effects, { phase2 = false, says = false, blocks = false, mine = false, narrowCheck = null } = {}],
  narrow = false) => ({
  name: `discovery-${mode}${narrow ? '-narrow' : ''}`, kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    const surface = discoverSurface();
    if (!surface.flow || (phase2 && !surface.phase2) || (says && !surface.says) || (blocks && !surface.blocks) || (mine && !surface.mine)) {
      rec.observe('merge-base surface', { present:false, reason:'this Discover screen was introduced on this branch' });
      return;
    }
    const page = await openExtPage(ctx, `tests/fixtures/explore.html?state=${frame}`);
    try {
      await page.send('Emulation.setDeviceMetricsOverride',{width:narrow?320:960,height:narrow?1450:900,deviceScaleFactor:1,mobile:false});
      if (!await waitFor(()=>evalIn(page, ready),{budgetMs:8000,pollMs:80})) throw new Error(`Discovery ${mode} did not render`);
      rec.check('discovery surface fits narrow and wide viewport', await evalIn(page,`document.documentElement.scrollWidth <= innerWidth`));
      if (narrow && narrowCheck) rec.check(narrowCheck[0], await evalIn(page, narrowCheck[1]));
      rec.check('frame sends only reads and the effect it draws', await evalIn(page, `JSON.stringify(window.__exploreFixtureCalls
        .filter(type => !${JSON.stringify(READS)}.includes(type))) === ${JSON.stringify(JSON.stringify(effects))}`));
      await rec.visualPage(`discovery-${mode}${narrow ? '-narrow' : ''}`, page);
    } finally { try { page.close(); } catch {} }
  },
});

// Blocked makers in Contacts: [mode, contacts.html frame, ready, the only
// effects the frame may send]. why a file probe: the fixture is new here.
const CONTACT_READS = ['contacts/list', 'dweb/distributed/info', 'dweb/blocked-peers'];
const CONTACT_FRAMES = [
  ['blocked', 'blocked', `document.querySelectorAll('.contacts-blocked-row').length === 2 && ${has('Blocked makers')}`, [], { narrow: true }],
  ['unblocked', 'unblocked', `${focused('.contacts-unblocked')} && document.querySelectorAll('.contacts-blocked-row').length === 1`,
    ['dweb/peer-unblock']],
];
const contactsState = ([mode, frame, ready, effects], narrow = false) => ({
  name: `contacts-${mode}${narrow ? '-narrow' : ''}`, kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    const surface = discoverSurface();
    if (surface.base && !existsSync(join(surface.tree, 'tests/fixtures/contacts.html'))) {
      rec.observe('merge-base surface', { present:false, reason:'the blocked makers list was introduced on this branch' });
      return;
    }
    const page = await openExtPage(ctx, `tests/fixtures/contacts.html?state=${frame}`);
    try {
      await page.send('Emulation.setDeviceMetricsOverride',{width:narrow?320:960,height:narrow?1100:760,deviceScaleFactor:1,mobile:false});
      if (!await waitFor(()=>evalIn(page, ready),{budgetMs:8000,pollMs:80})) throw new Error(`Contacts ${mode} did not render`);
      rec.check('contacts fit narrow and wide viewport', await evalIn(page,`document.documentElement.scrollWidth <= innerWidth`));
      rec.check('frame sends only reads and the effect it draws', await evalIn(page, `JSON.stringify(window.__contactsFixtureCalls
        .filter(type => !${JSON.stringify(CONTACT_READS)}.includes(type))) === ${JSON.stringify(JSON.stringify(effects))}`));
      await rec.visualPage(`contacts-${mode}${narrow ? '-narrow' : ''}`, page);
    } finally { try { page.close(); } catch {} }
  },
});

// The page Discover's Try opens, in the real Settings shell. The starter
// fixture draws its section alone, so only this capture shows the title.
// why either label: the merge-base tree renders its own words.
const tryPage = {
  name: 'options-starter', kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    const page = await openWidePage(ctx, 'options/options.html#!/transfer?starter=csv-lab');
    try {
      const ready = await waitFor(() => evalIn(page, `[...document.querySelectorAll('.starter-review button')]
        .some(button => ['Add to Library', 'Apply: add local copy'].includes(button.textContent))`), {budgetMs:15000,pollMs:80});
      if (!ready) throw new Error('The starter page did not render');
      rec.check('the page Try opens is titled for what it does', await evalIn(page,
        `document.querySelector('.options-page > h2')?.textContent === ${JSON.stringify(PHASE2 ? 'Try an app' : 'Backup & restore')}`));
      await rec.visualPage('options-starter', page);
    } finally { try { page.close(); } catch {} }
  },
};

// The page after an add peerd confirmed: Go to Library leads, and the line
// says that another add makes a second copy. The fixture answers the add.
const starterAdded = {
  name: 'discovery-starter-added', kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    if (!discoverSurface().added) {
      rec.observe('merge-base surface', { present:false, reason:'the page after an add was introduced on this branch' });
      return;
    }
    const page = await openExtPage(ctx, 'tests/fixtures/starters.html?starter=csv-lab&state=added');
    try {
      await page.send('Emulation.setDeviceMetricsOverride',{width:960,height:900,deviceScaleFactor:1,mobile:false});
      if (!await waitFor(() => evalIn(page, has('Add to Library')), {budgetMs:8000,pollMs:80})) throw new Error('The starter page did not render');
      await clickSync(page, 'button', 'Add to Library');
      rec.check('after an add, Go to Library leads and the line says another add makes a second copy', !!await waitFor(() => evalIn(page,
        `${has('If you add it again, you get a second copy.')} && [...document.querySelectorAll('button')]
          .some(button => button.textContent === 'Go to Library' && !button.classList.contains('secondary'))`), {budgetMs:4000,pollMs:50}));
      rec.check('the page sends only its check and the add', await evalIn(page,
        `JSON.stringify(window.__starterFixtureCalls) === ${JSON.stringify(JSON.stringify(['import/inspect', 'import/apply']))}`));
      await rec.visualPage('discovery-starter-added', page);
    } finally { try { page.close(); } catch {} }
  },
};

export const STARTER_VISUAL_STATES = [
  ...[false, true].flatMap(narrow => ['home', 'review', 'empty', 'no-results', 'publisher', 'suggestion'].map(mode => keptState(mode, narrow))),
  ...FLOW_FRAMES.flatMap(row => [frameState(row), ...row[4]?.narrow ? [frameState(row, true)] : []]),
  ...CONTACT_FRAMES.flatMap(row => [contactsState(row), ...row[4]?.narrow ? [contactsState(row, true)] : []]),
  tryPage, starterAdded,
];
