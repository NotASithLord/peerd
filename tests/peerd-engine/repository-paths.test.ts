import { describe, test, expect } from 'bun:test';
import { repositoryPaths } from '../../extension/peerd-engine/repository/paths.js';
import {
  createOpfsGitFs, normalizeRepositoryPath,
} from '../../extension/peerd-engine/repository/opfs-fs.js';

describe('repository storage paths', () => {
  test('keeps worktrees and Git object stores as siblings', () => {
    expect(repositoryPaths({ kind: 'app', id: 'app-1' })).toEqual({
      dir: '/peerd-apps/app-1', gitdir: '/peerd-git/app/app-1',
    });
    expect(repositoryPaths({ kind: 'notebook', id: 'note-1' })).toEqual({
      dir: '/peerd-notebooks/note-1', gitdir: '/peerd-git/notebook/note-1',
    });
    expect(repositoryPaths({ kind: 'pod', id: 'pod-1' })).toEqual({
      dir: '/peerd-pods/pod-1', gitdir: '/peerd-git/pod/pod-1',
    });
  });

  test('rejects traversal and unsupported repository kinds', () => {
    expect(() => repositoryPaths({ kind: 'app', id: '../escape' })).toThrow();
    expect(() => repositoryPaths({ kind: 'webvm', id: 'vm-1' })).toThrow();
    expect(() => normalizeRepositoryPath('/safe/../escape')).toThrow();
    expect(() => normalizeRepositoryPath('safe\\escape')).toThrow();
  });

  test('makes a forced OPFS leaf removal idempotent', async () => {
    const directory: any = {
      getDirectoryHandle: async () => directory,
      removeEntry: async () => { throw new DOMException('missing', 'NotFoundError'); },
    };
    const fs = createOpfsGitFs({ getRoot: async () => directory });
    await expect(fs.promises.rm('/peerd-git/app/app-1', {
      recursive: true, force: true,
    })).resolves.toBeUndefined();
    await expect(fs.promises.rm('/peerd-git/app/app-1'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

});
