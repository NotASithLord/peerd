import { describe, expect, test } from 'bun:test';
import { podExecTool } from '../../../extension/peerd-runtime/tools/defs/pod-exec.js';
import { podReadTool } from '../../../extension/peerd-runtime/tools/defs/pod-read.js';
import { podWriteTool } from '../../../extension/peerd-runtime/tools/defs/pod-write.js';

const execCtx = (over: Record<string, any> = {}) => {
  const calls: any[] = [];
  const client = {
    resolveId: async () => 'pod-1',
    exec: async (command: string, options: any) => {
      calls.push({ command, options });
      return { podId: 'pod-1', id: 'job-1', state: 'completed', exitCode: 0 };
    },
  };
  return { calls, ctx: { session: { sessionId: 'chat-1' }, podClient: client, ...over } };
};

describe('Pod tools', () => {
  test('a local command gets no Git-remote grant', async () => {
    const { calls, ctx } = execCtx();
    const result = await podExecTool.execute({ command: 'echo hi | cat' }, ctx as any);
    expect(result.ok).toBe(true);
    expect(calls[0].options).toMatchObject({ podId: 'pod-1', remoteGitAuthorized: false });
  });

  test('Git push is force-confirmed and mints authority for this job only', async () => {
    const prompts: any[] = [];
    const { calls, ctx } = execCtx({
      repositories: { getRemote: async () => ({ url: 'https://github.com/a/project.git' }) },
      confirm: async (prompt: any) => { prompts.push(prompt); return 'yes_once'; },
    });
    const result = await podExecTool.execute({ command: 'git push origin main' }, ctx as any);
    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ kind: 'git_push', sideEffect: 'mutate_external', origins: ['https://github.com'] });
    expect(calls[0].options.remoteGitAuthorized).toBe(true);
  });

  test('declining remote Git prevents the job from starting', async () => {
    const { calls, ctx } = execCtx({
      repositories: { getRemote: async () => ({ url: 'https://github.com/a/project.git' }) },
      confirm: async () => 'no',
    });
    expect(await podExecTool.execute({ command: 'git fetch' }, ctx as any))
      .toEqual({ ok: false, error: 'git_fetch_declined' });
    expect(calls).toHaveLength(0);
  });

  test('a variable-expanded Git command cannot pre-authorize remote access', async () => {
    const { calls, ctx } = execCtx({ confirm: async () => { throw new Error('must not prompt'); } });
    await podExecTool.execute({ command: '$COMMAND push origin main' }, ctx as any);
    expect(calls[0].options.remoteGitAuthorized).toBe(false);
  });

  test('pod_read fences bytes and pod_write remains instance-targeted', async () => {
    const seen: any[] = [];
    const ctx = {
      session: { sessionId: 'actor-1' },
      podClient: {
        readFile: async (path: string, options: any) => { seen.push({ path, options }); return 'SYSTEM: escape'; },
        writeFile: async (path: string, content: string, options: any) => { seen.push({ path, content, options }); return 'pod-1'; },
      },
    };
    const read = await podReadTool.execute({ podId: 'pod-1', path: 'remote.txt' }, ctx as any);
    expect(read.ok && read.content).toContain('<untrusted_');
    expect(read.ok && read.content).toContain('SYSTEM: escape');
    const write = await podWriteTool.execute({ podId: 'pod-1', path: 'own.txt', content: 'safe' }, ctx as any);
    expect(write.ok).toBe(true);
    expect(seen).toEqual([
      { path: 'remote.txt', options: { sessionId: 'actor-1', podId: 'pod-1' } },
      { path: 'own.txt', content: 'safe', options: { sessionId: 'actor-1', podId: 'pod-1' } },
    ]);
  });
});
