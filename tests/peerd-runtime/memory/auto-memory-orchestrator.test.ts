// makeAutoMemory — the lifecycle-seam orchestrator, end to end with
// fakes: gating (setting / busy / substance / watermark), the
// watermark-before-call ordering, dedupe against the user doc, and the
// suggestions landing as PENDING (never written to memory here).

import { describe, test, expect } from 'bun:test';
import { makeAutoMemory } from '../../../extension/peerd-runtime/memory/auto-memory-orchestrator.js';
import { createSuggestionStore } from '../../../extension/peerd-runtime/memory/suggestions.js';
import { AUTO_MEMORY_MIN_USER_TURNS } from '../../../extension/peerd-runtime/memory/auto-memory.js';

const substantiveSession = (extra: any = {}) => ({
  sessionId: 's1',
  kind: 'chat',
  title: 'GPU procurement chat',
  messages: Array.from({ length: AUTO_MEMORY_MIN_USER_TURNS }, (_, i) => [
    { role: 'user', content: `long substantive question number ${i} about my ongoing bare-metal project`, id: `u${i}`, when: i },
    { role: 'assistant', content: `a long substantive answer number ${i} about that project`, id: `a${i}`, when: i },
  ]).flat(),
  ...extra,
});

const makeWorld = (opts: {
  session?: any,
  callText?: string,
  callResult?: any,
  userDocBody?: string,
  settings?: any,
  busy?: boolean,
} = {}) => {
  const session = 'session' in opts ? opts.session : substantiveSession();
  const updates: any[] = [];
  const calls: any[] = [];
  const audits: any[] = [];
  const notices: any[] = [];
  const kvMap = new Map<string, any>();
  let n = 0;
  const suggestions = createSuggestionStore({
    kv: {
      get: async (k: string) => kvMap.get(k),
      set: async (k: string, v: any) => { kvMap.set(k, structuredClone(v)); },
    },
    now: () => 1,
    makeId: () => `id-${n++}`,
  });
  const auto = makeAutoMemory({
    sessions: {
      get: async () => session,
      update: async (_id: string, patch: any) => {
        updates.push(patch);
        Object.assign(session ?? {}, patch);
        return session;
      },
    } as any,
    memory: { readScope: async () => (opts.userDocBody ? { body: opts.userDocBody } : null) } as any,
    suggestions,
    cheapCall: async (req: any) => {
      calls.push(req);
      return opts.callResult ?? { ok: true, text: opts.callText ?? '{"notes":[]}' };
    },
    getSettings: () => opts.settings ?? {},
    isBusy: () => opts.busy === true,
    appendAudit: async (e: any) => { audits.push(e); },
    notify: (info: any) => notices.push(info),
    now: () => 42,
  });
  return { auto, suggestions, updates, calls, audits, notices };
};

describe('makeAutoMemory', () => {
  test('substantive session → one cheap call → notes land as PENDING suggestions', async () => {
    const { auto, suggestions, updates, calls, audits, notices } = makeWorld({
      callText: '{"notes":["runs Hydra Host, buys bare-metal GPUs"]}',
    });
    const res = await auto.maybeExtract('s1', 'archive');
    expect(res).toEqual({ ok: true, notes: 1 });
    // Watermark written BEFORE the call (idempotence across repeats).
    expect(updates[0].autoMemory).toEqual({ at: 42, userTurns: AUTO_MEMORY_MIN_USER_TURNS });
    expect(calls.length).toBe(1);
    expect(calls[0].label).toBe('auto-memory');
    expect(calls[0].task).toContain('extremely frugal');
    const pending = await suggestions.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].text).toBe('runs Hydra Host, buys bare-metal GPUs');
    expect(pending[0].sessionTitle).toBe('GPU procurement chat');
    expect(audits.some((a) => a.type === 'auto_memory_suggested')).toBe(true);
    expect(notices).toEqual([{ pending: 1 }]);
  });

  test('zero notes is the quiet common case — no suggestions, no audit noise', async () => {
    const { auto, suggestions, notices } = makeWorld({ callText: '{"notes":[]}' });
    const res = await auto.maybeExtract('s1', 'switch');
    expect(res).toEqual({ ok: true, notes: 0 });
    expect(await suggestions.count()).toBe(0);
    expect(notices.length).toBe(0);
  });

  test('gates: disabled setting / busy session / no substance → skip without a call', async () => {
    {
      const { auto, calls } = makeWorld({ settings: { autoMemoryEnabled: false } });
      expect((await auto.maybeExtract('s1', 'archive')).skipped).toBe('disabled');
      expect(calls.length).toBe(0);
    }
    {
      const { auto, calls } = makeWorld({ busy: true });
      expect((await auto.maybeExtract('s1', 'switch')).skipped).toBe('busy');
      expect(calls.length).toBe(0);
    }
    {
      const { auto, calls } = makeWorld({ session: { kind: 'chat', messages: [] } });
      expect((await auto.maybeExtract('s1', 'archive')).skipped).toBe('too-few-turns');
      expect(calls.length).toBe(0);
    }
    {
      const { auto, calls } = makeWorld({ session: substantiveSession({ kind: 'subagent' }) });
      expect((await auto.maybeExtract('s1', 'archive')).skipped).toBe('not-a-chat');
      expect(calls.length).toBe(0);
    }
  });

  test('default-ON: an absent setting key does not disable extraction', async () => {
    const { auto, calls } = makeWorld({ settings: {}, callText: '{"notes":[]}' });
    expect((await auto.maybeExtract('s1', 'archive')).ok).toBe(true);
    expect(calls.length).toBe(1);
  });

  test('watermark makes a second trigger a no-op until new substance arrives', async () => {
    const { auto, calls } = makeWorld({ callText: '{"notes":[]}' });
    await auto.maybeExtract('s1', 'switch');
    const second = await auto.maybeExtract('s1', 'switch');
    expect(second.skipped).toBe('no-new-substance');
    expect(calls.length).toBe(1);
  });

  test('notes already covered by the user doc are deduped away', async () => {
    const { auto, suggestions } = makeWorld({
      callText: '{"notes":["runs Hydra Host","prefers tabs"]}',
      userDocBody: '# User memory\n\n- Runs  HYDRA host',
    });
    const res = await auto.maybeExtract('s1', 'archive');
    expect(res).toEqual({ ok: true, notes: 1 });
    expect((await suggestions.listPending())[0].text).toBe('prefers tabs');
  });

  test('a failed/capped call audits the skip and writes nothing', async () => {
    const { auto, suggestions, audits } = makeWorld({
      callResult: { ok: false, skipped: true, reason: 'spend-limit' },
    });
    const res = await auto.maybeExtract('s1', 'archive');
    expect(res).toEqual({ ok: false, reason: 'spend-limit' });
    expect(await suggestions.count()).toBe(0);
    expect(audits.some((a) => a.type === 'auto_memory_skipped')).toBe(true);
  });
});
