// @ts-check
// query_dom tool — argument validation, scripting mock, output shape.
//
// The injected function itself isn't testable in this framework (it
// runs in a real page world). We cover the OUTER tool: input checks,
// scripting plumbing, formatting of the returned matches.

import { describe, it, expect } from '../../framework.js';
import { queryDomTool } from '/peerd-runtime/tools/defs/index.js';
import { BUILTIN_TOOLS } from '/peerd-runtime/index.js';

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResultOk} ToolResultOk */
/** @typedef {import('/shared/tool-types.js').ToolResultErr} ToolResultErr */
/** @param {import('/shared/tool-types.js').ToolResult} r @returns {any} */
const okContent = (r) => /** @type {ToolResultOk} */ (r).content;
/** @param {import('/shared/tool-types.js').ToolResult} r @returns {string} */
const errOf = (r) => /** @type {ToolResultErr} */ (r).error;

/**
 * @param {any} scriptResult
 * @param {Partial<ToolContext>} [overrides]
 * @returns {ToolContext}
 */
const mockCtx = (scriptResult, overrides = {}) => /** @type {ToolContext} */ ({
  activeTab: { id: 1, url: 'https://mail.example.com/u/0/#inbox', origin: 'https://mail.example.com' },
  tabs: {
    get: async (/** @type {number} */ id) => ({ id, url: 'https://mail.example.com/u/0/#inbox' }),
    query: async () => [{ id: 1, url: 'https://mail.example.com/u/0/#inbox' }],
  },
  scripting: {
    executeScript: async () => [{ result: scriptResult }],
  },
  ...overrides,
});

const SAMPLE_OK = {
  ok: true,
  url: 'https://mail.example.com/u/0/#inbox',
  totalMatches: 3,
  truncated: false,
  matches: [
    {
      tag: 'div', visible: true,
      label: 'Mark as read', role: 'button',
      href: '', type: '', name: '', testid: '', value: '',
      bbox: 'x=400 y=120 w=24 h=24',
      selector: '[aria-label="Mark as read"]',
    },
    {
      tag: 'div', visible: true,
      label: 'Mark as unread', role: 'button',
      href: '', type: '', name: '', testid: '', value: '',
      bbox: 'x=430 y=120 w=24 h=24',
      selector: '[aria-label="Mark as unread"]',
    },
    {
      tag: 'div', visible: false,
      label: 'Archive', role: 'button',
      href: '', type: '', name: '', testid: '', value: '',
      bbox: 'x=460 y=120 w=24 h=24',
      selector: '[aria-label="Archive"]',
    },
  ],
};

describe('query_dom — outer tool', () => {
  it('rejects an empty selector', async () => {
    const r = await queryDomTool.execute({}, mockCtx(SAMPLE_OK));
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('selector_required');
  });

  it('rejects a non-string selector', async () => {
    const r = await queryDomTool.execute({ selector: 42 }, mockCtx(SAMPLE_OK));
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('selector_required');
  });

  it('passes selector, limit, includeHidden through to the injected function', async () => {
    /** @type {any[] | null} */
    let capturedArgs = null;
    const ctx = mockCtx(SAMPLE_OK, {
      scripting: {
        executeScript: async (/** @type {any} */ opts) => {
          capturedArgs = opts.args;
          return [{ result: SAMPLE_OK }];
        },
      },
    });
    await queryDomTool.execute({
      selector: '[role="button"]', limit: 5, includeHidden: true,
    }, ctx);
    expect(capturedArgs?.[0]).toBe('[role="button"]');
    expect(capturedArgs?.[1]).toBe(5);
    expect(capturedArgs?.[2]).toBe(true);
  });

  it('clamps limit to the [1, 50] range', async () => {
    /** @type {any[]} */
    const captured = [];
    const ctx = mockCtx(SAMPLE_OK, {
      scripting: {
        executeScript: async (/** @type {any} */ opts) => {
          captured.push(opts.args[1]);
          return [{ result: SAMPLE_OK }];
        },
      },
    });
    await queryDomTool.execute({ selector: 'a', limit: 0 }, ctx);
    await queryDomTool.execute({ selector: 'a', limit: 9999 }, ctx);
    expect(captured[0]).toBe(1);
    expect(captured[1]).toBe(50);
  });

  it('defaults limit to 20 when omitted', async () => {
    /** @type {any} */
    let captured;
    const ctx = mockCtx(SAMPLE_OK, {
      scripting: {
        executeScript: async (/** @type {any} */ opts) => { captured = opts.args[1]; return [{ result: SAMPLE_OK }]; },
      },
    });
    await queryDomTool.execute({ selector: 'a' }, ctx);
    expect(captured).toBe(20);
  });

  it('wraps the body in untrusted_web_content with the page origin', async () => {
    const r = await queryDomTool.execute({ selector: 'button' }, mockCtx(SAMPLE_OK));
    expect(r.ok).toBe(true);
    expect(okContent(r).includes('<untrusted_web_content')).toBe(true);
    expect(okContent(r).includes('origin="https://mail.example.com"')).toBe(true);
    expect(okContent(r).includes('tool="query_dom"')).toBe(true);
  });

  it('formats matches with label, selector, bbox', async () => {
    const r = await queryDomTool.execute({ selector: '[role=button]' }, mockCtx(SAMPLE_OK));
    expect(okContent(r).includes('Mark as read')).toBe(true);
    expect(okContent(r).includes('[aria-label="Mark as read"]')).toBe(true);
    expect(okContent(r).includes('x=400 y=120 w=24 h=24')).toBe(true);
    expect(okContent(r).includes('role: button')).toBe(true);
  });

  it('reports total matches and hidden mode', async () => {
    const r = await queryDomTool.execute({ selector: '[role=button]' }, mockCtx(SAMPLE_OK));
    expect(okContent(r).includes('Total matches: 3')).toBe(true);
    expect(okContent(r).includes('visible only')).toBe(true);
  });

  it('includeHidden=true flips the mode banner', async () => {
    const r = await queryDomTool.execute({
      selector: '[role=button]', includeHidden: true,
    }, mockCtx(SAMPLE_OK));
    expect(okContent(r).includes('including hidden elements')).toBe(true);
  });

  it('renders "(no matches)" cleanly when nothing matched', async () => {
    const empty = { ok: true, url: 'https://mail.example.com/', totalMatches: 0, truncated: false, matches: [] };
    const r = await queryDomTool.execute({ selector: '.nope' }, mockCtx(empty));
    expect(r.ok).toBe(true);
    expect(okContent(r).includes('(no matches)')).toBe(true);
    expect(okContent(r).includes('Total matches: 0')).toBe(true);
  });

  it('returns the injected function\'s error verbatim', async () => {
    const bad = { ok: false, error: 'invalid_selector: bad selector' };
    const r = await queryDomTool.execute({ selector: ':::::' }, mockCtx(bad));
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('invalid_selector')).toBe(true);
  });

  it('surfaces a script_inject_failed error when scripting throws', async () => {
    const ctx = mockCtx(SAMPLE_OK, {
      scripting: { executeScript: async () => { throw new Error('frame removed'); } },
    });
    const r = await queryDomTool.execute({ selector: 'a' }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('script_inject_failed')).toBe(true);
    expect(errOf(r).includes('frame removed')).toBe(true);
  });

  it('is registered in BUILTIN_TOOLS', () => {
    const found = BUILTIN_TOOLS.find(t => t.name === 'query_dom');
    expect(!!found).toBe(true);
    expect(found?.primitive).toBe('tab');
    expect(found?.sideEffect).toBe('read');
  });
});
