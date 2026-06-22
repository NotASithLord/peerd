// @ts-check
// Ralph plan store — the plan file IS the durable memory.
//
// Ralph's whole point is to AVOID long-lived context: persistence lives
// in git + a plan file, never in an ever-growing context window. This
// module owns the plan-file format (parse/serialize) and a thin store
// over an injected kv-like backend (chrome.storage.local in prod, a Map
// stub in tests). The loop reads the plan at the START of each
// fresh-context iteration and writes it back at the END — so a SW
// restart between iterations loses nothing: the next cold start
// re-reads the same file.
//
// Functional core / imperative shell: parse/serialize/reducers here are
// PURE. The store wrapper is the only IO seam and takes kv via DI.
//
// ── Plan-file format ──────────────────────────────────────────────────
// A Ralph plan is GitHub-flavoured-markdown task list, human-editable,
// git-diffable, and trivially parseable. Example:
//
//   # Plan: ship the widget
//   <!-- ralph:meta {"version":1,"mode":"building"} -->
//
//   ## Goal
//   Free-text describing the north star. Carried verbatim into each
//   fresh-context iteration's prompt so the agent never loses the why.
//
//   ## Tasks
//   - [ ] First task title          (pending)
//   - [~] Task being worked on      (in-progress — single-writer marker)
//   - [x] Completed task            (done)
//   - [!] Blocked task: reason      (blocked — gate failed too many times)
//
// why a single in-progress marker `[~]`: single-threaded writes are a
// HARD constraint. Exactly one task may be `[~]` at a time; that IS the
// write lock. pickNextTask refuses to hand out a second one.

/** @typedef {'pending'|'in-progress'|'done'|'blocked'} TaskStatus */

/**
 * @typedef {Object} PlanTask
 * @property {string} id           stable id (derived from index at parse, or assigned)
 * @property {string} title        the task text
 * @property {TaskStatus} status
 * @property {string} [note]       e.g. blocked reason
 * @property {number} [attempts]   gate-failure retry counter
 */

/**
 * @typedef {Object} Plan
 * @property {string} title
 * @property {string} goal
 * @property {'planning'|'building'} mode
 * @property {PlanTask[]} tasks
 * @property {number} version
 */

/** @type {Record<TaskStatus, string>} */
const STATUS_BOX = { pending: '[ ]', 'in-progress': '[~]', done: '[x]', blocked: '[!]' };
/** @type {Record<string, TaskStatus>} */
const BOX_STATUS = { ' ': 'pending', '~': 'in-progress', x: 'done', X: 'done', '!': 'blocked' };

/** @returns {Plan} */
const EMPTY_PLAN = () => ({
  title: 'Untitled plan',
  goal: '',
  mode: 'planning',
  tasks: [],
  version: 1,
});

// ── PURE: parse ──────────────────────────────────────────────────────

/**
 * Parse a markdown plan file into a Plan. Tolerant: unknown lines are
 * ignored, missing sections default. Task ids are derived from a slug +
 * index so the SAME file re-parses to the SAME ids across restarts
 * (resumability depends on stable ids).
 *
 * @param {string} text
 * @returns {Plan}
 */
export const parsePlan = (text) => {
  if (typeof text !== 'string' || text.trim() === '') return EMPTY_PLAN();
  const plan = EMPTY_PLAN();
  const lines = text.split(/\r?\n/);
  let section = null; // 'goal' | 'tasks' | null
  const goalLines = [];
  let idx = 0;

  for (const raw of lines) {
    const line = raw.trimEnd();
    // Title: first H1.
    const h1 = /^#\s+(?:Plan:\s*)?(.+)$/.exec(line);
    if (h1 && plan.title === 'Untitled plan') { plan.title = h1[1].trim(); continue; }
    // Embedded meta comment carries mode + version verbatim.
    const meta = /^<!--\s*ralph:meta\s+(\{.*\})\s*-->$/.exec(line);
    if (meta) {
      try {
        const m = JSON.parse(meta[1]);
        if (m.mode === 'planning' || m.mode === 'building') plan.mode = m.mode;
        if (Number.isFinite(m.version)) plan.version = m.version;
      } catch { /* ignore malformed meta — file still usable */ }
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      const name = h2[1].trim().toLowerCase();
      section = name.startsWith('goal') ? 'goal' : name.startsWith('task') ? 'tasks' : null;
      continue;
    }
    if (section === 'goal') { goalLines.push(raw); continue; }
    if (section === 'tasks') {
      // - [ ] title   /   - [x] title: note
      const t = /^\s*[-*]\s*\[([ xX~!])\]\s*(.*)$/.exec(line);
      if (!t) continue;
      const status = BOX_STATUS[t[1]] ?? 'pending';
      let title = t[2].trim();
      let note;
      // attempt counter encoded as trailing ` (attempts: N)`
      const am = /\s*\(attempts:\s*(\d+)\)\s*$/.exec(title);
      let attempts;
      if (am) { attempts = Number(am[1]); title = title.slice(0, am.index).trim(); }
      if (status === 'blocked') {
        const ci = title.indexOf(':');
        if (ci !== -1) { note = title.slice(ci + 1).trim(); title = title.slice(0, ci).trim(); }
      }
      plan.tasks.push({
        id: `t${idx}-${slug(title)}`,
        title,
        status,
        ...(note ? { note } : {}),
        ...(attempts ? { attempts } : {}),
      });
      idx++;
    }
  }
  plan.goal = goalLines.join('\n').trim();
  return plan;
};

/** @param {string} s */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';

// ── PURE: serialize ──────────────────────────────────────────────────

/** @param {Plan} plan @returns {string} */
export const serializePlan = (plan) => {
  const out = [];
  out.push(`# Plan: ${plan.title}`);
  out.push(`<!-- ralph:meta ${JSON.stringify({ version: plan.version ?? 1, mode: plan.mode })} -->`);
  out.push('');
  out.push('## Goal');
  out.push(plan.goal || '(no goal set)');
  out.push('');
  out.push('## Tasks');
  for (const t of plan.tasks) {
    const box = STATUS_BOX[t.status] ?? STATUS_BOX.pending;
    let line = `- ${box} ${t.title}`;
    if (t.status === 'blocked' && t.note) line += `: ${t.note}`;
    if (t.attempts) line += ` (attempts: ${t.attempts})`;
    out.push(line);
  }
  out.push('');
  return out.join('\n');
};

// ── PURE: reducers over a Plan (the iteration mutates the plan ONLY
//        through these so the single-writer invariant stays checkable) ─

/**
 * Pick the next task to execute. Single-threaded-writes invariant:
 *   - if a task is already in-progress, return it (resume — a prior
 *     iteration crashed mid-flight; we re-do it, never start a second).
 *   - else the first pending task, transitioned to in-progress.
 *   - else null (plan exhausted or fully blocked).
 *
 * Returns a NEW plan (immutable) plus the picked task, so the caller can
 * persist the in-progress marker BEFORE doing work — that marker is the
 * crash-safe lock.
 *
 * @param {Plan} plan
 * @returns {{ plan: Plan, task: PlanTask|null }}
 */
export const pickNextTask = (plan) => {
  const inProgress = plan.tasks.find((t) => t.status === 'in-progress');
  if (inProgress) return { plan, task: inProgress };
  const pending = plan.tasks.find((t) => t.status === 'pending');
  if (!pending) return { plan, task: null };
  const tasks = plan.tasks.map((t) =>
    (t.id === pending.id ? { ...t, status: /** @type {TaskStatus} */ ('in-progress') } : t));
  return { plan: { ...plan, tasks }, task: { ...pending, status: 'in-progress' } };
};

/** Mark a task done. @param {Plan} plan @param {string} taskId @returns {Plan} */
export const completeTask = (plan, taskId) => ({
  ...plan,
  tasks: plan.tasks.map((t) => (t.id === taskId
    ? { ...t, status: /** @type {TaskStatus} */ ('done') }
    : t)),
});

/**
 * Record a gate failure on a task. Increments attempts; if it hits
 * maxAttempts the task is marked blocked (so the loop stops retrying it
 * and can move on / terminate). Otherwise it stays in-progress for
 * another fresh-context retry.
 *
 * @param {Plan} plan
 * @param {string} taskId
 * @param {string} reason
 * @param {number} [maxAttempts]
 * @returns {{ plan: Plan, blocked: boolean }}
 */
export const failTask = (plan, taskId, reason, maxAttempts = 3) => {
  let blocked = false;
  const tasks = plan.tasks.map((t) => {
    if (t.id !== taskId) return t;
    const attempts = (t.attempts ?? 0) + 1;
    if (attempts >= maxAttempts) {
      blocked = true;
      return { ...t, status: /** @type {TaskStatus} */ ('blocked'), attempts, note: reason || 'gate failed' };
    }
    // why: drop back to pending so pickNextTask re-selects it with a
    // FRESH context (the retry must not inherit the failed iteration's
    // reasoning — that's the anti-long-context discipline).
    return { ...t, status: /** @type {TaskStatus} */ ('pending'), attempts };
  });
  return { plan: { ...plan, tasks }, blocked };
};

/** @param {Plan} plan @returns {boolean} true when no pending/in-progress tasks remain. */
export const isPlanExhausted = (plan) =>
  !plan.tasks.some((t) => t.status === 'pending' || t.status === 'in-progress');

/** Summary counts for status surfaces. @param {Plan} plan */
export const planSummary = (plan) => {
  const c = { pending: 0, 'in-progress': 0, done: 0, blocked: 0 };
  for (const t of plan.tasks) c[t.status] = (c[t.status] ?? 0) + 1;
  return { total: plan.tasks.length, ...c };
};

// ── IMPERATIVE SHELL: persisted store over kv ────────────────────────

export const PLAN_KEY = 'ralph.plan.v1';

/**
 * @param {Object} deps
 * @param {{ get(k:string):Promise<any>, set(k:string,v:any):Promise<void>, delete(k:string):Promise<void> }} deps.kv
 */
export const createPlanStore = ({ kv }) => {
  /** @returns {Promise<Plan>} */
  const load = async () => {
    const text = await kv.get(PLAN_KEY);
    return parsePlan(typeof text === 'string' ? text : '');
  };
  /** @param {Plan} plan */
  const save = async (plan) => { await kv.set(PLAN_KEY, serializePlan(plan)); };
  const loadText = async () => {
    const text = await kv.get(PLAN_KEY);
    return typeof text === 'string' ? text : serializePlan(EMPTY_PLAN());
  };
  /** @param {string} text */
  const saveText = async (text) => { await kv.set(PLAN_KEY, String(text)); };
  const clear = async () => { await kv.delete(PLAN_KEY); };
  return Object.freeze({ load, save, loadText, saveText, clear });
};

export { EMPTY_PLAN };
