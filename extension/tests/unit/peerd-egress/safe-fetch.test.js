// @ts-check
// safeFetch / egress allowlist tests.
//
// These exercise the security guarantee from §4.5: requests to anything
// outside the allowlist throw EgressDeniedError synchronously (well, in
// the resolved promise) without dispatching the underlying fetch.

import { describe, it, expect } from '../../framework.js';
import {
  HARDCODED_ALLOWLIST,
  originOf,
  isAllowed,
  makeSafeFetch,
} from '/peerd-egress/index.js';

describe('egress', () => {
  describe('originOf', () => {
    it('extracts protocol+host from a string', () => {
      expect(originOf('https://api.anthropic.com/v1/messages')).toBe('https://api.anthropic.com');
    });
    it('extracts from a URL object', () => {
      expect(originOf(new URL('http://localhost:11434/api/chat'))).toBe('http://localhost:11434');
    });
    it('preserves non-default ports', () => {
      expect(originOf('https://example.com:8443/x')).toBe('https://example.com:8443');
    });
  });

  describe('isAllowed', () => {
    it('does exact origin matches only — no substrings', () => {
      const list = ['https://api.anthropic.com'];
      expect(isAllowed('https://api.anthropic.com', list)).toBe(true);
      expect(isAllowed('https://api.anthropic.com.evil.com', list)).toBe(false);
      expect(isAllowed('https://evil.com/?u=https://api.anthropic.com', list)).toBe(false);
    });
    it('http and https are distinct origins', () => {
      const list = ['https://api.anthropic.com'];
      expect(isAllowed('http://api.anthropic.com', list)).toBe(false);
    });
  });

  describe('makeSafeFetch', () => {
    it('forwards allowed origins to the underlying fetch', async () => {
      let called = false;
      const sf = makeSafeFetch({
        getAllowlist: () => ['https://api.anthropic.com'],
        fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => { called = true; return new Response('ok'); })),
      });
      const res = await sf('https://api.anthropic.com/v1/messages');
      expect(called).toBe(true);
      expect(await res.text()).toBe('ok');
    });

    it('throws EgressDeniedError for disallowed origins', async () => {
      let called = false;
      const sf = makeSafeFetch({
        getAllowlist: () => ['https://api.anthropic.com'],
        fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => { called = true; return new Response('ok'); })),
      });
      await expect(() => sf('https://evil.com/exfil')).toThrow(e => e.name === 'EgressDeniedError');
      expect(called).toBe(false);
    });

    it('audits the denial', async () => {
      /** @type {{ type: string, details?: Record<string, any> }[]} */
      const auditLog = [];
      const sf = makeSafeFetch({
        getAllowlist: () => [],
        fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => new Response('ok'))),
        audit: async (entry) => { auditLog.push(entry); },
      });
      await expect(() => sf('https://evil.com/x')).toThrow();
      // The throw is synchronous (within the promise) but the audit
      // write happens before. Wait a microtask to let it land.
      await Promise.resolve();
      expect(auditLog.length).toBe(1);
      expect(auditLog[0].type).toBe('egress_denied');
      expect((/** @type {{ details: Record<string, any> }} */ (auditLog[0])).details.origin).toBe('https://evil.com');
    });

    it('re-reads the allowlist on every call (no stale closure)', async () => {
      /** @type {string[]} */
      let allow = [];
      const sf = makeSafeFetch({
        getAllowlist: () => allow,
        fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => new Response('ok'))),
      });
      await expect(() => sf('https://example.com')).toThrow();
      allow = ['https://example.com'];
      const res = await sf('https://example.com');
      expect(await res.text()).toBe('ok');
    });
  });

  describe('HARDCODED_ALLOWLIST', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(HARDCODED_ALLOWLIST)).toBe(true);
    });
    it('contains the V1 provider endpoints', () => {
      expect(HARDCODED_ALLOWLIST).toContain('https://api.anthropic.com');
      expect(HARDCODED_ALLOWLIST).toContain('https://api.openai.com');
      expect(HARDCODED_ALLOWLIST).toContain('http://localhost:11434');
      expect(HARDCODED_ALLOWLIST).toContain('http://127.0.0.1:11434');
    });
  });
});
