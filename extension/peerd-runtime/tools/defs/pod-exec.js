// @ts-check

import { podGitRemoteIntent } from '/peerd-engine/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podExecTool = {
  name: 'pod_exec',
  primitive: 'pod',
  description: [
    'Run one command in this Pod shell. Supports files, pipelines/redirection,',
    'Web-standard JS (`js`, Chromium), WASI tools, browser Git, and audited HTTPS curl.',
    'This is not Linux: no Node/npm/native binaries/sockets/PTY. `background:true`',
    'returns a running job; inspect with pod_status and stop with pod_cancel.',
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
      const remoteIntent = podGitRemoteIntent(args.command);
      let remoteGitAuthorized = false;
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
        remoteGitAuthorized = true;
      }
      const job = await client.exec(args.command, {
        podId,
        timeoutMs: Math.min(300_000, Math.max(1, Number(args.timeoutMs) || 30_000)),
        background: args.background === true,
        remoteGitAuthorized,
      });
      return { ok: true, content: JSON.stringify(job, null, 2) };
    } catch (error) { return { ok: false, error: `pod_exec_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
};
