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
// `changed`: the page of an installed copy edited on this device. `plain`:
// the plain-words pass (empty pills, Library errors that say what to do, the
// user's own maker page), whose fixtures draw those screens. `lines`: fixture
// frames for the lines a reply adds (a failure, an unknown outcome, a copy)
// and for a tile with no description. why a fixture probe: an older tree
// draws these screens, but its fixtures cannot reach them. `names`: the apps
// that come with peerd go by plain names (Tables and charts, Desaturator,
// Chat rooms). The probe reads the tree's starter catalog. `polish`: fixture
// frames of the second plain-words and trust pass (an update that finished,
// the user's own app offline or out of the Library, a changed copy on a
// share-link page, Chat rooms added under a former name), and the checks of
// what that pass changed on screens an older tree draws too.
export const discoverSurface = () => {
  if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') {
    return {
      base: false, flow: true, phase2: true, says: true, blocks: true, mine: true, added: true, changed: true, plain: true, lines: true,
      names: true, polish: true, tree: null,
    };
  }
  const tree = process.argv.find(arg => arg.startsWith('--extension='))?.slice('--extension='.length);
  if (!tree) throw new Error('base visual render requires an explicit extension tree');
  const pages = join(tree, 'home/discover-pages.js');
  const flow = existsSync(pages);
  const source = flow ? readFileSync(pages, 'utf8') : '';
  const starters = join(tree, 'tests/fixtures/starters.js');
  /** @param {string} name @param {string} frame */
  const fixtureHas = (name, frame) => existsSync(join(tree, 'tests/fixtures', name))
    && readFileSync(join(tree, 'tests/fixtures', name), 'utf8').includes(`'${frame}'`);
  const catalog = join(tree, 'shared/starter-catalog.js');
  return {
    base: true, flow, phase2: source.includes('export const shareDialog'), says: source.includes('export const saysItSection'),
    blocks: source.includes('export const blockDialog'), mine: source.includes('You made this app.'),
    added: existsSync(starters) && readFileSync(starters, 'utf8').includes("=== 'added'"),
    changed: source.includes('It changed on this device after you installed it.'), plain: source.includes('This is you.'),
    lines: fixtureHas('explore.js', 'share-copied') && fixtureHas('contacts.js', 'unblock-failed'),
    names: existsSync(catalog) && readFileSync(catalog, 'utf8').includes("name: 'Tables and charts'"),
    polish: fixtureHas('explore.js', 'update-done'), tree,
  };
};

// Every read a Discover frame may send. Any other route is an effect.
const READS = ['apps/list', 'dweb/base/heard', 'bootstrap/ready', 'dweb/distributed/info', 'contacts/list', 'dweb/blocked-peers',
  'dweb/app-local-changes'];
const has = text => `document.body.textContent.includes(${JSON.stringify(text)})`;
// why the tree's own words: changed screens also render on the merge-base
// tree, in its words, and a check that took either would not prove the new ones.
const PHASE2 = discoverSurface().phase2;
const NAMES = discoverSurface().names;
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
// why again before each shot: "Link copied." goes away after two seconds, and
// the two theme shots can take longer. It waits for the stub write to land,
// then commits the redraw.
const COPY_AGAIN = `(async () => {
  const copy = document.querySelector('[data-share-copy]');
  copy.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  (await import('/vendor/mithril/mithril.js')).default.redraw.sync();
  copy.focus();
})()`;

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
      // The apps that come with peerd go by their plain names.
      if (mode === 'home' && NAMES) rec.check('the start row names Tables and charts in plain words', await evalIn(page,
        `${has('Add the Tables and charts app to your Library, then open it from there.')} && ${has('Try Tables and charts')}`));
      if (mode === 'review' && NAMES) rec.check('the page names Desaturator', await evalIn(page,
        `document.querySelector('.starter-review h3')?.textContent === 'Desaturator'`));
      // why the line under the name: "Desaturator" alone does not say what the app does.
      if (mode === 'review' && surface.polish) rec.check('the page says what the app does', await evalIn(page,
        `document.querySelector('.starter-review h3 + p')?.textContent === 'Make a picture gray, or black and white, all on your device.'`));
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
// does not draw; `changed`: one a tree without the changed-copy line does
// not draw; `plain`: one a tree without the plain-words pass does not draw;
// `lines` and `polish`: one the tree's fixture cannot reach; `narrow`: also at 320px;
// `narrowCheck`: a [name, check] that holds at 320px only; `newCheck`: a
// [name, check] of what the second pass changed, made only on a tree that has
// it; `again`: a script that draws a line that goes away by itself once more
// before each shot.
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
    ['dweb/base/install'], { narrow: true, newCheck: ['each done step says it is done in words, not only with its check', `(() => {
      const done = [...document.querySelectorAll('.disc-step.is-done')];
      return done.length === 2 && done.every(step => step.textContent.startsWith('Done: '))
        && document.querySelector('.disc-steps')?.getAttribute('aria-label') === 'Install steps';
    })()`] }],
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
    && ${panelButtons(['Try again', 'Open'])}`, ['dweb/base/update-app'], { narrow: true }],
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
    .some(line => line.textContent.startsWith(${JSON.stringify(NAMES ? 'peerd is not sure the Chat rooms app was added or opened.'
    : PHASE2 ? 'peerd is not sure Commons was added or opened.' : 'Could not confirm whether Commons was added or opened.')})
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
  ['says-nothing', 'says-nothing', `${focused('.disc-back')} && ${has('It does not use the peer network and has no instructions for peerd.')}
    && ${has('From the app’s own files, checked when peerd installed it.')}`, [], { says: true }],
  // The same installed version after an edit on this device: the head and
  // What to know say so, and none of the facts peerd checked at the install show.
  ['says-changed', 'says-changed', `${focused('.disc-back')} && ${has('It changed on this device after you installed it.')}
    && ${has('Changed on this device')} && !document.querySelector('.disc-says')`, [], { changed: true,
    newCheck: ['the panel says peers get the version peerd checked, not the changes', has('They do not get your changes.')] }],
  // The user's own app, made and shared from their Library: What to know says
  // they made it, never that an install checked it against its maker.
  ['mine', 'mine', `${focused('.disc-back')} && ${has('You made this app.')} && !${has('peerd checked')}`, [], { mine: true, narrow: true,
    newCheck: ['the panel of an app the user made has no install steps', `!document.querySelector('.disc-steps')
      && !!document.querySelector('.disc-panel .disc-installed')`] }],
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
  // Offline from the start, so peerd heard no card: a Library tile claims no description.
  ['offline-fresh', 'offline-fresh', `${has('Peer network is offline')} && ${cards(1)} && !document.querySelector('.disc-tile-desc')`,
    [], { plain: true, narrow: true }],
  // An update that could not stop sharing the old version says so in plain words.
  ['update-cleanup', 'update-cleanup', `!!document.querySelector('.disc-panel .disc-installed')
    && ${has('peerd still shares the old version. Sharing stops the next time you update or remove this app.')}`,
  ['dweb/base/update-app'], { plain: true, narrow: true }],
  // An update that runs names its step Update, as its line does.
  ['updating', 'updating', `${has('You can leave this page. The update keeps going.')}
    && document.querySelector('.disc-step.is-working .disc-step-title')?.textContent === 'Update'
    && document.querySelector('.disc-steps')?.getAttribute('aria-label') === 'Update steps'`,
  ['dweb/base/update-app'], { plain: true, narrow: true }],
  // Library errors say what failed, what stays off, then what to do: after a
  // refresh online and offline, and on an app page before any read.
  ['refresh-failed', 'refresh-failed', `${has('peerd could not refresh your Library. Surprise me stays off until peerd can read it.')}
    && [...document.querySelectorAll('button')].some(button => button.textContent === 'Surprise me' && button.disabled)`,
  [], { plain: true, narrow: true }],
  ['offline-refresh-failed', 'offline-refresh-failed', `${has('Peer network is offline')}
    && ${has('peerd could not refresh your Library. This list may be out of date. peerd tries again by itself.')}`, [], { plain: true, narrow: true }],
  ['library-failed', 'library-failed', `${focused('.disc-back')}
    && ${has('peerd could not read your Library. Install stays off until peerd can read it. Try again in a moment.')}
    && [...document.querySelectorAll('.disc-panel button')].some(button => button.textContent === 'Install and share' && button.disabled)`,
  [], { plain: true, narrow: true }],
  // An empty pill says why it is empty and what to do.
  ['pill-updates', 'pill-updates', `${has('No updates right now')} && ${cards(0)}`, [], { plain: true, narrow: true }],
  ['pill-contacts', 'pill-contacts', `${has('No apps from people you know yet')} && ${cards(0)}
    && ${has('Then open the menu on their page and choose Add a name.')}`, [], { plain: true, narrow: true }],
  // The user's own maker page, and a share link to their own app, speak to them.
  ['mine-maker', 'mine-maker', `${focused('.disc-back')} && ${has('This is you.')}
    && document.querySelector('.disc-person-head h2')?.textContent === 'You' && !document.querySelector('.disc-person-head h2 .type-code')
    && ${has('Apps you made')} && !${has('Apps from')}`, [], { plain: true, narrow: true }],
  ['mine-link', 'mine-link', `${focused('.disc-back')} && ${has('Made by you')} && ${has('You made this app.')}
    && !document.querySelector('.disc-steps')`,
    ['dweb/base/inspect-address'], { plain: true, narrow: true }],
  // Peers share an app the user made, and the user's Library no longer holds it: its tile says Made by you.
  ['mine-tile', 'mine-tile', `${cards(4)} && [...document.querySelectorAll('.disc-tile-meta')]
    .some(meta => meta.textContent.startsWith('Made by you'))`, [], { plain: true, narrow: true }],
  // The lines a reply adds: a name peerd could not save, or is not sure it
  // saved; a block that failed; an Open in Your apps that failed, or may not
  // have opened; a copy of the share link that worked or failed; and a maker
  // blocked in another tab, as an install and a link check say it.
  ['rename-failed', 'rename-failed', `${focused('.disc-rename button[type="submit"]')} && ${has('peerd could not save the name. Try again.')}`,
    ['contacts/set'], { lines: true, narrow: true }],
  ['rename-unknown', 'rename-unknown', `${focused('[data-maker-menu]')}
    && ${has('peerd is not sure the name was saved. Check Contacts before you try again.')}`, ['contacts/set'], { lines: true, narrow: true }],
  ['block-failed', 'block-failed', `${focused('[data-block-confirm]')} && ${has('peerd could not block Ana. Try again.')}`,
    ['dweb/peer-block'], { lines: true, narrow: true }],
  // why Open at the item's end: the line under it widens the item.
  ['yours-open-failed', 'yours-open-failed', `[...document.querySelectorAll('.disc-yours-item [role="alert"]')]
    .some(line => line.textContent === 'peerd could not open this app. Try again.') && (() => {
      const item = document.querySelector('.disc-yours-item [role="alert"]')?.closest('.disc-yours-item');
      const open = item?.querySelector('.disc-yours-open');
      return !!item && !!open && item.getBoundingClientRect().right - open.getBoundingClientRect().right <= 16;
    })()`, ['apps/open'], { lines: true, narrow: true }],
  ['yours-open-unknown', 'yours-open-unknown', `[...document.querySelectorAll('.disc-yours-item [role="status"]')]
    .some(line => line.textContent === 'peerd is not sure the app opened. Check your tabs.' && !line.classList.contains('error'))`,
  ['apps/open'], { lines: true, narrow: true }],
  ['share-copied', 'share-copied', `${focused('[data-share-copy]')} && document.querySelector('.disc-share-status')?.textContent === 'Link copied.'`,
    [], { lines: true, again: COPY_AGAIN }],
  ['share-copy-failed', 'share-copy-failed', `${focused('[data-share-copy]')} && document.querySelector('.disc-share-status')?.textContent
    === 'peerd could not copy the link. Select it and copy it yourself.'`, [], { lines: true, narrow: true }],
  // why no Try again: only an unblock in Contacts helps, and the hint says so.
  ['install-blocked', 'install-blocked', `${has('peerd could not install Field notes.')}
    && ${has('You blocked the maker of this app. To install it, unblock them in Contacts.')}
    && !document.querySelector('.disc-panel button')`, ['dweb/base/install'], { lines: true, narrow: true }],
  ['link-blocked', 'link-blocked', has('You blocked the maker of this app. To look at it, unblock them in Contacts.'),
    ['dweb/base/inspect-address'], { lines: true, narrow: true }],
  // A heard card whose maker gave no description says so in its tile.
  ['no-description', 'no-description', `${cards(3)}
    && document.querySelector('.disc-tile-desc.is-missing')?.textContent === 'No description from the maker.'`, [], { lines: true }],
  // The user's own shared app while the peer network is off: the Library says
  // the user made it, so its page speaks to them and claims no check.
  ['mine-offline', 'mine-offline', `${focused('.disc-back')} && ${has('Made by you')} && ${has('You made this app.')}
    && !${has('peerd checked')} && !document.querySelector('.disc-steps')`, [], { polish: true }],
  // Peers share an app the user made, and their Library no longer holds it.
  ['mine-not-installed', 'mine-not-installed', `${focused('.disc-back')} && ${has('You made this app. It is not in your Library now.')}
    && ${panelButtons(['Install and share'])}`, [], { polish: true, narrow: true }],
  // The share dialog of the user's own app: the update is theirs to make.
  ['mine-share', 'mine-share', `${focused('[data-share-copy]')}
    && ${has('If you update the app later, your friend still gets the version you shared.')}`, [], { polish: true }],
  // A normal update that finished: its steps, its line and What to know say
  // update. why the focus: the Update button is gone, as after an install.
  ['update-done', 'update-done', `${focused('.disc-panel .disc-installed')} && ${has('Field notes in your Library is now the new version.')}
    && [...document.querySelectorAll('.disc-step-title')].map(title => title.textContent).join() === 'Look at it,Update,Open'
    && ${has('When you updated it, peerd checked that it was exactly the app')}`, ['dweb/base/update-app'], { polish: true, narrow: true }],
  // A share link to an installed copy that changed on this device: the head and
  // What to know say so, and the link's facts do not stand for the copy Open runs.
  ['link-changed', 'link-changed', `${focused('.disc-back')} && ${has('Changed on this device')}
    && ${has('It changed on this device after you installed it.')} && !document.querySelector('.disc-says')
    && ${has('They do not get your changes.')}`, ['dweb/base/inspect-address'], { polish: true, narrow: true }],
  // An earlier add of Chat rooms under a former name: the tile, with Open, and Your apps show the name it has now.
  ['commons-renamed', 'commons-renamed', `[...document.querySelectorAll('.disc-tile-name, .disc-yours-name')]
    .filter(name => name.textContent === 'Chat rooms').length === 2 && !${has('Peerd-to-Peerd Commons')}
    && !${has('Add and open Chat rooms')}`, [], { polish: true }],
  // A search on All finds the app that comes with peerd that its words match, in the same grid.
  ['search-included', 'search-included', `${cards(1)} && document.querySelector('.disc-tile-name')?.textContent === 'Chat rooms'
    && document.querySelector('.disc-pill[aria-pressed="true"]')?.textContent === 'All' && !${has('No matching apps')}`, [],
  { polish: true }],
  // Surprise me on a pill with nothing to suggest says what to do in the screen's own words.
  ['surprise-filtered', 'surprise-filtered', `${has('No new suggestions here. Show all apps, then try again.')} && !${has('filters')}`,
    [], { polish: true, narrow: true }],
];

const frameState = ([mode, frame, ready, effects, {
  phase2 = false, says = false, blocks = false, mine = false, changed = false, plain = false, lines = false, polish = false,
  narrowCheck = null, newCheck = null, again = null,
} = {}], narrow = false) => ({
  name: `discovery-${mode}${narrow ? '-narrow' : ''}`, kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    const surface = discoverSurface();
    // why three reasons: a screen this branch adds, one an older tree does not
    // draw, and one an older tree draws but its fixture cannot reach.
    const reason = changed && !surface.changed ? 'this Discover screen was introduced on this branch'
      : !surface.flow || (phase2 && !surface.phase2) || (says && !surface.says) || (blocks && !surface.blocks) || (mine && !surface.mine)
        ? 'the merge-base tree does not draw this screen'
        : (plain && !surface.plain) || (lines && !surface.lines) || (polish && !surface.polish)
          ? 'the merge-base fixture cannot reach this screen' : null;
    if (reason) {
      rec.observe('merge-base surface', { present:false, reason });
      return;
    }
    const page = await openExtPage(ctx, `tests/fixtures/explore.html?state=${frame}`);
    try {
      await page.send('Emulation.setDeviceMetricsOverride',{width:narrow?320:960,height:narrow?1450:900,deviceScaleFactor:1,mobile:false});
      if (!await waitFor(()=>evalIn(page, ready),{budgetMs:8000,pollMs:80})) throw new Error(`Discovery ${mode} did not render`);
      rec.check('discovery surface fits narrow and wide viewport', await evalIn(page,`document.documentElement.scrollWidth <= innerWidth`));
      if (narrow && narrowCheck) rec.check(narrowCheck[0], await evalIn(page, narrowCheck[1]));
      if (newCheck && surface.polish) rec.check(newCheck[0], await evalIn(page, newCheck[1]));
      rec.check('frame sends only reads and the effect it draws', await evalIn(page, `JSON.stringify(window.__exploreFixtureCalls
        .filter(type => !${JSON.stringify(READS)}.includes(type))) === ${JSON.stringify(JSON.stringify(effects))}`));
      // `again` draws a line that goes away by itself once more before each shot.
      await rec.visualPage(`discovery-${mode}${narrow ? '-narrow' : ''}`, page, again ? { beforeShot: async () => {
        await evalIn(page, again, true);
        if (!await evalIn(page, ready)) throw new Error(`Discovery ${mode} did not render again`);
      } } : {});
    } finally { try { page.close(); } catch {} }
  },
});

// Blocked makers in Contacts: [mode, contacts.html frame, ready, the only
// effects the frame may send, options]. why a file probe: a tree older than
// the blocked makers list has no contacts fixture. `plain` and `lines`: a
// screen whose frame the tree's fixture cannot reach, which the probes name.
// `narrowCheck`: a [name, check] made at 320px.
const CONTACT_READS = ['contacts/list', 'dweb/distributed/info', 'dweb/blocked-peers'];
const CONTACT_FRAMES = [
  ['blocked', 'blocked', `document.querySelectorAll('.contacts-blocked-row').length === 2 && ${has('Blocked makers')}`, [], { narrow: true }],
  ['unblocked', 'unblocked', `${focused('.contacts-unblocked')} && document.querySelectorAll('.contacts-blocked-row').length === 1`,
    ['dweb/peer-unblock']],
  // People the user has not named show as their short key, in Discover's words:
  // Add a name, the app count alone under the key, and the full key only in Technical details.
  ['unnamed', 'unnamed', `document.querySelectorAll('.contact-row').length === 3 && ${has('No apps installed from them yet.')}
    && [...document.querySelectorAll('.contact-row-actions button')].some(button => button.textContent === 'Add a name')
    && [...document.querySelectorAll('.contact-row .peerd-disc-pub')].some(line => line.textContent === '1 app')
    && !!document.querySelector('.contact-detail details.contact-tech:not([open])')`, [], { narrow: true, plain: true,
    narrowCheck: ['the key of each person with no name shows in full', `[...document.querySelectorAll('.contact-row .peerd-disc-name')]
      .every(name => name.scrollWidth <= name.clientWidth)`] }],
  ['empty', 'empty', has('Nobody here yet.'), [], { narrow: true, plain: true }],
  // An unblock that failed says so in its row; one whose reply was lost stays
  // neutral and offers Check again; a list that cannot load says so, with
  // Try again; and the last unblock leaves nobody in the list.
  ['unblock-failed', 'unblock-failed', `${focused('[data-unblock]')} && ${has('peerd could not unblock Ana. Try again.')}`,
    ['dweb/peer-unblock'], { narrow: true, lines: true }],
  // why one "Blocked." only: the row whose unblock may be done claims neither outcome.
  ['unblock-unknown', 'unblock-unknown', `${focused('[data-unblock]')}
    && ${has('peerd is not sure Ana is unblocked. Check again before you try again.')}
    && document.querySelectorAll('.contacts-blocked-meta').length === 1`, ['dweb/peer-unblock'], { narrow: true, lines: true }],
  ['load-failed', 'load-failed', `${has('peerd could not load your blocked makers. Try again.')}
    && !!document.querySelector('.contacts-blocked-retry')`, [], { narrow: true, lines: true }],
  ['unblocked-last', 'unblocked-last', `${focused('.contacts-unblocked')} && ${has('Nobody is blocked now.')}
    && !${has('Their apps are hidden')}`, ['dweb/peer-unblock'], { lines: true }],
];
const contactsState = ([mode, frame, ready, effects, { plain = false, lines = false, narrowCheck = null } = {}], narrow = false) => ({
  name: `contacts-${mode}${narrow ? '-narrow' : ''}`, kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    const surface = discoverSurface();
    if (surface.base && !existsSync(join(surface.tree, 'tests/fixtures/contacts.html'))) {
      rec.observe('merge-base surface', { present:false, reason:'the merge-base tree has no contacts fixture' });
      return;
    }
    if ((plain && !surface.plain) || (lines && !surface.lines)) {
      rec.observe('merge-base surface', { present:false, reason:'the merge-base fixture cannot reach this screen' });
      return;
    }
    const page = await openExtPage(ctx, `tests/fixtures/contacts.html?state=${frame}`);
    try {
      await page.send('Emulation.setDeviceMetricsOverride',{width:narrow?320:960,height:narrow?1100:760,deviceScaleFactor:1,mobile:false});
      if (!await waitFor(()=>evalIn(page, ready),{budgetMs:8000,pollMs:80})) throw new Error(`Contacts ${mode} did not render`);
      rec.check('contacts fit narrow and wide viewport', await evalIn(page,`document.documentElement.scrollWidth <= innerWidth`));
      if (narrow && narrowCheck) rec.check(narrowCheck[0], await evalIn(page, narrowCheck[1]));
      rec.check('frame sends only reads and the effect it draws', await evalIn(page, `JSON.stringify(window.__contactsFixtureCalls
        .filter(type => !${JSON.stringify(CONTACT_READS)}.includes(type))) === ${JSON.stringify(JSON.stringify(effects))}`));
      await rec.visualPage(`contacts-${mode}${narrow ? '-narrow' : ''}`, page);
    } finally { try { page.close(); } catch {} }
  },
});

// The page Discover's Try opens, in the real Settings shell. The starter
// fixture draws its section alone, so only this capture shows the title.
// why the tree's own label: the merge-base tree renders its own words.
const tryPage = {
  name: 'options-starter', kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    const page = await openWidePage(ctx, 'options/options.html#!/transfer?starter=csv-lab');
    try {
      const ready = await waitFor(() => evalIn(page, `[...document.querySelectorAll('.starter-review button')]
        .some(button => button.textContent === ${JSON.stringify(PHASE2 ? 'Add to Library' : 'Apply: add local copy')})`), {budgetMs:15000,pollMs:80});
      if (!ready) throw new Error('The starter page did not render');
      rec.check('the page Try opens is titled for what it does', await evalIn(page,
        `document.querySelector('.options-page > h2')?.textContent === ${JSON.stringify(PHASE2 ? 'Try an app' : 'Backup & restore')}`));
      if (NAMES) rec.check('the page names Tables and charts', await evalIn(page,
        `document.querySelector('.starter-review h3')?.textContent === 'Tables and charts'`));
      // why: the page is Try an app, not Backup & restore, and its buttons must not touch.
      if (discoverSurface().polish) {
        rec.check('the page says what the app does, and the Settings list marks no other page as this one', await evalIn(page, `(() => {
          const [add, library] = document.querySelectorAll('.starter-review > button');
          return document.querySelector('.starter-review h3 + p')?.textContent === 'Explore tables, numbers and a chart, all on your device.'
            && !document.querySelector('.options-nav-item.is-active, .options-nav-item[aria-current]')
            && !!add && !!library && library.getBoundingClientRect().left - add.getBoundingClientRect().right >= 7.5;
        })()`));
      }
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


// A packaged starter's own page in the real App runner, after its main button
// ran: plain words on the page, and the technical ones only behind Technical
// details. why a fixture probe: an older tree has no fixture for this page.
/** @param {'wasm-image'|'csv-lab'} key @param {string} status */
const starterAppState = (key, status) => ({
  name: `starter-app-${key}`, kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    const surface = discoverSurface();
    if (surface.base && !existsSync(join(surface.tree, 'tests/fixtures/starter-app.html'))) {
      rec.observe('merge-base surface', { present:false, reason:'the merge-base tree has no fixture for the page of a starter' });
      return;
    }
    const page = await openExtPage(ctx, `tests/fixtures/starter-app.html?starter=${key}`);
    try {
      await page.send('Emulation.setDeviceMetricsOverride',{width:960,height:key === 'csv-lab' ? 1180 : 760,deviceScaleFactor:1,mobile:false});
      const done = await waitFor(() => evalIn(page, `window.__starterApp?.pressed === true
        && window.__starterApp.status.startsWith(${JSON.stringify(status)})`), {budgetMs:15000,pollMs:80});
      rec.check(`the starter page ran and says so in plain words: ${status}`, !!done,
        JSON.stringify(await evalIn(page, 'window.__starterApp')));
      await rec.visualPage(`starter-app-${key}`, page);
    } finally { try { page.close(); } catch {} }
  },
});

const recentMissState = (narrow) => ({
  name: `discovery-recent-misses${narrow ? '-narrow' : ''}`, kind: 'visual', phase: 'post-unlock', responder: null,
  async run(ctx, rec) {
    const surface = discoverSurface();
    if (surface.base && !readFileSync(join(surface.tree, 'home/explore-order.js'), 'utf8').includes('recentRetrievalMiss')) {
      rec.observe('merge-base surface', { present: false, reason: 'Recent retrieval history was introduced on this branch' });
      return;
    }
    const page = await openExtPage(ctx, 'tests/fixtures/explore.html?state=recent-misses');
    try {
      await page.send('Emulation.setDeviceMetricsOverride', {width:narrow?320:960,height:narrow?1450:900,deviceScaleFactor:1,mobile:false});
      if (!await waitFor(() => evalIn(page, `${cards(3)} && [...document.querySelectorAll('button')].some(b => b.textContent === 'Surprise me' && !b.disabled)`), {budgetMs:8000,pollMs:50})) throw new Error('Discovery not ready');
      await clickSync(page, 'button', 'Surprise me');
      rec.check('recent misses explain retry without opening a suggestion', await evalIn(page, `${has('Recent attempts found no sharing peers.')} && !document.querySelector('.disc-page')`));
      rec.check('retry explanation fits viewport', await evalIn(page, 'document.documentElement.scrollWidth <= innerWidth'));
      await rec.visualPage(`discovery-recent-misses${narrow ? '-narrow' : ''}`, page);
      await clickSync(page, '.disc-tile-open', 'Field notes');
      rec.check('direct retry remains available', !!await waitFor(() => evalIn(page, `!!document.querySelector('.disc-page') && [...document.querySelectorAll('button')].some(b => b.textContent === 'Install and share' && !b.disabled)`), {budgetMs:4000,pollMs:50}));
      rec.check('selection and direct review perform no network fetch or install', await evalIn(page, `window.__exploreFixtureCalls.every(type => ${JSON.stringify(READS)}.includes(type))`));
    } finally { try { page.close(); } catch {} }
  },
});

export const STARTER_VISUAL_STATES = [
  recentMissState(false), recentMissState(true),
  ...[false, true].flatMap(narrow => ['home', 'review', 'empty', 'no-results', 'publisher', 'suggestion'].map(mode => keptState(mode, narrow))),
  ...FLOW_FRAMES.flatMap(row => [frameState(row), ...row[4]?.narrow ? [frameState(row, true)] : []]),
  ...CONTACT_FRAMES.flatMap(row => [contactsState(row), ...row[4]?.narrow ? [contactsState(row, true)] : []]),
  tryPage, starterAdded,
  starterAppState('wasm-image', 'Done. The picture is now black and white.'),
  starterAppState('csv-lab', 'The table has 5 rows and 3 columns.'),
];
