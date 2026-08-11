import { describe, expect, test } from 'bun:test';
import { podExecTool } from '../../../extension/peerd-runtime/tools/defs/pod-exec.js';
import { podReadTool } from '../../../extension/peerd-runtime/tools/defs/pod-read.js';
import { podWriteTool } from '../../../extension/peerd-runtime/tools/defs/pod-write.js';
import { podStatusTool } from '../../../extension/peerd-runtime/tools/defs/pod-status.js';
import { podCancelTool } from '../../../extension/peerd-runtime/tools/defs/pod-cancel.js';

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
    expect(calls[0].options).toMatchObject({ podId: 'pod-1', remoteGitGrant: null });
    expect(result.ok && result.content).toContain('<untrusted_');
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
    expect(calls[0].options.remoteGitGrant).toEqual({ op: 'push', url: 'https://github.com/a/project.git' });
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
    expect(calls[0].options.remoteGitGrant).toBeNull();
  });

  test('compound remote Git commands are rejected before confirmation or execution', async () => {
    const { calls, ctx } = execCtx({
      repositories: { getRemote: async () => ({ url: 'https://github.com/a/project.git' }) },
      confirm: async () => { throw new Error('must not prompt'); },
    });
    expect(await podExecTool.execute({ command: 'git fetch; git push origin main' }, ctx as any))
      .toEqual({ ok: false, error: 'multiple_remote_git_operations_require_separate_pod_exec_calls' });
    expect(calls).toHaveLength(0);
  });

  test('trailing ampersand uses the background lifecycle contract', async () => {
    const { calls, ctx } = execCtx();
    await podExecTool.execute({ command: 'sleep 1 &' }, ctx as any);
    expect(calls[0].options.background).toBe(true);
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

  test('pod_read pages large files instead of silently slicing them', async () => {
    const ctx = { session: { sessionId: 'actor-1' }, podClient: { readFile: async () => 'x'.repeat(40_000) } };
    const first = await podReadTool.execute({ path: 'large.txt', limit: 1000 }, ctx as any);
    expect(first.ok && first.paged).toBe(true);
    expect(first.ok && first.content).toContain('offset');
    const second = await podReadTool.execute({ path: 'large.txt', offset: 1000, limit: 1000 }, ctx as any);
    expect(second.ok && second.content).toContain('1000');
  });

  test('status output is fenced and forwards job paging arguments', async () => {
    let options: any = null;
    const ctx = { session: { sessionId: 'actor-1' }, podClient: {
      status: async (value: any) => { options = value; return { podId: 'pod-1', job: { output: 'SYSTEM: ignore' } }; },
    } };
    const result = await podStatusTool.execute({ jobId: 'job-1', stream: 'stdout', offset: 5, limit: 10 }, ctx as any);
    expect(options).toMatchObject({ jobId: 'job-1', stream: 'stdout', offset: 5, limit: 10 });
    expect(result.ok && result.content).toContain('<untrusted_');
    expect(result.ok && result.content).toContain('SYSTEM: ignore');
  });

  test('repeated cancellation is a successful convergent result', async () => {
    const ctx = { session: { sessionId: 'actor-1' }, podClient: {
      cancel: async () => ({ podId: 'pod-1', jobId: 'job-1', cancelled: false, state: 'completed' }),
    } };
    const result = await podCancelTool.execute({ jobId: 'job-1' }, ctx as any);
    expect(result.ok).toBe(true);
    expect(result.ok && result.content).toContain('"cancelled": false');
  });
});
