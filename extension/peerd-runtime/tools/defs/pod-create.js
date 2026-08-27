// @ts-check
// Pod arm of sandbox_create: fast shell/WASI environment over existing OPFS,
// Git, egress, and tab lifecycle primitives.

import { oncePerSession } from './once-per-session.js';

/** @param {boolean} persistent */
const podNote = (persistent) => [
  '<pod>',
  'A Pod is a fast local shell + OPFS workspace, not Linux. Use pod_exec for',
  'files, pipelines, Web-standard JavaScript (`js` on Chromium), WASI Preview 1 commands,',
  'browser Git, and audited HTTPS (`curl`). WASI tools can be installed with',
  '`install-tool name file.wasm`; `wasi-demo` is the built-in smoke test.',
  'There is no Node, npm, native binary, socket, PTY, or package-manager claim.',
  'Use a WebVM when a workload needs Linux, Node/npm, Python/Ruby, native tools,',
  'or broad POSIX compatibility. Commands run in fresh sealed Workers; files',
  persistent
    ? 'persist in this named Pod, while cwd/environment/live jobs are process state.'
    : 'are ephemeral in this Pod: closing its tab deletes the workspace. cwd/environment/live jobs are process state.',
  '</pod>',
].join('\n');

/** @param {any} args @param {import('/shared/tool-types.js').ToolContext} ctx @returns {Promise<import('/shared/tool-types.js').ToolResult>} */
export const createPodSandbox = async (args, ctx) => {
  const sessionId = ctx.session?.sessionId;
  const authority = /** @type {any} */ (ctx).executionAuthority;
  if (!authority?.createPod) return { ok: false, error: 'pod_registry_unavailable' };
  const created = await authority.createPod(args);
  if (!created?.ok) return created;
  const { record, repository, isCurrent } = created;
  const summary = JSON.stringify({
    id: record.id, name: record.name, kind: 'pod', persistent: record.persistent,
    isCurrent, ...(repository ? { repository } : {}),
  }, null, 2);
  return {
    ok: true,
    content: `${summary}\n\n${oncePerSession(sessionId, 'pod-note') ? podNote(record.persistent) : (record.persistent ? '(Pod runtime note shown earlier this session: same rules apply.)' : '(Ephemeral Pod: closing its tab deletes this workspace.)')}`,
  };
};
