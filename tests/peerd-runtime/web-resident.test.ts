import { describe, test, expect } from 'bun:test';
import {
  fenceWebResidentSummary,
  WEB_RESIDENT_SUMMARY_PROMPT,
  makeWebResidentBindings,
} from '../../extension/peerd-runtime/subagent/web-resident.js';
import { stripUntrustedFences } from '../../extension/shared/util.js';

describe('fenceWebResidentSummary — self-fence the resident\'s own memory', () => {
  test('wraps the summary as untrusted, body preserved (round-trips with the strip)', () => {
    const fenced = fenceWebResidentSummary('clicked Login; the form is a modal', { now: () => 0 });
    expect(fenced.includes('<untrusted_web_content')).toBe(true);
    expect(fenced.includes('clicked Login; the form is a modal')).toBe(true);
    expect(stripUntrustedFences(fenced)).toBe('clicked Login; the form is a modal');
  });
  test('tags the origin as the web resident (not a real web origin)', () => {
    expect(fenceWebResidentSummary('x', { tabUrl: 'https://app.com', now: () => 0 }))
      .toContain('web-resident(https://app.com)');
  });
  test('a non-string summary fences to an empty body, never throws', () => {
    expect(stripUntrustedFences(fenceWebResidentSummary(undefined as unknown as string, { now: () => 0 }))).toBe('');
  });
});

describe('WEB_RESIDENT_SUMMARY_PROMPT — action-log shaped', () => {
  test('keeps progress, drops verbatim page text, treats injection as data', () => {
    expect(WEB_RESIDENT_SUMMARY_PROMPT).toContain('PROGRESS');
    expect(WEB_RESIDENT_SUMMARY_PROMPT).toContain('DROP verbatim page text');
    expect(WEB_RESIDENT_SUMMARY_PROMPT.toLowerCase()).toContain('instruction');
  });
});

describe('makeWebResidentBindings — tab→session store (the tab is the durable handle)', () => {
  test('bind / resolve / has / drop', () => {
    const b = makeWebResidentBindings();
    expect(b.resolve(7)).toBeNull();
    b.bind(7, 'res-web-1');
    expect(b.resolve(7)).toBe('res-web-1');
    expect(b.has(7)).toBe(true);
    expect(b.drop(7)).toBe(true);
    expect(b.resolve(7)).toBeNull();
  });
  test('entries + load (rehydrate on SW boot)', () => {
    const b = makeWebResidentBindings();
    b.bind(1, 'a'); b.bind(2, 'b');
    expect(b.entries().sort()).toEqual([[1, 'a'], [2, 'b']]);
    const b2 = makeWebResidentBindings();
    b2.load(b.entries());
    expect(b2.resolve(2)).toBe('b');
  });
});
