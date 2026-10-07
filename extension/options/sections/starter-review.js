// @ts-check
import m from '/vendor/mithril/mithril.js';
import { packagedStarter, loadPackagedStarter } from '/shared/starter-catalog.js';
import { openHome } from '/shared/open-home.js';
import { isUnknownMutationOutcome, unknownMutationCopy } from '../mutation-custody.js';
/** @typedef {import('./reset-row.js').Send} Send */
export const StarterReview = () => {
  let dead = false, loading = true, busy = false, unknown = false, installed = false;
  let error = '';
  /** @type {any} */ let envelope = null;
  /** @type {any} */ let summary = null;
  /** @param {Send} send */
  const apply = async send => {
    if (!envelope || busy || unknown || installed) return;
    busy = true; error = ''; m.redraw();
    try {
      const result = await send({ type: 'import/apply', envelope });
      if (result?.ok && result.kind === 'app' && typeof result.id === 'string' && result.id.length > 0) installed = true;
      else if (!result || result.ok !== false || isUnknownMutationOutcome(result)) unknown = true;
      else error = 'The starter was not added. Review the import again before another attempt.';
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
        if (!reply?.ok || reply.summary?.kind !== 'app') throw new Error('The packaged App could not be verified.');
        envelope = value; summary = reply.summary;
      } catch (cause) { error = /** @type {Error} */ (cause).message; }
      finally { loading = false; if (!dead) m.redraw(); }
    },
    onremove: () => { dead = true; },
    /** @param {{attrs:{starter:unknown,send:Send}}} vnode */
    view: ({ attrs: { starter, send } }) => m('section.starter-review', [
      m('h3', packagedStarter(starter)?.name ?? 'Unknown starter'),
      m('p', 'Included with Peerd. This packaged example has no peer publisher and does not depend on another peer being online.'),
      m('p', 'Apply creates a new local copy in your Library. It does not enable networking, share the App, or run it.'),
      loading ? m('p', { role: 'status' }, 'Inspecting packaged App…') : null,
      summary ? m('p', `${summary.fileCount} ${summary.fileCount === 1 ? 'file' : 'files'}; ${summary.size} bundle bytes.`) : null,
      error ? m('p', { role: 'alert' }, error) : null,
      unknown ? m('p', { role: 'alert' }, `${unknownMutationCopy('adding the starter')} Check your Library before reviewing another copy.`) : null,
      installed ? m('p', { role: 'status' }, 'Local copy added. Open it from your Library when you are ready.') : null,
      envelope && !installed && !unknown ? m('button', { disabled: busy, onclick: () => apply(send) }, busy ? 'Adding…' : 'Apply: add local copy') : null,
      m('button.secondary', { onclick: () => openHome('library') }, 'View in Library'),
    ]),
  };
};
