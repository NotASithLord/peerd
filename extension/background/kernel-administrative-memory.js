// @ts-check

import {
  buildWriteProposal,
  initializerScope,
  normalizeBody,
  scopeId,
  seedInitializerBody,
} from '/peerd-runtime/kernel-memory.js';
import { makeSerialLane } from '../shared/cold-util.js';

const STORE = 'agents_memory';
const versionOf = (/** @type {any} */ doc) => doc == null ? 'missing' : JSON.stringify([
  doc.id, doc.kind, doc.workspace ?? '', doc.subpath ?? '', doc.body,
  doc.createdAt, doc.updatedAt,
]);

/**
 * @param {Object} deps
 * @param {{get:(store:string,id:string)=>Promise<any>,transact:(stores:string[],operation:(stores:Record<string,IDBObjectStore>,transaction:IDBTransaction)=>any)=>Promise<any>}} deps.idb
 * @param {(prompt:any,signal?:AbortSignal)=>Promise<'yes_once'|'yes_session'|'no'>} deps.confirm
 * @param {()=>Promise<string|null>|string|null} deps.currentSessionId
 * @param {()=>void} deps.canWrite
 * @param {()=>Promise<void>|void} deps.assertAllowed
 * @param {()=>number} [deps.now]
 */
export const createKernelAdministrativeMemory = ({
  idb, confirm, currentSessionId, canWrite, assertAllowed, now = Date.now,
}) => {
  if (!idb || typeof idb.get !== 'function' || typeof idb.transact !== 'function'
      || typeof confirm !== 'function' || typeof currentSessionId !== 'function'
      || typeof canWrite !== 'function' || typeof assertAllowed !== 'function') {
    throw new TypeError('kernel-administrative-memory-config-invalid');
  }
  const serial = makeSerialLane();
  const commitInit = (/** @type {{workspace:string,body:string,checklist:string[]}} */ input,
    /** @type {AbortSignal} */ signal,
    /** @type {string|null|undefined} */ boundSessionId = undefined) => serial(async () => {
    if (signal?.aborted) return { ok: false, error: 'aborted' };
    await assertAllowed();
    canWrite();
    const scope = { kind: /** @type {const} */ ('project'), workspace: input.workspace };
    const id = scopeId(scope);
    const prior = await idb.get(STORE, id) ?? null;
    const priorVersion = versionOf(prior);
    const proposal = buildWriteProposal({ scope, prior, body: input.body, origin: 'agent' });
    if (proposal.op !== 'noop') {
      const sessionId = boundSessionId === undefined
        ? await currentSessionId() : boundSessionId;
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, error: 'memory-session-unavailable' };
      }
      const answer = await confirm({
        toolName: 'init',
        description: `Create AGENTS.md for ${input.workspace}`,
        origins: [], sideEffect: 'write', proposal,
        sessionId, ownerSessionId: sessionId, dispatchId: null,
      }, signal);
      if (answer !== 'yes_once' && answer !== 'yes_session') {
        return { ok: false, rejected: true };
      }
    }
    if (signal?.aborted) return { ok: false, rejected: true };
    const timestamp = now();
    const initializer = initializerScope(input.workspace);
    const initializerId = scopeId(initializer);
    const initializerBody = seedInitializerBody({
      workspace: input.workspace,
      checklist: input.checklist,
      nowIso: new Date(timestamp).toISOString(),
    });
    return idb.transact([STORE], (stores, transaction) => {
      const memory = stores[STORE];
      /** @type {any} */ let result = { ok: false, error: 'memory-write-unknown' };
      const currentRequest = memory.get(id);
      currentRequest.onsuccess = () => {
        if (versionOf(currentRequest.result ?? null) !== priorVersion) {
          result = { ok: false, error: 'memory-write-conflict' };
          return;
        }
        try {
          if (proposal.op === 'delete') memory.delete(id);
          else if (proposal.op !== 'noop') memory.put({
            id,
            kind: 'project',
            workspace: proposal.scope.workspace,
            body: normalizeBody(proposal.body),
            createdAt: Number.isFinite(prior?.createdAt) ? prior.createdAt : timestamp,
            updatedAt: timestamp,
          });
          const initializerRequest = memory.get(initializerId);
          initializerRequest.onsuccess = () => {
            try {
              if (!initializerRequest.result) memory.put({
                id: initializerId,
                kind: 'subtree',
                workspace: initializer.workspace,
                subpath: initializer.subpath,
                body: initializerBody,
                createdAt: timestamp,
                updatedAt: timestamp,
              });
              result = { ok: true, workspace: input.workspace };
            } catch { try { transaction.abort(); } catch {} }
          };
        } catch {
          try { transaction.abort(); } catch {}
        }
      };
      return () => result;
    });
  });
  return Object.freeze({ commitInit });
};
