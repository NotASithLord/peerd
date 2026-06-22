// @ts-check
// webFetch — denylist + scheme gate for arbitrary web tool fetches.

import { describe, it, expect } from '../../framework.js';
import { makeWebFetch } from '/peerd-egress/index.js';

/**
 * @param {string} host
 * @param {readonly string[]} patterns
 * @returns {boolean}
 */
const denyMatcher = (host, patterns) => patterns.some((p) => {
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);   // ".chase.com"
    return host.endsWith(suffix);
  }
  return host === p;
});

describe('peerd-egress.webFetch', () => {
  it('allows ordinary HTTPS hosts not on the denylist', async () => {
    /** @type {{ type: string, details: Record<string, any> }[]} */
    const audits = [];
    /** @type {RequestInfo | URL | null} */
    let fetched = null;
    const wf = makeWebFetch({
      getDenylist: () => [],
      matchDenylist: denyMatcher,
      audit: async (e) => { audits.push(/** @type {{ type: string, details: Record<string, any> }} */ (e)); },
      fetchFn: /** @type {typeof fetch} */ (async (url) => { fetched = url; return new Response('ok', { status: 200 }); }),
    });
    const res = await wf('https://example.com/page');
    expect(res.status).toBe(200);
    expect(fetched).toBe('https://example.com/page');
    expect(audits.some((a) => a.type === 'web_fetch')).toBe(true);
  });

  it('refuses denylisted hosts and audits the denial', async () => {
    /** @type {{ type: string, details: Record<string, any> }[]} */
    const audits = [];
    /** @type {RequestInfo | URL | null} */
    let fetched = null;
    const wf = makeWebFetch({
      getDenylist: () => ['chase.com', '*.chase.com'],
      matchDenylist: denyMatcher,
      audit: async (e) => { audits.push(/** @type {{ type: string, details: Record<string, any> }} */ (e)); },
      fetchFn: /** @type {typeof fetch} */ (async (url) => { fetched = url; return new Response('ok'); }),
    });
    await expect(() => wf('https://chase.com/login'))
      .toThrow(e => e.name === 'EgressDeniedError');
    expect(fetched).toBe(null);
    expect(audits.some((a) => a.type === 'egress_denied' && a.details.reason === 'denylist')).toBe(true);
  });

  it('refuses non-http schemes', async () => {
    /** @type {RequestInfo | URL | null} */
    let fetched = null;
    const wf = makeWebFetch({
      getDenylist: () => [],
      matchDenylist: denyMatcher,
      fetchFn: /** @type {typeof fetch} */ (async (url) => { fetched = url; return new Response('ok'); }),
    });
    await expect(() => wf('file:///etc/passwd'))
      .toThrow(e => e.name === 'EgressDeniedError');
    expect(fetched).toBe(null);
  });

  it('refuses malformed URLs', async () => {
    const wf = makeWebFetch({
      getDenylist: () => [],
      matchDenylist: denyMatcher,
      fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => new Response('ok'))),
    });
    await expect(() => wf('not a url at all'))
      .toThrow(e => e.name === 'EgressDeniedError');
  });

  it('matches wildcards in the denylist', async () => {
    const wf = makeWebFetch({
      getDenylist: () => ['*.proton.me'],
      matchDenylist: denyMatcher,
      fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => new Response('ok'))),
    });
    await expect(() => wf('https://mail.proton.me/login'))
      .toThrow(e => e.name === 'EgressDeniedError');
  });

  it('does NOT match similar-but-different hosts (no fuzzy matching)', async () => {
    /** @type {RequestInfo | URL | null} */
    let fetched = null;
    const wf = makeWebFetch({
      getDenylist: () => ['*.proton.me'],
      matchDenylist: denyMatcher,
      fetchFn: /** @type {typeof fetch} */ (async (url) => { fetched = url; return new Response('ok'); }),
    });
    // protonmail.com must NOT match *.proton.me (per DESIGN §4.2)
    const res = await wf('https://protonmail.com/');
    expect(res.status).toBe(200);
    expect(fetched).toBe('https://protonmail.com/');
  });
});
