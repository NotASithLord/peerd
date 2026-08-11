// @ts-check
// vm-tab/firefox-webvm-note.js — the Firefox "WebVM can't run here yet" notice.
//
// why: WebVM (CheerpX) needs SharedArrayBuffer, which the browser grants only to
// a cross-origin-ISOLATED page. Firefox doesn't honor COOP/COEP as manifest keys,
// so an extension page can't isolate itself there — a Firefox PLATFORM limitation,
// not a peerd bug (packaging/gen-manifest.ts already strips the dead keys from the
// Firefox manifest). Rather than fail the boot with a misleading "manifest must
// declare…" error, Firefox users get a clear explanation and the two open threads
// to push on, so the fix gets weight.
//
// why a module (not inline in the page): vm-tab.js is otherwise an untestable
// page script, and CI runs Chrome (where isolation is on), so this exact path is
// never reached by the e2e harness. Keeping the notice a PURE DOM builder lets an
// in-browser test pin the message and — the load-bearing part — that both links
// resolve to the real bug + standards issue.

export const FIREFOX_WEBVM_BUG = 'https://bugzilla.mozilla.org/show_bug.cgi?id=1673477';
export const WECG_COI_ISSUE = 'https://github.com/w3c/webextensions/issues/1039';

/**
 * Build the Firefox WebVM-unavailable notice element.
 * @param {{ bugUrl?: string, wecgUrl?: string, doc?: Document }} [opts]
 * @returns {HTMLElement}
 */
export const buildFirefoxWebVmNote = ({ bugUrl = FIREFOX_WEBVM_BUG, wecgUrl = WECG_COI_ISSUE, doc = document } = {}) => {
  const note = doc.createElement('div');
  note.className = 'boot-firefox-note';

  const lead = doc.createElement('p');
  lead.className = 'ffx-lead';
  lead.textContent = 'WebVM can’t run in Firefox yet';

  const body = doc.createElement('p');
  body.textContent = 'The Linux VM (CheerpX) needs SharedArrayBuffer, which browsers grant '
    + 'only to cross-origin-isolated pages. Firefox doesn’t let an extension page isolate '
    + 'itself, so the VM can’t start here. This is a Firefox platform limitation, not a peerd '
    + 'bug — everything else works, and WebVM runs today in the Chrome build.';

  const cta = doc.createElement('p');
  cta.className = 'ffx-cta';
  cta.textContent = 'Want it fixed? Add your voice on the open threads:';

  const list = doc.createElement('ul');
  list.className = 'ffx-links';
  for (const [label, href] of [
    ['Firefox bug 1673477 — Bugzilla', bugUrl],
    ['WECG issue 1039 — cross-browser proposal', wecgUrl],
  ]) {
    const li = doc.createElement('li');
    const a = doc.createElement('a');
    a.href = href;
    a.textContent = label;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.appendChild(a);
    list.appendChild(li);
  }

  note.append(lead, body, cta, list);
  return note;
};
