// The runtime projections for self-device sync: the durable-content vs
// device-bookkeeping split (sessions), logical-artifact shaping (apps,
// workspaces), and the apply-side idempotency + conflict behavior. These
// enforce the issue's §10 exclusions at the projection layer, device-local
// state must NOT be present in the person-portable form.

import { describe, test, expect } from 'bun:test';
import {
  portableSession, shapeSessionsSurface, applySessionsSurface,
  shapeAppsSurface, applyAppsSurface,
  shapeWorkspacesSurface, applyWorkspacesSurface,
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
      backing: 'tab', originState: { mode: 'bound' }, review: true, prewalk: { phase: 'planning' },
      permissionMode: 'act', confirmActions: false, parentSessionId: 'p1', task: 'do it', depth2: 9,
      messages: [
        { role: 'user', content: 'hi', actorDelivery: { x: 1 }, streaming: true },
        { role: 'assistant', content: 'hello' },
      ],
    };
    const portable = portableSession(session);
    for (const field of ['grantedTools', 'spawnedTrusted', 'instanceId', 'actorType', 'backing',
      'originState', 'review', 'prewalk', 'permissionMode', 'confirmActions', 'parentSessionId', 'task']) {
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
    const surface = shapeSessionsSurface({
      sessions: [
        { sessionId: 'chat-1', kind: 'chat', messages: [] },
        { sessionId: 'actor-1', kind: 'actor', instanceId: 'vm', messages: [] },
        { sessionId: 'spawned-1', kind: 'spawned', parentSessionId: 'chat-1', messages: [] },
        { sessionId: 'chat-old', messages: [] }, // legacy record, kind undefined = chat
      ],
    });
    expect(surface.sessions.map((s) => s.sessionId).sort()).toEqual(['chat-1', 'chat-old']);
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
