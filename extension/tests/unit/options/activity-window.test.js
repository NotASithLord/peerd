// @ts-check
// Options → Activity: the fetch window must not pose as the whole log.
//
// audit/list returns the newest 500 rows by default but counts every row,
// and the filters ran over that window alone, so an older event read as
// "Nothing matches" under a header that counted it. The header now names
// the window, the first filter over a cut-off window loads the whole log
// once, and the list caps what it renders.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ActivityView } from '/options/sections/activity.js';

/** @param {number} n @param {string} type */
const rows = (n, type) => Array.from({ length: n }, (_, i) => ({ id: `${type}-${i}`, when: 1000 + i, type }));

const OLD_ROW = { id: 'old', when: 1, type: 'denylist_added', details: { pattern: 'old-row.test' } };

// A fake audit/list with the route's shape: no limit returns the newest
// `window` rows; a limit returns that many. `log` is newest-first already.
/** @param {any[]} log @param {number} window */
const mount = (log, window) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  /** @type {any[]} */
  const calls = [];
  const send = async (/** @type {any} */ msg) => {
    calls.push(msg);
    if (msg.type !== 'audit/list') return { ok: true };
    return { ok: true, entries: log.slice(0, msg.limit ?? window), total: log.length };
  };
  m.mount(root, { view: () => m(ActivityView, { send }) });
  const lists = () => calls.filter((c) => c.type === 'audit/list');
  return { root, lists, unmount: () => { m.mount(root, null); root.remove(); } };
};

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => m.redraw.sync());

/** @param {ParentNode} root @param {string} value */
const setQuery = (root, value) => {
  const input = /** @type {HTMLInputElement} */ (root.querySelector('.log-filter-query'));
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  m.redraw.sync();
};

/** @param {ParentNode} root @param {string} value */
const setLevel = (root, value) => {
  const select = /** @type {HTMLSelectElement} */ (root.querySelector('.log-filter-level'));
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  m.redraw.sync();
};

describe('options.activity: the fetch window', () => {
  it('names the window when the log holds more rows than were fetched', async () => {
    const { root, lists, unmount } = mount([...rows(2, 'tool_executed'), OLD_ROW], 2);
    try {
      await settle();
      expect(root.textContent).toContain('Newest 2 of 3 recorded events');
      expect(root.querySelectorAll('.log-row').length).toBe(2);
      // No filter: the default window is enough, nothing else is fetched.
      expect(lists().length).toBe(1);
      expect(lists()[0].limit).toBe(undefined);
    } finally { unmount(); }
  });

  it('a filter entered during Refresh loads the whole log once and finds the older row', async () => {
    const { root, lists, unmount } = mount([...rows(2, 'tool_executed'), OLD_ROW], 2);
    try {
      await settle();
      /** @type {HTMLButtonElement} */ (root.querySelector('button[title="Refresh"]')).click();
      setQuery(root, 'old-row');
      await settle();
      expect(lists().length).toBe(3);
      expect(lists()[1].limit).toBe(undefined);
      expect(lists()[2].limit).toBe(Number.MAX_SAFE_INTEGER);
      expect(root.querySelectorAll('.log-row').length).toBe(1);
      expect(root.textContent).toContain('old-row.test');
      expect(root.textContent).toContain('3 recorded events');
      // Later filter flips stay client-side over the loaded rows.
      setLevel(root, 'ok');
      await settle();
      expect(lists().length).toBe(3);
      expect(root.querySelectorAll('.log-row').length).toBe(1);
    } finally { unmount(); }
  });

  it('a full window needs no second fetch', async () => {
    const { root, lists, unmount } = mount([...rows(2, 'tool_executed'), OLD_ROW], 3);
    try {
      await settle();
      expect(root.textContent).toContain('3 recorded events');
      setQuery(root, 'old-row');
      await settle();
      expect(lists().length).toBe(1);
      expect(root.querySelectorAll('.log-row').length).toBe(1);
    } finally { unmount(); }
  });

  it('a log that keeps growing is fetched whole once, not once per keystroke', async () => {
    // An agent run writes audit rows between a reply and the next keystroke,
    // so "fewer rows than the total" is the normal state while peerd works.
    const log = [...rows(2, 'tool_executed'), OLD_ROW];
    const { root, lists, unmount } = mount(log, 2);
    try {
      await settle();
      for (const query of ['o', 'ol', 'old']) {
        log.unshift({ id: `landed-${query}`, when: 2000 + query.length, type: 'tool_executed' });
        setQuery(root, query);
        await settle();
      }
      expect(lists().length).toBe(2);
      expect(lists()[1].limit).toBe(Number.MAX_SAFE_INTEGER);
      expect(root.textContent).toContain('old-row.test');
    } finally { unmount(); }
  });

  it('renders no more than 500 rows and says how many more there are', async () => {
    const { root, unmount } = mount(rows(600, 'tool_executed'), 600);
    try {
      await settle();
      expect(root.querySelectorAll('.log-row').length).toBe(500);
      expect(root.textContent).toContain('Showing the newest 500 of 600. Narrow the filter to see the rest.');
    } finally { unmount(); }
  });
});
