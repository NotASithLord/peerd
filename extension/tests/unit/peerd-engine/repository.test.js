// @ts-check
// Real browser integration for the vendored Git engine + OPFS adapter. This is
// the seam Bun cannot exercise: MV3-compatible code, browser storage handles,
// and the no-build UMD bundle loaded under the extension CSP.

import { describe, it, expect } from '../../framework.js';
import { createRepositoryService, opfsHelpers } from '/peerd-engine/index.js';

describe('peerd-engine repository — real OPFS + vendored Git', () => {
  it('runs a practical local Pod Git workflow against the Pod OPFS tree', async () => {
    const id = `pod-repository-test-${Date.now().toString(36)}`;
    const ref = { kind: 'pod', id };
    const files = opfsHelpers(['peerd-pods', id]);
    const repositories = createRepositoryService();
    try {
      await files.write('README.md', '# pod\n');
      await repositories.init(ref, { message: 'initial Pod' });
      await files.write('src/main.js', 'export const answer = 42;\n');
      expect((await repositories.status(ref)).dirty).toBe(true);
      expect((await repositories.stage(ref, { paths: ['src/main.js'] })).staged)
        .toEqual(['src/main.js']);
      const commit = await repositories.commit(ref, { message: 'add source' });
      expect(commit.created).toBe(true);
      expect((await repositories.history(ref, { depth: 5 }))[0].message).toBe('add source');
      await repositories.branch(ref, { name: 'experiment', checkout: true });
      expect((await repositories.status(ref)).branch).toBe('experiment');
      await repositories.checkout(ref, { name: 'main' });
      expect((await repositories.status(ref)).branch).toBe('main');
    } finally {
      await repositories.destroy(ref, { worktree: true });
    }
  });

  it('commits, diffs, restores, and branches without Linux', async () => {
    const id = `repository-test-${Date.now().toString(36)}`;
    const ref = { kind: 'app', id };
    const files = opfsHelpers(['peerd-apps', id]);
    const repositories = createRepositoryService();
    try {
      await files.write('index.html', '<h1>one</h1>\n');
      await files.write('.gitignore', '.env\n');
      await files.write('__proto__', 'prototype-shaped file\n');
      await files.write('constructor', 'constructor-shaped file\n');
      await files.write('toString', 'string-shaped file\n');
      const firstOid = await repositories.init(ref, { message: 'initial app' });
      expect(typeof firstOid).toBe('string');
      expect((await repositories.status(ref)).dirty).toBe(false);
      const initialSnapshot = await repositories.snapshot(ref, { at: firstOid });
      expect(Object.hasOwn(initialSnapshot, '__proto__')).toBe(true);
      expect(Object.hasOwn(initialSnapshot, 'constructor')).toBe(true);
      expect(Object.hasOwn(initialSnapshot, 'toString')).toBe(true);

      await files.write('index.html', '<h1>two</h1>\n');
      await files.write('src/main.js', 'export const n = 2;\n');
      const liveDiff = await repositories.diff(ref);
      expect(liveDiff.files.map((/** @type {{path:string}} */ f) => f.path)).toEqual(['index.html', 'src/main.js']);
      const second = await repositories.commit(ref, { message: 'second app' });
      expect(second.created).toBe(true);
      expect((await repositories.history(ref, { depth: 5 })).length).toBe(2);

      // A restore is allowed to be destructive only after the exact live tree
      // (including ignored local bytes) is preserved on a private safety ref.
      await files.write('index.html', '<h1>uncommitted</h1>\n');
      await files.write('.env', 'TOKEN=local-only\n');
      const secretSafeDiff = await repositories.diff(ref);
      expect(secretSafeDiff.files.some((/** @type {{path:string}} */ file) => file.path === '.env')).toBe(false);
      expect(secretSafeDiff.patch.includes('TOKEN=local-only')).toBe(false);

      const restored = await repositories.restore(ref, { to: firstOid });
      expect(restored.restored).toBe(true);
      expect(typeof restored.checkpointOid).toBe('string');
      expect(await files.read('index.html')).toBe('<h1>one</h1>\n');
      await expect(() => files.read('src/main.js')).toThrow((e) => e?.name === 'NotFoundError');
      await expect(() => files.read('.env')).toThrow((e) => e?.name === 'NotFoundError');
      expect((await repositories.history(ref, { depth: 10 })).some((/** @type {{safety?:boolean}} */ row) => row.safety)).toBe(false);
      expect((await repositories.history(ref, { depth: 10, includeSafety: true })).some((/** @type {{safety?:boolean,oid:string}} */ row) => row.safety && row.oid === restored.checkpointOid)).toBe(true);

      // The private safety commit is itself restorable, proving ignored bytes
      // were not merely named in metadata but actually recoverable.
      await repositories.restore(ref, { to: restored.checkpointOid });
      expect(await files.read('index.html')).toBe('<h1>uncommitted</h1>\n');
      expect(await files.read('.env')).toBe('TOKEN=local-only\n');

      await repositories.branch(ref, { name: 'experiment', checkout: true });
      expect((await repositories.status(ref)).branch).toBe('experiment');
    } finally {
      await repositories.destroy(ref, { worktree: true });
    }
  });
});
