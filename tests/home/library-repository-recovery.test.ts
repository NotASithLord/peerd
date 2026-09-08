import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

describe('Home Git recovery UX', () => {
  test('a failed lazy repository load reaches a bounded retry/close state', () => {
    const source = readFileSync(join(EXTENSION_DIR, 'home/library-section.js'), 'utf8');
    expect(source).toContain('repositoryErrors = {}');
    expect(source).toContain('Git took too long to respond. Nothing was changed; try again.');
    expect(source).toContain("m('button.library-btn', {");
    expect(source).toContain('onclick: () => LibrarySection.openRepository(vnode, app, true)');
    expect(source).toContain("}, 'Retry')");
    expect(source).toContain("}, 'Close')");
    expect(source).not.toMatch(/if \(!repo\) return m\([^\n]+Loading repository/);
  });

  test('every basic App action releases busy state and avoids raw transport codes', () => {
    const source = readFileSync(join(EXTENSION_DIR, 'home/library-section.js'), 'utf8');
    expect(source).toContain('mutationFailureCopy');
    expect(source).toContain('Refresh to reconcile before trying again.');
    expect(source).toContain('The export service stopped responding. Nothing was downloaded; try again.');
    expect(source).toMatch(/async exportApp[\s\S]*finally \{[\s\S]*busyId = null;/);
    expect(source).toMatch(/async confirmDelete[\s\S]*finally \{[\s\S]*busyId = null;/);
  });
});
