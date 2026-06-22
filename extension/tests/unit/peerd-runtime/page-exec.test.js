// @ts-check
// page_exec — outer tool surface tests.
//
// The actual CDP Runtime.evaluate path isn't unit-testable here (needs
// a real tab). We cover input validation, debugger-pool plumbing,
// formatting of the CDP result shape, error mapping.

import { describe, it, expect } from '../../framework.js';
import { pageExecTool } from '/peerd-runtime/tools/defs/index.js';
import { BUILTIN_TOOLS } from '/peerd-runtime/index.js';

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/peerd-runtime/tools/defs/page-exec.js').PageExecResult} PageExecResult */
/** @param {PageExecResult} r @returns {string} */
const okContent = (r) => /** @type {import('/shared/tool-types.js').ToolResultOk} */ (r).content;
/** @param {PageExecResult} r @returns {string} */
const errOf = (r) => /** @type {import('/shared/tool-types.js').ToolResultErr} */ (r).error;

/**
 * @param {any} cdpResult
 * @param {Record<string, any>} [overrides]
 * @returns {ToolContext}
 */
const mockCtx = (cdpResult, overrides = {}) => /** @type {ToolContext} */ (/** @type {unknown} */ ({
  activeTab: { id: 1, url: 'https://mail.example.com/', origin: 'https://mail.example.com' },
  tabs: {
    get: async (/** @type {number} */ id) => ({ id, url: 'https://mail.example.com/' }),
    query: async () => [{ id: 1, url: 'https://mail.example.com/' }],
  },
  debuggerPool: {
    evaluate: async () => cdpResult,
  },
  ...overrides,
}));

const OK_RESULT = {
  result: { type: 'string', value: 'hello world' },
  _capturedConsole: 'log message 1\nlog message 2',
};

const RETURN_OBJECT = {
  result: { type: 'object', value: { count: 42, ok: true } },
  _capturedConsole: '',
};

const THREW_RESULT = {
  result: { type: 'undefined' },
  exceptionDetails: {
    text: 'Uncaught ReferenceError: foo is not defined',
    exception: { description: 'ReferenceError: foo is not defined\n    at <anonymous>:1:1' },
  },
  _capturedConsole: '',
};

describe('page_exec — outer tool', () => {
  it('rejects missing expression', async () => {
    const r = await pageExecTool.execute({}, mockCtx(OK_RESULT));
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('expression_required');
  });

  it('rejects empty expression', async () => {
    const r = await pageExecTool.execute({ expression: '' }, mockCtx(OK_RESULT));
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('expression_required');
  });

  it('rejects expression over 200k chars', async () => {
    const r = await pageExecTool.execute(
      { expression: 'x'.repeat(200_001) },
      mockCtx(OK_RESULT),
    );
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('expression_too_large')).toBe(true);
  });

  it('reports debugger_unavailable when ctx.debuggerPool missing', async () => {
    const r = await pageExecTool.execute(
      { expression: '1' },
      mockCtx(OK_RESULT, { debuggerPool: undefined }),
    );
    expect(r.ok).toBe(false);
    expect(errOf(r).startsWith('debugger_unavailable')).toBe(true);
  });

  it('conveys a hard build/platform limit (not a flippable setting) when the API is absent', async () => {
    const r = await pageExecTool.execute(
      { expression: '1' },
      mockCtx(OK_RESULT, { debuggerPool: undefined, cdpUnavailableReason: 'browser_unsupported' }),
    );
    expect(r.ok).toBe(false);
    expect(errOf(r).startsWith('debugger_unavailable')).toBe(true);
    // `browser_unsupported` covers BOTH Firefox (no chrome.debugger API ever)
    // and the store Chrome build (debugger stripped until post-approval), so the
    // message must read as a hard limit — NOT a setting — and must not point at
    // the Settings switch (that's the `setting_off` case, asserted in the next
    // test). We assert the stable semantic ("not a setting"), not exact wording.
    expect(errOf(r).includes('not a setting')).toBe(true);
    expect(errOf(r).includes('Settings')).toBe(false);
  });

  it('points at the Settings switch when the user turned the setting off', async () => {
    const r = await pageExecTool.execute(
      { expression: '1' },
      mockCtx(OK_RESULT, { debuggerPool: undefined, cdpUnavailableReason: 'setting_off' }),
    );
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('Settings')).toBe(true);
  });

  it('passes expression + tabId through to the debugger pool', async () => {
    /** @type {{ tabId: number, expr: string } | undefined} */
    let captured;
    const ctx = mockCtx(OK_RESULT, {
      debuggerPool: {
        evaluate: async (/** @type {number} */ tabId, /** @type {string} */ expr) => {
          captured = { tabId, expr };
          return OK_RESULT;
        },
      },
    });
    await pageExecTool.execute({ expression: 'return 1 + 1' }, ctx);
    expect(captured?.tabId).toBe(1);
    expect(captured?.expr).toBe('return 1 + 1');
  });

  it('wraps body in untrusted_web_content with the tab origin', async () => {
    const r = await pageExecTool.execute({ expression: 'x' }, mockCtx(OK_RESULT));
    expect(r.ok).toBe(true);
    expect(okContent(r).includes('<untrusted_web_content')).toBe(true);
    expect(okContent(r).includes('origin="https://mail.example.com"')).toBe(true);
    expect(okContent(r).includes('tool="page_exec"')).toBe(true);
  });

  it('surfaces return value + console output', async () => {
    const r = await pageExecTool.execute({ expression: 'x' }, mockCtx(OK_RESULT));
    expect(okContent(r).includes('[CONSOLE]')).toBe(true);
    expect(okContent(r).includes('log message 1')).toBe(true);
    expect(okContent(r).includes('[RETURN]')).toBe(true);
    expect(okContent(r).includes('hello world')).toBe(true);
    expect(okContent(r).includes('Status: ok')).toBe(true);
  });

  it('formats object return values as pretty JSON', async () => {
    const r = await pageExecTool.execute({ expression: 'x' }, mockCtx(RETURN_OBJECT));
    expect(okContent(r).includes('"count": 42')).toBe(true);
    expect(okContent(r).includes('"ok": true')).toBe(true);
  });

  it('returns ok=false when the code threw, with the exception text', async () => {
    const r = await pageExecTool.execute({ expression: 'foo' }, mockCtx(THREW_RESULT));
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('ReferenceError')).toBe(true);
    expect(okContent(r).includes('[ERROR]')).toBe(true);
    expect(okContent(r).includes('Status: threw')).toBe(true);
  });

  it('maps debugger_detached errors to a clean message', async () => {
    const ctx = mockCtx(OK_RESULT, {
      debuggerPool: {
        evaluate: async () => { throw new Error('Detached: target closed'); },
      },
    });
    const r = await pageExecTool.execute({ expression: 'x' }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('debugger_detached')).toBe(true);
  });

  it('maps cannot-attach errors when the tab is a chrome:// URL', async () => {
    const ctx = mockCtx(OK_RESULT, {
      debuggerPool: {
        evaluate: async () => { throw new Error('Cannot access a chrome:// URL'); },
      },
    });
    const r = await pageExecTool.execute({ expression: 'x' }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('cannot_attach_to_tab')).toBe(true);
  });

  it('is registered in BUILTIN_TOOLS with DOM primitive + write side-effect', () => {
    const found = BUILTIN_TOOLS.find(t => t.name === 'page_exec');
    expect(!!found).toBe(true);
    expect(found?.primitive).toBe('tab');
    expect(found?.sideEffect).toBe('write');
  });

  it('exposes the active-tab origin for the egress gate', () => {
    const origins = pageExecTool.origins({ expression: 'x' }, /** @type {ToolContext} */ ({
      activeTab: { origin: 'https://github.com' },
    }));
    expect(origins).toEqual(['https://github.com']);
  });
});
