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
import { snapshotTool, clickTool, typeTool } from '/peerd-runtime/tools/defs/index.js';

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
      executeScript: async ({ func, args }) => [{ result: func(...(args ?? [])) }],
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
      expect(clicks > 0).toBe(true);
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
      expect(field.value).toBe('Ada Lovelace');
      expect(inputs).toBe(1);
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
