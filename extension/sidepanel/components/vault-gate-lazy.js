// @ts-check
// Rich unlocked surfaces need the gate only after lock; first paint owns its own gate.
import m from '/vendor/mithril/mithril.js';

/** @type {any} */ let gate = null;
let loading = false;
let failed = false;
const load = () => {
  if (gate || loading) return;
  loading = true;
  failed = false;
  import('./vault-gate.js').then(module => { gate = module.VaultGate; })
    .catch(() => { failed = true; })
    .finally(() => { loading = false; m.redraw(); });
};
export const VaultGate = {
  /** @param {{attrs:any}} vnode */
  view({ attrs }) {
    if (gate) return m(gate, attrs);
    if (!failed) load();
    return failed ? m('button', { type: 'button', onclick: load }, 'Retry loading vault controls')
      : m('p', { role: 'status' }, 'Vault locked. Loading unlock controls…');
  },
};
