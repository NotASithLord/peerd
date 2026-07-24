import { describe, test, expect } from 'bun:test';
import { classifyUrl, UGC_RULES } from '../../../extension/peerd-runtime/actor/ugc-registry.js';

// security-arc #242 — the pure UGC-zone classifier. These pins nail the
// contract the exposure/gate follow-up will build on: every known zone → `ugc`
// with its ruleId, ordinary pages → `standard`, path specificity (a repo's
// /settings is not a zone, its /issues is), origin normalization (case, trailing
// slash, port, query all ignored), and fail-open on garbage input.

describe('classifyUrl — known UGC zones', () => {
  const ugcCases: Array<[string, string]> = [
    ['https://github.com/anthropics/peerd/issues/242', 'github-issues-pulls'],
    ['https://github.com/anthropics/peerd/pull/218', 'github-issues-pulls'],
    ['https://github.com/anthropics/peerd/discussions/10', 'github-issues-pulls'],
    ['https://docs.google.com/document/d/1AbC/edit', 'google-docs'],
    ['https://docs.google.com/spreadsheets/d/1AbC/edit', 'google-docs'],
    ['https://acme.atlassian.net/browse/ENG-123', 'atlassian-jira-confluence'],
    ['https://acme.atlassian.net/wiki/spaces/DEV/pages/42', 'atlassian-jira-confluence'],
    ['https://linear.app/acme/issue/ENG-123/fix-the-thing', 'linear-issue'],
    ['https://www.reddit.com/r/programming/comments/abc123/title/', 'reddit-comments'],
    ['https://twitter.com/jack/status/20', 'twitter-status'],
    ['https://x.com/jack/status/20', 'twitter-status'],
  ];

  for (const [url, ruleId] of ugcCases) {
    test(`${url} → ugc (${ruleId})`, () => {
      expect(classifyUrl(url)).toEqual({ zone: 'ugc', ruleId });
    });
  }
});

describe('classifyUrl — standard (non-UGC) pages', () => {
  const standardCases = [
    'https://github.com/anthropics/peerd',            // repo root
    'https://github.com/anthropics',                  // org page
    'https://example.com/',                           // arbitrary marketing site
    'https://peerd.ai/',                              // arbitrary site
    'https://docs.google.com/',                       // host root, no doc surface
    'https://linear.app/',                            // marketing root
    'https://www.reddit.com/r/programming',           // subreddit listing, not a thread
    'https://twitter.com/jack',                       // profile, not a status
  ];

  for (const url of standardCases) {
    test(`${url} → standard`, () => {
      expect(classifyUrl(url)).toEqual({ zone: 'standard' });
    });
  }
});

describe('classifyUrl — path specificity', () => {
  test('github repo /settings is NOT ugc', () => {
    expect(classifyUrl('https://github.com/anthropics/peerd/settings')).toEqual({ zone: 'standard' });
  });

  test('github repo /issues IS ugc', () => {
    expect(classifyUrl('https://github.com/anthropics/peerd/issues')).toEqual({
      zone: 'ugc',
      ruleId: 'github-issues-pulls',
    });
  });

  test('github /actions is NOT ugc (adjacent trusted path)', () => {
    expect(classifyUrl('https://github.com/anthropics/peerd/actions')).toEqual({ zone: 'standard' });
  });
});

describe('classifyUrl — normalization', () => {
  test('trailing slash is ignored', () => {
    expect(classifyUrl('https://github.com/anthropics/peerd/issues/242/')).toMatchObject({ zone: 'ugc' });
  });

  test('host case is normalized', () => {
    expect(classifyUrl('https://GitHub.com/anthropics/peerd/issues/242')).toMatchObject({ zone: 'ugc' });
  });

  test('explicit default port is dropped', () => {
    expect(classifyUrl('https://github.com:443/anthropics/peerd/issues/242')).toMatchObject({ zone: 'ugc' });
  });

  test('query string is ignored for classification', () => {
    expect(classifyUrl('https://github.com/anthropics/peerd/issues/242?tab=comments')).toMatchObject({ zone: 'ugc' });
  });

  test('fragment is ignored for classification', () => {
    expect(classifyUrl('https://github.com/anthropics/peerd/issues/242#issuecomment-1')).toMatchObject({ zone: 'ugc' });
  });

  test('www. host prefix still matches', () => {
    expect(classifyUrl('https://www.github.com/anthropics/peerd/issues/242')).toMatchObject({ zone: 'ugc' });
  });

  test('atlassian tenant wildcard matches any subdomain', () => {
    expect(classifyUrl('https://another-tenant.atlassian.net/browse/OPS-9')).toMatchObject({
      zone: 'ugc',
      ruleId: 'atlassian-jira-confluence',
    });
  });
});

describe('classifyUrl — malformed / non-public input fails open to standard', () => {
  const badInputs: unknown[] = [
    '',
    '   ',
    'not a url',
    'javascript:alert(1)',
    'ftp://github.com/x/y/issues/1',   // non-http(s) scheme
    'http://localhost/x/y/issues/1',   // private origin rejected by normalizer
    'http://127.0.0.1/x/y/issues/1',   // bare IP rejected by normalizer
    null,
    undefined,
    42,
    {},
  ];

  for (const input of badInputs) {
    test(`${JSON.stringify(input)} → standard, no throw`, () => {
      expect(() => classifyUrl(input as any)).not.toThrow();
      expect(classifyUrl(input as any)).toEqual({ zone: 'standard' });
    });
  }
});

describe('registry shape', () => {
  test('UGC_RULES is frozen and every entry is frozen', () => {
    expect(Object.isFrozen(UGC_RULES)).toBe(true);
    for (const rule of UGC_RULES) expect(Object.isFrozen(rule)).toBe(true);
  });

  test('rule ids are unique', () => {
    const ids = UGC_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
