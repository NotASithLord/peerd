import { describe, test, expect } from 'bun:test';
import { repositoryPaths } from '../../extension/peerd-engine/repository/paths.js';
import { normalizeRepositoryPath } from '../../extension/peerd-engine/repository/opfs-fs.js';

describe('repository storage paths', () => {
  test('keeps worktrees and Git object stores as siblings', () => {
    expect(repositoryPaths({ kind: 'app', id: 'app-1' })).toEqual({
      dir: '/peerd-apps/app-1', gitdir: '/peerd-git/app/app-1',
    });
    expect(repositoryPaths({ kind: 'notebook', id: 'note-1' })).toEqual({
      dir: '/peerd-notebooks/note-1', gitdir: '/peerd-git/notebook/note-1',
    });
  });

  test('rejects traversal and unsupported repository kinds', () => {
    expect(() => repositoryPaths({ kind: 'app', id: '../escape' })).toThrow();
    expect(() => repositoryPaths({ kind: 'webvm', id: 'vm-1' })).toThrow();
    expect(() => normalizeRepositoryPath('/safe/../escape')).toThrow();
    expect(() => normalizeRepositoryPath('safe\\escape')).toThrow();
  });
});
