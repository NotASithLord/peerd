// The Playwright-vocabulary facade: page_goto/page_click/page_fill map to the
// ref-first tools with locator strictness, and a runnerWebMode setting swaps the
// runner between ref-first and selector-first driving (the A/B). The security
// tail of the prompt must NOT drift between modes.

import { describe, test, expect } from 'bun:test';
import { playwrightClickArgs, playwrightFillArgs } from '../../extension/peerd-runtime/tools/web/playwright.js';
import {
  isPlaywrightMode, doToolsetFor, readToolsetFor,
  DO_TOOLSET, READ_TOOLSET, PLAYWRIGHT_DO_TOOLSET, PLAYWRIGHT_READ_TOOLSET,
  RUNNER_PROMPT, PLAYWRIGHT_RUNNER_PROMPT,
} from '../../extension/peerd-runtime/runner/index.js';

describe('playwright facade — locator strictness', () => {
  test('page_click without nth requires exactly one match', () => {
    expect(playwrightClickArgs({ selector: '.x' })).toEqual({ selector: '.x', expectedCount: 1 });
  });
  test('page_click with nth targets one match and drops the single-match guard', () => {
    expect(playwrightClickArgs({ selector: '.x', nth: 2 })).toEqual({ selector: '.x', nth: 2 });
  });
  test('page_fill is always strict (a single field)', () => {
    expect(playwrightFillArgs({ selector: '#f', text: 'hi' })).toEqual({ selector: '#f', text: 'hi', expectedCount: 1 });
  });
});

describe('playwright facade — mode swap', () => {
  test('default (no setting / unknown value) is ref mode', () => {
    expect(isPlaywrightMode(undefined)).toBe(false);
    expect(isPlaywrightMode({ settings: {} })).toBe(false);
    expect(isPlaywrightMode({ settings: { runnerWebMode: 'ref' } })).toBe(false);
    expect(doToolsetFor({ settings: {} })).toBe(DO_TOOLSET);
    expect(readToolsetFor({ settings: {} })).toBe(READ_TOOLSET);
  });
  test('the playwright setting swaps both toolsets', () => {
    const ctx = { settings: { runnerWebMode: 'playwright' } };
    expect(isPlaywrightMode(ctx)).toBe(true);
    expect(doToolsetFor(ctx)).toBe(PLAYWRIGHT_DO_TOOLSET);
    expect(readToolsetFor(ctx)).toBe(PLAYWRIGHT_READ_TOOLSET);
  });
  test('playwright toolsets are selector-first: page_* in, snapshot/ref tools out', () => {
    for (const t of ['page_goto', 'page_click', 'page_fill']) expect(PLAYWRIGHT_DO_TOOLSET).toContain(t);
    for (const t of ['snapshot', 'click', 'type']) expect(PLAYWRIGHT_DO_TOOLSET).not.toContain(t);
    expect(PLAYWRIGHT_READ_TOOLSET).not.toContain('snapshot');
  });
});

describe('playwright facade — the injection-defense tail cannot drift', () => {
  test('both prompts carry the byte-identical untrusted-content / injection-drill tail', () => {
    const marker = 'UNTRUSTED CONTENT';
    const refTail = RUNNER_PROMPT.slice(RUNNER_PROMPT.indexOf(marker));
    const pwTail = PLAYWRIGHT_RUNNER_PROMPT.slice(PLAYWRIGHT_RUNNER_PROMPT.indexOf(marker));
    expect(refTail.length).toBeGreaterThan(500);
    expect(pwTail).toBe(refTail);
  });
  test('the playwright head teaches selectors, not refs', () => {
    expect(PLAYWRIGHT_RUNNER_PROMPT).toContain('SELECTOR-first');
    expect(PLAYWRIGHT_RUNNER_PROMPT).toContain('page_click');
    expect(PLAYWRIGHT_RUNNER_PROMPT).not.toContain('accessibility tree with element refs');
  });
});
