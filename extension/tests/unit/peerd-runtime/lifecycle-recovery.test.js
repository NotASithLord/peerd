// @ts-check
// Lifecycle recovery — REAL-BROWSER execution of the contract's SW-eviction
// sequence (§15). The bun suite proves the decisions; this file proves them
// over the storage that actually survives an eviction: chrome.storage.local
// through the same adapters the SW wires. An "eviction" here is what the
// contract defines it to be (§2.1): durable storage persists, memory does
// not — so booting a second lifecycle instance over the same real storage
// IS the fault injection.

import { describe, it, expect } from '../../framework.js';
import {
  makeLifecycleBoot, makeDispatchTracker, retryClassForTool,
  OPERATION_STATES, groupResourceLossNotices,
} from '/peerd-runtime/index.js';
import { dispatchToolCall as dispatchExplicitToolCall } from '/peerd-runtime/tools/local-tool-dispatcher.js';
import { toToolDescriptor } from '/peerd-runtime/tools/metadata/descriptor.js';

const S = OPERATION_STATES;

/** @type {import('/shared/tool-types.js').Tool | null} */
let fixtureTool = null;
/** @param {import('/shared/tool-types.js').Tool} tool */
const setFixtureTool = (tool) => { fixtureTool = tool; };
const clearFixtureTool = () => { fixtureTool = null; };
/** @param {import('/shared/tool-types.js').ToolCall} call @param {any} ctx */
const dispatchToolCall = (call, ctx) => {
  const implementation = fixtureTool?.name === call.name ? fixtureTool : null;
  return dispatchExplicitToolCall(call, ctx, {
    descriptor: implementation ? toToolDescriptor(implementation) : undefined,
    execute: (prepared) => implementation
      ? implementation.execute(prepared.args, prepared.execCtx)
      : ({ ok: false, error: 'tool implementation unavailable', outcomeKnown: true }),
  });
};

// REAL browser storage. As an extension page this is chrome.storage.local
// (the SW's actual kv backing); under the CDP harness the runner serves
// over localhost where chrome.* is absent, so the same contract rides real
// IndexedDB — still durable browser storage with the §2.1 survival
// property (persists across the simulated eviction), still the async IO
// path the bun suite cannot exercise. Namespaced/isolated either way.
const PREFIX = 'test.lifecycle.';
const IDB_NAME = 'peerd-test-lifecycle';
const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome?.storage?.local;

const openTestDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(IDB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
/** @param {'readonly'|'readwrite'} mode @param {(store: IDBObjectStore) => IDBRequest} fn */
const idbOp = async (mode, fn) => {
  const db = /** @type {IDBDatabase} */ (await openTestDb());
  try {
    return await new Promise((resolve, reject) => {
      const request = fn(db.transaction('kv', mode).objectStore('kv'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
};

const realStorage = () => (hasChromeStorage
  ? {
    /** @param {string} key */
    get: async (key) => (await chrome.storage.local.get(PREFIX + key))[PREFIX + key],
    /** @param {string} key @param {any} value */
    set: async (key, value) => chrome.storage.local.set({ [PREFIX + key]: value }),
  }
  : {
    /** @param {string} key */
    get: (key) => idbOp('readonly', (s) => s.get(PREFIX + key)),
    /** @param {string} key @param {any} value */
    set: async (key, value) => { await idbOp('readwrite', (s) => s.put(value, PREFIX + key)); },
  });

const cleanup = async () => {
  if (hasChromeStorage) {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
    return;
  }
  await idbOp('readwrite', (s) => s.clear());
};

let nonceCounter = 0;
const boot = (extra = {}) => makeLifecycleBoot({
  storage: realStorage(),
  nonce: () => `nonce-${Date.now()}-${nonceCounter += 1}`,
  ...extra,
});

describe('lifecycle recovery over real chrome.storage', () => {
  it('groups engine losses into one bounded report for the owning chat', () => {
    const notices = groupResourceLossNotices([
      { kind: 'vm', id: 'vm-1', name: 'workbench', ownerSessionId: 'chat-a' },
      { kind: 'app', id: 'app-1', name: 'preview', ownerSessionId: 'chat-a' },
    ]);
    expect(notices.length).toBe(1);
    expect(notices[0].sessionId).toBe('chat-a');
    expect(notices[0].user.includes('Linux VM "workbench"')).toBe(true);
    expect(notices[0].user.includes('App "preview"')).toBe(true);
    expect(notices[0].user.includes('in-memory state were lost')).toBe(true);
    expect(notices[0].agent.includes('Linux VM "vm-1"')).toBe(true);
    expect(notices[0].agent.includes('workbench')).toBe(false);
  });

  it('a rebooted generation settles each retry class to its contract state', async () => {
    await cleanup();
    try {
      const gen1 = boot();
      const { generation } = await gen1.init();
      const log = gen1.operationLog;
      /** @param {string} id @param {string} retryClass */
      const begin = (id, retryClass) => log.begin({
        operationId: id, sessionId: 'sess-real', toolName: `tool-${retryClass}`,
        retryClass, generationId: generation.id,
      });

      await begin('real-b', 'B');
      await log.transition('real-b', S.RUNNING);
      await log.markDispatched('real-b');
      await begin('real-e', 'E');
      await log.transition('real-e', S.RUNNING);
      await log.markDispatched('real-e');
      await begin('real-e2', 'E');
      await log.transition('real-e2', S.RUNNING);
      await log.transition('real-e2', S.AWAITING_USER);

      // The eviction: a fresh boot over the same real storage.
      const gen2 = boot();
      const { plan } = await gen2.init();
      expect(plan.transitions.length).toBe(3);
      expect((await gen2.operationLog.get('real-b'))?.state).toBe(S.INTERRUPTED);
      expect((await gen2.operationLog.get('real-e'))?.state).toBe(S.OUTCOME_UNKNOWN);
      expect((await gen2.operationLog.get('real-e2'))?.state).toBe(S.INTERRUPTED);

      // The agent-facing notice drains once, then never again.
      const block = await gen2.drainNoticesFor('sess-real');
      expect(block.includes('outcome_unknown')).toBe(true);
      expect(await gen2.drainNoticesFor('sess-real')).toBe('');
    } finally {
      await cleanup();
    }
  });

  it('generation seq survives the reboot monotonically in real storage', async () => {
    await cleanup();
    try {
      const first = await boot().init();
      const second = await boot().init();
      expect(second.generation.seq).toBe(first.generation.seq + 1);
      expect(second.generation.id === first.generation.id).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('routes an immediate recovery note to its session without tool arguments', async () => {
    await cleanup();
    try {
      const gen1 = boot();
      const { generation } = await gen1.init();
      await gen1.operationLog.begin({
        operationId: 'real-notice', sessionId: 'session-owner', toolName: 'submit_form',
        retryClass: 'E', generationId: generation.id,
      });
      await gen1.operationLog.transition('real-notice', S.RUNNING);
      await gen1.operationLog.markDispatched('real-notice');

      /** @type {Array<{ sessionId: string, text: string }>} */
      const notes = [];
      await boot({
        notify: (/** @type {string} */ sessionId, /** @type {string} */ text) => {
          notes.push({ sessionId, text });
        },
      }).init();

      expect(notes.length).toBe(1);
      expect(notes[0].sessionId).toBe('session-owner');
      expect(notes[0].text.includes('Recovery for submit_form')).toBe(true);
      expect(notes[0].text.includes('operationId')).toBe(false);
      expect(notes[0].text.includes('args')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('the wired dispatcher refuses a cross-generation Class E replay end-to-end', async () => {
    await cleanup();
    clearFixtureTool();
    try {
      let executions = 0;
      setFixtureTool(/** @type {any} */ ({
        name: 'test_submit', description: 'x', schema: {},
        primitive: 'web', sideEffect: 'mutate_external',
        origins: () => [],
        execute: async () => { executions += 1; throw new Error('request timed out'); },
      }));
      const ctx = (/** @type {any} */ tracker) => /** @type {any} */ ({
        audit: async () => {}, hooks: [],
        session: { sessionId: 'sess-real' },
        permission: { mode: 'act', confirmActions: false },
        lifecycle: tracker,
      });

      // Generation 1 dispatches; the timeout settles it outcome_unknown.
      const gen1 = boot();
      const g1 = await gen1.init();
      const tracker1 = makeDispatchTracker({
        operationLog: gen1.operationLog,
        generationId: () => g1.generation.id,
        retryClassFor: retryClassForTool,
      });
      const first = await dispatchToolCall(
        { id: 'real-tu-1', name: 'test_submit', args: {} }, ctx(tracker1));
      expect(first.ok).toBe(false);
      expect(String(/** @type {any} */ (first).error).startsWith('outcome_unknown:')).toBe(true);

      // Generation 2 (post-eviction) re-drives the same tool_use id: the
      // replay guard must answer without re-executing the tool.
      const gen2 = boot();
      const g2 = await gen2.init();
      const tracker2 = makeDispatchTracker({
        operationLog: gen2.operationLog,
        generationId: () => g2.generation.id,
        retryClassFor: retryClassForTool,
      });
      const replay = await dispatchToolCall(
        { id: 'real-tu-1', name: 'test_submit', args: {} }, ctx(tracker2));
      expect(executions).toBe(1);
      expect(replay.ok).toBe(false);
      expect(String(/** @type {any} */ (replay).error).startsWith('outcome_unknown:')).toBe(true);
    } finally {
      clearFixtureTool();
      await cleanup();
    }
  });
});
