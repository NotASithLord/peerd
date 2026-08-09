// @ts-check
// DOM-walk pseudo-snapshot — REAL-DOM integration of the Firefox-parity
// fallback chain: domWalkInjected (the function chrome.scripting would
// serialize into a page) runs against THIS page's live DOM, its output
// feeds the pure serializer through the snapshot tool, and click/type
// resolve the resulting walk refs back to the same live elements.
//
// The scripting mock here doesn't fake results — it INVOKES the real
// injected function in this page, which is exactly what executeScript
// does to the target tab (same DOM semantics, same isolated-world
// globals). What it can't reproduce is the page/extension world split —
// fine, since the walk runs isolated-world anyway.

import { describe, it, expect } from '../../framework.js';
import { domWalkInjected, createRefRegistry } from '/peerd-runtime/index.js';
import { hasPasswordFieldInjected } from '/peerd-runtime/dom/walk-injected.js';
import { liveDocumentLocationInjected } from '/peerd-runtime/tools/defs/dom-helpers.js';
import { snapshotTool, clickTool, typeTool } from '/peerd-runtime/tools/defs/index.js';
import { clickInjected } from '/peerd-runtime/tools/defs/click.js';
import { TEST_TIME_ORIGIN } from '../../helpers/browser-scripting.js';

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */
/** Narrow a ToolResult to its ok-content (tests assert ok first). @param {ToolResult} r */
const contentOf = (r) => /** @type {import('/shared/tool-types.js').ToolResultOk} */ (r).content;
/** Narrow a ToolResult to its error string. @param {ToolResult} r */
const errorOf = (r) => /** @type {import('/shared/tool-types.js').ToolResultErr} */ (r).error;

/**
 * One pseudo-a11y node in the CDP getFullAXTree shape `serializeAxTree`
 * consumes (walk-injected.js docblock). The injected fn is ES5 with no
 * `@returns`, so type its output here — the test reads exactly these
 * fields, making this a drift detector for the walk node contract.
 * @typedef {object} WalkNode
 * @property {string} walkId
 * @property {{ value: string }} role
 * @property {{ value: any }} [name]
 * @property {{ value: any }} [value]
 * @property {{ name: string, value: { value: any } }[]} properties
 */

/** @param {ReturnType<typeof domWalkInjected>} out @returns {WalkNode[]} */
const walkNodes = (out) => /** @type {WalkNode[]} */ (/** @type {unknown} */ (out.nodes));

// A fixture corner of the test page: a small form with the roles the
// walk must classify. withFixture() removes it after each test.
// why type="button" on the hidden button: a bare <button> defaults to type=submit, and
// it sits inside this <form>. The click-tool test below targets it (nth:1), and
// clickInjected fires a native el.click() — a submit button would submit the form and
// NAVIGATE the test-runner page, reloading runner.html mid-suite so the result marker is
// never written (the in-browser run hangs at "Loading…" instead of failing cleanly).
const FIXTURE_HTML = `
  <h2>Pizza order</h2>
  <form aria-label="Order form">
    <label for="dw-name">Customer name</label>
    <input id="dw-name" type="text" value="">
    <input id="dw-news" type="checkbox" aria-label="Newsletter" checked>
    <select id="dw-size" aria-label="Size">
      <option>Small</option><option selected>Medium</option><option>Large</option>
    </select>
    <a id="dw-help" href="#help">Help</a>
    <button id="dw-send" type="button" disabled>Send order</button>
    <div id="dw-hidden-wrap" hidden><button type="button">Invisible</button></div>
    <input id="dw-secret" type="password" aria-label="Passphrase" value="hunter2">
  </form>`;

/** @param {(host: HTMLDivElement) => void | Promise<void>} fn */
const withFixture = async (fn) => {
  const host = document.createElement('div');
  host.id = 'dom-walk-fixture';
  host.innerHTML = FIXTURE_HTML;
  document.body.appendChild(host);
  try { await fn(host); }
  finally { host.remove(); }
};

// ctx whose scripting EXECUTES the injected function against this page —
// the executeScript contract, minus the world hop. The fixture supplies
// only the slots the DOM-walk fallback reads; cast to the full ToolContext.
const makeCtx = () => /** @type {ToolContext & { domRefs: ReturnType<typeof createRefRegistry> }} */ (
  /** @type {unknown} */ ({
    activeTab: { id: 1, url: 'https://example.test/order', origin: 'https://example.test' },
    tabs: {
      /** @param {number} id */
      get: async (id) => ({ id, url: 'https://example.test/order' }),
      query: async () => [{ id: 1, url: 'https://example.test/order' }],
    },
    scripting: {
      /** @param {{ func: (...a: any[]) => any, args?: any[] }} arg */
      executeScript: async ({ func, args }) => {
        const result = func(...(args ?? []));
        // The harness itself is served from loopback, while this fixture models
        // a public tab. Keep the live-location probe consistent with the mocked
        // tabs API without changing the real DOM behavior under test.
        if (func === liveDocumentLocationInjected) {
          return [{ documentId: 'fixture-document', result: {
            origin: 'https://example.test',
            href: 'https://example.test/order',
            timeOrigin: TEST_TIME_ORIGIN,
          } }];
        }
        if (func === hasPasswordFieldInjected) {
          return [{ documentId: 'fixture-document', result: {
            ...result,
            origin: 'https://example.test',
            href: 'https://example.test/order',
          } }];
        }
        return [{ documentId: 'fixture-document', result }];
      },
    },
    domRefs: createRefRegistry(),
    // no debuggerPool — the Firefox / advanced-automation-off shape
  })
);

describe('domWalkInjected — real DOM', () => {
  it('classifies roles, names, and state for the fixture form', async () => {
    await withFixture(() => {
      const out = domWalkInjected();
      expect(out.ok).toBe(true);
      /** @type {Map<any, WalkNode>} */
      const byName = new Map(walkNodes(out).map((n) => [n.name?.value, n]));
      // why: the test asserts each fixture node is present; `get` throwing
      // on a missing name surfaces the same failure a `.role` access on
      // undefined already would, just typed.
      /** @param {string} name @returns {WalkNode} */
      const node = (name) => {
        const n = byName.get(name);
        if (!n) throw new Error(`missing walk node: ${name}`);
        return n;
      };
      expect(node('Customer name').role.value).toBe('textbox');
      expect(node('Newsletter').role.value).toBe('checkbox');
      expect(node('Newsletter').properties.some((p) => p.name === 'checked' && p.value.value === true)).toBe(true);
      expect(node('Size').role.value).toBe('combobox');
      expect(/** @type {{ value: any }} */ (node('Size').value).value).toBe('Medium');
      expect(node('Help').role.value).toBe('link');
      expect(node('Send order').role.value).toBe('button');
      expect(node('Send order').properties.some((p) => p.name === 'disabled' && p.value.value === true)).toBe(true);
      expect(node('Pizza order').role.value).toBe('heading');
    });
  });

  it('skips hidden subtrees and masks password values', async () => {
    await withFixture(() => {
      const out = domWalkInjected();
      const names = walkNodes(out).map((n) => n.name?.value);
      expect(names.includes('Invisible')).toBe(false);
      const secret = walkNodes(out).find((n) => n.name?.value === 'Passphrase');
      expect(/** @type {{ value: any }} */ (/** @type {WalkNode} */ (secret).value).value).toBe('•••');
      expect(JSON.stringify(out.nodes).includes('hunter2')).toBe(false);
    });
  });

  it('keeps walkIds stable across re-walks of the same document', async () => {
    await withFixture(() => {
      const a = domWalkInjected();
      const b = domWalkInjected();
      /** @param {ReturnType<typeof domWalkInjected>} out @param {string} name */
      const idOf = (out, name) => walkNodes(out).find((n) => n.name?.value === name)?.walkId;
      expect(idOf(a, 'Send order')).toBe(idOf(b, 'Send order'));
      expect(idOf(a, 'Customer name')).toBe(idOf(b, 'Customer name'));
    });
  });
});

describe('snapshot → click/type over walk refs — full chain', () => {
  it('snapshot falls back to the walk, says so, and registers usable refs', async () => {
    await withFixture(async () => {
      const ctx = makeCtx();
      const r = await snapshotTool.execute({ budget: 30000 }, ctx);
      expect(r.ok).toBe(true);
      expect(contentOf(r)).toContain('pseudo-a11y');
      expect(contentOf(r)).toContain('button "Send order" [disabled]');
      expect(ctx.domRefs.size(1) > 0).toBe(true);
    });
  });

  it('click {ref} fires real handlers on the live element', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      let clicks = 0;
      const btn = /** @type {HTMLButtonElement} */ (host.querySelector('#dw-send'));
      btn.disabled = false;
      btn.addEventListener('click', () => { clicks += 1; });
      const snap = await snapshotTool.execute({ budget: 30000 }, ctx);
      const ref = /(@e\d+) button "Send order"/.exec(contentOf(snap))?.[1];
      expect(typeof ref).toBe('string');
      const r = await clickTool.execute({ ref }, ctx);
      expect(r.ok).toBe(true);
      expect(contentOf(r)).toContain('"via": "dom-walk"');
      // matchedCount rides the walk-ref success shape too — a resolved walk
      // ref is exactly one element (issue #36 contract consistency).
      expect(contentOf(r)).toContain('"matchedCount": 1');
      expect(clicks > 0).toBe(true);
    });
  });

  it('click {ref, expectedCount≠1} fails matched_count_mismatch BEFORE clicking', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      let clicks = 0;
      const btn = /** @type {HTMLButtonElement} */ (host.querySelector('#dw-send'));
      btn.disabled = false;
      btn.addEventListener('click', () => { clicks += 1; });
      const snap = await snapshotTool.execute({ budget: 30000 }, ctx);
      const ref = /(@e\d+) button "Send order"/.exec(contentOf(snap))?.[1];
      // A walk ref names exactly one element — expecting 2 is a planning
      // contradiction the guard must catch deterministically, pre-action.
      const r = await clickTool.execute({ ref, expectedCount: 2 }, ctx);
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toContain('matched_count_mismatch');
      expect(errorOf(r)).toContain('matched 1 element(s), expected 2');
      expect(clicks).toBe(0);
    });
  });

  it('click {selector, expectedCount} reports the real matchedCount on success', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      let clicks = 0;
      for (const btn of host.querySelectorAll('button')) {
        /** @type {HTMLButtonElement} */ (btn).disabled = false;
        btn.addEventListener('click', () => { clicks += 1; });
      }
      const r = await clickTool.execute({ selector: '#dom-walk-fixture button', expectedCount: 2, nth: 1 }, ctx);
      expect(r.ok).toBe(true);
      expect(contentOf(r)).toContain('"matchedCount": 2');
      expect(contentOf(r)).toContain('"nth": 1');
      // why >0, not ===1: clickInjected deliberately dispatches a synthetic click event
      // AND calls native el.click() (so it activates both framework listeners and native
      // behaviour), so a plain addEventListener('click') counter fires more than once per
      // tool-click. The test only needs to confirm the nth:1 element actually received the
      // click — not pin the dispatch count.
      expect(clicks).toBeGreaterThan(0);
    });
  });

  it('type {ref} sets the value and fires input events', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      const field = /** @type {HTMLInputElement} */ (host.querySelector('#dw-name'));
      let inputs = 0;
      field.addEventListener('input', () => { inputs += 1; });
      const snap = await snapshotTool.execute({ budget: 30000 }, ctx);
      const ref = /(@e\d+) textbox "Customer name"/.exec(contentOf(snap))?.[1];
      expect(typeof ref).toBe('string');
      const r = await typeTool.execute({ ref, text: 'Ada Lovelace' }, ctx);
      expect(r.ok).toBe(true);
      // matchedCount rides the walk-ref success shape too (issue #36).
      expect(contentOf(r)).toContain('"matchedCount": 1');
      expect(field.value).toBe('Ada Lovelace');
      expect(inputs).toBe(1);
    });
  });

  it('allows same-origin form submission through type {submit:true}', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      const form = /** @type {HTMLFormElement} */ (host.querySelector('form'));
      const field = /** @type {HTMLInputElement} */ (host.querySelector('#dw-name'));
      // The fixture form's empty action resolves to this document, which is the
      // exact same-origin case the guard must leave alone. Prevent navigation so
      // a successful native requestSubmit remains observable inside the runner.
      let submits = 0;
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submits += 1;
      });
      const r = await typeTool.execute({ selector: '#dw-name', text: 'same origin', submit: true }, ctx);
      expect(r.ok).toBe(true);
      expect(field.value).toBe('same origin');
      expect(submits).toBeGreaterThan(0);
    });
  });

  it('blocks a cross-origin submit click before focus, click, or submission', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      const form = /** @type {HTMLFormElement} */ (host.querySelector('form'));
      const button = /** @type {HTMLButtonElement} */ (host.querySelector('#dw-send'));
      form.action = 'https://collector.invalid/receive';
      button.type = 'submit';
      button.disabled = false;
      let focuses = 0;
      let clicks = 0;
      let submits = 0;
      button.addEventListener('focus', () => { focuses += 1; });
      button.addEventListener('click', () => { clicks += 1; });
      form.addEventListener('submit', (event) => {
        // Safety net for a regressed guard: fail the assertions without
        // navigating the in-browser test runner away.
        event.preventDefault();
        submits += 1;
      });

      const r = await clickTool.execute({ selector: '#dw-send' }, ctx);
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toBe('cross_origin_form_submission_blocked');
      expect(focuses).toBe(0);
      expect(clicks).toBe(0);
      expect(submits).toBe(0);
    });
  });

  it('honors a submitter formaction override when a descendant is clicked', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      const form = /** @type {HTMLFormElement} */ (host.querySelector('form'));
      const button = /** @type {HTMLButtonElement} */ (host.querySelector('#dw-send'));
      form.action = location.href;
      button.type = 'submit';
      button.disabled = false;
      button.setAttribute('formaction', 'https://collector.invalid/override');
      button.innerHTML = '<span id="dw-send-label">Send order</span>';
      let clicks = 0;
      let submits = 0;
      button.addEventListener('click', () => { clicks += 1; });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submits += 1;
      });

      const r = await clickTool.execute({ selector: '#dw-send-label' }, ctx);
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toBe('cross_origin_form_submission_blocked');
      expect(clicks).toBe(0);
      expect(submits).toBe(0);
    });
  });

  it('blocks cross-origin submission activated through a label', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      const form = /** @type {HTMLFormElement} */ (host.querySelector('form'));
      const button = /** @type {HTMLButtonElement} */ (host.querySelector('#dw-send'));
      form.action = 'https://collector.invalid/receive';
      button.type = 'submit';
      button.disabled = false;
      const label = document.createElement('label');
      label.htmlFor = button.id;
      label.id = 'dw-send-label-control';
      label.textContent = 'Submit through label';
      form.appendChild(label);
      let clicks = 0;
      let submits = 0;
      button.addEventListener('click', () => { clicks += 1; });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submits += 1;
      });

      const r = await clickTool.execute({ selector: '#dw-send-label-control' }, ctx);
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toBe('cross_origin_form_submission_blocked');
      expect(clicks).toBe(0);
      expect(submits).toBe(0);
    });
  });

  it('blocks a label nested inside a cross-origin submit button', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      const form = /** @type {HTMLFormElement} */ (host.querySelector('form'));
      const button = /** @type {HTMLButtonElement} */ (host.querySelector('#dw-send'));
      form.action = 'https://collector.invalid/receive';
      button.type = 'submit';
      button.disabled = false;
      button.innerHTML = '<label id="dw-nested-submit-label">Send order</label>';
      let submits = 0;
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submits += 1;
      });

      const r = await clickTool.execute({ selector: '#dw-nested-submit-label' }, ctx);
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toBe('cross_origin_form_submission_blocked');
      expect(submits).toBe(0);
    });
  });

  it('is not bypassed by a form control named action', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      const form = /** @type {HTMLFormElement} */ (host.querySelector('form'));
      const button = /** @type {HTMLButtonElement} */ (host.querySelector('#dw-send'));
      form.setAttribute('action', 'https://collector.invalid/receive');
      button.type = 'submit';
      button.disabled = false;
      const clobber = document.createElement('input');
      clobber.name = 'action';
      form.appendChild(clobber);
      expect(form.action === /** @type {unknown} */ (clobber)).toBe(true);

      const r = await clickTool.execute({ selector: '#dw-send' }, ctx);
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toBe('cross_origin_form_submission_blocked');
    });
  });

  it('pins the confirmed login exception to the exact live action origin', async () => {
    await withFixture((host) => {
      const form = /** @type {HTMLFormElement} */ (host.querySelector('form'));
      const button = /** @type {HTMLButtonElement} */ (host.querySelector('#dw-send'));
      button.type = 'submit';
      button.disabled = false;
      form.addEventListener('submit', (event) => { event.preventDefault(); });
      form.action = 'https://accounts.example/start';
      const allowed = clickInjected('#dw-send', 0, null, 1, 'https://accounts.example');
      expect(allowed.ok).toBe(true);

      form.action = 'https://collector.invalid/receive';
      const refused = clickInjected('#dw-send', 0, null, 1, 'https://accounts.example');
      expect(refused.ok).toBe(false);
      expect(refused.error).toBe('cross_origin_form_submission_blocked');
    });
  });

  it('blocks cross-origin type submission before value, focus, or input events', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      const form = /** @type {HTMLFormElement} */ (host.querySelector('form'));
      const field = /** @type {HTMLInputElement} */ (host.querySelector('#dw-name'));
      form.action = 'https://collector.invalid/receive';
      field.value = 'unchanged';
      let focuses = 0;
      let inputs = 0;
      let changes = 0;
      let keys = 0;
      let submits = 0;
      field.addEventListener('focus', () => { focuses += 1; });
      field.addEventListener('input', () => { inputs += 1; });
      field.addEventListener('change', () => { changes += 1; });
      field.addEventListener('keydown', () => { keys += 1; });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submits += 1;
      });

      const r = await typeTool.execute({ selector: '#dw-name', text: 'scraped secret', submit: true }, ctx);
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toBe('cross_origin_form_submission_blocked');
      expect(field.value).toBe('unchanged');
      expect(focuses).toBe(0);
      expect(inputs).toBe(0);
      expect(changes).toBe(0);
      expect(keys).toBe(0);
      expect(submits).toBe(0);
    });
  });

  it('a removed element makes its walk ref STALE, not a mis-click', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      const snap = await snapshotTool.execute({ budget: 30000 }, ctx);
      const ref = /(@e\d+) button "Send order"/.exec(contentOf(snap))?.[1];
      /** @type {Element} */ (host.querySelector('#dw-send')).remove();
      const r = await clickTool.execute({ ref }, ctx);
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toContain('stale_ref');
    });
  });

  it('snapshot diff works across two walk captures (walkId identity)', async () => {
    await withFixture(async (host) => {
      const ctx = makeCtx();
      await snapshotTool.execute({ budget: 30000 }, ctx);
      /** @type {HTMLButtonElement} */ (host.querySelector('#dw-send')).disabled = false;   // changed
      /** @type {Element} */ (host.querySelector('#dw-help')).remove();           // removed
      const r = await snapshotTool.execute({ diff: true, budget: 30000 }, ctx);
      expect(r.ok).toBe(true);
      expect(contentOf(r)).toContain('~ ');                 // Send changed state
      expect(contentOf(r)).toContain('- link "Help"');
    });
  });
});

// The password-field signal (issue 251) — the ONE bit the walk reports to the
// origin classifier, and the only input to "does the user have an account here"
// that the DOM can supply. Both entry points are covered because they are
// separate ES5 copies by necessity (an injected body closes over nothing), so
// they can drift apart silently.
//
// The load-bearing case is `new-password`. Measured on the live web, the Stack
// Exchange network ships a hidden SIGNUP modal on every page; treating that as
// "you have an account here" locked a roaming helper out of stackoverflow.com
// after a single ordinary read, permanently and invisibly.
describe('dom walk — the password-field signal', () => {
  /**
   * A fixture with NO password field of its own, so each test controls exactly
   * what is in the document. why its own helper: the shared FIXTURE_HTML above
   * carries `#dw-secret`, which would make every case below trivially true.
   * @param {string} html
   * @param {(host: HTMLElement) => Promise<void> | void} fn
   */
  const withInputs = async (html, fn) => {
    const host = document.createElement('div');
    host.id = 'pw-signal-fixture';
    host.innerHTML = html;
    document.body.appendChild(host);
    try { await fn(host); }
    finally { host.remove(); }
  };

  it('no password field anywhere: both entry points say false', async () => {
    await withInputs('<input type="text" name="q">', () => {
      expect(domWalkInjected().hasPasswordField).toBe(false);
      expect(hasPasswordFieldInjected().has).toBe(false);
    });
  });

  it('a bare password field marks the origin', async () => {
    await withInputs('<input type="password" name="pass">', () => {
      expect(domWalkInjected().hasPasswordField).toBe(true);
      expect(hasPasswordFieldInjected().has).toBe(true);
    });
  });

  it('autocomplete="current-password" marks the origin — that IS a sign-in box', async () => {
    await withInputs('<input type="password" autocomplete="current-password">', () => {
      expect(domWalkInjected().hasPasswordField).toBe(true);
      expect(hasPasswordFieldInjected().has).toBe(true);
    });
  });

  it('a HIDDEN sign-in box still marks the origin (the deliberate case)', async () => {
    // why this test exists: the obvious fix for the signup false positive is to
    // skip fields that are not rendered, and it would break this — a login modal
    // behind a button is hidden AND is a real signal. It is the reason the signal
    // reads the document rather than the walk.
    await withInputs('<div style="display:none"><input type="password" autocomplete="current-password"></div>', () => {
      expect(domWalkInjected().hasPasswordField).toBe(true);
      expect(hasPasswordFieldInjected().has).toBe(true);
    });
  });

  it('autocomplete="new-password" ALONE does NOT mark the origin — it is a signup form', async () => {
    // The shipped Stack Exchange shape, reduced: a hidden signup modal whose
    // password field is for CREATING an account the user does not have.
    await withInputs(
      '<form action="/users/signup" style="visibility:hidden">'
      + '<input type="email" name="email">'
      + '<input type="password" name="password" autocomplete="new-password">'
      + '</form>',
      () => {
        expect(domWalkInjected().hasPasswordField).toBe(false);
        expect(hasPasswordFieldInjected().has).toBe(false);
      },
    );
  });

  it('an identifier sibling does NOT rescue a signup form', async () => {
    // why called out: requiring the password field to sit in a form that also has
    // an identifier input was the mitigation origin-sensitivity.js weighed and did
    // not take. It would NOT have fixed this — the signup form has an email field.
    await withInputs(
      '<form><input type="text" name="email"><input type="password" autocomplete="new-password"></form>',
      () => {
        expect(domWalkInjected().hasPasswordField).toBe(false);
      },
    );
  });

  it('a signup form ALONGSIDE a sign-in box still marks the origin', async () => {
    await withInputs(
      '<input type="password" autocomplete="new-password">'
      + '<input type="password" autocomplete="current-password">',
      () => {
        expect(domWalkInjected().hasPasswordField).toBe(true);
        expect(hasPasswordFieldInjected().has).toBe(true);
      },
    );
  });

  it('the token is matched case-insensitively', async () => {
    await withInputs('<input type="password" autocomplete="NEW-PASSWORD">', () => {
      expect(domWalkInjected().hasPasswordField).toBe(false);
      expect(hasPasswordFieldInjected().has).toBe(false);
    });
  });
});

// ── attribution (issue 278) ─────────────────────────────────────────────────
// The caller resolves the tab BEFORE injecting, so `tab.url` is a snapshot; the
// probe runs later, in whatever document is committed by then. Without the probe
// saying where it ran, a page that navigates inside that window gets its password
// field credited to the origin the caller started on — which lets a hostile page
// mark arbitrary third parties as "the user has an account here", and, repeated,
// fill the 500-entry cap so nothing further is ever learned.
describe('peerd-runtime.dom-walk · the probe reports where it ran', () => {
  it('hasPasswordFieldInjected returns the observing origin alongside the boolean', () => {
    const r = hasPasswordFieldInjected();
    expect(typeof r).toBe('object');
    expect(typeof r.has).toBe('boolean');
    // In the test page this is the extension origin; what matters is that it is
    // the DOCUMENT's own origin, not anything the caller passed in.
    expect(r.origin).toBe(location.origin);
  });

  it('the full walk reports it too — the dom-walk path races identically', () => {
    const walk = domWalkInjected();
    expect(walk.probeOrigin).toBe(location.origin);
  });
});
