import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

const bootBody = async () => {
  const source = await Bun.file('./extension/background/vault-kernel.js').text();
  const region = source.slice(source.indexOf('const recoveryCustody ='), source.indexOf('const vaultRoutes ='));
  return region.slice(region.lastIndexOf('});') + 3);
};
const runBoot = async (over: Record<string, any> = {}) => {
  const resumes: unknown[] = [], reads: unknown[] = [], warnings: unknown[] = [];
  let ready!: () => void;
  const kernelReady = new Promise<void>((resolve) => { ready = resolve; });
  runInNewContext(await bootBody(), {
    kernelReady,
    vault: { isLocked: () => over.locked === true },
    settingsStore: { get: () => ({ autoResumeInterruptedTurns: over.auto !== false }) },
    sessionCache: { sessionGet: async () => { reads.push('current'); return over.id === undefined ? 'chat-1' : over.id; } },
    kernelSessions: { get: async (id: string) => { reads.push(id); return { messages: over.messages ?? [] }; } },
    recoveryCustody: { resume: async (id: unknown) => { resumes.push(id); } },
    console: { warn: (...args: unknown[]) => warnings.push(args) },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { resumes, reads, warnings, ready, flush };
};

describe('cold kernel interruption preflight', () => {
  test('the actual boot body waits for readiness and sends current interruptions to recovery custody', async () => {
    for (const last of [
      { role: 'assistant', streaming: true },
      { role: 'assistant', stopReason: 'incomplete' },
      { role: 'assistant', stopReason: 'tool_use', toolUses: [{ id: 'tool-1' }] },
      { role: 'user', toolResults: [{ tool_use_id: 'tool-1', content: 'done' }] },
    ]) {
      const h = await runBoot({ messages: [last] });
      await h.flush();
      expect(h.reads).toEqual([]);
      h.ready(); await h.flush();
      expect(h.resumes).toEqual(['chat-1']);
      expect(h.warnings).toEqual([]);
    }
  });
  test('locked, disabled, absent and finished chats do not load the recovery owner', async () => {
    for (const over of [
      { locked: true, messages: [{ role: 'assistant', streaming: true }] },
      { auto: false, messages: [{ role: 'assistant', streaming: true }] },
      { id: null }, {},
      { messages: [{ role: 'assistant', stopReason: 'end_turn' }] },
      { messages: [{ role: 'assistant', stopReason: 'aborted' }] },
      { messages: [{ role: 'user', content: 'not yet admitted' }] },
    ]) {
      const h = await runBoot(over); h.ready(); await h.flush();
      expect(h.resumes).toEqual([]);
      if (over.locked || over.auto === false) expect(h.reads).toEqual([]);
    }
  });
});
