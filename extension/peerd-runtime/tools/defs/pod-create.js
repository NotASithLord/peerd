// @ts-check
// Pod arm of sandbox_create: fast shell/WASI environment over existing OPFS,
// Git, egress, and tab lifecycle primitives.

import { ENGINE_TAB_GROUP_TITLE } from '/shared/engine-tab-group.js';
import { normalizeGitRemote } from '/peerd-engine/repository/remote.js';
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
  const registry = /** @type {any} */ (ctx).podRegistry;
  const tracker = /** @type {any} */ (ctx).podTabTracker;
  const repositories = /** @type {any} */ (ctx).repositories;
  if (!registry || !tracker) return { ok: false, error: 'pod_registry_unavailable' };
  const sessionId = ctx.session?.sessionId;
  const name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 40) : undefined;
  const gitUrl = typeof args?.gitUrl === 'string' ? args.gitUrl.trim() : '';
  /** @type {ReturnType<typeof normalizeGitRemote>|null} */ let remote = null;
  if (gitUrl) {
    if (!repositories) return { ok: false, error: 'repository_unavailable' };
    try { remote = normalizeGitRemote(gitUrl); }
    catch (error) { return { ok: false, error: `git_clone_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
    const answer = await /** @type {any} */ (ctx).confirm?.({
      tool: 'sandbox_create', kind: 'git_clone', sideEffect: 'write', origins: [new URL(remote.url).origin],
      summary: `Clone ${remote.url} into a local Peerd Pod? Repository bytes stay in OPFS; a configured vault credential for this host may be used by the broker.`,
    });
    if (answer !== true && answer !== 'yes_once' && answer !== 'yes_session') return { ok: false, error: 'git_clone_declined' };
  }
  const record = await registry.create({
    name, ownerSessionId: sessionId ?? null, persistent: args?.persistent !== false,
  });
  let repository = null;
  try {
    if (remote) repository = await repositories.clone({ kind: 'pod', id: record.id }, {
      url: remote.url,
      ...(typeof args.gitRef === 'string' && args.gitRef.trim() ? { ref: args.gitRef.trim() } : {}),
      depth: Math.min(500, Math.max(1, Number(args.gitDepth) || 50)),
      signal: /** @type {any} */ (ctx).abortSignal,
    });
    try { await tracker.ensureTab(record.id, { active: false, groupTitle: ENGINE_TAB_GROUP_TITLE }); }
    catch (error) {
      // Background tabs may be throttled past the readiness deadline even though
      // the tab exists. Keep the live workspace; only roll back a real spawn failure.
      if (tracker.getTabId?.(record.id) == null) throw error;
    }
    if (sessionId) await registry.setDefaultForSession(sessionId, record.id);
  } catch (error) {
    await repositories?.destroy?.({ kind: 'pod', id: record.id }, { worktree: true }).catch(() => {});
    await registry.delete(record.id).catch(() => {});
    return { ok: false, error: `pod_create_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` };
  }
  const summary = JSON.stringify({
    id: record.id, name: record.name, kind: 'pod', persistent: record.persistent,
    isCurrent: !!sessionId, ...(repository ? { repository } : {}),
  }, null, 2);
  return {
    ok: true,
    content: `${summary}\n\n${oncePerSession(sessionId, 'pod-note') ? podNote(record.persistent) : (record.persistent ? '(Pod runtime note shown earlier this session: same rules apply.)' : '(Ephemeral Pod: closing its tab deletes this workspace.)')}`,
  };
};
