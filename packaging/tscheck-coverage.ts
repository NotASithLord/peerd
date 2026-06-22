// Shared // @ts-check coverage scan — used by the ratchet (check-tscheck.ts)
// AND the badge generator (gen-tscheck-badge.ts) so both report the same
// number from one implementation.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EXTENSION_DIR } from './lib.ts';

// Deliberately-ES5 injected-into-page bodies (see eslint.config.js): serialized
// via .toString() and re-evaluated in a target page's classic-script world, so
// they are exempt from the modern-JS rules AND from type checking. They don't
// count toward the denominator.
export const ES5_INJECTED = new Set<string>([
  'peerd-runtime/dom/walk-injected.js',
  'peerd-runtime/dom/framework-state.js',
  'peerd-runtime/dom/pull-in-hint-injected.js',
  'background/debugger-pool.js',
  'peerd-runtime/tools/defs/watch-changes.js',
]);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'vendor' || entry === 'node_modules') continue;
      walk(p, out);
    } else if (entry.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
};

// // @ts-check must be in the file's leading comment block (TS only honors it
// before the first statement); checking the first 3 lines is enough and avoids
// matching the literal string elsewhere in the file.
const hasDirective = (src: string): boolean =>
  /^[ \t]*\/\/[ \t]*@ts-check\b/m.test(src.split('\n').slice(0, 3).join('\n'));

export interface TscheckCoverage { count: number; total: number; pct: number; }

/** Scan the extension for // @ts-check coverage. Pure read; no side effects. */
export const computeCoverage = (): TscheckCoverage => {
  const files = walk(EXTENSION_DIR).filter((f) => !ES5_INJECTED.has(relative(EXTENSION_DIR, f)));
  const count = files.filter((f) => hasDirective(readFileSync(f, 'utf8'))).length;
  const total = files.length;
  return { count, total, pct: (count / total) * 100 };
};
