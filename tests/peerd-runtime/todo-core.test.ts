// The goal run's plan-of-record — pure list ops (extension/peerd-runtime/todo/core.js).
// Pins: init validation + the hard item cap (reject, never clip), check/add
// purity (fresh arrays, stable ids), next-pending steering, and the prompt
// block render the goal continuation embeds.

import { describe, test, expect } from 'bun:test';
import {
  initTodos, checkTodo, addTodo, nextPending, todoProgress, formatTodoBlock, MAX_TODO_ITEMS,
} from '../../extension/peerd-runtime/todo/core.js';

const okInit = (items: unknown) => {
  const out = initTodos(items);
  if (!out.ok) throw new Error(`init failed: ${(out as { error: string }).error}`);
  return out.todos;
};

describe('initTodos', () => {
  test('builds 1-based pending items from {text, validation} records', () => {
    const todos = okInit([
      { text: 'open the dashboard', validation: 'URL shows /dashboard' },
      { text: 'export the report' },
    ]);
    expect(todos).toEqual([
      { id: 1, text: 'open the dashboard', validation: 'URL shows /dashboard', status: 'pending' },
      { id: 2, text: 'export the report', status: 'pending' },
    ]);
  });

  test('accepts bare strings and collapses whitespace', () => {
    const todos = okInit(['  step\n one  ']);
    expect(todos[0]).toEqual({ id: 1, text: 'step one', status: 'pending' });
  });

  test('REJECTS an over-cap list (never silently clips)', () => {
    const out = initTodos(Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, i) => `s${i}`));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain(String(MAX_TODO_ITEMS));
  });

  test('rejects empty input and empty item text', () => {
    expect(initTodos([]).ok).toBe(false);
    expect(initTodos(undefined).ok).toBe(false);
    expect(initTodos([{ text: '   ' }]).ok).toBe(false);
  });
});

describe('checkTodo', () => {
  test('marks one item done and returns a NEW list', () => {
    const todos = okInit(['a', 'b']);
    const out = checkTodo(todos, 1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item.status).toBe('done');
    expect(out.todos[0].status).toBe('done');
    expect(out.todos[1].status).toBe('pending');
    expect(todos[0].status).toBe('pending'); // input untouched — pure
  });

  test('refuses unknown ids, double-checks, and a missing list', () => {
    const todos = okInit(['a']);
    expect(checkTodo(todos, 9).ok).toBe(false);
    const once = checkTodo(todos, 1);
    if (!once.ok) throw new Error('unexpected');
    expect(checkTodo(once.todos, 1).ok).toBe(false);
    expect(checkTodo([], 1).ok).toBe(false);
  });
});

describe('addTodo', () => {
  test('appends with a never-recycled id and honors the cap', () => {
    const todos = okInit(['a', 'b']);
    const out = addTodo(todos, 'c', 'c works');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item).toEqual({ id: 3, text: 'c', validation: 'c works', status: 'pending' });
    const full = okInit(Array.from({ length: MAX_TODO_ITEMS }, (_, i) => `s${i}`));
    expect(addTodo(full, 'one more').ok).toBe(false);
  });

  test('starts a list from nothing and rejects empty text', () => {
    const out = addTodo(undefined, 'first');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.item.id).toBe(1);
    expect(addTodo([], '  ').ok).toBe(false);
  });
});

describe('steering reads', () => {
  test('nextPending walks the first unchecked item; progress counts', () => {
    const todos = okInit(['a', 'b', 'c']);
    const one = checkTodo(todos, 1);
    if (!one.ok) throw new Error('unexpected');
    expect(nextPending(one.todos)?.id).toBe(2);
    expect(todoProgress(one.todos)).toEqual({ done: 1, total: 3 });
    expect(nextPending(undefined)).toBeNull();
    expect(todoProgress(undefined)).toEqual({ done: 0, total: 0 });
  });

  test('formatTodoBlock renders boxes, the next arrow, and pending validations only', () => {
    const todos = okInit([
      { text: 'a', validation: 'a passes' },
      { text: 'b', validation: 'b passes' },
    ]);
    const one = checkTodo(todos, 1);
    if (!one.ok) throw new Error('unexpected');
    const block = formatTodoBlock(one.todos);
    expect(block).toContain('Plan (1/2 done):');
    expect(block).toContain('[x] 1. a');
    expect(block).not.toContain('a passes');            // done → validation dropped
    expect(block).toContain('[ ] 2. b (verify: b passes)  ← next');
    expect(formatTodoBlock([])).toBe('');
    expect(formatTodoBlock(undefined)).toBe('');
  });
});
