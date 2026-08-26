import { describe, expect, test } from 'bun:test';
import { createPersistenceToolAuthority } from '../../extension/background/persistence-tool-authority.js';

const context = (overrides: Record<string, any> = {}) => ({
  session: { sessionId: 'session-1' },
  activeTab: { origin: 'https://example.test' },
  ...overrides,
});

describe('exact persistence authority', () => {
  test('pins memory reads to the admitted scope', async () => {
    let reads = 0;
    const authority = createPersistenceToolAuthority({
      call: { name: 'read_memory', args: { scope: 'project' } },
      ctx: context({
        memory: {
          readScope: async () => { reads += 1; return { body: 'facts' }; },
        },
      }),
    });
    await expect(authority.readMemoryScope({
      kind: 'project', workspace: 'https://example.test',
    })).resolves.toEqual({ body: 'facts' });
    expect(() => authority.readMemoryScope({ kind: 'user', workspace: '' }))
      .toThrow('persistence authority mismatch');
    expect(reads).toBe(1);
  });

  test('keeps confirmation and its abort signal in the service worker', async () => {
    const prompts: any[] = [];
    const abortController = new AbortController();
    const authority = createPersistenceToolAuthority({
      call: { name: 'remember', args: { scope: 'user', body: 'fact' } },
      ctx: context({
        abortSignal: abortController.signal,
        confirm: async (prompt: any, signal: AbortSignal) => {
          prompts.push({ prompt, signal });
          return 'yes_once';
        },
        memory: {
          writeWithConfirm: async (request: any) => {
            expect(await request.confirm({
              op: 'create', header: 'User memory', addedLines: 1, removedLines: 0,
            })).toBe('yes_once');
            return { rejected: false, op: 'create', id: 'user' };
          },
        },
      }),
    });
    await expect(authority.writeMemory(
      { kind: 'user', workspace: 'https://example.test', subpath: undefined }, 'fact',
    )).resolves.toMatchObject({ rejected: false, id: 'user' });
    expect(prompts[0].prompt).toMatchObject({
      tool: 'remember', sideEffect: 'write', kind: 'memory_write', sessionId: 'session-1',
    });
    expect(prompts[0].signal).toBe(abortController.signal);
  });

  test('uses an authority-owned version check for todo replacement', async () => {
    let todos = [{ id: 1, text: 'first', done: false }];
    const authority = createPersistenceToolAuthority({
      call: { name: 'todo_add', args: { text: 'second' } },
      ctx: context({
        todoStore: {
          apply: async (update: (current: any[]) => any) => {
            const result = update(todos);
            if (result?.ok === true && Array.isArray(result.todos)) todos = result.todos;
            return result;
          },
        },
      }),
    });
    const snapshot = await authority.readTodos();
    await expect(authority.replaceTodos('stale', [])).resolves
      .toEqual({ ok: false, error: 'todo_conflict' });
    expect(todos).toHaveLength(1);
    const replacement = [...snapshot.todos, { id: 2, text: 'second', done: false }];
    await expect(authority.replaceTodos(snapshot.version, replacement)).resolves
      .toMatchObject({ ok: true });
    expect(todos).toEqual(replacement);
  });

  test('refuses a changed admitted memory body before mutation', () => {
    let writes = 0;
    const authority = createPersistenceToolAuthority({
      call: { name: 'remember', args: { scope: 'user', body: 'approved' } },
      ctx: context({
        memory: { writeWithConfirm: async () => { writes += 1; } },
      }),
    });
    expect(() => authority.writeMemory(
      { kind: 'user', workspace: 'https://example.test', subpath: undefined }, 'altered',
    )).toThrow('persistence authority mismatch');
    expect(writes).toBe(0);
  });
});
