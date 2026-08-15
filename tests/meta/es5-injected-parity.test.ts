import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import { ES5_INJECTED } from '../../packaging/tscheck-coverage.ts';

/**
 * The deliberately-ES5 injected-into-page bodies are named in two places:
 * eslint.config.js exempts them from the modernization rules, and
 * tscheck-coverage.ts drops them from the typecheck-coverage denominator.
 * Both lists describe the SAME set of files, for the same reason: the source is
 * serialized and re-evaluated in a page's classic-script world, so it can carry
 * neither modern syntax nor a // @ts-check directive.
 *
 * why this test: the lists drifted. fetch-tap-injected.js was exempted in
 * eslint.config.js and missing from ES5_INJECTED, which quietly parked an
 * un-annotatable file in the coverage denominator and held the reported number
 * below 100% with nothing a contributor could do about it.
 */
describe('ES5 injected-body exemptions', () => {
  const eslintConfig = readFileSync(join(REPO_ROOT, 'eslint.config.js'), 'utf8');

  /** The `files: [...]` array of the injected-classic-script override block. */
  const eslintExemptions = (): string[] => {
    const block = /injected classic-script bodies[\s\S]*?files:\s*\[([\s\S]*?)\]/.exec(eslintConfig);
    if (!block) throw new Error('could not find the injected-classic-script override in eslint.config.js');
    return [...block[1].matchAll(/'extension\/([^']+)'/g)].map((match) => match[1]).sort();
  };

  test('eslint and the typecheck scan exempt exactly the same files', () => {
    expect(eslintExemptions()).toEqual([...ES5_INJECTED].sort());
  });

  test('every exempted file exists and is genuinely un-annotated', () => {
    for (const relativePath of ES5_INJECTED) {
      const source = readFileSync(join(REPO_ROOT, 'extension', relativePath), 'utf8');
      // A directive here would be inert (the body never reaches the checker)
      // and would misreport coverage, so its absence is the invariant.
      expect(source.split('\n').slice(0, 3).join('\n')).not.toMatch(/^[ \t]*\/\/[ \t]*@ts-check\b/m);
    }
  });
});
