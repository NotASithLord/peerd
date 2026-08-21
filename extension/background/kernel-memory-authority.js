// @ts-check
import {
  appendMemorySuggestion,
  MEMORY_SUGGESTIONS_KEY,
  normalizeBody,
  normalizeMemoryScope,
  validMemorySuggestion,
} from '../shared/memory-authority-policy.js';

const STORE = 'agents_memory';
const failure = (/** @type {string} */ error) => /** @type {any} */ ({ ok: false, error });

/** @param {any} deps */
export const createKernelMemoryAuthority = ({ idb, kv, auditLog, now = Date.now }) => {
  let effectTail = Promise.resolve();
  /** @template T @param {()=>Promise<T>} operation */
  const effect = (operation) => {
    const task = effectTail.then(operation, operation);
    effectTail = task.then(() => {}, () => {});
    return task;
  };
  const suggestions = async () => {
    const stored = await kv.get(MEMORY_SUGGESTIONS_KEY);
    return Array.isArray(stored?.pending)
      ? stored.pending.filter(validMemorySuggestion).slice(-20) : [];
  };
  const write = async (/** @type {unknown} */ rawScope, /** @type {unknown} */ rawBody) => {
    let scope; let body;
    try { scope = normalizeMemoryScope(/** @type {any} */ (rawScope)); }
    catch { return failure('bad-scope'); }
    try { body = normalizeBody(String(rawBody??'')); }
    catch { return failure('bad-body'); }
    return idb.transact([STORE], (/** @type {Record<string,IDBObjectStore>} */ stores,
      /** @type {IDBTransaction} */ transaction) => {
      let result = failure('write-failed');
      const request = stores[STORE].get(scope.id);
      request.onsuccess = () => {
        try {
          const prior = request.result;
          const previous = typeof prior?.body === 'string' ? prior.body : '';
          const op = body === previous ? 'noop' : body === '' ? 'delete'
            : previous === '' ? 'create' : 'update';
          if (op === 'delete') stores[STORE].delete(scope.id);
          else if (op !== 'noop') {
            const timestamp = now();
            stores[STORE].put({
              id: scope.id, kind: scope.kind, workspace: scope.workspace,
              subpath: scope.subpath || undefined, body,
              createdAt: Number.isFinite(prior?.createdAt) ? prior.createdAt : timestamp,
              updatedAt: timestamp,
            });
          }
          result = { ok: true, op, id: scope.id };
        } catch { try { transaction.abort(); } catch {} }
      };
      return () => result;
    });
  };
  const deleteAll = () => idb.transact([STORE], (
    /** @type {Record<string,IDBObjectStore>} */ stores,
  ) => {
    let deleted = 0;
    const request = stores[STORE].count();
    request.onsuccess = () => {
      deleted = request.result;
      stores[STORE].clear();
    };
    return () => ({ ok: true, deleted });
  });
  const resolveSuggestion = (/** @type {unknown} */ rawId, /** @type {boolean} */ approve) => {
    const id = typeof rawId === 'string' ? rawId : '';
    if (!id) return Promise.resolve(failure('id-required'));
    return effect(async () => {
      const pending = await suggestions();
      const index = pending.findIndex((/** @type {any} */ entry) => entry.id === id);
      if (index < 0) return failure('not-found');
      const [suggestion] = pending.splice(index, 1);
      if (approve) {
        const prior = await idb.get(STORE, 'user');
        const body = appendMemorySuggestion(prior?.body ?? '', suggestion.text);
        const written = await write({ kind: 'user' }, body);
        if (!written.ok) return written;
      }
      await kv.set(MEMORY_SUGGESTIONS_KEY, { pending });
      auditLog.append({
        type: approve ? 'memory_suggestion_approved' : 'memory_suggestion_dismissed',
        sessionId: suggestion.sessionId ?? undefined, details: { id },
      }).catch(() => {});
      return { ok: true };
    });
  };
  /** @param {boolean} known @param {(message:any)=>Promise<any>} run */
  const route = (known, run) => async (/** @type {any} */ message = {}) => {
    try { return await run(message); }
    catch {
      return {
        ok: false,
        error: known ? 'The memory operation could not be completed.'
          : 'The memory operation outcome could not be confirmed.',
        outcomeKnown: known,
        retryable: known,
      };
    }
  };
  return Object.freeze({
    routes: Object.freeze({
      'memory/export': route(true, async () => ({
        ok: true, payload: { version: 1, exportedAt: now(), docs: await idb.getAll(STORE) },
      })),
      'memory/deleteAll': route(false, () => effect(deleteAll)),
      'memory/write': route(false, (message) =>
        effect(() => write(message?.scope, message?.body))),
      'memory/delete': route(false, (message) => effect(() => write(message?.scope, ''))),
      'memory/suggestions': route(true, async () => ({
        ok: true, suggestions: await suggestions(),
      })),
      'memory/suggestions/approve': route(false, (message) =>
        resolveSuggestion(message?.id, true)),
      'memory/suggestions/dismiss': route(false, (message) =>
        resolveSuggestion(message?.id, false)),
    }),
  });
};
