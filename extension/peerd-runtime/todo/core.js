// @ts-check
// peerd-runtime/todo — the session plan-of-record, pure core.
//
// A goal run's todo list is the plan the agent writes for ITSELF (todo_init)
// and then works through (todo_check). It exists because a plan held only in
// model context evaporates: a cheap executor — or the same model forty turns
// later — forgets what it derived, but it cannot forget a checklist the
// harness re-surfaces every turn (the goal continuation prompt embeds
// formatTodoBlock). This is also the prewalk contract's spine: the planner
// model's understanding is handed to the executor as a ticking checklist in
// shared context, not as a prose plan it would have to re-derive.
//
// Everything here is pure (values in, values out) — the persisted list lives
// on the session record (session.todos); IO stays in the SW-injected
// ctx.todoStore the tool defs call. Bun-tested in tests/peerd-runtime.

// why a hard cap: small executors game unbounded lists (60 micro-items
// checked off in batches teaches the loop nothing), and a plan that long is
// recon deferred, not planning. The init tool REJECTS an over-cap list so the
// model consolidates — a silent clip would leave it believing steps exist
// that were dropped.
export const MAX_TODO_ITEMS = 12;

// Item text bounds — a todo is a checklist line, not a design doc.
const MAX_TEXT_CHARS = 200;
const MAX_VALIDATION_CHARS = 200;

/**
 * One plan step. `validation` is the "how I'll know it worked" the planning
 * nudge asks for — kept as its own field so the check-off turn re-reads the
 * success criterion instead of trusting a vibe.
 *
 * @typedef {Object} TodoItem
 * @property {number} id                 1-based, stable for the list's lifetime
 * @property {string} text
 * @property {string} [validation]
 * @property {'pending' | 'done'} status
 */

/** @param {unknown} s @param {number} cap */
const cleanText = (s, cap) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);

/**
 * Build a fresh list from the model's raw items. Replaces any prior list —
 * re-planning is a deliberate act, not an append.
 *
 * @param {unknown} rawItems
 * @returns {{ ok: true, todos: TodoItem[] } | { ok: false, error: string }}
 */
export const initTodos = (rawItems) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: 'todo_init needs a non-empty items array.' };
  }
  if (rawItems.length > MAX_TODO_ITEMS) {
    return {
      ok: false,
      error: `Too many items (${rawItems.length}). Consolidate the plan into at most `
        + `${MAX_TODO_ITEMS} concrete steps — group related work into one item.`,
    };
  }
  /** @type {TodoItem[]} */
  const todos = [];
  for (const raw of rawItems) {
    const rec = /** @type {{ text?: unknown, validation?: unknown }} */ (
      typeof raw === 'string' ? { text: raw } : (raw ?? {}));
    const text = cleanText(rec.text, MAX_TEXT_CHARS);
    if (!text) return { ok: false, error: `Item ${todos.length + 1} has no text.` };
    const validation = cleanText(rec.validation, MAX_VALIDATION_CHARS);
    todos.push({
      id: todos.length + 1,
      text,
      ...(validation ? { validation } : {}),
      status: 'pending',
    });
  }
  return { ok: true, todos };
};

/**
 * Mark one item done. Pure — returns a NEW list.
 *
 * @param {ReadonlyArray<TodoItem>} todos
 * @param {unknown} rawId
 * @returns {{ ok: true, todos: TodoItem[], item: TodoItem } | { ok: false, error: string }}
 */
export const checkTodo = (todos, rawId) => {
  const id = Number(rawId);
  if (!Array.isArray(todos) || todos.length === 0) {
    return { ok: false, error: 'No todo list exists yet — call todo_init first.' };
  }
  const item = todos.find((t) => t.id === id);
  if (!item) return { ok: false, error: `No todo item with id ${String(rawId)}.` };
  if (item.status === 'done') {
    return { ok: false, error: `Item ${id} ("${item.text}") is already done.` };
  }
  const done = /** @type {TodoItem} */ ({ ...item, status: 'done' });
  return { ok: true, todos: todos.map((t) => (t.id === id ? done : t)), item: done };
};

/**
 * Append one item (a step discovered mid-run). Same cap as init.
 *
 * @param {ReadonlyArray<TodoItem> | undefined} todos
 * @param {unknown} rawText
 * @param {unknown} [rawValidation]
 * @returns {{ ok: true, todos: TodoItem[], item: TodoItem } | { ok: false, error: string }}
 */
export const addTodo = (todos, rawText, rawValidation) => {
  const list = Array.isArray(todos) ? todos : [];
  if (list.length >= MAX_TODO_ITEMS) {
    return {
      ok: false,
      error: `The list is at its ${MAX_TODO_ITEMS}-item cap. Finish or fold existing items first.`,
    };
  }
  const text = cleanText(rawText, MAX_TEXT_CHARS);
  if (!text) return { ok: false, error: 'todo_add needs non-empty text.' };
  const validation = cleanText(rawValidation, MAX_VALIDATION_CHARS);
  // why max+1 (not length+1): ids must stay unique for the list's lifetime,
  // and a future remove-item op would otherwise recycle a checked id.
  const id = list.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  const item = /** @type {TodoItem} */ ({
    id, text, ...(validation ? { validation } : {}), status: 'pending',
  });
  return { ok: true, todos: [...list, item], item };
};

/**
 * The first unchecked item — "what's next" for steering text.
 * @param {ReadonlyArray<TodoItem> | undefined} todos
 * @returns {TodoItem | null}
 */
export const nextPending = (todos) =>
  (Array.isArray(todos) ? todos.find((t) => t.status !== 'done') ?? null : null);

/**
 * @param {ReadonlyArray<TodoItem> | undefined} todos
 * @returns {{ done: number, total: number }}
 */
export const todoProgress = (todos) => {
  const list = Array.isArray(todos) ? todos : [];
  return { done: list.filter((t) => t.status === 'done').length, total: list.length };
};

/**
 * Render the list as the compact block the goal continuation prompt (and the
 * todo tools' own results) embed. This re-surfacing IS the steering
 * mechanism: the model sees the live plan every turn without having to hold
 * it in its head.
 *
 * @param {ReadonlyArray<TodoItem> | undefined} todos
 * @returns {string} '' when there is no list
 */
export const formatTodoBlock = (todos) => {
  if (!Array.isArray(todos) || todos.length === 0) return '';
  const next = nextPending(todos);
  const lines = todos.map((t) => {
    const box = t.status === 'done' ? '[x]' : '[ ]';
    const arrow = next && t.id === next.id ? '  ← next' : '';
    const check = t.validation && t.status !== 'done' ? ` (verify: ${t.validation})` : '';
    return `${box} ${t.id}. ${t.text}${check}${arrow}`;
  });
  const { done, total } = todoProgress(todos);
  return [`Plan (${done}/${total} done):`, ...lines].join('\n');
};
