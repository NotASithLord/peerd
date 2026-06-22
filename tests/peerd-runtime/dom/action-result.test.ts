import { describe, test, expect } from 'bun:test';
import { summarizeMutations } from '../../../extension/peerd-runtime/dom/action-result.js';

// Shapes mirror what the page-side observer in debugger-pool.js returns —
// the exact structure validated live on httpbin via Claude-in-Chrome:
//   {"added":["dialog \"Order confirmation\""],"attr":["button \"Submit order\" @disabled"]}

describe('summarizeMutations', () => {
  test('summarizes the real captured shape (dialog opened, button disabled)', () => {
    const s = summarizeMutations({
      added: ['dialog "Order confirmation"'],
      removed: [],
      attr: ['button "Submit order" @disabled'],
      counts: { added: 1, removed: 0, attr: 1 },
    });
    expect(s).toBe('+1 added (dialog "Order confirmation"); 1 attr (button "Submit order" @disabled)');
  });

  test('reports no-op explicitly when nothing changed', () => {
    expect(summarizeMutations({ added: [], removed: [], attr: [], counts: { added: 0, removed: 0, attr: 0 } }))
      .toBe('no DOM change detected');
  });

  test('handles removals', () => {
    const s = summarizeMutations({ removed: ['li "old row"'], counts: { added: 0, removed: 1, attr: 0 } });
    expect(s).toContain('−1 removed (li "old row")');
  });

  test('null capture (e.g. navigated) → null', () => {
    expect(summarizeMutations(null)).toBeNull();
    expect(summarizeMutations(undefined)).toBeNull();
  });
});
