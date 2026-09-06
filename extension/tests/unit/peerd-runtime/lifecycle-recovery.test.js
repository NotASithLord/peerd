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

const S = OPERATION_STATES;

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

  it('the authority tracker refuses a cross-generation Class E replay', async () => {
    await cleanup();
    try {
      const gen1 = boot();
      const g1 = await gen1.init();
      const tracker1 = makeDispatchTracker({
        operationLog: gen1.operationLog,
        generationId: () => g1.generation.id,
        retryClassFor: retryClassForTool,
      });
      const first = await tracker1.beginTracking({
        callId: 'real-tu-1', sessionId: 'sess-real', args: {},
        tool: { name: 'test_submit', retryClass: 'E' },
      });
      const settled = await tracker1.settleTracking(
        /** @type {{handle:any}} */ (first).handle,
        { ok: false, error: 'request timed out' },
      );
      expect(String(settled?.error).startsWith('outcome_unknown:')).toBe(true);

      const gen2 = boot();
      const g2 = await gen2.init();
      const tracker2 = makeDispatchTracker({
        operationLog: gen2.operationLog,
        generationId: () => g2.generation.id,
        retryClassFor: retryClassForTool,
      });
      const replay = await tracker2.beginTracking({
        callId: 'real-tu-1', sessionId: 'sess-real', args: {},
        tool: { name: 'test_submit', retryClass: 'E' },
      });
      expect(String(/** @type {any} */ (replay).refuse.error)
        .startsWith('outcome_unknown:')).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
