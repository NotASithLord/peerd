// @ts-check

import {
  canonicalKernelSessionId,
  canonicalKernelSessionModel,
  kernelPermissionPatch,
} from '../shared/kernel-support-protocol.js';

class SupportEffectError extends Error {
  /** @param {string} operation @param {any} result */
  constructor(operation, result) {
    super(result?.error ?? result?.code ?? operation);
    this.name = 'SupportEffectError';
    this.code = result?.code ?? 'support-effect-failed';
    this.outcomeKnown = result?.outcomeKnown === true;
  }
}

const effect = async (/** @type {any} */ context, /** @type {string} */ operation,
  /** @type {Record<string,unknown>} */ payload) => {
  const result = await context.effects.call(operation, payload);
  if (result?.ok !== true || result.outcomeKnown !== true) {
    throw new SupportEffectError(operation, result);
  }
  return result.value;
};
const toolManifestLabel = (/** @type {unknown} */ value) => {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'custom (0 tools)';
  const raw = /** @type {{preset?:unknown,allow?:unknown}} */ (value);
  const preset = typeof raw.preset === 'string' && raw.preset.trim()
    ? raw.preset.trim() : null;
  const allow = Array.isArray(raw.allow)
    ? raw.allow.filter((name) => typeof name === 'string' && name.length > 0) : null;
  if (preset) return `${preset}${allow?.length ? ` +${allow.length}` : ''}`;
  const count = allow?.length ?? 0;
  return `custom (${count} tool${count === 1 ? '' : 's'})`;
};
const sessionRow = (/** @type {any} */ session) => ({
  sessionId: session.sessionId,
  title: session.title ?? null,
  createdAt: session.createdAt,
  lastMessageAt: session.lastMessageAt ?? session.createdAt,
  messageCount: Number.isSafeInteger(session.messageCount) ? session.messageCount : 0,
  archived: session.archivedAt !== undefined,
  provider: session.provider,
  model: session.model,
  hasCustomSystemPrompt: session.hasCustomSystemPrompt === true,
  toolManifestLabel: toolManifestLabel(session.toolManifest),
});
export const routes = Object.freeze({
  'session/list': async (/** @type {any} */ _message, /** @type {any} */ context) => {
    const snapshot = await effect(context, 'support.sessions.list', {});
    if (snapshot.status === 'locked') return { ok: false, error: 'locked' };
    const sessions = snapshot.candidates;
    return { ok: true, sessions: sessions.filter((/** @type {any} */ session) => {
      const kind = session?.kind ?? 'chat';
      return kind !== 'spawned' && kind !== 'actor';
    }).map(sessionRow) };
  },
  'session/get': async (/** @type {any} */ message = {}, /** @type {any} */ context) => {
    const snapshot = await effect(context, 'support.session.read', {
      sessionId: canonicalKernelSessionId(message.sessionId),
    });
    if (snapshot.status === 'locked') return { ok: false, error: 'locked' };
    if (snapshot.status === 'invalid') return { ok: false, error: 'sessionId-required' };
    return snapshot.status === 'ok'
      ? { ok: true, session: snapshot.session } : { ok: false, error: 'session-not-found' };
  },
  'session/contextSnapshots': async (
    /** @type {any} */ message = {}, /** @type {any} */ context,
  ) => {
    const snapshot = await effect(context, 'support.session.context-snapshots', {
      sessionId: canonicalKernelSessionId(message.sessionId),
    });
    if (snapshot.status === 'locked') return { ok: false, error: 'locked' };
    if (snapshot.status === 'invalid') return { ok: false, error: 'sessionId-required' };
    return snapshot.status === 'ok'
      ? { ok: true, snapshots: snapshot.snapshots }
      : { ok: false, error: 'session-not-found' };
  },
  'session/setModel': async (/** @type {any} */ message = {}, /** @type {any} */ context) => {
    const model = canonicalKernelSessionModel(message.model);
    const committed = await effect(context, 'support.session.model.commit', {
      sessionId: canonicalKernelSessionId(message.sessionId), model,
    });
    if (committed?.status === 'locked') return { ok: false, error: 'locked' };
    if (committed?.status === 'no-session') return { ok: false, error: 'no-session' };
    if (committed?.status === 'invalid-model') return { ok: false, error: 'invalid-model' };
    if (committed?.status === 'not-found') return { ok: false, error: 'session-not-found' };
    return committed?.status === 'updated'
      ? { ok: true, model } : { ok: false, error: 'session-update-failed' };
  },
  'permission/set': async (/** @type {any} */ message = {}, /** @type {any} */ context) => {
    if (message.mode === undefined && message.confirmActions === undefined) {
      return { ok: false, error: 'no-mode-or-confirm' };
    }
    const patch = kernelPermissionPatch(message);
    const permission = await effect(context, 'support.permission.commit', { patch });
    return { ok: true, permission };
  },
});
