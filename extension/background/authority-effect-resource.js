// @ts-check

import { controllerDomainOperationPolicy } from '/shared/controller-kernel-quota.js';

const text = (/** @type {unknown} */ value) => typeof value === 'string' && value
  ? value.slice(0, 512) : '';

const liveInstance = (/** @type {any} */ ctx) => text(ctx?.actorInstanceId);
const session = (/** @type {any} */ ctx) => text(ctx?.session?.sessionId) || 'no-session';
const pageResource = (/** @type {any} */ ctx) => {
  const pinned = text(ctx?.authorityPageResourceKey);
  if (pinned) return pinned;
  if (Number.isInteger(ctx?.activeTab?.id)) return `page:tab:${ctx.activeTab.id}`;
  return ctx?.actorType === 'web'
    ? `page:actor:${session(ctx)}` : `page:${session(ctx)}`;
};

// why: lifecycle targets identify a retryable intent, while scheduler keys
// identify the mutable host resource shared by different intents. This key is
// derived only inside the SW from the exact authority class plus host-bound
// identity; the semantic realm can never nominate a lock lane.
export const authorityEffectResourceKey = (
  /** @type {string} */ operation,
  /** @type {any} */ args,
  /** @type {any} */ ctx,
) => {
  const authorityClass = controllerDomainOperationPolicy(operation)?.authorityClass;
  const actorInstance = liveInstance(ctx);
  switch (authorityClass) {
    case 'page':
      // The actor host pins this value at turn admission. An established actor
      // uses its host-owned tab lane, while a zero-tab actor keeps its session
      // lane through first-tab adoption so the lock cannot change mid-effect.
      return pageResource(ctx);
    case 'siteclient': {
      if (operation === 'turn.site-client.capture-start'
          || operation === 'turn.site-client.capture-stop') return pageResource(ctx);
      // A stored client run in a tab-backed Web actor can mutate the same site
      // as page click/fill/program operations. Keep both on the host-pinned
      // page lane; API actors have no page and remain origin-serialized.
      if (operation === 'turn.site-client.run' && ctx?.actorType === 'web'
          && ctx?.actorBacking !== 'api') return pageResource(ctx);
      let origin = '';
      try { origin = new URL(text(args?.origin)).origin; } catch { /* exact binder refuses it */ }
      return `siteclient:${origin || actorInstance || session(ctx)}`;
    }
    case 'vm':
      return `vm:${actorInstance || text(args?.vmId) || session(ctx)}`;
    case 'notebook':
      return `instance:notebook:${actorInstance || text(args?.notebookId) || session(ctx)}`;
    case 'app':
      return `instance:app:${actorInstance || text(args?.appId) || session(ctx)}`;
    case 'pod':
      return `pod:${actorInstance || text(args?.podId) || session(ctx)}`;
    case 'repository':
    case 'editing': {
      const kind = ctx?.actorType === 'app' || ctx?.actorType === 'notebook'
        || ctx?.actorType === 'pod' ? ctx.actorType
        : args?.kind === 'notebook' ? 'notebook'
          : args?.kind === 'app' ? 'app' : 'repository';
      const instanceId = actorInstance || text(args?.targetId) || text(args?.podId)
        || text(args?.appId) || session(ctx);
      return `instance:${kind}:${instanceId}`;
    }
    case 'persistence':
      return operation.startsWith('turn.memory.') ? 'memory:profile' : `session:${session(ctx)}`;
    case 'schedule':
      return 'schedule:store';
    case 'actor':
      return `actor:${text(args?.to) || text(args?.taskId) || session(ctx)}`;
    case 'execution':
      return `execution:${actorInstance || text(args?.plan?.kind) || session(ctx)}`;
    case 'resource':
      return `resource:${actorInstance || session(ctx)}`;
    case 'dweb':
      return 'dweb:state';
    case 'introspection':
      return `introspection:${session(ctx)}`;
    default:
      return `authority:${session(ctx)}`;
  }
};
