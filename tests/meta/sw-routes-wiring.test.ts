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
const SEMANTIC_HOST = [
  join(EXTENSION_DIR, 'offscreen/semantic-route-host.js'),
  ...readdirSync(join(EXTENSION_DIR, 'offscreen/semantic-routes'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => join(EXTENSION_DIR, 'offscreen/semantic-routes', file)),
].map((file) => readFileSync(file, 'utf8')).join('\n');
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

const factorySourceSpan = (src: string, factory: string): string => {
  const start = src.indexOf(`export const ${factory}`);
  if (start < 0) return '';
  const next = src.indexOf('\nexport const ', start + factory.length);
  return src.slice(start, next < 0 ? src.length : next);
};

/** Inner text of the object literal passed at the `...makeFooRoutes({ ... })` call site. */
const callSiteSpan = (factory: string): string | null => {
  const open = SW.indexOf(`${factory}({`);
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

const allRouteFiles = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
const routeFiles = allRouteFiles.filter((file) => {
  const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
  return factoryNames(source).some((factory) => callSiteSpan(factory) !== null);
});

describe('sw routes wiring (per-module deps)', () => {
  test('there is at least one extracted route module', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  test('every route factory removed from the cold worker is explicitly hosted by semantic dispatch', () => {
    const unwired = allRouteFiles.flatMap((file) => {
      const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
      return factoryNames(source)
        .filter((factory) => callSiteSpan(factory) === null)
        .filter((factory) => !SEMANTIC_HOST.includes(`${factory}(`))
        .map((factory) => `${file}:${factory}`);
    });
    expect(unwired).toEqual([]);
  });

  for (const file of routeFiles) {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const factories = factoryNames(src);

    test(`${file}: declares one or more uniquely named route factories`, () => {
      expect(factories.length).toBeGreaterThan(0);
      expect(new Set(factories).size).toBe(factories.length);
    });

    for (const factory of factories) {
      test(`${file}:${factory}: deps exactly match its call site`, () => {
        const used = [...new Set(destructuredDeps(factorySourceSpan(src, factory)))].sort();
        const provided = providedAtCallSite(factory);
        expect(provided).not.toBeNull();
        const prov = [...new Set(provided!)].sort();
        expect(used.filter((name) => !prov.includes(name))).toEqual([]);
        expect(prov.filter((name) => !used.includes(name))).toEqual([]);
      });

      test(`${file}:${factory}: wiring is shorthand-only`, () => {
        for (const span of destructureSpans(factorySourceSpan(src, factory))) {
          expect(nonShorthand(span)).toEqual([]);
        }
        const span = callSiteSpan(factory);
        expect(span).not.toBeNull();
        expect(nonShorthand(span!)).toEqual([]);
      });
    }

    test(`${file}: imports nothing (deps-injected, Bun-importable)`, () => {
      expect(/^\s*import\s/m.test(src)).toBe(false);
    });

  }
});
