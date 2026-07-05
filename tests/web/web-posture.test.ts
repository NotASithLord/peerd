// Web-target posture guards — the web analogue of tests/store/store-posture.
// These lock in the decisions that make the web demo safe to derive from live
// source (docs/specs/PEERD-WEB-SURFACE.md §10), so a refactor can't silently
// regress them. Assertions run against the GENERATORS + the curation SSOT
// (packaging/web-target.ts), not a built web-dist/ — pure values in/out, no
// staging needed, runs in the plain `bun test ./tests` CI job.

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { genChannelConfigSource, flattenDefaults } from '../../packaging/gen-channel-config.ts';
import { EXTENSION_DIR, TEMPLATES_DIR, STORE_LOADER_TEMPLATE } from '../../packaging/lib.ts';
import {
  WEB_INCLUDE_DIRS, WEB_PRUNE_WITHIN, WEB_SWAPS, WEB_STUB_PATHS,
} from '../../packaging/web-target.ts';

describe('web channel flavor', () => {
  const src = genChannelConfigSource('web');

  test('web build declares CHANNEL "web" — never lies "store"', () => {
    // why: any code branching on CHANNEL must see the truth; the demo is a
    // third destination, not a store artifact that happens to be on a page.
    expect(src).toContain('export const CHANNEL = "web"');
  });

  test('web build has DWEB_ENABLED false — the agent-side dweb gate stays shut', () => {
    // The shell peer talks to peerd-distributed directly (sanctioned); the
    // AGENT reaches dweb only through the loader, which the web build stubs.
    expect(src).toContain('export const DWEB_ENABLED = false');
  });

  test('web defaults fall back to the STORE posture per key', () => {
    // why: safety defaults stay strict; the demo diverges only where a key
    // declares an explicit web value. No web overrides exist yet, so the two
    // flat maps must be identical — a divergence here is a deliberate choice
    // that should update this test alongside default-settings.mjs.
    expect(flattenDefaults('web')).toEqual(flattenDefaults('store'));
  });
});

describe('web swaps + stubs', () => {
  test('the browser-polyfill swap exists and is the no-throw page shim', () => {
    const template = WEB_SWAPS['vendor/browser-polyfill.js'];
    expect(template).toBe('browser-polyfill.web.js');
    const body = readFileSync(join(TEMPLATES_DIR, template), 'utf8');
    // must not carry the extension-only module-scope throw — in CODE (the
    // shim's own comment QUOTES the message when explaining why it exists,
    // so strip comment lines before asserting).
    const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('should only be loaded in a browser extension');
    expect(code).not.toContain('throw new Error');
    // …and must export a default `browser` with the storage areas the staged
    // egress storage wrappers touch at import time.
    expect(body).toContain('export default browser');
    expect(body).toContain('storage');
  });

  test('every swap template exists on disk', () => {
    for (const template of Object.values(WEB_SWAPS)) {
      expect(existsSync(join(TEMPLATES_DIR, template))).toBe(true);
    }
    expect(existsSync(STORE_LOADER_TEMPLATE)).toBe(true);
  });

  test('stub templates match the real /background/ constants (value drift gate)', () => {
    // The stubs exist so curated tool defs can import two cosmetic title
    // constants without dragging extension chassis into the page. If upstream
    // changes a value (or renames the export), the web copy must not silently
    // diverge — same check package-web.ts enforces at build time.
    const exportRe = /^export const (\w+) = (.+?);/gm;
    for (const rel of WEB_STUB_PATHS) {
      const template = readFileSync(join(TEMPLATES_DIR, WEB_SWAPS[rel]), 'utf8');
      const real = readFileSync(join(EXTENSION_DIR, rel), 'utf8');
      exportRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      let constants = 0;
      while ((m = exportRe.exec(template))) {
        constants++;
        const realMatch = real.match(new RegExp(`export const ${m[1]} = (.+?);`));
        expect(realMatch?.[1]).toBe(m[2]);
      }
      expect(constants).toBeGreaterThan(0);
    }
  });

  test('stubbed paths are all declared as swaps', () => {
    for (const rel of WEB_STUB_PATHS) {
      expect(Object.keys(WEB_SWAPS)).toContain(rel);
    }
  });
});

describe('web curation invariants', () => {
  test('pruned vendor dirs are never statically imported by staged source', () => {
    // The prune list is only sound while these dirs are referenced as runtime
    // URL strings. A static import of a pruned dir would 404 the page —
    // check-web-boundary catches it post-build; this pins it pre-build.
    const prunedVendor = WEB_PRUNE_WITHIN.filter((p) => p.startsWith('vendor/'));
    const staticImportRe = (dir: string) => new RegExp(`from\\s+['"]/${dir}/`);
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'vendor' && entry.name !== 'node_modules') walk(p, out); }
        else if (entry.name.endsWith('.js')) out.push(p);
      }
      return out;
    };
    const sources = WEB_INCLUDE_DIRS.filter((d) => d !== 'vendor')
      .flatMap((d) => walk(join(EXTENSION_DIR, d)))
      .map((f) => readFileSync(f, 'utf8'));
    for (const pruned of prunedVendor) {
      const re = staticImportRe(pruned);
      const offender = sources.find((src) => re.test(src));
      expect(offender ?? null).toBeNull();
    }
  });

  test('peerd-distributed is included (the shell peer runs from source)', () => {
    expect(WEB_INCLUDE_DIRS).toContain('peerd-distributed');
  });
});
