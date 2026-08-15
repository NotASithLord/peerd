// Guard: every name the service worker imports from its peerd-runtime barrel
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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { init, parse } from 'es-module-lexer';
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

/** Names the SW imports specifically from its background runtime barrel. */
const swBarrelImports = (src: string): string[] => {
  // [^}]* (not [\s\S]*?) so the match can't span EARLIER import blocks from other
  // modules — an import's braces never contain a '}', so this isolates exactly the
  // peerd-runtime statement.
  const names: string[] = [];
  const matches = src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\/peerd-runtime\/background\.js['"]/g);
  for (const match of matches) {
    for (const raw of stripComments(match[1]).split(',')) {
      const name = raw.trim();
      if (!name) continue;
      names.push(name.split(/\s+as\s+/)[0].trim()); // `a as b` needs the barrel to export a
    }
  }
  if (!names.length) throw new Error('could not find the SW import from /peerd-runtime/background.js');
  return names;
};

/**
 * Every statically linked module Chrome must parse before the MV3 worker can
 * finish registration. Dynamic imports are deliberately excluded: they do not
 * delay listener registration and are the intended boundary for host-only code.
 */
const staticImportGraph = async (entry: string): Promise<Set<string>> => {
  await init;
  const graph = new Set<string>();
  const extensionPrefix = `${resolve(EXTENSION_DIR)}${sep}`;

  const visit = (file: string) => {
    const absolute = resolve(file);
    if (graph.has(absolute) || !existsSync(absolute)) return;
    graph.add(absolute);
    const source = readFileSync(absolute, 'utf8');
    for (const imported of parse(source)[0]) {
      if (imported.d !== -1 || !imported.n) continue;
      const specifier = imported.n.split(/[?#]/, 1)[0];
      const target = specifier.startsWith('/')
        ? resolve(EXTENSION_DIR, `.${specifier}`)
        : resolve(dirname(absolute), specifier);
      if (target.startsWith(extensionPrefix)) visit(target);
    }
  };

  visit(entry);
  return graph;
};

describe('service-worker ↔ peerd-runtime barrel link integrity', () => {
  const swSrc = readFileSync(join(EXTENSION_DIR, 'background', 'service-worker.js'), 'utf8');
  const barrelSrc = readFileSync(join(EXTENSION_DIR, 'peerd-runtime', 'background.js'), 'utf8');
  const universalSrc = readFileSync(join(EXTENSION_DIR, 'peerd-runtime', 'index.js'), 'utf8');
  const voicePickerSrc = readFileSync(
    join(EXTENSION_DIR, 'peerd-runtime', 'voice', 'engine-picker.js'),
    'utf8',
  );
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

  test('the SW-reachable runtime barrel excludes offscreen-only voice code', () => {
    // voice/index exposes the transcriber factory and reaches the multi-MB
    // Moonshine bundle. The universal barrel must export only lightweight
    // voice control/UI modules directly.
    expect(universalSrc).not.toMatch(/from\s*['"]\.\/voice\/index\.js['"]/);
    expect(universalSrc).not.toContain('createBestTranscriber');
    expect(universalSrc).toContain("from './voice/settings.js'");
    expect(swSrc).toContain("from '/peerd-runtime/background.js'");
    expect(swSrc).not.toContain("from '/peerd-runtime/index.js'");
    expect(swSrc).toContain("from '/peerd-engine/background.js'");
    expect(swSrc).not.toContain("from '/peerd-engine/index.js'");
    expect(barrelSrc).not.toContain("from './voice/mic-button.js'");
    expect(voicePickerSrc).not.toContain("from './transcriber.js'");
    expect(swSrc).not.toContain('/vendor/moonshine-js/');
  });

  test('the complete cold service-worker graph excludes universal and UI-only modules', async () => {
    const graph = await staticImportGraph(join(EXTENSION_DIR, 'background', 'service-worker.js'));
    const modules = new Set([...graph].map((file) => relative(EXTENSION_DIR, file)));

    // Keep this non-trivial assertion so a parser or path-resolution regression
    // cannot turn the exclusions below into vacuous passes.
    expect(modules.size).toBeGreaterThan(100);
    expect(modules).not.toContain('peerd-runtime/index.js');
    expect(modules).not.toContain('peerd-engine/index.js');
    expect(modules).not.toContain('peerd-runtime/voice/mic-button.js');
    expect(modules).not.toContain('peerd-voice-host/index.js');
    expect(modules).not.toContain('peerd-engine/editor.js');
    expect([...modules].some((file) => file.includes('vendor/codemirror'))).toBe(false);
    expect([...modules].some((file) => file.includes('vendor/moonshine-js'))).toBe(false);
  });
});
