// edit_file — create-first hint when no current instance.
//
// edit_file is cross-kind (App OR Notebook) and always-on, so it isn't
// instance-gated at the dispatch layer like the *_write_file ops. When the
// chat has no current instance and no explicit targetId, it must give the same
// "create one first" guidance instead of swallowing the resolve error into a
// confusing search_not_found.

import { describe, test, expect } from 'bun:test';
import { editFileTool } from '../../extension/peerd-runtime/tools/defs/edit-file.js';

const WHOLE_FILE = '<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n';

const baseCtx = (over: any = {}) => ({
  session: { sessionId: 's1' },
  appClient: { readFile: async () => '', writeFile: async () => {} },
  jsClient: { readFile: async () => '', writeFile: async () => {} },
  appRegistry: { getDefaultForSession: async () => null },
  jsRegistry: { getDefaultForSession: async () => null },
  ...over,
});

describe('edit_file — create-first hint (progressive disclosure consistency)', () => {
  test('app: no current app → create-first hint naming app_create', async () => {
    const r: any = await editFileTool.execute({ path: 'index.html', edits: WHOLE_FILE }, baseCtx() as any);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_current_instance');
    expect(r.error).toContain('app_create');
  });

  test('notebook: no current notebook → create-first hint naming js_create', async () => {
    const r: any = await editFileTool.execute({ path: 'x.js', edits: WHOLE_FILE, kind: 'notebook' }, baseCtx() as any);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_current_instance');
    expect(r.error).toContain('js_create');
  });

  test('proceeds normally when a current instance exists', async () => {
    const ctx = baseCtx({ appRegistry: { getDefaultForSession: async () => 'app-1' } });
    const r: any = await editFileTool.execute({ path: 'index.html', edits: WHOLE_FILE }, ctx as any);
    expect(r.ok).toBe(true);
  });

  test('an explicit targetId skips the current-instance check', async () => {
    const r: any = await editFileTool.execute({ path: 'index.html', edits: WHOLE_FILE, targetId: 'app-9' }, baseCtx() as any);
    expect(r.ok).toBe(true);
  });

  test('no false negative when the registry is not wired (degrades to prior behavior)', async () => {
    // No appRegistry → the check is skipped; the write mock succeeds.
    const ctx = baseCtx({ appRegistry: undefined });
    const r: any = await editFileTool.execute({ path: 'index.html', edits: WHOLE_FILE }, ctx as any);
    expect(r.ok).toBe(true);
  });
});
