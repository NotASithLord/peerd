// @ts-check
import m from '/vendor/mithril/mithril.js';

/** @param {any} attempt */
export const transferLabel = (attempt) => {
  if (attempt?.phase === 'committing') return 'Finishing installation. It is too late to cancel.';
  if (attempt?.phase === 'cancelling') return 'Cancelling. Waiting for the install to stop…';
  if (attempt?.phase === 'unknown') return 'The install outcome is not confirmed. Check your Library before trying again.';
  const progress = attempt?.progress;
  if (progress?.phase === 'chunk') return Number.isSafeInteger(progress.done) && Number.isSafeInteger(progress.total)
      && progress.done >= 0 && progress.total > 0 && progress.done <= progress.total
    ? `Downloading and checking files: ${progress.done} of ${progress.total} pieces.` : 'Downloading and checking files…';
  const labels = /** @type {Record<string,string>} */ ({ locating: 'Looking for people who share this app…', connecting: 'Connecting to a sharing peer…',
    manifest: 'Checking the signed app description…', verifying: 'Verifying the app files…' });
  return labels[progress?.phase]
    ?? 'Waiting for install status…';
};

/** @typedef {{address:string,kind:'address'|'install'|'update',appId?:string,send:(message:any)=>Promise<any>}} Attrs */
/** @param {{attrs:Attrs}} vnode */
export const InstallTransfer = (vnode) => {
  const { send, ...target } = vnode.attrs;
  let dead = false; let busy = false; let revision = 0;
  /** @type {any} */ let attempt = null;
  let issue = '';
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  const redraw = () => { if (!dead) m.redraw(); };
  const read = async () => {
    const epoch = revision;
    try {
      if (!busy) {
        const reply = await send({ type: 'dweb/base/install-status', ...target });
        if (!dead && epoch === revision) attempt = reply?.ok === true ? reply.attempt : null;
      }
    } catch { if (!dead && epoch === revision) attempt = null; }
    finally {
      if (!dead) { redraw(); timer = setTimeout(() => { void read(); }, 750); }
    }
  };
  const cancel = async () => {
    if (busy || attempt?.cancellable !== true || typeof attempt.id !== 'string') return;
    const id = attempt.id; busy = true; issue = ''; revision++; redraw();
    try {
      const reply = await send({ type: 'dweb/base/cancel-install', ...target, attemptId: id });
      if (dead) return;
      if (reply?.ok === true) attempt = { ...attempt, phase: 'cancelling', cancellable: false };
      else if (reply?.phase === 'committing') attempt = { ...attempt, phase: 'committing', cancellable: false };
      else issue = 'Cancellation was not confirmed. Wait for the install status before trying again.';
    } catch { if (!dead) issue = 'Cancellation was not confirmed. Wait for the install status before trying again.'; }
    finally { busy = false; redraw(); }
  };
  return {
    oninit() { void read(); },
    onremove() { dead = true; revision++; clearTimeout(timer); },
    view() {
      return m('.disc-transfer', [
        m('p.type-body-sm', { role: 'status', 'aria-live': 'polite' }, transferLabel(attempt)),
        attempt?.cancellable === true ? m('button.secondary.disc-btn', { type: 'button', disabled: busy,
          onclick: () => { void cancel(); } }, busy ? 'Cancelling…' : 'Cancel') : null,
        issue ? m('p.type-small', { role: 'status' }, issue) : null,
      ]);
    },
  };
};
