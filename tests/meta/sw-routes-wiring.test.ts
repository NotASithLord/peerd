// Guard: every route module is wired with an EXPLICIT per-module deps object
// whose keys EXACTLY match what the module destructures — no missing key
// (undefined at call time → silent break) and no dead key (wiring cruft).
//
// why this exists: the route modules (background/routes/*.js) are hand-wired
// with `...makeXRoutes({ ...collaborators })` in the service worker. A name the
// module destructures but the call site forgets is `undefined` at call time — a
// silent runtime break that NEITHER the Bun suite (can't import the SW) NOR the
// in-browser harness (doesn't register the SW) would catch. This static check
// is that net. ESLint no-undef covers the other direction (a deps entry naming
// a binding that doesn't exist). Together they make the manual wiring safe.

import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const SW = readFileSync(join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8');
const ROUTES_DIR = join(EXTENSION_DIR, 'background/routes');

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Comma-separated entries of an object/destructure span, comments stripped,
 *  trimmed, empties dropped — raw (NOT reduced to the key). */
const rawEntries = (s: string): string[] =>
  stripComments(s).split(',').map((x) => x.trim()).filter(Boolean);

/** A shorthand-only span has every entry a bare identifier — no `key: value`.
 *  Enforcing this is what lets the name-level set-compare also catch a VALUE
 *  mis-wire (`settingsStore: someSnapshot`): such an entry isn't shorthand, so
 *  it's rejected before it can pass the name check under a right-looking key. */
const SHORTHAND = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const nonShorthand = (s: string): string[] => rawEntries(s).filter((e) => !SHORTHAND.test(e));
const idents = (s: string): string[] => rawEntries(s).filter((e) => SHORTHAND.test(e));

/** Inner text of EVERY `const { … } = deps` block in a module (not just the
 *  first — a second hidden block would otherwise dodge the check). */
const destructureSpans = (src: string): string[] =>
  [...stripComments(src).matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*deps/g)].map((m) => m[1]);

const destructuredDeps = (src: string): string[] => destructureSpans(src).flatMap(idents);

/** `export const makeFooRoutes = (deps) =>` factory names declared in a file. */
const factoryNames = (src: string): string[] =>
  [...src.matchAll(/export const (make\w+Routes)\s*=/g)].map((m) => m[1]);

/** Inner text of the object literal passed at the `...makeFooRoutes({ ... })` call site. */
const callSiteSpan = (factory: string): string | null => {
  const open = SW.indexOf(`...${factory}({`);
  if (open === -1) return null;
  // Walk from the first `{` matching braces to find the object-literal span.
  const braceStart = SW.indexOf('{', open);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < SW.length; i += 1) {
    if (SW[i] === '{') depth += 1;
    else if (SW[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  return SW.slice(braceStart + 1, end);
};
const providedAtCallSite = (factory: string): string[] | null => {
  const span = callSiteSpan(factory);
  return span === null ? null : idents(span);
};

const routeFiles = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));

describe('sw routes wiring (per-module deps)', () => {
  test('there is at least one extracted route module', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  for (const file of routeFiles) {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const factories = factoryNames(src);

    test(`${file}: declares exactly one route factory`, () => {
      expect(factories.length).toBe(1);
    });

    test(`${file}: its deps object EXACTLY matches what it destructures`, () => {
      const used = [...new Set(destructuredDeps(src))].sort();
      const provided = providedAtCallSite(factories[0]);
      expect(provided).not.toBeNull();
      const prov = [...new Set(provided!)].sort();
      // Missing = used by the module but not provided at the call site → undefined at runtime.
      expect(used.filter((n) => !prov.includes(n))).toEqual([]);
      // Dead = provided at the call site but never used by the module → wiring cruft.
      expect(prov.filter((n) => !used.includes(n))).toEqual([]);
    });

    test(`${file}: imports nothing (deps-injected, Bun-importable)`, () => {
      expect(/^\s*import\s/m.test(src)).toBe(false);
    });

    test(`${file}: wiring is shorthand-only (no key:value mis-wire can hide)`, () => {
      // Destructure side: `const { settingsStore: x } = deps` would let the body
      // use `x` while the name check sees `settingsStore` — reject aliases.
      for (const span of destructureSpans(src)) expect(nonShorthand(span)).toEqual([]);
      // Call-site side: `{ settingsStore: someSnapshot }` binds the wrong value
      // under a right-looking key — reject so the set-compare stays value-honest.
      const span = callSiteSpan(factories[0]);
      expect(span).not.toBeNull();
      expect(nonShorthand(span!)).toEqual([]);
    });
  }
});
