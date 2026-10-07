// @ts-check
import m from '/vendor/mithril/mithril.js';
import { packagedStarter, starterKeys } from '/shared/starter-catalog.js';
import { openOptions } from '/shared/open-options.js';
import { loadDweb } from '/shared/dweb-loader.js';
/** @typedef {import('./library-section.js').Send} Send */
export const StarterSection = () => {
  let dead = false, busy = false, loading = true, unknown = false, error = '';
  /** @type {string|null} */ let commonsId = null;
  /** @param {Send} send */
  const catalog = async send => {
    const reply = await send({ type: 'apps/list' });
    if (!reply?.ok || !Array.isArray(reply.apps)) throw new Error('Could not read the Library.');
    commonsId = reply.apps.find((/** @type {any} */ app) => app.dweb?.seed === 'commons')?.id ?? null;
  };
  /** @param {Send} send */
  const addCommons = async send => {
    if (busy || unknown || loading || commonsId) return;
    busy = true; error = ''; m.redraw();
    try {
      const client = await loadDweb();
      if (!client.loadSeedApp) throw new Error('Commons is unavailable in this build.');
      const seed = await client.loadSeedApp({ fetchText: async path => {
        // The seed loader selects only our own packaged extension asset.
        // eslint-disable-next-line no-restricted-globals
        const response = await fetch(path);
        if (!response.ok) throw new Error('Could not load packaged Commons.');
        return response.text();
      } });
      unknown = true;
      const reply = await send({ type: 'dweb/open-commons', seed });
      if (reply?.ok) { unknown = false; await catalog(send); }
      else error = 'Could not confirm whether Commons was added or opened. Check your Library and tabs before trying again.';
    } catch (cause) { error = /** @type {Error} */ (cause).message; }
    finally { busy = false; if (!dead) m.redraw(); }
  };
  return {
    /** @param {{attrs:{send:Send}}} vnode */
    oninit: ({ attrs: { send } }) => { catalog(send).catch(cause => { error = cause.message; }).finally(() => { loading = false; if (!dead) m.redraw(); }); },
    onremove: () => { dead = true; },
    /** @param {{attrs:{send:Send,enabled:boolean}}} vnode */
    view: ({ attrs: { send, enabled } }) => m('section.card', { style: 'margin:16px;padding:16px;overflow-wrap:anywhere;' }, [
      m('h2', 'Included with Peerd'),
      m('p', 'Start with a packaged example, even with the peer network off. Review it in Settings, add a local copy, then open it from your Library. Nothing runs or is shared automatically.'),
      starterKeys.map(key => { const starter = packagedStarter(key); return m('article', { key, style: 'margin:18px 0;' }, [
        m('h3', starter?.name), m('p', starter?.description), m('p.muted', starter?.runtime),
        m('button.secondary', { onclick: () => openOptions(`transfer?starter=${key}`) }, 'Review starter'),
      ]); }),
      m('article', [m('h3', 'Peerd-to-Peerd Commons'),
        m('p', 'Packaged peer chat. Enable the peer network above to add and open Commons. Joining a room is a separate action inside the App.'),
        commonsId ? m('button.secondary', { disabled: busy, onclick: async () => {
          busy = true; try { if (!(await send({ type: 'apps/open', appId: commonsId }))?.ok) error = 'Could not open Commons.'; }
          catch { error = 'Could not confirm whether Commons opened. Check your tabs.'; }
          finally { busy = false; if (!dead) m.redraw(); }
        } }, 'Open Commons') : m('button.secondary', { disabled: !enabled || busy || loading || unknown, onclick: () => addCommons(send) }, busy ? 'Opening…' : 'Add and open Commons'),
      ]),
      error ? m('p', { role: 'alert' }, error) : null,
    ]),
  };
};
