// @ts-check
// page_keys — outer tool surface + parser tests.

import { describe, it, expect } from '../../framework.js';
import {
  pageKeysTool,
  _parseKeySequenceForTests,
} from '/peerd-runtime/tools/defs/page-keys.js';
import { BUILTIN_TOOLS } from '/peerd-runtime/index.js';
import { browserProbeResult } from '../../helpers/browser-scripting.js';

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/peerd-runtime/tools/defs/page-keys.js').KeyEvent} KeyEvent */
/** @param {import('/shared/tool-types.js').ToolResult} r @returns {string} */
const okContent = (r) => /** @type {import('/shared/tool-types.js').ToolResultOk} */ (r).content;
/** @param {import('/shared/tool-types.js').ToolResult} r @returns {string} */
const errOf = (r) => /** @type {import('/shared/tool-types.js').ToolResultErr} */ (r).error;

/**
 * @param {Record<string, any>} [overrides]
 * @returns {ToolContext}
 */
const mockCtx = (overrides = {}) => /** @type {ToolContext} */ (/** @type {unknown} */ ({
  activeTab: { id: 1, url: 'https://mail.example.com/', origin: 'https://mail.example.com' },
  tabs: {
    get: async (/** @type {number} */ id) => ({ id, url: 'https://mail.example.com/' }),
    query: async () => [{ id: 1, url: 'https://mail.example.com/' }],
  },
  scripting: {
    executeScript: async (/** @type {any} */ request) => browserProbeResult(request, {
      url: 'https://mail.example.com/',
    }),
  },
  debuggerPool: {
    dispatchKeys: async () => {},
  },
  ...overrides,
}));

describe('page_keys — parser', () => {
  it('parses a single character', () => {
    const evs = _parseKeySequenceForTests('a');
    expect(evs.length).toBe(1);
    expect(evs[0].key).toBe('a');
    expect(evs[0].modifiers).toBe(0);
    expect(evs[0].text).toBe('a');
  });

  it('parses a single modifier combo', () => {
    const evs = _parseKeySequenceForTests('Shift+I');
    expect(evs.length).toBe(1);
    expect(evs[0].key).toBe('I');
    expect(evs[0].modifiers).toBe(8);   // Shift
    // Modified combos don't emit text — they're shortcuts, not typing.
    expect(evs[0].text).toBe(undefined);
  });

  it('parses Cmd+K as Meta (4) modifier', () => {
    const evs = _parseKeySequenceForTests('Cmd+K');
    expect(evs[0].modifiers).toBe(4);
  });

  it('parses Ctrl+Shift+P as combined bits', () => {
    const evs = _parseKeySequenceForTests('Ctrl+Shift+P');
    expect(evs.length).toBe(1);
    expect(evs[0].key).toBe('P');
    expect(evs[0].modifiers).toBe(2 | 8);   // Ctrl=2, Shift=8 → 10
  });

  it('parses a space-separated sequence', () => {
    const evs = _parseKeySequenceForTests('g i');
    expect(evs.length).toBe(2);
    expect(evs[0].key).toBe('g');
    expect(evs[1].key).toBe('i');
  });

  it('parses Gmail "* u" select-all-unread', () => {
    const evs = _parseKeySequenceForTests('* u');
    expect(evs.length).toBe(2);
    expect(evs[0].key).toBe('*');
    expect(evs[1].key).toBe('u');
  });

  it('parses special keys (Enter, ArrowDown, Escape)', () => {
    const evs = _parseKeySequenceForTests('ArrowDown ArrowDown Enter');
    expect(evs.map(e => e.key)).toEqual(['ArrowDown', 'ArrowDown', 'Enter']);
  });

  it('throws on unknown modifier', () => {
    /** @type {unknown} */
    let thrown;
    try { _parseKeySequenceForTests('Foo+B'); }
    catch (e) { thrown = e; }
    expect(/** @type {{ message?: string }} */ (thrown)?.message?.includes('unknown modifier')).toBe(true);
  });

  it('throws on empty token', () => {
    /** @type {unknown} */
    let thrown;
    try { _parseKeySequenceForTests('+'); }
    catch (e) { thrown = e; }
    expect(!!thrown).toBe(true);
  });
});

describe('page_keys — outer tool', () => {
  it('rejects missing keys', async () => {
    const r = await pageKeysTool.execute({}, mockCtx());
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('keys_required');
  });

  it('rejects empty keys', async () => {
    const r = await pageKeysTool.execute({ keys: '' }, mockCtx());
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('keys_required');
  });

  it('rejects keys over 1000 chars', async () => {
    const r = await pageKeysTool.execute(
      { keys: 'a '.repeat(501) },
      mockCtx(),
    );
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('keys_too_long')).toBe(true);
  });

  it('reports debugger_unavailable when ctx.debuggerPool missing', async () => {
    const r = await pageKeysTool.execute(
      { keys: 'a' },
      mockCtx({ debuggerPool: undefined }),
    );
    expect(r.ok).toBe(false);
    expect(errOf(r).startsWith('debugger_unavailable')).toBe(true);
    // The honest gap: trusted input cannot be faked with synthetic events.
    expect(errOf(r).includes('isTrusted')).toBe(true);
  });

  it('surfaces parse errors cleanly', async () => {
    const r = await pageKeysTool.execute(
      { keys: 'Foo+B' },
      mockCtx(),
    );
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('parse_failed')).toBe(true);
  });

  it('does not dispatch parsed events because CDP input is tab-scoped', async () => {
    /** @type {{ tabId: number, events: KeyEvent[] } | undefined} */
    let captured;
    const ctx = mockCtx({
      debuggerPool: {
        dispatchKeys: async (/** @type {number} */ tabId, /** @type {KeyEvent[]} */ events) => {
          captured = { tabId, events };
        },
      },
    });
    const r = await pageKeysTool.execute({ keys: 'Shift+I' }, ctx);
    expect(captured).toBe(undefined);
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('browser_target_unverified');
  });

  it('gives the model a document-bound correction without claiming success', async () => {
    const r = await pageKeysTool.execute({ keys: 'Shift+I' }, mockCtx());
    expect(r.ok).toBe(false);
    expect(okContent(r).includes('did not send any keys')).toBe(true);
    expect(okContent(r).includes('Use type with a selector or element ref')).toBe(true);
  });

  it('never reaches debugger dispatch errors', async () => {
    const ctx = mockCtx({
      debuggerPool: {
        dispatchKeys: async () => { throw new Error('Detached: target closed'); },
      },
    });
    const r = await pageKeysTool.execute({ keys: 'a' }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('browser_target_unverified');
  });

  it('is registered in BUILTIN_TOOLS with DOM primitive + write side-effect', () => {
    const found = BUILTIN_TOOLS.find(t => t.name === 'page_keys');
    expect(!!found).toBe(true);
    expect(found?.primitive).toBe('tab');
    expect(found?.sideEffect).toBe('write');
  });

  it('origin gate returns the active tab origin', () => {
    const origins = pageKeysTool.origins({ keys: 'a' }, /** @type {ToolContext} */ ({
      activeTab: { origin: 'https://gmail.com' },
    }));
    expect(origins).toEqual(['https://gmail.com']);
  });
});
