// @ts-check
// Web tool escalation policy — pure heuristics.

import { describe, it, expect } from '../../../framework.js';
import {
  looksLikeSpaShell,
  matchesAntiBotTemplate,
  satisfiesExpects,
  shouldEscalate,
} from '/peerd-runtime/tools/web/policy.js';

const SHELL = `<!doctype html><html><head><title>App</title></head><body>
<div id="root"></div><script src="/bundle.js"></script></body></html>`;

const REAL_ARTICLE = `<!doctype html><html><head><title>Post</title></head><body>
<article><h1>A real post</h1><p>${'Lorem ipsum '.repeat(60)}</p></article>
<script>window.analytics = {};</script></body></html>`;

describe('web.policy', () => {
  describe('looksLikeSpaShell', () => {
    it('detects a classic SPA skeleton', () => {
      expect(looksLikeSpaShell(SHELL)).toBe(true);
    });
    it('does not flag a real article with a small script tag', () => {
      expect(looksLikeSpaShell(REAL_ARTICLE)).toBe(false);
    });
    it('does not flag HTML without any script tag', () => {
      expect(looksLikeSpaShell('<html><body><p>plain</p></body></html>')).toBe(false);
    });
    it('returns false on empty or non-string', () => {
      // why casts: deliberately feed non-string inputs to exercise the
      // runtime type guard (looksLikeSpaShell's signature is `string`).
      expect(looksLikeSpaShell('')).toBe(false);
      expect(looksLikeSpaShell(/** @type {string} */ (/** @type {unknown} */ (null)))).toBe(false);
      expect(looksLikeSpaShell(/** @type {string} */ (/** @type {unknown} */ (undefined)))).toBe(false);
    });
  });

  describe('matchesAntiBotTemplate', () => {
    it('flags Cloudflare challenges', () => {
      expect(matchesAntiBotTemplate('<title>Just a moment...</title>')).toBeTruthy();
      expect(matchesAntiBotTemplate('please enable cf-browser-verification cookie')).toBeTruthy();
    });
    it('flags reCAPTCHA / hCaptcha shells', () => {
      expect(matchesAntiBotTemplate('<div class="g-recaptcha"></div>')).toBeTruthy();
      expect(matchesAntiBotTemplate('script src="https://hcaptcha.com/1/api.js"')).toBeTruthy();
    });
    it('flags Akamai / Imperva access-denied pages', () => {
      expect(matchesAntiBotTemplate('Access Denied — your IP has been blocked')).toBeTruthy();
      expect(matchesAntiBotTemplate('Pardon Our Interruption while we verify')).toBeTruthy();
    });
    it('returns null for ordinary content', () => {
      expect(matchesAntiBotTemplate('A perfectly normal blog post body.')).toBe(null);
    });
  });

  describe('satisfiesExpects', () => {
    it('returns ok when expects is empty/missing', () => {
      expect(satisfiesExpects('anything', undefined).ok).toBe(true);
      expect(satisfiesExpects('anything', []).ok).toBe(true);
    });
    it('returns ok when all needles are present', () => {
      expect(satisfiesExpects('hello world', ['hello', 'world']).ok).toBe(true);
    });
    it('reports missing needles', () => {
      const r = satisfiesExpects('hello world', ['hello', 'goodbye']);
      expect(r.ok).toBe(false);
      expect(/** @type {{ ok: false, missing: string[] }} */ (r).missing).toEqual(['goodbye']);
    });
  });

  describe('shouldEscalate', () => {
    it('escalates on 403/429/503', () => {
      for (const status of [403, 429, 503]) {
        const r = shouldEscalate({ status, body: 'whatever', expects: undefined });
        expect(r.escalate).toBe(true);
      }
    });
    it('escalates on SPA shells', () => {
      const r = shouldEscalate({ status: 200, body: SHELL, expects: undefined });
      expect(r.escalate).toBe(true);
      expect(/** @type {{ escalate: true, reason: string }} */ (r).reason).toBe('spa_shell');
    });
    it('escalates on anti-bot templates', () => {
      const r = shouldEscalate({ status: 200, body: 'Just a moment...', expects: undefined });
      expect(r.escalate).toBe(true);
      expect(/** @type {{ escalate: true, reason: string }} */ (r).reason.startsWith('antibot:')).toBe(true);
    });
    it('escalates on missing expects', () => {
      const r = shouldEscalate({ status: 200, body: REAL_ARTICLE, expects: ['paywall sentinel'] });
      expect(r.escalate).toBe(true);
      expect(/** @type {{ escalate: true, reason: string }} */ (r).reason.startsWith('expects_missing:')).toBe(true);
    });
    it('does NOT escalate on a real article that matches expects', () => {
      const r = shouldEscalate({ status: 200, body: REAL_ARTICLE, expects: ['A real post'] });
      expect(r.escalate).toBe(false);
    });
    it('does NOT escalate on a 2xx article without any signals', () => {
      const r = shouldEscalate({ status: 200, body: REAL_ARTICLE, expects: undefined });
      expect(r.escalate).toBe(false);
    });
  });
});
