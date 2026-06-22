// Guard: every name the service worker imports from the peerd-runtime barrel
// must be exported by that barrel.
//
// why this exists: the SW (background/service-worker.js) is an ES module Chrome
// links at registration. A named import the barrel doesn't re-export is a LINK
// error → "Service worker registration failed. Status code: 15" → the whole
// extension fails to load. Neither the bun suite NOR the in-browser CDP harness
// catches it: bun can't import the barrel (it transitively pulls extension-
// absolute paths like /background/*), and the in-browser tests don't register
// the background SW. This static check is the net — it would have caught a
// filterByDwebActive that was exported from exposure.js but never re-exported
// through index.js.
//
// The barrel uses only explicit `export { … } [from …]` / `export const|fn|class`
// (no `export *`), so a text parse is exact.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const stripComments = (s: string): string => s.replace(/\/\/[^\n]*/g, '');

/** All names the barrel re-exports or declares as exports. */
const barrelExports = (src: string): Set<string> => {
  const out = new Set<string>();
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of stripComments(m[1]).split(',')) {
      const name = raw.trim();
      if (!name) continue;
      const asMatch = name.match(/\bas\s+([A-Za-z0-9_$]+)$/); // `x as y` exports y
      out.add(asMatch ? asMatch[1] : name.split(/\s+/)[0]);
    }
  }
  for (const m of src.matchAll(/export\s+(?:const|let|function\*?|class)\s+([A-Za-z0-9_$]+)/g)) out.add(m[1]);
  return out;
};

/** Names the SW imports specifically from the peerd-runtime barrel. */
const swBarrelImports = (src: string): string[] => {
  // [^}]* (not [\s\S]*?) so the match can't span EARLIER import blocks from other
  // modules — an import's braces never contain a '}', so this isolates exactly the
  // peerd-runtime statement.
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]\/peerd-runtime\/index\.js['"]/);
  if (!m) throw new Error('could not find the SW import from /peerd-runtime/index.js');
  const names: string[] = [];
  for (const raw of stripComments(m[1]).split(',')) {
    const name = raw.trim();
    if (!name) continue;
    names.push(name.split(/\s+as\s+/)[0].trim()); // `a as b` needs the barrel to export a
  }
  return names;
};

describe('service-worker ↔ peerd-runtime barrel link integrity', () => {
  const swSrc = readFileSync(join(EXTENSION_DIR, 'background', 'service-worker.js'), 'utf8');
  const barrelSrc = readFileSync(join(EXTENSION_DIR, 'peerd-runtime', 'index.js'), 'utf8');
  const exported = barrelExports(barrelSrc);
  const imported = swBarrelImports(swSrc);

  test('parsed a non-trivial import + export set (the regex actually matched)', () => {
    expect(imported.length).toBeGreaterThan(20);
    expect(exported.size).toBeGreaterThan(20);
  });

  test('every SW import from the barrel is exported by it (a miss = SW registration failure, status 15)', () => {
    const missing = imported.filter((n) => !exported.has(n));
    expect(missing).toEqual([]);
  });
});
