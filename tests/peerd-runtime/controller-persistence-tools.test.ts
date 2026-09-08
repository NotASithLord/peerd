import { describe, expect, test } from 'bun:test';
import { executeControllerPersistenceTool } from '../../extension/peerd-runtime/controller-persistence-tools.js';

describe('controller-owned persistence semantics', () => {
  test('formats memory reads from an exact authority capability', async () => {
    const scopes: any[] = [];
    const result: any = await executeControllerPersistenceTool(
      'read_memory',
      { scope: 'project', workspace: 'https://example.test' },
      { sessionId: 'session-1', activeTabOrigin: 'https://unused.test' },
      {
        readMemoryScope: async (scope: any) => {
          scopes.push(scope);
          return { body: 'project facts' };
        },
      },
    );
    expect(scopes).toEqual([{ kind: 'project', workspace: 'https://example.test' }]);
    expect(result).toEqual({ ok: true, content: 'project facts' });
  });

  test('keeps memory write shaping controller-side and delegates one exact mutation', async () => {
    const writes: any[] = [];
    const result: any = await executeControllerPersistenceTool(
      'remember',
      { scope: 'subtree', workspace: 'work', subpath: 'src', body: 'fact' },
      { sessionId: 'session-1', goalActive: false },
      {
        writeMemory: async (scope: any, body: string) => {
          writes.push({ scope, body });
          return { rejected: false, op: 'create', id: 'subtree:work:src' };
        },
      },
    );
    expect(writes).toEqual([{
      scope: { kind: 'subtree', workspace: 'work', subpath: 'src' }, body: 'fact',
    }]);
    expect(result).toMatchObject({ ok: true });
    expect(result.content).toContain('subtree:work:src');
  });

  test('retries a version conflict while keeping todo math out of authority', async () => {
    let reads = 0;
    const replacements: any[] = [];
    const result: any = await executeControllerPersistenceTool(
      'todo_add',
      { text: 'verify the cutover', validation: 'focused tests pass' },
      { sessionId: 'session-1', goalActive: true },
      {
        readTodos: async () => ({
          todos: reads++ === 0 ? [] : [{ id: 1, text: 'existing', done: false }],
          version: reads === 1 ? 'v1' : 'v2',
        }),
        replaceTodos: async (version: string, todos: any[]) => {
          replacements.push({ version, todos });
          return version === 'v1' ? { ok: false, error: 'todo_conflict' } : { ok: true };
        },
      },
    );
    expect(replacements).toHaveLength(2);
    expect(replacements[1].todos.map((todo: any) => todo.text))
      .toEqual(['existing', 'verify the cutover']);
    expect(result).toMatchObject({ ok: true });
    expect(result.content).toContain('Added: 2. verify the cutover');
  });

  test('does not expose todo storage outside an active goal', async () => {
    let reads = 0;
    const result: any = await executeControllerPersistenceTool(
      'todo_check', { id: 1 }, { sessionId: 'session-1', goalActive: false },
      { readTodos: async () => { reads += 1; return { todos: [], version: '[]' }; } },
    );
    expect(result).toMatchObject({ ok: false, error: 'no_active_goal_run' });
    expect(reads).toBe(0);
  });
});
