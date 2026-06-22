// @ts-check
// page_eval — outer tool surface tests.
//
// The injected function runs in a real page world (chrome.scripting
// MAIN world), so we can't unit-test the eval semantics directly.
// We cover everything OUTSIDE the injection: input validation,
// scripting plumbing, output formatting, origin gating.

import { describe, it, expect } from '../../framework.js';
import { pageEvalTool } from '/peerd-runtime/tools/defs/index.js';
import { BUILTIN_TOOLS } from '/peerd-runtime/index.js';

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/peerd-runtime/tools/defs/page-eval.js').PageEvalResult} PageEvalResult */
/** @param {PageEvalResult} r @returns {string} */
const okContent = (r) => /** @type {import('/shared/tool-types.js').ToolResultOk} */ (r).content;
/** @param {PageEvalResult} r @returns {string} */
const errOf = (r) => /** @type {import('/shared/tool-types.js').ToolResultErr} */ (r).error;

/**
 * @param {any} scriptResult
 * @param {Partial<ToolContext>} [overrides]
 * @returns {ToolContext}
 */
const mockCtx = (scriptResult, overrides = {}) => /** @type {ToolContext} */ ({
  activeTab: { id: 1, url: 'https://mail.example.com/', origin: 'https://mail.example.com' },
  tabs: {
    get: async (/** @type {number} */ id) => ({ id, url: 'https://mail.example.com/' }),
    query: async () => [{ id: 1, url: 'https://mail.example.com/' }],
  },
  scripting: {
    executeScript: async () => [{ result: scriptResult }],
  },
  ...overrides,
});

const SAMPLE_OK = {
  url: 'https://mail.example.com/',
  threw: false,
  error: '',
  stack: '',
  consoleOutput: 'starting batch 1\n42 records found',
  returnValue: '{"count":42}',
};

const SAMPLE_THREW = {
  url: 'https://mail.example.com/',
  threw: true,
  error: 'ReferenceError: foo is not defined',
  stack: 'ReferenceError: foo is not defined\n    at <anonymous>:1:1',
  consoleOutput: '',
  returnValue: undefined,
};

describe('page_eval — outer tool', () => {
  it('rejects missing code', async () => {
    const r = await pageEvalTool.execute({}, mockCtx(SAMPLE_OK));
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('code_required');
  });

  it('rejects empty code', async () => {
    const r = await pageEvalTool.execute({ code: '' }, mockCtx(SAMPLE_OK));
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('code_required');
  });

  it('rejects code over 100k chars', async () => {
    const r = await pageEvalTool.execute(
      { code: 'x'.repeat(100_001) },
      mockCtx(SAMPLE_OK),
    );
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('code_too_large')).toBe(true);
  });

  it('passes code through to the injected function', async () => {
    /** @type {any} */
    let captured;
    const ctx = mockCtx(SAMPLE_OK, {
      scripting: {
        executeScript: async (/** @type {any} */ opts) => {
          captured = opts.args;
          return [{ result: SAMPLE_OK }];
        },
      },
    });
    await pageEvalTool.execute({ code: 'return 1 + 1' }, ctx);
    expect(captured[0]).toBe('return 1 + 1');
  });

  it('uses MAIN world for the injection', async () => {
    /** @type {any} */
    let capturedWorld;
    const ctx = mockCtx(SAMPLE_OK, {
      scripting: {
        executeScript: async (/** @type {any} */ opts) => {
          capturedWorld = opts.world;
          return [{ result: SAMPLE_OK }];
        },
      },
    });
    await pageEvalTool.execute({ code: 'return 1' }, ctx);
    expect(capturedWorld).toBe('MAIN');
  });

  it('wraps the body in untrusted_web_content with the page origin', async () => {
    const r = await pageEvalTool.execute({ code: 'x' }, mockCtx(SAMPLE_OK));
    expect(r.ok).toBe(true);
    expect(okContent(r).includes('<untrusted_web_content')).toBe(true);
    expect(okContent(r).includes('origin="https://mail.example.com"')).toBe(true);
    expect(okContent(r).includes('tool="page_eval"')).toBe(true);
  });

  it('surfaces console output and return value in the body', async () => {
    const r = await pageEvalTool.execute({ code: 'x' }, mockCtx(SAMPLE_OK));
    expect(okContent(r).includes('[CONSOLE]')).toBe(true);
    expect(okContent(r).includes('starting batch 1')).toBe(true);
    expect(okContent(r).includes('[RETURN]')).toBe(true);
    expect(okContent(r).includes('"count":42')).toBe(true);
    expect(okContent(r).includes('Status: ok')).toBe(true);
  });

  it('returns ok=false when the injected code threw', async () => {
    const r = await pageEvalTool.execute({ code: 'foo' }, mockCtx(SAMPLE_THREW));
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('ReferenceError')).toBe(true);
    expect(okContent(r).includes('[ERROR]')).toBe(true);
    expect(okContent(r).includes('Status: threw')).toBe(true);
  });

  it('truncates very long console output', async () => {
    const huge = 'x'.repeat(20_000);
    const r = await pageEvalTool.execute(
      { code: 'x' },
      mockCtx({ ...SAMPLE_OK, consoleOutput: huge, returnValue: undefined }),
    );
    expect(okContent(r).includes('chars elided')).toBe(true);
    expect(okContent(r).length < 15_000).toBe(true);
  });

  it('omits sections that are empty', async () => {
    const r = await pageEvalTool.execute(
      { code: 'x' },
      mockCtx({
        url: 'https://example.com/',
        threw: false, error: '', stack: '',
        consoleOutput: '', returnValue: undefined,
      }),
    );
    expect(okContent(r).includes('[CONSOLE]')).toBe(false);
    expect(okContent(r).includes('[RETURN]')).toBe(false);
    expect(okContent(r).includes('[ERROR]')).toBe(false);
  });

  it('surfaces script_inject_failed when scripting throws', async () => {
    const ctx = mockCtx(SAMPLE_OK, {
      scripting: { executeScript: async () => { throw new Error('frame gone'); } },
    });
    const r = await pageEvalTool.execute({ code: 'x' }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('script_inject_failed')).toBe(true);
  });

  it('is registered in BUILTIN_TOOLS with DOM primitive + write side-effect', () => {
    const found = BUILTIN_TOOLS.find(t => t.name === 'page_eval');
    expect(!!found).toBe(true);
    expect(found?.primitive).toBe('tab');
    expect(found?.sideEffect).toBe('write');
  });

  it('origin gate returns the active-tab origin', () => {
    const origins = pageEvalTool.origins({ code: 'x' }, /** @type {ToolContext} */ ({
      activeTab: { origin: 'https://github.com' },
    }));
    expect(origins).toEqual(['https://github.com']);
  });
});
