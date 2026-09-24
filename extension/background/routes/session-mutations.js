// @ts-check
import { bindCurrentChat } from '../../shared/current-session-binding.js';

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeSessionMutationRoutes = (deps) => {
  const {
    vault, auditLog, pushState, sessions, sessionCache, autoMemory,
    SessionNotFoundError,
    maybeAutoResumeAfterRecovery, haltGoalRun, turnSlots, actorMessaging, nukeSessionWorkspace,
    actorLifecycle, purgeLifecycleSession,
  } = deps;

  // why: permission/set is owned by kernel-session-authority, which revokes
  // both session stores before readiness or persistence can yield.
  return {
    'session/reset': async () => {
      // why read BEFORE delete: "new chat" is a switch-away from the
      // current session — one of auto-memory's two lifecycle seams.
      const previousId = await sessionCache.sessionGet('currentSessionId');
      // why: Stop live work before storage IO can delay or fail the reset.
      if (previousId && turnSlots?.stop?.(previousId)) {
        auditLog.append({ type: 'session_ended', sessionId: previousId, details: { reason: 'session_reset' } }).catch(() => {});
      }
      if (previousId && actorMessaging?.stopActorsFor) {
        for (const actorSessionId of actorMessaging.stopActorsFor(previousId)) {
          if (turnSlots.stop(actorSessionId)) {
            auditLog.append({ type: 'actor_stopped', sessionId: previousId, details: { actorSessionId, reason: 'session_reset_cascade' } }).catch(() => {});
          }
        }
      }
      if (previousId) {
        for (const childSessionId of actorLifecycle?.stopSubtree?.(previousId) ?? []) {
          auditLog.append({ type: 'actor_stopped', sessionId: previousId,
            details: { childSessionId, reason: 'session_reset_cascade' } }).catch(() => {});
        }
        await haltGoalRun?.(previousId);
      }
      await bindCurrentChat(sessionCache, null);
      // The caller may send the first message of the new chat immediately
      // after this route resolves. Finish projecting the empty chat first so
      // this reset snapshot cannot arrive after that turn's live events and
      // wipe the new transcript back to the welcome screen.
      await pushState();
      if (previousId) {
        autoMemory.maybeExtract(previousId, 'switch')
          .catch((/** @type {unknown} */ e) => console.warn('[sw] auto-memory extract failed', e));
      }
      return { ok: true };
    },

    'session/switch': async ({ sessionId } = {}) => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, error: 'sessionId-required' };
      }
      const session = await sessions.get(sessionId);
      if (!session) return { ok: false, error: 'session-not-found' };
      // DESIGN-17 / spawned sessions: only real CHATS are switchable. An actor/actor
      // is reached by message / through its parent, never made the active chat —
      // already hidden from session/list, this is the matching guard so a crafted
      // id can't park currentSessionId on a non-chat session.
      const switchKind = session.kind ?? 'chat';
      if (switchKind === 'actor' || switchKind === 'spawned') {
        return { ok: false, error: 'not-a-chat' };
      }
      const previousId = await sessionCache.sessionGet('currentSessionId');
      await bindCurrentChat(sessionCache, session);
      pushState();
      // #72: auto-resume — if THIS chat's last turn was reclaimed mid-flight
      // (SW eviction etc.), continue it now. Fire-and-forget; gated + deduped
      // inside the helper, so opening a normally-finished chat is a no-op.
      maybeAutoResumeAfterRecovery(sessionId);
      // Auto-memory lifecycle seam: switching AWAY from a session with
      // real substance. Fire-and-forget — the switch itself never waits
      // on (or fails with) the extraction.
      if (previousId && previousId !== sessionId) {
        autoMemory.maybeExtract(previousId, 'switch')
          .catch((/** @type {unknown} */ e) => console.warn('[sw] auto-memory extract failed', e));
      }
      return { ok: true };
    },

    'session/archive': async ({ sessionId }) => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      try {
        // why: Archive must stop live work before it changes durable state.
        if (turnSlots?.stop?.(sessionId)) {
          auditLog.append({ type: 'session_ended', sessionId, details: { reason: 'session_archive' } }).catch(() => {});
        }
        /** @type {string[]} */
        const actorSessionIds = [];
        if (actorMessaging?.stopActorsFor) {
          for (const actorSessionId of actorMessaging.stopActorsFor(sessionId)) {
            actorSessionIds.push(actorSessionId);
            if (turnSlots.stop(actorSessionId)) {
              auditLog.append({ type: 'actor_stopped', sessionId, details: { actorSessionId, reason: 'session_archive_cascade' } }).catch(() => {});
            }
          }
        }
        for (const childSessionId of actorLifecycle?.stopSubtree?.(sessionId) ?? []) {
          actorSessionIds.push(childSessionId);
          auditLog.append({ type: 'actor_stopped', sessionId,
            details: { childSessionId, reason: 'session_archive_cascade' } }).catch(() => {});
        }
        await haltGoalRun?.(sessionId);
        // why: Stop wins even when storage is unavailable, but a missing
        // record must never reach archive or its durable cleanup side effects.
        if (!await sessions.get(sessionId)) return { ok: false, error: 'session-not-found' };
        await sessions.archive(sessionId);
        // why: Keep uncertain effects for each stopped execution session.
        for (const lifecycleSessionId of new Set([sessionId, ...actorSessionIds])) {
          await purgeLifecycleSession?.(lifecycleSessionId);
        }
        // Clear the active cache when it points to the archived session.
        const currentId = await sessionCache.sessionGet('currentSessionId');
        if (currentId === sessionId) {
          await bindCurrentChat(sessionCache, null);
        }
        pushState();
        // Archive starts a best-effort memory extraction.
        autoMemory.maybeExtract(sessionId, 'archive')
          .catch((/** @type {unknown} */ e) => console.warn('[sw] auto-memory extract failed', e));
        // why: Archive is the terminal session event. Remove its script files.
        // Cleanup is best-effort and must not fail archive.
        Promise.resolve(nukeSessionWorkspace?.(sessionId)).catch(() => {});
        return { ok: true };
      } catch (e) {
        if (e instanceof SessionNotFoundError) return { ok: false, error: 'session-not-found' };
        throw e;
      }
    },

  };
};
