// @ts-check
// Context → Denylist tab — component tests over a fake SW send().
//
// Renders the real Mithril editor against a fixture overlay and asserts
// (a) the search box narrows live with an honest n-of-N count, (b) every
// remove/disable is two-step — the confirm states the consequence and
// NOTHING dispatches until the verb is clicked, (c) provenance renders
// honestly — seed rows offer Disable (reversible), user rows offer
// Remove, and (d) cancel disarms without dispatching. No SW, no
// storage: `send` is the seam (same shape as hooks-view.test.js).

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { DenylistView } from '/sidepanel/components/denylist-view.js';

/** @typedef {{ type: string } & Record<string, any>} Msg */
/** @typedef {Record<string, (msg: Msg) => any>} Overrides */
/** @typedef {((msg: Msg) => Promise<any>) & { calls: Msg[] }} FakeSend */

// Effective = (seed − disabled) ∪ added: two seed patterns survive,
// one user pattern rides on top, one seed pattern is disabled.
const FIXTURE = {
  patterns: ['chase.com', '*.chase.com', 'evil.example'],
  added: ['evil.example'],
  disabled: ['*.fidelity.com'],
};

// Fake one-shot send(): records every message, answers denylist/list
// with the fixture (cloned so component-side state can't bleed between
// tests), and lets a test override any route's reply.
/** @param {Overrides} [overrides] */
const makeSend = (overrides = {}) => {
  /** @type {Msg[]} */
  const calls = [];
  /** @type {FakeSend} */
  const send = Object.assign(
    /** @param {Msg} msg */
    async (msg) => {
      calls.push(msg);
      const override = overrides[msg.type];
      if (override) return override(msg);
      if (msg.type === 'denylist/list') return { ok: true, ...structuredClone(FIXTURE) };
      return { ok: true };
    },
    { calls },
  );
  return send;
};

// Query that asserts presence — a null here is a real test failure
// (same as the old direct .click()/.value access on a missing node).
/**
 * @template {HTMLElement} [T=HTMLElement]
 * @param {ParentNode} root
 * @param {string} sel
 * @param {new () => T} [_ctor] element constructor — drives the return type
 *   (e.g. `HTMLInputElement` so `.value`/`.disabled` are visible)
 * @returns {T}
 */
const need = (root, sel, _ctor) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return /** @type {T} */ (el);
};

// Find a <button> by its exact text within a scope; throws if absent so
// `.click()` mirrors the old `.find(...).click()` (TypeError on missing).
/**
 * @param {ParentNode} scope
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
const button = (scope, text) => {
  const el = [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!el) throw new Error(`missing button: ${text}`);
  return el;
};

// Let the component's async oninit fetch settle, then force a sync
// redraw so assertions see the final DOM without racing the rAF-based
// auto-redraw.
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  m.redraw.sync();
};

/**
 * @param {FakeSend} send
 * @param {{ onChanged?: () => void }} [attrs]
 */
const mountView = async (send, attrs = {}) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(DenylistView, { send, ...attrs }) });
  await flush();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

/**
 * @param {ParentNode} root
 * @param {string} value
 */
const setSearch = async (root, value) => {
  const box = need(root, '.denylist-search-input', HTMLInputElement);
  box.value = value;
  box.dispatchEvent(new Event('input'));
  await flush();
};

/** @param {ParentNode} root */
// Enforced chips live inside their category group; the disabled section keeps
// its own grid. Both are chips, so the helper spans both containers.
const chipTexts = (root) =>
  [...root.querySelectorAll('.denylist-group-body code.denylist-item, .denylist-grid code.denylist-item')]
    .map((c) => c.textContent);

describe('sidepanel.denylist-view', () => {
  describe('rendering', () => {
    it('renders enforced + disabled patterns with honest provenance affordances', async () => {
      const { root, unmount } = await mountView(makeSend());
      try {
        expect(chipTexts(root)).toEqual(
          ['chase.com', '*.chase.com', 'evil.example', '*.fidelity.com']);
        // User chip is visually tagged; the disabled seed is struck out.
        expect(need(root, '.denylist-item.is-user').textContent).toBe('evil.example');
        expect(need(root, '.denylist-item.is-disabled').textContent).toBe('*.fidelity.com');
        // Seed rows arm a DISABLE; the user row arms a REMOVE.
        expect(root.querySelector('button[aria-label="Disable chase.com"]')).toBeTruthy();
        expect(root.querySelector('button[aria-label="Remove evil.example"]')).toBeTruthy();
        expect(root.querySelector('button[aria-label="Remove chase.com"]')).toBe(null);
        // The disabled seed offers the way back.
        expect(root.querySelector('button[aria-label="Re-enable *.fidelity.com"]')).toBeTruthy();
        // Unfiltered count shows the full population (3 enforced + 1 disabled).
        expect(need(root, '.denylist-count').textContent).toBe('4 patterns');
      } finally { unmount(); }
    });
  });

  describe('search', () => {
    it('narrows live, case-insensitive, with an n-of-N count', async () => {
      const { root, unmount } = await mountView(makeSend());
      try {
        await setSearch(root, 'CHASE');
        expect(chipTexts(root)).toEqual(['chase.com', '*.chase.com']);
        expect(need(root, '.denylist-count').textContent).toBe('2 of 4');

        // The filter spans the disabled section too.
        await setSearch(root, 'fidelity');
        expect(chipTexts(root)).toEqual(['*.fidelity.com']);
        expect(need(root, '.denylist-count').textContent).toBe('1 of 4');

        await setSearch(root, 'zzz');
        expect(chipTexts(root).length).toBe(0);
        expect(root.textContent).toContain('No patterns match the search.');
      } finally { unmount(); }
    });

    it('Clear restores the full list', async () => {
      const { root, unmount } = await mountView(makeSend());
      try {
        await setSearch(root, 'chase');
        need(root, 'button[aria-label="Clear search"]').click();
        await flush();
        expect(chipTexts(root).length).toBe(4);
        expect(need(root, '.denylist-search-input', HTMLInputElement).value).toBe('');
        expect(root.querySelector('button[aria-label="Clear search"]')).toBe(null);
      } finally { unmount(); }
    });
  });

  describe('remove / disable', () => {
    it('user rows: arming shows the consequence; confirm dispatches denylist/remove', async () => {
      const send = makeSend();
      const { root, unmount } = await mountView(send);
      try {
        need(root, 'button[aria-label="Remove evil.example"]').click();
        await flush();
        // Armed, not dispatched — the consequence copy is on screen.
        expect(send.calls.some((c) => c.type === 'denylist/remove')).toBe(false);
        const strip = need(root, '.denylist-item-row.is-arming');
        expect(strip.textContent).toContain('peerd will be able to act on evil.example again');
        expect(need(strip, '.denylist-badge').textContent).toBe('user');

        button(strip, 'Remove?').click();
        await flush();
        const remove = send.calls.find((c) => c.type === 'denylist/remove');
        expect(remove).toEqual({ type: 'denylist/remove', pattern: 'evil.example' });
        // Successful mutation re-fetches (SW is the source of truth).
        expect(send.calls.filter((c) => c.type === 'denylist/list').length).toBeGreaterThan(1);
      } finally { unmount(); }
    });

    it('seed rows: the armed confirm offers Disable, tagged built-in — never a delete', async () => {
      const send = makeSend();
      const { root, unmount } = await mountView(send);
      try {
        need(root, 'button[aria-label="Disable chase.com"]').click();
        await flush();
        const strip = need(root, '.denylist-item-row.is-arming');
        expect(need(strip, '.denylist-badge').textContent).toBe('built-in');
        expect(strip.textContent).toContain('peerd will be able to act on chase.com again');
        expect(strip.textContent).toContain("can't be deleted");
        const verbs = [...strip.querySelectorAll('button')].map((b) => b.textContent);
        expect(verbs).toContain('Disable?');
        // why not expect(...).not: the in-browser framework keeps its
        // matcher set minimal — no negation chain.
        expect(verbs.includes('Remove?')).toBe(false);

        button(strip, 'Disable?').click();
        await flush();
        // Disable rides the same overlay route; the SW decides seed-vs-user.
        expect(send.calls.find((c) => c.type === 'denylist/remove'))
          .toEqual({ type: 'denylist/remove', pattern: 'chase.com' });
      } finally { unmount(); }
    });

    it('cancel disarms without dispatching anything', async () => {
      const send = makeSend();
      const { root, unmount } = await mountView(send);
      try {
        need(root, 'button[aria-label="Disable chase.com"]').click();
        await flush();
        const strip = need(root, '.denylist-item-row.is-arming');
        need(strip, 'button[aria-label="Cancel"]').click();
        await flush();
        expect(root.querySelector('.denylist-item-row.is-arming')).toBe(null);
        expect(send.calls.some((c) => c.type === 'denylist/remove')).toBe(false);
        // The row's arm control is back.
        expect(root.querySelector('button[aria-label="Disable chase.com"]')).toBeTruthy();
      } finally { unmount(); }
    });
  });

  describe('add / re-enable', () => {
    it('the add form dispatches denylist/add and clears on success', async () => {
      const send = makeSend();
      const { root, unmount } = await mountView(send);
      try {
        const input = need(root, '.denylist-input', HTMLInputElement);
        input.value = 'tracker.example';
        input.dispatchEvent(new Event('input'));
        await flush();
        need(root, 'form.denylist-add').dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
        await flush();
        expect(send.calls.find((c) => c.type === 'denylist/add'))
          .toEqual({ type: 'denylist/add', pattern: 'tracker.example' });
        expect(need(root, '.denylist-input', HTMLInputElement).value).toBe('');
      } finally { unmount(); }
    });

    it('a failed add keeps the draft and surfaces the validity hint', async () => {
      const send = makeSend({ 'denylist/add': () => ({ ok: false, error: 'invalid-pattern' }) });
      const { root, unmount } = await mountView(send);
      try {
        const input = need(root, '.denylist-input', HTMLInputElement);
        input.value = 'not a pattern';
        input.dispatchEvent(new Event('input'));
        await flush();
        need(root, 'form.denylist-add').dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
        await flush();
        expect(need(root, '.key-msg.err').textContent).toContain('Not a valid pattern');
        expect(need(root, '.denylist-input', HTMLInputElement).value).toBe('not a pattern');
      } finally { unmount(); }
    });

    it('re-enable dispatches denylist/add for the disabled seed pattern, no confirm', async () => {
      const send = makeSend();
      const { root, unmount } = await mountView(send);
      try {
        need(root, 'button[aria-label="Re-enable *.fidelity.com"]').click();
        await flush();
        expect(send.calls.find((c) => c.type === 'denylist/add'))
          .toEqual({ type: 'denylist/add', pattern: '*.fidelity.com' });
      } finally { unmount(); }
    });

    it('mutations notify the parent so the tab badge stays live', async () => {
      const send = makeSend();
      let changed = 0;
      const { root, unmount } = await mountView(send, { onChanged: () => { changed += 1; } });
      try {
        need(root, 'button[aria-label="Re-enable *.fidelity.com"]').click();
        await flush();
        expect(changed).toBe(1);
      } finally { unmount(); }
    });
  });
});

// ── grouping (P4) ───────────────────────────────────────────────────────────
// 164 seed patterns flat was a wall nobody read. What has to hold once they are
// grouped: a group never disappears (an absent group reads as "no such
// protection"), a search opens the group holding its match, and the provenance
// rules from above still apply inside a group.
describe('sidepanel.denylist-view · categories', () => {
  const CATEGORISED = {
    patterns: ['chase.com', 'uhc.com', 'mine.example'],
    added: ['mine.example'],
    disabled: [],
    categories: { banks_us: ['chase.com', 'wellsfargo.com'], health_us: ['uhc.com'] },
  };
  const sendCategorised = () => Object.assign(
    async (/** @type {any} */ msg) => (msg.type === 'denylist/list'
      ? { ok: true, ...structuredClone(CATEGORISED) }
      : { ok: true }),
    { calls: [] },
  );

  it('renders one group per seed category, plus the user’s own, with counts from the data', async () => {
    const { root, unmount } = await mountView(sendCategorised());
    try {
      const labels = [...root.querySelectorAll('.denylist-group-label')].map((e) => e.textContent);
      expect(labels.includes('Banks (US)')).toBe(true);
      expect(labels.includes('Health (US)')).toBe(true);
      expect(labels.includes('Your patterns')).toBe(true);
      const counts = [...root.querySelectorAll('.denylist-group-count')].map((e) => e.textContent);
      // Unfiltered, a group shows its plain size — the fraction is reserved for
      // "the search narrowed this", where it carries information.
      expect(counts.includes('2')).toBe(true);
    } finally { unmount(); }
  });

  it('collapses seed categories by default and opens the user’s own', async () => {
    const { root, unmount } = await mountView(sendCategorised());
    try {
      const open = [...root.querySelectorAll('.denylist-group.is-open .denylist-group-label')]
        .map((e) => e.textContent);
      expect(open).toEqual(['Your patterns']);
      // A collapsed group shows no chips…
      expect(root.querySelector('.denylist-group:not(.is-open) .denylist-group-body')).toBe(null);
      // …but is still announced as collapsed rather than missing.
      const heads = [...root.querySelectorAll('.denylist-group-head')];
      expect(heads.some((h) => h.getAttribute('aria-expanded') === 'false')).toBe(true);
    } finally { unmount(); }
  });

  it('clicking a group header expands it', async () => {
    const { root, unmount } = await mountView(sendCategorised());
    try {
      const banks = /** @type {HTMLButtonElement | undefined} */ (
        [...root.querySelectorAll('.denylist-group-head')]
          .find((h) => h.textContent?.includes('Banks (US)')));
      expect(!!banks).toBe(true);
      if (!banks) return;
      banks.click();
      await flush();
      const openLabels = [...root.querySelectorAll('.denylist-group.is-open .denylist-group-label')]
        .map((e) => e.textContent);
      expect(openLabels.includes('Banks (US)')).toBe(true);
    } finally { unmount(); }
  });

  it('a group with no search hits STAYS listed, marked empty', async () => {
    // Hiding it would read as "peerd does not block banks".
    const { root, unmount } = await mountView(sendCategorised());
    try {
      await setSearch(root, 'uhc');
      const labels = [...root.querySelectorAll('.denylist-group-label')].map((e) => e.textContent);
      expect(labels.includes('Banks (US)')).toBe(true);
      const banksGroup = [...root.querySelectorAll('.denylist-group')]
        .find((g) => g.textContent?.includes('Banks (US)'));
      expect(!!banksGroup).toBe(true);
      if (!banksGroup) return;
      expect(banksGroup.classList.contains('is-empty')).toBe(true);
      // …and while filtered it reads as a fraction, so "0 of 2" states the miss.
      expect(need(banksGroup, '.denylist-group-count').textContent).toBe('0 of 2');
    } finally { unmount(); }
  });

  it('a search hit opens the group holding it', async () => {
    // A filter that leaves its own match hidden behind a click is broken.
    const { root, unmount } = await mountView(sendCategorised());
    try {
      await setSearch(root, 'uhc');
      const health = [...root.querySelectorAll('.denylist-group')]
        .find((g) => g.textContent?.includes('Health (US)'));
      expect(!!health).toBe(true);
      if (!health) return;
      expect(health.classList.contains('is-open')).toBe(true);
      expect(need(health, 'code.denylist-item').textContent).toBe('uhc.com');
    } finally { unmount(); }
  });

  it('an old SW reply with no categories still renders every pattern', async () => {
    // Forward-compat in the other direction: no taxonomy → one group, nothing lost.
    const { root, unmount } = await mountView(makeSend());
    try {
      expect(chipTexts(root).includes('chase.com')).toBe(true);
      expect(chipTexts(root).includes('evil.example')).toBe(true);
    } finally { unmount(); }
  });
});
