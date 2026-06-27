// @ts-check
// background/routes/session-mutations.js — session lifecycle + permission
// mutations: session/{setModel,switch,reset,archive} + permission/set.
//
// Unblocked by background/session-state.js: these kept the activeSession cache
// coherent by reassigning it, so they had to stay inline. Now they call
// sessionState.set()/.clear() through deps. Bodies verbatim, imports none. (The
// read-only session routes — session/list,get + agent/composer — live in
// routes/sessions.js.)

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeSessionMutationRoutes = (deps) => {
  const {
    vault, auditLog, pushState, sessions, sessionCache, sessionState, autoMemory,
    resolvePermission, normalizeMode, normalizeConfirmActions, SessionNotFoundError,
    maybeAutoResume, haltGoalRun,
  } = deps;

  return {
    // Switch the model on an EXISTING session (mid-session, model-only — the
    // provider is fixed at create). The next turn reads provider/model straight
    // off the session record (agent-loop), so a persist is all it takes.
    'session/setModel': async ({ sessionId = null, model } = {}) => {
      const sid = sessionId ?? await sessionCache.sessionGet('currentSessionId');
      if (!sid) return { ok: false, error: 'no-session' };
      if (typeof model !== 'string' || !model.trim()) return { ok: false, error: 'invalid-model' };
      const sess = await sessions.get(sid);
      if (!sess) return { ok: false, error: 'session-not-found' };
      const next = model.trim().slice(0, 200);
      await sessions.update(sid, { model: next });
      // Keep the in-memory active-session mirror coherent so a same-turn read
      // (e.g. tool-context build) sees the new model.
      if (sessionState.current()?.sessionId === sid) sessionState.set({ ...sessionState.current(), model: next });
      auditLog.append({ type: 'session_model_changed', sessionId: sid, details: { model: next } }).catch(() => {});
      pushState();
      return { ok: true, model: next };
    },

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
      await sessionCache.sessionDelete('currentSessionId');
      sessionState.clear();
      pushState();
      if (previousId) {
        autoMemory.maybeExtract(previousId, 'switch')
          .catch((/** @type {unknown} */ e) => console.warn('[sw] auto-memory extract failed', e));
      }
      return { ok: true };
    },

    'session/switch': async ({ sessionId }) => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      const session = await sessions.get(sessionId);
      if (!session) return { ok: false, error: 'session-not-found' };
      // DESIGN-17 / subagents: only real CHATS are switchable. An actor/subagent
      // is reached by message / through its parent, never made the active chat —
      // already hidden from session/list, this is the matching guard so a crafted
      // id can't park currentSessionId on a non-chat session.
      const switchKind = session.kind ?? 'chat';
      if (switchKind === 'actor' || switchKind === 'subagent') {
        return { ok: false, error: 'not-a-chat' };
      }
      const previousId = await sessionCache.sessionGet('currentSessionId');
      await sessionCache.sessionSet('currentSessionId', sessionId);
      sessionState.set(session);
      pushState();
      // #72: auto-resume — if THIS chat's last turn was reclaimed mid-flight
      // (SW eviction etc.), continue it now. Fire-and-forget; gated + deduped
      // inside the helper, so opening a normally-finished chat is a no-op.
      maybeAutoResume(sessionId);
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
        // If the archived session was the active one, drop the cache so
        // the next agent/send creates a fresh session.
        const currentId = await sessionCache.sessionGet('currentSessionId');
        if (currentId === sessionId) {
          await sessionCache.sessionDelete('currentSessionId');
          sessionState.clear();
        }
        pushState();
        // Auto-memory lifecycle seam: archiving IS the session wrapping
        // up. Fire-and-forget so archive stays instant.
        autoMemory.maybeExtract(sessionId, 'archive')
          .catch((/** @type {unknown} */ e) => console.warn('[sw] auto-memory extract failed', e));
        return { ok: true };
      } catch (e) {
        if (e instanceof SessionNotFoundError) return { ok: false, error: 'session-not-found' };
        throw e;
      }
    },

    // --- Plan/Act permission (Feature 03) ---
    // Mid-session switching from the ModeSelector / Settings. Persist BOTH on
    // the session record (durable) AND in chrome.storage.session (so a change
    // made before the first turn still applies, and survives an SW respawn). The
    // next buildToolContext reads them via resolvePermission.
    'permission/set': async ({ mode, confirmActions }) => {
      const patch = {};
      if (mode !== undefined) patch.permissionMode = normalizeMode(mode);
      if (confirmActions !== undefined) patch.confirmActions = normalizeConfirmActions(confirmActions);
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: 'no-mode-or-confirm' };
      }
      // Cache first — covers the pre-session-create window + SW survival.
      if (patch.permissionMode !== undefined) {
        await sessionCache.sessionSet('currentPermissionMode', patch.permissionMode);
      }
      if (patch.confirmActions !== undefined) {
        await sessionCache.sessionSet('currentConfirmActions', patch.confirmActions);
      }
      // Persist on the session record too, when one exists.
      const sessionId = await sessionCache.sessionGet('currentSessionId');
      if (sessionId && !vault.isLocked()) {
        try {
          await sessions.update(sessionId, patch);
          if (sessionState.current()?.sessionId === sessionId) {
            sessionState.set({ ...sessionState.current(), ...patch });
          }
        } catch (e) {
          if (!(e instanceof SessionNotFoundError)) throw e;
        }
      }
      const resolved = await resolvePermission(sessionId && !vault.isLocked() ? await sessions.get(sessionId) : null);
      // why: permission changes are security-relevant state transitions —
      // audit them like every other one. The Logs view already has a
      // mode_changed label waiting (audit/types.js declares the type).
      auditLog.append({
        type: 'mode_changed',
        sessionId: sessionId ?? null,
        details: { mode: resolved.mode, confirmActions: resolved.confirmActions },
      }).catch(() => {});
      pushState();
      return { ok: true, permission: resolved };
    },
  };
};
