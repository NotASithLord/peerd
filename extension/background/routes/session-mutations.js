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
    purgeLifecycleSession,
  } = deps;

  return {
    'session/reset': async () => {
      // why read BEFORE delete: "new chat" is a switch-away from the
      // current session — one of auto-memory's two lifecycle seams.
      const previousId = await sessionCache.sessionGet('currentSessionId');
      // why: a "new chat" abandons the current one — end its goal run (if any)
      // so it doesn't keep driving the orphaned session in the background.
      // (A plain session/switch does NOT halt — that's the "keep running while
      // I'm in another chat" case.) Awaited: stop() durably forgets the run's
      // persisted record, so a "new chat" can't be undone by a resume() on the
      // next unlock even if the SW is torn down right after this handler (#60).
      if (previousId) await haltGoalRun?.(previousId);
      // A "new chat" abandons the current session, so its BACKGROUND WORK must
      // stop — not keep running invisibly. haltGoalRun (above) ends any goal
      // loop; this ends the live TURN and CASCADES to its in-flight ACTORS (each
      // runs on its OWN turn slot, so stopping the orchestrator alone leaves
      // delegated web/VM/App/Notebook work running to completion). why: without
      // it, New-chat mid-web-task — and the OM2W eval harness, which
      // session/resets between EVERY task — leaks a live web-actor loop; they
      // pile up until the SW saturates and every later turn stalls (the harness
      // "2 tasks then a wall of timeouts"). Mirrors agent/stop's cascade
      // (routes/sessions.js). Guarded so callers that don't wire the slots (unit
      // tests) are a no-op.
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
        await sessions.archive(sessionId);
        // Archiving wraps the chat up — end its goal run (if any) so it can't
        // keep running on a put-away session. Awaited: durably forget the run so
        // it can't resurrect on the next unlock (#60).
        await haltGoalRun?.(sessionId);
        // Archive is also Stop. End the root turn and every delegated actor
        // before cleaning up durable state so no hidden work can continue on
        // a put-away chat.
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
        // Settle lifecycle records before returning. For dispatched Class D/E
        // actions this preserves uncertainty and a verification notice instead
        // of falsely reporting cancellation.
        // Tool operations are keyed to the execution session, not only the
        // owning root chat. Settle every stopped actor too, before archive
        // returns, so a crash cannot strand its dispatched D/E action until a
        // later boot or hide its verification notice in an archived chat.
        for (const lifecycleSessionId of new Set([sessionId, ...actorSessionIds])) {
          await purgeLifecycleSession?.(lifecycleSessionId);
        }
        // If the archived session was the active one, drop the cache so
        // the next agent/send creates a fresh session.
        const currentId = await sessionCache.sessionGet('currentSessionId');
        if (currentId === sessionId) {
          await bindCurrentChat(sessionCache, null);
        }
        pushState();
        // Auto-memory lifecycle seam: archiving IS the session wrapping
        // up. Fire-and-forget so archive stays instant.
        autoMemory.maybeExtract(sessionId, 'archive')
          .catch((/** @type {unknown} */ e) => console.warn('[sw] auto-memory extract failed', e));
        // Tear down the session's durable script workspace
        // (['peerd-workspace', sid] in OPFS). why HERE: archive is the terminal
        // session-lifecycle event today — no session-delete route exists (the
        // sessions view's "×" archives) — so this is where "the session is torn
        // down" lives; if a true delete route ever lands, it must nuke too.
        // Fire-and-forget + guarded: workspace bytes are agent scratch,
        // best-effort cleanup must never fail the archive.
        Promise.resolve(nukeSessionWorkspace?.(sessionId)).catch(() => {});
        return { ok: true };
      } catch (e) {
        if (e instanceof SessionNotFoundError) return { ok: false, error: 'session-not-found' };
        throw e;
      }
    },

  };
};
