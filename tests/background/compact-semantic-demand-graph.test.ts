import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';

const ROOT = resolve(import.meta.dir, '../..');
const GATEWAY = resolve(ROOT, 'extension/background/kernel-controller-call.js');
const RETIRED_GATEWAY = resolve(ROOT, 'extension/background/kernel-semantic-demand.js');
const DEMAND = resolve(ROOT, 'extension/background/semantic-demand-client.js');

describe('compact semantic demand static boundary', () => {
  test('cold gateway is one fixed static private-channel closure with no runtime import', async () => {
    const files = [...await collectStaticModuleGraph(ROOT, GATEWAY)];
    const graph = files
      .map((file) => file.slice(ROOT.length + 1)).sort();
    expect(graph).toEqual([
      'extension/background/kernel-controller-call.js',
      'extension/shared/build-config.js',
      'extension/shared/kernel-identity.js',
    ]);
    const source = readFileSync(GATEWAY, 'utf8');
    expect(source).not.toContain("from './semantic-demand-client.js'");
    for (const file of files) {
      const reachable = readFileSync(file, 'utf8');
      const executable = reachable.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      expect(executable, file).not.toMatch(/\bimport\(\s*(['"])[^'"]+\1\s*\)/);
      expect(executable, file).not.toContain('runtime.sendMessage');
      expect(executable, file).not.toContain('runtime.onMessage');
    }
    expect(source).not.toContain('runAgentTurn');
    expect(source).not.toContain('applyComposer');
  });

  test('the retired parallel demand client is physically absent', () => {
    expect(existsSync(DEMAND)).toBe(false);
    expect(existsSync(RETIRED_GATEWAY)).toBe(false);
  });
});
