import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Firefox js_run/read_pdf fix (#6) lives in service-worker.js, which can't
// be imported under bun (no chrome/browser globals) — so, like pricing.test.ts,
// we assert against the SOURCE TEXT. This pins the ACTUAL changed line (the
// `offscreenAvailable ? … : null` gate), which the tool-contract test
// js-run-unavailable.test.ts does NOT cover: that one exercises the tool's
// pre-existing `if (!client)` guard (byte-identical on main), so it would pass
// even with this SW gate reverted. Reverting the gate fails the assertions here.
const src = readFileSync(
  join(import.meta.dir, '../../extension/background/service-worker.js'),
  'utf8',
);

describe('service worker — offscreen client gating (Firefox parity, #6)', () => {
  test('offscreenAvailable is derived from the chrome.offscreen probe', () => {
    // same predicate ensureOffscreen uses for its Firefox early-return, so the
    // gate and the runtime host degrade together.
    expect(src).toMatch(/const offscreenAvailable\s*=\s*typeof[\s\S]{0,80}offscreen\?\.createDocument\s*===\s*'function'/);
  });

  test('jsOffscreenClient is gated to null when offscreen is absent', () => {
    expect(src).toMatch(/const jsOffscreenClient\s*=\s*offscreenAvailable\s*\?\s*makeOffscreenJsClient\(/);
    expect(src).toMatch(/makeOffscreenJsClient\([\s\S]{0,200}?\)\s*:\s*null;/);
  });

  test('pdfOffscreenClient is gated to null when offscreen is absent', () => {
    expect(src).toMatch(/const pdfOffscreenClient\s*=\s*offscreenAvailable\s*\?\s*makeOffscreenPdfClient\(/);
    expect(src).toMatch(/makeOffscreenPdfClient\([\s\S]{0,200}?\)\s*:\s*null;/);
  });
});
