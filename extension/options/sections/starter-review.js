// @ts-check
import m from '/vendor/mithril/mithril.js';
import { packagedStarter, loadPackagedStarter } from '/shared/starter-catalog.js';
import { openHome } from '/shared/open-home.js';
import { isUnknownMutationOutcome } from '../mutation-custody.js';
/** @typedef {import('./reset-row.js').Send} Send */
// why these words: Discover's "Try" opens this page, so it says what the app
// is and does, and adds it in one step. peerd still checks the packaged files first.
// why Go to Library leads after an add: the app opens from there, and peerd
// cannot tell a second add from the first, so the line says what it makes.
export const StarterReview = () => {
  let dead = false, loading = true, busy = false, unknown = false, installed = false;
  let error = '';
  /** @type {any} */ let envelope = null;
  /** @param {Send} send */
  const apply = async send => {
    if (!envelope || busy || unknown || installed) return;
    busy = true; error = ''; m.redraw();
    try {
      const result = await send({ type: 'import/apply', envelope });
      if (result?.ok && result.kind === 'app' && typeof result.id === 'string' && result.id.length > 0) installed = true;
      else if (!result || result.ok !== false || isUnknownMutationOutcome(result)) unknown = true;
      else error = 'peerd could not add the app to your Library. Reload the page, then try again.';
    } catch { unknown = true; }
    finally {
      envelope = null; busy = false;
      if (!dead) m.redraw();
    }
  };
  return {
    /** @param {{attrs:{starter:unknown,send:Send}}} vnode */
    async oninit({ attrs: { starter, send } }) {
      try {
        const value = await loadPackagedStarter(starter);
        if (dead) return;
        const reply = await send({ type: 'import/inspect', envelope: value });
        if (!reply?.ok || reply.summary?.kind !== 'app') throw new Error('starter-inspection-failed');
        envelope = value;
      } catch { error = 'peerd could not check this app. Reload the page, then try again.'; }
      finally { loading = false; if (!dead) m.redraw(); }
    },
    onremove: () => { dead = true; },
    /** @param {{attrs:{starter:unknown,send:Send}}} vnode */
    view: ({ attrs: { starter, send } }) => m('section.starter-review', [
      m('h3', packagedStarter(starter)?.name ?? 'Unknown app'),
      packagedStarter(starter)?.description ? m('p.starter-review-what', packagedStarter(starter)?.description) : null,
      m('p', 'Comes with peerd. It runs on this device and needs no network.'),
      loading ? m('p', { role: 'status' }, 'Checking the app…') : null,
      error ? m('p', { role: 'alert' }, error) : null,
      unknown ? m('p', { role: 'status' }, 'peerd is not sure the app was added. Check your Library before you add it again.') : null,
      installed ? m('p', { role: 'status' }, 'Added to your Library. Open it from there. If you add it again, you get a second copy.') : null,
      envelope && !installed && !unknown ? m('button.secondary', { disabled: busy, onclick: () => apply(send) }, busy ? 'Adding…' : 'Add to Library') : null,
      m(installed ? 'button' : 'button.secondary', { onclick: () => openHome('library') }, 'Go to Library'),
    ]),
  };
};
