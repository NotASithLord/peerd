// @ts-check
import m from '/vendor/mithril/mithril.js';
import { transferProgress } from './discover-model.js';

/** @param {any} attempt */
export const transferLabel = (attempt) => {
  if (attempt?.phase === 'committing') return 'Almost done. It is too late to cancel.';
  if (attempt?.phase === 'cancelling') return 'Cancelling. Waiting for the install to stop…';
  if (!attempt || attempt.phase === 'unknown') return 'Starting…';
  const labels = /** @type {Record<string,string>} */ ({ locating: 'Looking for people who share this app…',
    connecting: 'Connecting to someone who shares this app…', manifest: 'Checking the app…', chunk: 'Downloading…', bytes: 'Downloading…',
    verifying: 'Checking the files…' });
  return labels[attempt.progress?.phase] ?? 'Starting…';
};

const LIVE = Object.freeze(['retrieving', 'committing', 'cancelling']);
const CANCEL_ISSUE = 'peerd could not cancel yet. Try again in a moment.';

/** @typedef {{address:string,kind:'address'|'install'|'update',appId?:string,send:(message:any)=>Promise<any>,
 *   onHost?:(live:boolean)=>void,onCancelled?:()=>void,quiet?:boolean}} Attrs */
/** @param {{attrs:Attrs}} vnode */
export const InstallTransfer = (vnode) => {
  // why the callbacks and quiet leave the target: a function in the message breaks runtime.sendMessage.
  const { send, onHost: _onHost, onCancelled: _onCancelled, quiet: _quiet, ...target } = vnode.attrs;
  let attrs = vnode.attrs;
  let dead = false; let busy = false; let revision = 0; let misses = 0;
  /** @type {any} */ let attempt = null;
  /** @type {boolean|undefined} */ let reported;
  let issue = '';
  // The attempt whose cancel the host confirmed. The host confirms a cancel
  // only before its commit, so when that attempt is gone it installed nothing.
  let cancelledId = '';
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  const redraw = () => { if (!dead) m.redraw(); };
  /** @param {boolean} next */
  const report = (next) => { if (next !== reported) { reported = next; attrs.onHost?.(next); } };
  // why three misses: one lost status read must not remove the bar and
  // Cancel of a download that still runs.
  const read = async () => {
    const epoch = revision;
    try {
      if (!busy) {
        const reply = await send({ type: 'dweb/base/install-status', ...target });
        if (reply?.ok !== true) throw new Error('no-status');
        if (!dead && epoch === revision) {
          misses = 0; attempt = reply.attempt ?? null; report(LIVE.includes(attempt?.phase));
          // why the id: a later attempt at this address is not the cancelled one.
          if (attempt && attempt.id !== cancelledId) cancelledId = '';
          if (cancelledId && !attempt) { cancelledId = ''; attrs.onCancelled?.(); }
        }
      }
    } catch {
      if (!dead && epoch === revision && ++misses >= 3) { attempt = null; report(false); }
    } finally {
      // why no slower read after a `false` report alone: the first read of a
      // new install often comes back before the host has made its attempt.
      if (!dead) { redraw(); timer = setTimeout(() => { void read(); }, attrs.quiet ? 3000 : 750); }
    }
  };
  const cancel = async () => {
    if (busy || attempt?.cancellable !== true || typeof attempt.id !== 'string') return;
    const id = attempt.id; busy = true; issue = ''; revision++; redraw();
    try {
      const reply = await send({ type: 'dweb/base/cancel-install', ...target, attemptId: id });
      if (dead) return;
      if (reply?.ok === true) { cancelledId = id; attempt = { ...attempt, phase: 'cancelling', cancellable: false }; }
      else if (reply?.phase === 'committing') attempt = { ...attempt, phase: 'committing', cancellable: false };
      else issue = CANCEL_ISSUE;
    } catch { if (!dead) issue = CANCEL_ISSUE; }
    finally { busy = false; redraw(); }
  };
  return {
    oninit() { void read(); },
    onremove() { dead = true; revision++; clearTimeout(timer); },
    /** @param {{attrs:Attrs}} v */
    view(v) {
      attrs = v.attrs;
      if (attrs.quiet) return null;
      const numbers = attempt?.phase === 'retrieving' ? transferProgress(attempt.progress) : null;
      // why 99 for the file check: it comes after the last piece, and a bar that leaves then comes back full looks broken.
      const percent = attempt?.phase === 'committing' ? 100
        : numbers?.percent ?? (attempt?.phase === 'retrieving' && attempt.progress?.phase === 'verifying' ? 99 : undefined);
      return m('.disc-transfer', [
        m('p.type-body-sm', { role: 'status', 'aria-live': 'polite' }, transferLabel(attempt)),
        percent === undefined ? null : m('.disc-progress', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent,
          'aria-label': attrs.kind === 'update' ? 'Update progress' : 'Install progress' },
        m('.disc-progress-fill', { style: { width: `${percent}%` } })),
        // why no role: a screen reader would speak each step.
        numbers ? m('p.type-small.disc-footnote', numbers.sizes ? `${numbers.percent}% · ${numbers.sizes}` : `${numbers.percent}%`) : null,
        attempt?.cancellable === true ? m('button.secondary.disc-btn', { type: 'button', disabled: busy,
          onclick: () => { void cancel(); } }, busy ? 'Cancelling…' : 'Cancel') : null,
        issue ? m('p.type-small', { role: 'status' }, issue) : null,
      ]);
    },
  };
};
