// @ts-check
// Playwright-vocabulary page tools — page_goto / page_click / page_fill.
//
// A thin, SELECTOR-first facade over navigate/click/type whose names and shape
// match the Playwright API models already know from their training data. It
// exists to settle an experiment by MEASUREMENT, not vibes: does the agent drive
// the web better when the tools are named + shaped like Playwright (read the
// HTML, target a CSS selector) than with peerd's ref-first a11y-snapshot tools?
// The runner swaps to these in playwright mode (settings.runnerWebMode ===
// 'playwright'); the ref-first tools are the default. A/B the two modes through
// the eval benchmark.
//
// LOCATOR STRICTNESS is the one genuine reliability win Playwright semantics
// bring, so it's the default here: page_click/page_fill refuse when the selector
// matches != 1 element (instead of silently acting on the first), via the
// existing expectedCount guard on click/type (#103). Pass an explicit nth to
// target one of several matches deliberately (Playwright's .nth(i)).
//
// Everything else DELEGATES to the underlying tool's execute, so the gate
// pipeline, CDP/scripting fallback, untrusted-content handling, and result shape
// are identical — these are a vocabulary layer, not a reimplementation.

import { clickTool } from '../defs/click.js';
import { typeTool } from '../defs/type.js';
import { navigateTool } from '../defs/navigate.js';

// no nth → require exactly one match (Playwright locator strictness); explicit
// nth → the agent is choosing among matches, so don't also pin the count.
/** @param {{ selector?: string, nth?: number }} args */
export const playwrightClickArgs = (args) => ({
  selector: args?.selector,
  ...(typeof args?.nth === 'number' ? { nth: args.nth } : { expectedCount: 1 }),
});

// page_fill always targets a single field (type has no nth) — strict by default.
/** @param {{ selector?: string, text?: string }} args */
export const playwrightFillArgs = (args) => ({
  selector: args?.selector,
  text: args?.text,
  expectedCount: 1,
});

/** @type {import('/shared/tool-types.js').Tool} */
export const pageGotoTool = {
  name: 'page_goto',
  primitive: 'tab',
  description: 'Navigate the tab to a URL (Playwright page.goto). http(s) only.',
  schema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Absolute http(s) URL to load.' } },
    required: ['url'],
  },
  sideEffect: 'write',
  origins: navigateTool.origins,
  execute: (args, ctx) => navigateTool.execute({ url: args?.url }, ctx),
};

/** @type {import('/shared/tool-types.js').Tool} */
export const pageClickTool = {
  name: 'page_click',
  primitive: 'tab',
  description: [
    'Click the element matching a CSS selector (Playwright page.click). Get',
    'selectors from read_page or query_dom. STRICT: fails unless the selector',
    'matches exactly one element — pass nth (0-indexed) to choose among several',
    'deliberately.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the element to click.' },
      nth: { type: 'integer', description: 'Optional 0-indexed match when the selector matches several (disables the single-match guard).' },
    },
    required: ['selector'],
  },
  sideEffect: 'write',
  origins: clickTool.origins,
  execute: (args, ctx) => clickTool.execute(playwrightClickArgs(args), ctx),
};

/** @type {import('/shared/tool-types.js').Tool} */
export const pageFillTool = {
  name: 'page_fill',
  primitive: 'tab',
  description: [
    'Fill the input/textarea/contenteditable matching a CSS selector with text',
    '(Playwright page.fill). Get selectors from read_page or query_dom. STRICT:',
    'fails unless the selector matches exactly one element.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the field.' },
      text: { type: 'string', description: 'The value to set.' },
    },
    required: ['selector', 'text'],
  },
  sideEffect: 'write',
  origins: typeTool.origins,
  execute: (args, ctx) => typeTool.execute(playwrightFillArgs(args), ctx),
};

export const PLAYWRIGHT_TOOLS = [pageGotoTool, pageClickTool, pageFillTool];
