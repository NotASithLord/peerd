import { describe, test, expect } from 'bun:test';
import { diffRepositorySnapshots } from '../../extension/peerd-engine/repository/diff.js';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('repository snapshot diff', () => {
  test('reports added, removed, modified and a readable patch', () => {
    const result = diffRepositorySnapshots(
      { 'same.txt': bytes('same\n'), 'old.txt': bytes('old\n'), 'edit.txt': bytes('before\n') },
      { 'same.txt': bytes('same\n'), 'new.txt': bytes('new\n'), 'edit.txt': bytes('after\n') },
    );
    expect(result.files.map((f) => [f.path, f.status])).toEqual([
      ['edit.txt', 'modified'], ['new.txt', 'added'], ['old.txt', 'deleted'],
    ]);
    expect(result.patch).toContain('--- a/edit.txt');
    expect(result.patch).toContain('+after');
  });

  test('never decodes binary content into the patch', () => {
    const result = diffRepositorySnapshots({ 'x.bin': new Uint8Array([0, 1]) }, { 'x.bin': new Uint8Array([0, 2]) });
    expect(result.files[0]).toMatchObject({ path: 'x.bin', status: 'modified', binary: true });
    expect(result.patch).toContain('Binary files differ');
  });
});
