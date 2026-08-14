// @ts-check

import { parsePodShell, podGitRemoteIntents } from '/peerd-engine/background.js';
import { wrapUntrusted } from '../prompt-wrap.js';

const POD_EXEC_PREVIEW_CHARS = 8_000;

/** @param {any} job @param {string} podId */
export const pagePodExecJob = (job, podId) => {
  const result = { ...job };
  for (const stream of ['stdout', 'stderr']) {
    const text = typeof job?.[stream] === 'string' ? job[stream] : '';
    const end = Math.min(text.length, POD_EXEC_PREVIEW_CHARS);
    result[stream] = text.slice(0, end);
    if (end < text.length || job?.[`${stream}Truncated`] === true) {
      result[`${stream}Page`] = {
        offset: 0, end, retainedChars: text.length, remainingChars: text.length - end,
        ...(job?.[`${stream}Truncated`] === true
          ? { sourceTruncated: true, note: 'The job exceeded retained output; bytes beyond retainedChars are unavailable.' }
          : {}),
        ...(end < text.length ? { next: { tool: 'pod_status', args: { podId, jobId: job.id, stream, offset: end, limit: POD_EXEC_PREVIEW_CHARS } } } : {}),
      };
    }
  }
  return result;
};

/** @type {import('/shared/tool-types.js').Tool} */
export const podExecTool = {
  name: 'pod_exec',
  primitive: 'pod',
  description: [
    'Run one command in this Pod shell. Supports files, pipelines/redirection,',
    'Web-standard JS (`js`, Chromium), WASI tools, browser Git, and audited HTTPS curl.',
    'This is not Linux: no Node/npm/native binaries/sockets/PTY. `background:true`',
    'returns a running job; inspect with pod_status and stop with pod_cancel.',
    'Foreground results preview 8000 characters per stream; follow the returned',
    'pod_status args to page retained output. grep uses JS regex; pass -F for literals.',
    'Timeout default 30s, maximum 300s. Ambiguous interrupted commands are never replayed.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Pod shell command.' },
      podId: { type: 'string', description: 'Optional Pod id (actor calls are pinned).' },
      timeoutMs: { type: 'integer', description: 'Wall clock limit, 1–300000ms.' },
      background: { type: 'boolean', description: 'Return immediately with a running job.' },
    },
    required: ['command'],
  },
  sideEffect: 'write',
  retryClass: 'E',
  origins: (args) => {
    const matches = String(args?.command ?? '').match(/https:\/\/[^\s'"<>|]+/g) ?? [];
    return [...new Set(matches.map((url) => { try { return new URL(url).origin; } catch { return ''; } }).filter(Boolean))];
  },
  execute: async (args, ctx) => {
    if (typeof args?.command !== 'string' || !args.command.trim()) return { ok: false, error: 'command_required' };
    const client = /** @type {any} */ (ctx).podClient;
    if (!client?.exec) return { ok: false, error: 'pod_unavailable' };
    try {
      const podId = await client.resolveId({ sessionId: ctx.session?.sessionId, podId: args.podId });
      const remoteIntents = podGitRemoteIntents(args.command);
      if (remoteIntents.length > 1) {
        return { ok: false, error: 'multiple_remote_git_operations_require_separate_pod_exec_calls' };
      }
      const remoteIntent = remoteIntents[0] ?? null;
      /** @type {{op:'clone'|'fetch'|'push'|'link',url:string}|null} */
      let remoteGitGrant = null;
      if (remoteIntent) {
        const repositories = /** @type {any} */ (ctx).repositories;
        const current = remoteIntent.url ? null : await repositories?.getRemote?.({ kind: 'pod', id: podId });
        const target = remoteIntent.url ?? current?.url;
        if (!target) return { ok: false, error: `git_${remoteIntent.op}_requires_https_remote` };
        const confirm = /** @type {any} */ (ctx).confirm;
        if (!confirm) return { ok: false, error: 'git_confirmation_unavailable' };
        const answer = await confirm({
          tool: 'pod_exec', kind: `git_${remoteIntent.op}`,
          sideEffect: remoteIntent.op === 'push' ? 'mutate_external' : 'write',
          origins: [new URL(target).origin],
          summary: remoteIntent.op === 'push'
            ? `Allow this one Pod job to push code and commit history to ${target}?`
            : `Allow this one Pod job to ${remoteIntent.op} ${target} through peerd's audited Git transport?`,
        });
        if (answer !== true && answer !== 'yes_once' && answer !== 'yes_session') {
          return { ok: false, error: `git_${remoteIntent.op}_declined` };
        }
        remoteGitGrant = { op: remoteIntent.op, url: target };
      }
      const background = args.background === true || parsePodShell(args.command).background;
      const job = await client.exec(args.command, {
        podId,
        timeoutMs: Math.min(300_000, Math.max(1, Number(args.timeoutMs) || 30_000)),
        background,
        remoteGitGrant,
        signal: background ? undefined : /** @type {any} */ (ctx).abortSignal,
      });
      return {
        ok: true,
        content: wrapUntrusted({
          origin: `pod:${podId}/job:${job.id ?? 'unknown'}`,
          tool: 'pod_exec',
          body: JSON.stringify(pagePodExecJob(job, podId), null, 2),
        }),
      };
    } catch (error) { return { ok: false, error: `pod_exec_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
};
