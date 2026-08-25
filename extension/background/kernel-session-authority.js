// @ts-check

import {
  KERNEL_SUPPORT_EFFECTS_BY_ROUTE,
  canonicalKernelSessionId,
  canonicalKernelSessionModel,
  kernelPermissionPatch,
} from '../shared/kernel-support-protocol.js';

/** @param {unknown} left @param {unknown} right @returns {boolean} */
const sameValue = (left, right) => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = /** @type {Record<string,unknown>} */ (left);
  const rightRecord = /** @type {Record<string,unknown>} */ (right);
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => Object.hasOwn(rightRecord, key)
      && sameValue(leftRecord[key], rightRecord[key]));
};
const candidateManifest = (/** @type {unknown} */ value) => {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { allow: [] };
  const raw = /** @type {Record<string,any>} */ (value);
  const preset = typeof raw.preset === 'string' && raw.preset.trim()
    ? raw.preset.trim().slice(0, 128) : undefined;
  const allow = Array.isArray(raw.allow) ? raw.allow
    .filter((name) => typeof name === 'string' && name.length > 0)
    .slice(0, 512).map((name) => name.slice(0, 128)) : undefined;
  return preset === undefined && allow === undefined ? { allow: [] } : {
    ...(preset === undefined ? {} : { preset }),
    ...(allow === undefined ? {} : { allow }),
  };
};
const sessionCandidate = (/** @type {any} */ session) => ({
  kind: session.kind === 'actor' || session.kind === 'spawned' ? session.kind : 'chat',
  sessionId: typeof session.sessionId === 'string' ? session.sessionId : '',
  title: typeof session.title === 'string' ? session.title.slice(0, 64 * 1024) : null,
  createdAt: Number.isFinite(session.createdAt) ? session.createdAt : 0,
  lastMessageAt: Number.isFinite(session.lastMessageAt)
    ? session.lastMessageAt : Number.isFinite(session.createdAt) ? session.createdAt : 0,
  messageCount: Number.isSafeInteger(session.messageCount) && session.messageCount >= 0
    ? session.messageCount : 0,
  archivedAt: Number.isFinite(session.archivedAt) ? session.archivedAt : undefined,
  provider: typeof session.provider === 'string' ? session.provider.slice(0, 128) : '',
  model: typeof session.model === 'string' ? session.model.slice(0, 512) : '',
  hasCustomSystemPrompt: session.hasCustomSystemPrompt === true,
  toolManifest: candidateManifest(session.toolManifest),
});
/** @param {Record<string,any>} deps */
export const createKernelSessionAuthority = (deps) => {
  if (typeof deps.admitRoute !== 'function' || typeof deps.sessions?.listSummaries !== 'function') {
    throw new TypeError('kernel-session-authority-config-invalid');
  }
  const effects = Object.freeze({
    'support.sessions.list': async () => {
      if (deps.vault.isLocked()) return { status: 'locked', candidates: [] };
      const summaries = await deps.sessions.listSummaries();
      return { status: 'ok', candidates: summaries
        .filter((/** @type {any} */ session) => (session?.kind ?? 'chat') === 'chat')
        .map(sessionCandidate)
        .filter((/** @type {{sessionId:string}} */ candidate) => candidate.sessionId.length > 0) };
    },
    'support.session.read': async (/** @type {{sessionId:string|null}} */ { sessionId }) => {
      if (deps.vault.isLocked()) return { status: 'locked' };
      if (!sessionId) return { status: 'invalid' };
      const session = await deps.sessions.get(sessionId);
      return session ? { status: 'ok', session } : { status: 'not-found' };
    },
    'support.session.context-snapshots': async (
      /** @type {{sessionId:string|null}} */ { sessionId },
    ) => {
      if (deps.vault.isLocked()) return { status: 'locked' };
      if (!sessionId) return { status: 'invalid' };
      return { status: 'ok', snapshots: deps.contextSnapshots?.snapshotsFor(sessionId) ?? [] };
    },
    'support.session.model.commit': async (
      /** @type {{sessionId:string|null,model:string|null}} */ { sessionId, model },
    ) => {
      await deps.ready;
      if (deps.vault.isLocked()) return { status: 'locked' };
      const current = sessionId ?? await deps.sessionCache.sessionGet('currentSessionId');
      if (typeof current !== 'string' || !current) return { status: 'no-session' };
      if (!model) return { status: 'invalid-model' };
      if (typeof deps.sessions.updateMetadata !== 'function') {
        throw new Error('session-atomic-update-unavailable');
      }
      const updated = await deps.sessions.updateMetadata(current, { model });
      if (updated) {
        void deps.auditLog?.append({
          type: 'session_model_changed', sessionId: current, details: { model },
        }).catch(() => {});
        void Promise.resolve(deps.pushState?.()).catch(() => {});
      }
      return { status: updated ? 'updated' : 'not-found' };
    },
    'support.permission.commit': async (
      /** @type {{patch:Record<string,'plan'|'act'|boolean>}} */ { patch },
    ) => {
      await deps.ready;
      if (typeof deps.sessionCache?.sessionSet !== 'function') {
        throw new Error('session-cache-write-unavailable');
      }
      try {
        for (const [key, value] of /** @type {const} */ ([
          ['currentPermissionMode', patch.permissionMode],
          ['currentConfirmActions', patch.confirmActions],
        ])) {
          if (value !== undefined) await deps.sessionCache.sessionSet(key, value);
        }
        const [sessionId, mode, confirmActions] = await Promise.all([
          deps.sessionCache.sessionGet('currentSessionId'),
          deps.sessionCache.sessionGet('currentPermissionMode'),
          deps.sessionCache.sessionGet('currentConfirmActions'),
        ]);
        let session;
        if (typeof sessionId === 'string' && sessionId && !deps.vault.isLocked()) {
          if (typeof deps.sessions.updateMetadata !== 'function') {
            throw new Error('session-atomic-update-unavailable');
          }
          session = await deps.sessions.updateMetadata(sessionId, patch);
        }
        const permission = deps.resolvePermission(session, mode, confirmActions);
        void deps.auditLog?.append({
          type: 'mode_changed',
          sessionId: typeof sessionId === 'string' ? sessionId : null,
          details: permission,
        }).catch(() => {});
        void Promise.resolve(deps.pushState?.()).catch(() => {});
        return permission;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        Object.assign(error, { outcomeKnown: false, retryable: false });
        throw error;
      }
    },
  });
  const effectAllowed = (/** @type {string} */ operation, /** @type {any} */ payload,
    /** @type {{message?:Record<string,any>,request?:{route?:string}}} */ context) => {
    const route = context.request?.route;
    if (typeof route !== 'string'
        || !/** @type {Record<string,readonly string[]>} */ (
          KERNEL_SUPPORT_EFFECTS_BY_ROUTE
        )[route]?.includes(operation)) return false;
    const message = context.message ?? {};
    switch (operation) {
      case 'support.sessions.list':
        return Object.keys(payload).length === 0;
      case 'support.session.read':
      case 'support.session.context-snapshots':
        return payload.sessionId === canonicalKernelSessionId(message.sessionId);
      case 'support.session.model.commit':
        return payload.model === (typeof message.model === 'string'
          ? canonicalKernelSessionModel(message.model) : null)
          && payload.sessionId === canonicalKernelSessionId(message.sessionId);
      case 'support.permission.commit':
        return sameValue(payload.patch, kernelPermissionPatch(message));
      default: return false;
    }
  };
  return Object.freeze({
    effects,
    effectAllowed,
    admit: (/** @type {string} */ route, /** @type {Record<string,any>} */ message,
      /** @type {unknown} */ sender) => deps.admitRoute(route, message, sender) === true,
  });
};
