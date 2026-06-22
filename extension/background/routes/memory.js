// @ts-check
// background/routes/memory.js — memory (V1.5) + auto-memory suggestion routes.
//
// The reversibility surface (CLAUDE.md): the user can see, export, and delete
// every memory doc, and approve/dismiss the wrap-up extraction's suggestions.
// onboarding/complete stays inline in the SW — it reassigns defaultProfile.
// Bodies verbatim, deps injected, imports none.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeMemoryRoutes = (deps) => {
  const {
    vault, auditLog, pushState, memory, memorySuggestions,
    runInit, postChatNote, USER_DOC_SCOPE, appendNoteToUserDoc,
    profileState, seedUserDocBody,
  } = deps;

  return {
    // --- memory (V1.5) ---
    // Reversibility surface (CLAUDE.md): the user can see, export, and
    // delete every memory doc. /init is also reachable as a direct route
    // (e.g. a Settings button) in addition to the slash command.
    'memory/export': async () => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      return { ok: true, payload: await memory.exportAll() };
    },
    'memory/deleteAll': async () => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      return { ok: true, ...(await memory.deleteAll()) };
    },
    'memory/init': async () => {
      runInit().catch((/** @type {unknown} */ e) => {
        console.error('[sw] memory/init threw', e);
        postChatNote(`/init failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
      });
      return { ok: true };
    },
    // The user editing their OWN memory in the Context tab. origin:'user'
    // commits directly — the confirmation gate (lethal-trifecta defense) is
    // for AGENT-origin writes, not the human curating their workspace notes.
    'memory/write': async ({ scope, body }) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (!scope || typeof scope.kind !== 'string') return { ok: false, error: 'bad-scope' };
      const res = await memory.writeWithConfirm({ scope, body: String(body ?? ''), origin: 'user' });
      return res.ok ? { ok: true, op: res.op, id: res.id } : { ok: false, error: res.reason ?? 'write-failed' };
    },
    'memory/delete': async ({ scope }) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (!scope || typeof scope.kind !== 'string') return { ok: false, error: 'bad-scope' };
      const res = await memory.deleteScope({ scope, origin: 'user' });
      return res.ok ? { ok: true, op: res.op, id: res.id } : { ok: false, error: res.reason ?? 'delete-failed' };
    },

    // --- auto-memory suggestions (Context → Memory) ---
    //
    // Pending notes proposed by the wrap-up extraction. NOTHING here is
    // auto-written: approve appends the note to the user doc — the click
    // IS the consent, the same origin:'user' contract the Context-tab
    // editor follows — and dismiss just drops the suggestion.
    'memory/suggestions': async () => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      return { ok: true, suggestions: await memorySuggestions.listPending() };
    },
    'memory/suggestions/approve': async ({ id }) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof id !== 'string' || !id) return { ok: false, error: 'id-required' };
      const sug = await memorySuggestions.get(id);
      if (!sug) return { ok: false, error: 'not-found' };
      const prior = await memory.readScope(USER_DOC_SCOPE);
      const body = appendNoteToUserDoc(prior?.body ?? '', sug.text);
      const res = await memory.writeWithConfirm({ scope: USER_DOC_SCOPE, body, origin: 'user' });
      if (!res.ok) return { ok: false, error: res.reason ?? 'write-failed' };
      // Resolve only AFTER the write landed — a failed write keeps the
      // suggestion pending instead of silently losing it.
      await memorySuggestions.resolve(id);
      auditLog.append({
        type: 'memory_suggestion_approved',
        sessionId: sug.sessionId ?? undefined,
        details: { id },
      }).catch(() => {});
      return { ok: true };
    },
    'memory/suggestions/dismiss': async ({ id }) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof id !== 'string' || !id) return { ok: false, error: 'id-required' };
      const res = await memorySuggestions.resolve(id);
      if (!res.ok) return { ok: false, error: res.error ?? 'not-found' };
      auditLog.append({
        type: 'memory_suggestion_dismissed',
        sessionId: res.suggestion?.sessionId ?? undefined,
        details: { id },
      }).catch(() => {});
      return { ok: true };
    },

    // --- onboarding (first-run "Hello, I'm peerd") ---
    //
    // One shot: names the AI peer on the default profile (normalized in the
    // store) and latches onboardingComplete so the flow never re-fires. When the
    // user filled any basic-facts fields, the user doc (memory scope 'user') is
    // seeded — origin:'user' commits without a confirm prompt because onboarding
    // IS the explicit user act; later AGENT expansion of the same doc still
    // rides the confirm gate. Skip arrives as facts:null → seedUserDocBody
    // returns '' → no memory write at all.
    'onboarding/complete': async ({ peerName, facts }) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      const profile = await profileState.completeOnboarding({ peerName });
      const prior = await memory.readScope(USER_DOC_SCOPE);
      const body = seedUserDocBody(facts ?? {}, prior?.body ?? '');
      if (body) {
        await memory.writeWithConfirm({ scope: USER_DOC_SCOPE, body, origin: 'user' });
      }
      // why push: the side panel's route gate reads profile.onboardingComplete
      // off state — without a push the welcome screen would linger until the
      // next unrelated state change.
      pushState();
      return { ok: true, profile };
    },
  };
};
