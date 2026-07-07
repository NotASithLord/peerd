// The web-actor eval suite is only meaningful if the fixture site actually
// serves the exact values the tasks assert on. These tests couple the two
// sides (scripts/cdp/fixtures/web-suite.mjs ↔ extension/eval/tasks.js
// WEB_ACTOR_TASKS) so an edit to one that breaks the other fails HERE, in the
// fast tier — not silently as a mysteriously-failing benchmark task later.

import { describe, test, expect } from 'bun:test';
import { route } from '../../scripts/cdp/fixtures/web-suite.mjs';
import { WEB_ACTOR_TASKS, SUITES } from '../../extension/eval/tasks.js';

describe('web-actor fixture — serves what the tasks assert', () => {
  test('home heading is the store name (web-home-heading)', () => {
    expect(route('GET', '/').html).toContain('Peerdmart');
  });

  test('the product list carries all three names (web-products-list-all)', () => {
    const html = route('GET', '/products').html;
    for (const n of ['Coffee Mug', 'Notebook', 'Pen Set']) expect(html).toContain(n);
  });

  test('prices + SKU + stock match the extraction tasks', () => {
    expect(route('GET', '/products').html).toContain('$8.50');              // web-product-price
    expect(route('GET', '/products/mug').html).toContain('PM-MUG-001');     // web-click-sku
    expect(route('GET', '/products/notebook').html).toContain('In stock: 23'); // web-multihop-stock
    // web-compare-prices: Pen Set $15.00 - Notebook $8.50 = $6.50
    expect(route('GET', '/products/pens').html).toContain('$15.00');
  });

  test('the contact form posts back a deterministic confirmation (web-form-submit)', () => {
    const form = route('GET', '/contact').html;
    for (const f of ['name', 'email', 'orderId', 'message']) expect(form).toContain(`name="${f}"`);
    expect(route('POST', '/contact', 'orderId=1042&name=Ada').html).toContain('TICKET-1042');
  });

  test('the Contact link target is /contact (web-link-target)', () => {
    expect(route('GET', '/').html).toContain('href="/contact"');
  });

  test('absent pages/products 404 — the honest-refusal probes have nothing to find', () => {
    expect(route('GET', '/careers').status).toBe(404);                 // web-honest-no-careers
    expect(route('GET', '/products').html).not.toContain('Wireless Keyboard'); // web-honest-missing-price
  });
});

describe('web-actor suite — shape', () => {
  test('registered in SUITES and non-empty', () => {
    expect(SUITES['web-actor']?.tasks).toBe(WEB_ACTOR_TASKS);
    expect(WEB_ACTOR_TASKS.length).toBeGreaterThanOrEqual(8);
  });

  test('every task has a unique id, a check fn, and references the __FIXTURE__ sentinel', () => {
    const ids = new Set<string>();
    for (const t of WEB_ACTOR_TASKS) {
      expect(typeof t.check).toBe('function');
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      const usesFixture = (t.startUrl || '').includes('__FIXTURE__') || t.prompt.includes('__FIXTURE__');
      expect(usesFixture).toBe(true);
    }
  });
});
