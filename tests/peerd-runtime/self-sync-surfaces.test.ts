// The runtime projections for self-device sync: the durable-content vs
// device-bookkeeping split (sessions), logical-artifact shaping (apps,
// workspaces), and the apply-side idempotency + conflict behavior. These
// enforce the issue's §10 exclusions at the projection layer, device-local
// state must NOT be present in the person-portable form.

import { describe, test, expect } from 'bun:test';
import {
  portableSession, shapeSessionsSurface, applySessionsSurface,
  shapeSettingsSurface,
  shapeAppsSurface, captureAppsSurface, applyAppsSurface,
  shapeWorkspacesSurface, applyWorkspacesSurface,
  shapeSecretsSurface,
  encodeSurface, decodeSurface,
} from '../../extension/peerd-runtime/transfer/self-sync-surfaces.js';

describe('session projection', () => {
  test('strips ALL device-local bookkeeping, keeps the conversation', () => {
    const session = {
      sessionId: 's1', createdAt: 1, provider: 'anthropic', model: 'claude-sonnet-5',
      title: 'My chat', kind: 'chat', depth: 0,
      cost: { total: 10 },
      // Device-local bookkeeping that must NOT travel:
      grantedTools: ['x'], spawnedTrusted: true, instanceId: 'vm-1', actorType: 'webvm',
      backing: 'tab', originState: { mode: 'bound' }, prewalk: { phase: 'planning' },
      permissionMode: 'act', confirmActions: false, parentSessionId: 'p1', task: 'do it', depth2: 9,
      trimSummary: { rolling: 'source-only model context' }, toolManifest: { tools: ['dangerous'] },
      messages: [
        { role: 'user', content: 'hi', actorDelivery: { x: 1 }, streaming: true },
        { role: 'assistant', content: 'hello' },
      ],
    };
    const portable: any = portableSession(session);
    for (const field of ['grantedTools', 'spawnedTrusted', 'instanceId', 'actorType', 'backing',
      'originState', 'prewalk', 'permissionMode', 'confirmActions', 'parentSessionId', 'task',
      'trimSummary', 'toolManifest']) {
      expect(portable).not.toHaveProperty(field);
    }
    expect(portable.title).toBe('My chat');
    expect(portable.cost).toEqual({ total: 10 });
    expect(portable.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  test('only top-level chats are portable; actors/spawned are dropped', () => {
    const surface: any = shapeSessionsSurface({
      sessions: [
        { sessionId: 'chat-1', kind: 'chat', messages: [] },
        { sessionId: 'actor-1', kind: 'actor', instanceId: 'vm', messages: [] },
        { sessionId: 'spawned-1', kind: 'spawned', parentSessionId: 'chat-1', messages: [] },
        { sessionId: 'chat-old', messages: [] }, // legacy record, kind undefined = chat
      ],
    });
    expect(surface.sessions.map((s: any) => s.sessionId).sort()).toEqual(['chat-1', 'chat-old']);
  });

  test('apply is idempotent and keeps the destination on conflict', async () => {
    const surface = shapeSessionsSurface({
      sessions: [
        { sessionId: 'chat-1', kind: 'chat', messages: [{ role: 'user', content: 'a' }] },
        { sessionId: 'chat-2', kind: 'chat', messages: [{ role: 'user', content: 'b' }] },
      ],
    });
    const written: any[] = [];
    const result = await applySessionsSurface(surface, {
      existingIds: new Set(['chat-1']), // chat-1 already here → keep destination
      putSession: async (s) => { written.push(s); },
    });
    expect(result).toEqual({ written: 1, skipped: 1 });
    expect(written.map((s) => s.sessionId)).toEqual(['chat-2']);
  });

  test('a second-session failure reports the item that already committed', async () => {
    const surface = shapeSessionsSurface({
      sessions: [
        { sessionId: 'chat-1', kind: 'chat', messages: [] },
        { sessionId: 'chat-2', kind: 'chat', messages: [] },
      ],
    });
    let calls = 0;
    try {
      await applySessionsSurface(surface, {
        existingIds: new Set(),
        putSession: async () => {
          calls++;
          if (calls === 2) throw new Error('disk full');
        },
      });
      throw new Error('expected the sessions surface to fail');
    } catch (error: any) {
      expect(error.name).toBe('SurfaceApplyPartialError');
      expect(error.result).toEqual({ written: 1, skipped: 0 });
    }
  });

  test('future or malformed session/App payloads fail instead of applying empty success', async () => {
    await expect(applySessionsSurface({ v: 2, conversations: [] }, {
      existingIds: new Set(), putSession: async () => {},
    })).rejects.toThrow(/malformed or unsupported/);
    await expect(applyAppsSurface({ v: 2, artifacts: [] }, {
      existingHashes: new Set(), installApp: async () => {},
    })).rejects.toThrow(/malformed or unsupported/);
  });
});

describe('secret custody boundary', () => {
  test('filters protected keys while shaping', () => {
    const shaped = shapeSecretsSurface({ secrets: {
      'provider/anthropic': 'portable',
      'distributed/identity/v1': 'root',
      'distributed/device-key/v1': 'device',
      'distributed/self-discovery/v1': 'topic-secret',
      'distributed/self-records/v1': 'roster',
    } });
    expect(shaped.secrets).toEqual({ 'provider/anthropic': 'portable' });

  });
});

test('settings projection never moves the dweb transport toggle', () => {
  expect(shapeSettingsSurface({ settings: { theme: 'dark', dwebEnabled: false } }))
    .toEqual({ v: 1, settings: { theme: 'dark' } });
});

describe('apps projection', () => {
  test('shapes logical artifacts, dedups by content hash on apply', async () => {
    const surface = shapeAppsSurface({
      apps: [
        { name: 'Timer', entryFile: 'index.html', files: { 'index.html': 'PGgxPg==' }, contentHash: 'aaa' },
        { name: 'Notes', entryFile: 'index.html', files: { 'index.html': 'Pg==' }, contentHash: 'bbb' },
      ],
    });
    expect(surface.apps[0]).not.toHaveProperty('id'); // no local IDB handle travels
    const installed: any[] = [];
    const result = await applyAppsSurface(surface, {
      existingHashes: new Set(['aaa']), // Timer already present by hash
      installApp: async (a) => { installed.push(a); },
    });
    expect(result).toEqual({ installed: 1, skipped: 1 });
    expect(installed[0].name).toBe('Notes');
  });

  test('a failed live App snapshot makes the whole surface unavailable', async () => {
    const seen: string[] = [];
    await expect(captureAppsSurface({
      records: [{ id: 'a' }, { id: 'broken' }, { id: 'c' }],
      snapshotApp: async (record) => {
        seen.push(record.id);
        if (record.id === 'broken') throw new Error('OPFS read failed');
        return { name: record.id, entryFile: 'index.html', files: { 'index.html': '' } };
      },
    })).rejects.toThrow('OPFS read failed');
    expect(seen).toEqual(['a', 'broken']);
  });

  test('local Apps get stable retry identities and capture stops at the cumulative cap', async () => {
    const record = { id: 'local-1' };
    const snapshot = async () => ({
      name: 'Local', entryFile: 'index.html', fileKinds: {}, files: { 'index.html': 'PGgxPk9LPC9oMT4=' },
    });
    const first = await captureAppsSurface({ records: [record], snapshotApp: snapshot });
    const second = await captureAppsSurface({ records: [record], snapshotApp: snapshot });
    expect(first.apps[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.apps[0].contentHash).toBe(first.apps[0].contentHash);
    await expect(captureAppsSurface({ records: [record], snapshotApp: snapshot, maxBytes: 8 }))
      .rejects.toThrow(/transfer cap/);
  });

  test('recomputes App identity from captured bytes after a local edit', async () => {
    const staleHash = 'a'.repeat(64);
    const record = { id: 'app-1', syncContentHash: staleHash };
    const capture = (bytes: string) => captureAppsSurface({
      records: [record],
      snapshotApp: async () => ({
        name: 'Notes', entryFile: 'index.html', fileKinds: {},
        files: { 'index.html': bytes }, contentHash: staleHash,
      }),
    });
    const original = await capture('b2xk');
    const edited = await capture('bmV3');
    expect(original.apps[0].contentHash).not.toBe(staleHash);
    expect(edited.apps[0].contentHash).not.toBe(original.apps[0].contentHash);
  });

  test('a second-App failure reports the App that already committed', async () => {
    let attempts = 0;
    await expect(applyAppsSurface({ v: 1,
      apps: [
        { name: 'One', entryFile: 'index.html', files: { 'index.html': 'MQ==' } },
        { name: 'Two', entryFile: 'index.html', files: { 'index.html': 'Mg==' } },
      ],
    }, {
      existingHashes: new Set(),
      installApp: async () => { attempts++; if (attempts === 2) throw new Error('quota'); },
    })).rejects.toMatchObject({
      name: 'SurfaceApplyPartialError', result: { installed: 1, skipped: 0 },
    });
  });
});

describe('workspaces projection', () => {
  test('shapes path→bytes trees and materializes into fresh roots (no handles)', async () => {
    const surface = shapeWorkspacesSurface({
      workspaces: [{ id: 'nb-1', kind: 'notebook', files: { 'main.py': 'cHJpbnQoMSk=', 'data/x.txt': 'aGk=' } }],
    });
    expect(surface.workspaces[0]).not.toHaveProperty('handle');
    const materialized: any[] = [];
    const result = await applyWorkspacesSurface(surface, {
      materializeWorkspace: async (w) => { materialized.push(w); },
    });
    expect(result).toEqual({ materialized: 1, skipped: 0 });
    expect(Object.keys(materialized[0].files)).toEqual(['main.py', 'data/x.txt']);
  });
});

describe('surface encode/decode seam', () => {
  test('round-trips a shaped payload through bytes', () => {
    const shaped = shapeSessionsSurface({ sessions: [{ sessionId: 'c1', kind: 'chat', messages: [] }] });
    const bytes = encodeSurface(shaped);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decodeSurface(bytes)).toEqual(shaped);
  });
});
