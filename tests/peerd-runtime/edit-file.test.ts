// edit_file — create-first hint when no current instance.
//
// edit_file is cross-kind (App OR Notebook) and always-on, so it isn't
// instance-gated at the dispatch layer like the *_write_file ops. When the
// chat has no current instance and no explicit targetId, it must give the same
// "create one first" guidance instead of swallowing the resolve error into a
// confusing search_not_found.

import { describe, test, expect } from 'bun:test';
import { editFileTool } from '../../extension/peerd-runtime/tools/defs/edit-file.js';
import { createEditingToolAuthority } from '../../extension/background/editing-tool-authority.js';

const WHOLE_FILE = '<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n';

const baseCtx = (over: any = {}) => ({
  session: { sessionId: 's1' },
  appClient: { readFile: async () => '', writeFile: async () => {} },
  jsClient: { readFile: async () => '', writeFile: async () => {} },
  appRegistry: { getDefaultForSession: async () => null },
  jsRegistry: { getDefaultForSession: async () => null },
  ...over,
});

const executeEdit = (args: any, ctx: any) => editFileTool.execute(args, {
  editingAuthority: createEditingToolAuthority({
    call: { name: 'edit_file', args }, ctx,
  }),
} as any);

describe('edit_file — create-first hint (progressive disclosure consistency)', () => {
  test('app: no current app → create-first hint naming sandbox_create', async () => {
    const r: any = await executeEdit({ path: 'index.html', edits: WHOLE_FILE }, baseCtx());
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_current_instance');
    expect(r.error).toContain("sandbox_create({kind:'app'})");
  });

  test('notebook: no current notebook → create-first hint naming sandbox_create', async () => {
    const r: any = await executeEdit({ path: 'x.js', edits: WHOLE_FILE, kind: 'notebook' }, baseCtx());
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_current_instance');
    expect(r.error).toContain("sandbox_create({kind:'notebook'})");
  });

  test('proceeds normally when a current instance exists', async () => {
    const ctx = baseCtx({ appRegistry: { getDefaultForSession: async () => 'app-1' } });
    const r: any = await executeEdit({ path: 'index.html', edits: WHOLE_FILE }, ctx);
    expect(r.ok).toBe(true);
  });

  test('an explicit targetId skips the current-instance check', async () => {
    const r: any = await executeEdit({ path: 'index.html', edits: WHOLE_FILE, targetId: 'app-9' }, baseCtx());
    expect(r.ok).toBe(true);
  });

  test('no false negative when the registry is not wired (degrades to prior behavior)', async () => {
    // No appRegistry → the check is skipped; the write mock succeeds.
    const ctx = baseCtx({ appRegistry: undefined });
    const r: any = await executeEdit({ path: 'index.html', edits: WHOLE_FILE }, ctx);
    expect(r.ok).toBe(true);
  });
});

// 3a: a read that returns "no such file" must not be laundered into a create.
const ANCHORED = '<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE\n';

// A registry that confirms a current instance so we bypass the create-first
// hint and reach the read/apply path under test.
const withInstance = (over: any = {}) =>
  baseCtx({ appRegistry: { getDefaultForSession: async () => 'app-1' }, ...over });

describe('edit_file — 3a–3d robustness surface', () => {
  test('anchored edit against a missing file → file_not_found (not search_not_found)', async () => {
    // readFile returns null → the file does not exist.
    const ctx = withInstance({ appClient: { readFile: async () => null, writeFile: async () => {} } });
    const r: any = await executeEdit({ path: 'nope.js', edits: ANCHORED }, ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('file_not_found');
    expect(r.error).toContain('nope.js');
    expect(r.error).toContain('app_list_files');
  });

  test('notebook anchored edit against a missing file names js_read_file', async () => {
    const ctx = baseCtx({
      jsRegistry: { getDefaultForSession: async () => 'nb-1' },
      jsClient: { readFile: async () => null, writeFile: async () => {} },
    });
    const r: any = await executeEdit({ path: 'nope.js', edits: ANCHORED, kind: 'notebook' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('file_not_found');
    expect(r.error).toContain('js_read_file');
  });

  test('whole-file create against a missing file → success, path echoed', async () => {
    const ctx = withInstance({ appClient: { readFile: async () => null, writeFile: async () => {} } });
    const r: any = await executeEdit({ path: 'fresh.html', edits: WHOLE_FILE }, ctx);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).path).toBe('fresh.html');
  });

  test('a non-not-found read error surfaces as read_failed (not a silent empty)', async () => {
    const ctx = withInstance({
      appClient: {
        readFile: async () => { throw new Error('OPFS unavailable'); },
        writeFile: async () => {},
      },
    });
    const r: any = await executeEdit({ path: 'index.html', edits: ANCHORED }, ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('read_failed');
    expect(r.error).toContain('OPFS unavailable');
  });

  test('a NotFoundError thrown by the client is treated as absent (create ok)', async () => {
    const notFound = Object.assign(new Error('missing'), { name: 'NotFoundError' });
    const ctx = withInstance({
      appClient: {
        readFile: async () => { throw notFound; },
        writeFile: async () => {},
      },
    });
    const r: any = await executeEdit({ path: 'fresh.html', edits: WHOLE_FILE }, ctx);
    expect(r.ok).toBe(true);
  });

  // The REAL notebook client (background/notebook-client.js) re-inflates the
  // OPFS not-found signal into a NotFoundError-named Error across the tab RPC —
  // these lock the edit_file contract on that shape (a plain Error would break
  // both branches: create → read_failed, anchored → read_failed not file_not_found).
  test('notebook create against a NotFoundError-throwing client → success', async () => {
    const notFound = Object.assign(new Error('A requested file could not be found'), { name: 'NotFoundError' });
    const ctx = baseCtx({
      jsRegistry: { getDefaultForSession: async () => 'nb-1' },
      jsClient: { readFile: async () => { throw notFound; }, writeFile: async () => {} },
    });
    const r: any = await executeEdit({ path: 'fresh.js', edits: WHOLE_FILE, kind: 'notebook' }, ctx);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).path).toBe('fresh.js');
  });

  test('notebook anchored edit against a NotFoundError-throwing client → file_not_found', async () => {
    const notFound = Object.assign(new Error('A requested file could not be found'), { name: 'NotFoundError' });
    const ctx = baseCtx({
      jsRegistry: { getDefaultForSession: async () => 'nb-1' },
      jsClient: { readFile: async () => { throw notFound; }, writeFile: async () => {} },
    });
    const r: any = await executeEdit({ path: 'gone.js', edits: ANCHORED, kind: 'notebook' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('file_not_found');
    expect(r.error).toContain('js_read_file');
  });

  test('already-applied edit → success with alreadyApplied:true', async () => {
    // File already holds the post-edit text; the anchor (const x = 1;) is gone.
    const ctx = withInstance({
      appClient: { readFile: async () => 'const x = 2;\n', writeFile: async () => {} },
    });
    const r: any = await executeEdit({ path: 'index.html', edits: ANCHORED }, ctx);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).alreadyApplied).toBe(true);
  });

  test('ambiguous match surfaces locations', async () => {
    const ctx = withInstance({
      appClient: { readFile: async () => 'const x = 1;\nconst x = 1;\n', writeFile: async () => {} },
    });
    const r: any = await executeEdit({ path: 'index.html', edits: ANCHORED }, ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('search_ambiguous');
    expect(r.locations.map((l: any) => l.line)).toEqual([1, 2]);
  });

  test('whitespace-only mismatch surfaces the whitespace flag + line', async () => {
    const ctx = withInstance({
      appClient: { readFile: async () => 'function f() {\n    return 1;\n}\n', writeFile: async () => {} },
    });
    const edits = '<<<<<<< SEARCH\n\treturn 1;\n=======\n\treturn 2;\n>>>>>>> REPLACE\n';
    const r: any = await executeEdit({ path: 'index.html', edits }, ctx);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('search_not_found');
    expect(r.whitespace).toBe(true);
    expect(r.line).toBe(2);
  });

  test('App edits enforce the UTF-8 byte cap and report actual bytes', async () => {
    const overLimit = '😀'.repeat(125_001);
    const edits = `<<<<<<< SEARCH\n=======\n${overLimit}\n>>>>>>> REPLACE\n`;
    const ctx = withInstance({ appClient: { readFile: async () => null, writeFile: async () => {} } });
    const result: any = await executeEdit({ path: 'fresh.txt', edits }, ctx);
    expect(result.ok).toBe(false);
    // The App byte rail catches this even though the string has far fewer
    // UTF-16 code units.
    expect(result.error).toContain('content_too_large: 500004 > 500000');
  });

  test('anchored edits can retain a large imported dwapp file without re-emitting it', async () => {
    const source = `${'a'.repeat(500_001)}\nconst protocol = 5;\n`;
    let written = '';
    const ctx = withInstance({
      appClient: {
        readFile: async () => source,
        writeFile: async ({ content }: { content: string }) => { written = content; },
      },
    });
    const edits = '<<<<<<< SEARCH\nconst protocol = 5;\n=======\nconst protocol = 6;\n>>>>>>> REPLACE\n';
    const result: any = await executeEdit({ path: 'bundle.js', edits }, ctx);
    expect(result.ok).toBe(true);
    expect(written.endsWith('const protocol = 6;\n')).toBe(true);
    expect(new TextEncoder().encode(written).byteLength).toBeGreaterThan(500_000);
  });
});
