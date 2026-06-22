// @ts-check
// background/routes/sessions.js — agent send/stop, session read routes
// (list/get), the composer palette sources (commands/list, composer/files,
// composer/tabs), and the subagent/review spawn entry points.
//
// The mutating session routes — session/{setModel,switch,reset,archive} +
// permission/set — live in routes/session-mutations.js (they go through the
// session-state store). composer/tabs lives HERE and reads the LIVE denylist
// via denylistStore.patterns(). The routes here close over only stable
// collaborators. Bodies verbatim, deps injected, imports none.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeSessionRoutes = (deps) => {
  const {
    vault, auditLog, sessions, sessionCache, turnSlots, manifestLabel,
    buildToolContext, applyComposer, commandSources, prepareUserAttachments,
    runAgentTurn, runInit, handleSystemCommand, handleToolsCommand,
    postChatNote, spawnSubagent, requestReview, appClient,
    browser, originOfTabUrl, matchesDenylist, denylistStore,
    startGoalRun, haltGoalRun, ensureSession,
  } = deps;

  return {
    // --- agent ---
    'agent/stop': async () => {
      // Idempotent — silent if there's nothing in flight. Scoped to the
      // CURRENT chat: Stop must never reach across conversations and kill
      // a turn streaming elsewhere (turn slots are per-session).
      const sessionId = await sessionCache.sessionGet('currentSessionId');
      // Stop ends the whole goal run (not just the in-flight turn) so it can't
      // auto-continue after the abort.
      if (sessionId && haltGoalRun) haltGoalRun(/** @type {any} */ (sessionId));
      if (sessionId && turnSlots.stop(sessionId)) {
        auditLog.append({ type: 'session_ended', details: { reason: 'user_stop' } })
          .catch(() => {});
      }
      return { ok: true };
    },

    'agent/send': async ({ text, attachments, activeTabId = null, goal = false }) => {
      if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: 'empty-message' };
      }
      const trimmedGoal = text.trim();
      // Goal mode (the mode-row Goal toggle): run autonomous turns in THIS chat
      // until the agent calls complete_goal (or the cap / Stop). The goal is the
      // first, visible message; continuations are hidden synthetic turns, so the
      // work streams into the chat like a normal session. Ensure a session up
      // front (a fresh chat has none yet — same lazy-create the model turn does).
      if (goal === true) {
        if (!startGoalRun || !ensureSession) return { ok: false, error: 'goal-mode-unavailable' };
        try {
          const sessionId = await ensureSession();
          await startGoalRun({ sessionId, goal: trimmedGoal });
        } catch (e) {
          console.error('[sw] goal start threw', e);
          postChatNote(`Goal couldn't start: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
        }
        return { ok: true, handled: 'goal' };
      }
      // A normal (non-goal) user message while a goal run is live means the user
      // is steering / taking over — halt the run so it doesn't auto-continue on
      // top of the new message.
      if (haltGoalRun) {
        const curSid = await sessionCache.sessionGet('currentSessionId');
        if (curSid) haltGoalRun(/** @type {any} */ (curSid));
      }
      // /init is handled in the SW, not sent to the model (feature 01) —
      // check it BEFORE composer expansion so the slash command short-
      // circuits the turn entirely (it drafts AGENTS.md, no model call).
      const trimmed = text.trim();
      if (trimmed === '/init' || trimmed.startsWith('/init ')) {
        runInit().catch((/** @type {unknown} */ e) => {
          console.error('[sw] /init threw', e);
          postChatNote(`/init failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
        });
        return { ok: true, handled: 'init' };
      }
      // /system [text|clear] — set/show/clear this chat's custom system-
      // prompt augmentation. SW-handled like /init; never reaches the model
      // as user text (it CHANGES what the model is told instead).
      if (trimmed === '/system' || trimmed.startsWith('/system ')) {
        handleSystemCommand(trimmed.slice('/system'.length).trim()).catch((/** @type {unknown} */ e) => {
          console.error('[sw] /system threw', e);
          postChatNote(`/system failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
        });
        return { ok: true, handled: 'system' };
      }
      // /tools [preset|full|list] — set/show/clear this chat's tool
      // exposure manifest. SW-handled like /system; never reaches the model
      // (it CHANGES which tools the model is offered instead).
      if (trimmed === '/tools' || trimmed.startsWith('/tools ')) {
        handleToolsCommand(trimmed.slice('/tools'.length).trim()).catch((/** @type {unknown} */ e) => {
          console.error('[sw] /tools threw', e);
          postChatNote(`/tools failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
        });
        return { ok: true, handled: 'tools' };
      }
      // Composer expansion (feature 04): rewrite /commands and @-references
      // BEFORE the turn starts. @tab/@file pulls (possibly untrusted)
      // content; the resolvers wrap it (<untrusted_web_content>/<peerd_file>)
      // and apply the denylist origin gate. Build a tool context for them.
      let userText = trimmed;
      try {
        const ctx = await buildToolContext();
        const applied = await applyComposer({ text: userText, commandSources, ctx });
        userText = applied.text;
        // Audit any @-references the user inlined — provenance for the
        // lethal-trifecta surface. Failures are noted, not fatal.
        for (const r of applied.refs) {
          auditLog.append({
            type: 'composer_reference',
            details: { raw: r.raw, ok: r.ok, error: r.error ?? null },
          }).catch(() => {});
        }
        if (applied.command) {
          auditLog.append({
            type: 'composer_command',
            details: { command: applied.command, found: applied.commandFound },
          }).catch(() => {});
        }
      } catch (e) {
        console.error('[sw] applyComposer failed; sending raw text', e);
        userText = trimmed;
      }
      // File attachments — validate through the pure core, FAIL CLOSED:
      // an invalid batch rejects the whole send with the typed error's
      // message so the panel can put the draft back (a partial attach the
      // user didn't ask for would be a lie). text/* payloads are inlined
      // into userText here (the @file precedent); image/pdf base64 rides
      // to runUserTurn, which ships it this turn and persists stripped.
      let turnAttachments = null;
      if (Array.isArray(attachments) && attachments.length > 0) {
        try {
          const prepared = prepareUserAttachments({ text: userText, attachments });
          userText = prepared.text;
          turnAttachments = prepared.attachments;
        } catch (e) {
          return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
        }
      }
      // Fire and forget — the side panel doesn't await; it watches the
      // port for streaming events. Returning immediately keeps the
      // message-channel cycle short.
      runAgentTurn({ userText, attachments: turnAttachments, activeTabId }).catch((/** @type {unknown} */ e) =>
        console.error('[sw] runAgentTurn threw', e));
      return { ok: true };
    },

    // --- composer: palette data sources ---
    //
    // The command palette (sidepanel/components/command-palette.js) queries
    // these to populate its candidate lists. Read-only and cheap.

    // Commands available to `/` — from every wired source (local store +
    // any feature-07 skill source). Bodies omitted from the list payload;
    // the palette only needs name + description to render + filter.
    'commands/list': async () => {
      const all = await commandSources.list();
      return { ok: true, commands: all.map((/** @type {any} */ c) => ({ name: c.name, description: c.description ?? '' })) };
    },

    // Open tabs for the @tab picker — id, title, origin, active flag, plus
    // whether the origin is denylisted (so the palette can disable it: a
    // denylisted tab can never be inlined). Mirrors the resolver's gate.
    'composer/tabs': async () => {
      let tabs = [];
      try { tabs = await browser.tabs.query({}); } catch { tabs = []; }
      const list = tabs.map((/** @type {any} */ t) => {
        const url = t.url ?? '';
        const origin = originOfTabUrl(url);
        let blocked = false;
        try {
          const host = url ? new URL(url).hostname : '';
          blocked = !!host && matchesDenylist(host, denylistStore.patterns());
        } catch { blocked = false; }
        const unsupported = /^(chrome|about|devtools|chrome-extension|edge|moz-extension):/.test(url);
        return {
          id: t.id,
          title: (t.title ?? '').slice(0, 80),
          origin,
          active: !!t.active,
          blocked: blocked || unsupported,
        };
      });
      return { ok: true, tabs: list };
    },

    // Files for the @file picker — the current chat's App files. Returns []
    // when there's no current app rather than erroring; the palette just
    // shows "no files".
    'composer/files': async () => {
      if (vault.isLocked()) return { ok: true, files: [] };
      try {
        const sessionId = await sessionCache.sessionGet('currentSessionId');
        if (!appClient?.listFiles) return { ok: true, files: [] };
        const files = await appClient.listFiles({ sessionId });
        return { ok: true, files: (files ?? []).map((/** @type {any} */ f) => (typeof f === 'string' ? f : f.path)) };
      } catch {
        return { ok: true, files: [] };
      }
    },

    'session/list': async () => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      const all = await sessions.list();
      return {
        ok: true,
        // why: subagent sessions are inspectable through their parent's
        // transcript, not the chat list — filter them out of /chats so
        // decomposition work doesn't clutter the user's conversations.
        // See docs/SUBAGENTS.md.
        sessions: all.filter((/** @type {any} */ s) => (s.kind ?? 'chat') !== 'subagent').map((/** @type {any} */ s) => ({
          sessionId: s.sessionId,
          title: s.title ?? null,
          createdAt: s.createdAt,
          lastMessageAt: s.messages[s.messages.length - 1]?.when ?? s.createdAt,
          messageCount: s.messages.length,
          archived: s.archivedAt !== undefined,
          provider: s.provider,
          model: s.model,
          // Presence flag only — the row badge needs a boolean, not the
          // (possibly long) instruction text itself.
          hasCustomSystemPrompt: typeof s.customSystemPrompt === 'string'
            && s.customSystemPrompt.length > 0,
          // Short label ('research', 'custom (3 tools)') or null — the row
          // badge shows WHICH manifest, not the allow-list itself.
          toolManifestLabel: manifestLabel(s.toolManifest),
        })),
      };
    },

    // Fetch any single session by id — including subagents (which are
    // hidden from session/list). The side panel calls this lazily when the
    // user expands a spawn_subagent tool card to render the child's
    // transcript inline. See docs/SUBAGENTS.md + message-list.js.
    'session/get': async ({ sessionId }) => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, error: 'sessionId-required' };
      }
      const session = await sessions.get(sessionId);
      if (!session) return { ok: false, error: 'session-not-found' };
      return { ok: true, session };
    },

    // --- subagents ---
    //
    // The peerd.runtime.runAgent shim (an App/Notebook the agent built embedding its
    // own agent) posts here. Notebook tabs are extension-origin pages, so
    // runtime.onMessage reaches us directly — the caller is already
    // authenticated as our own extension. The parent is whichever chat
    // session is current; the subagent inherits its depth (+1), permission
    // mode, and provider key through the orchestrator. If an artifact makes
    // several calls, each creates its own child session and runs
    // independently. (The model's OWN parallel work goes through the
    // spawn_subagent tool, not this path.)
    'subagent/spawn': async ({ task, tools, maxSteps, maxDepth, allowRecursion }) => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      if (typeof task !== 'string' || !task.trim()) {
        return { ok: false, error: 'task-required' };
      }
      const parentSessionId = await sessionCache.sessionGet('currentSessionId');
      if (!parentSessionId) return { ok: false, error: 'no-active-session' };
      const parent = await sessions.get(parentSessionId);
      const out = await spawnSubagent({
        task,
        tools: Array.isArray(tools) ? tools : undefined,
        maxSteps: Number.isFinite(maxSteps) ? maxSteps : undefined,
        maxDepth: Number.isFinite(maxDepth) ? maxDepth : undefined,
        allowRecursion: allowRecursion === true,
        parentSessionId,
        parentDepth: parent?.depth ?? 0,
      });
      return { ok: true, result: out };
    },

    // Clean-context review (feature 08). The `/review` command surface +
    // Notebook peerd.review() shim post here. Spawns a READ-ONLY reviewer
    // over a diff and returns the structured summary. The parent is the
    // current chat session; the reviewer inherits its depth (+1) and trust
    // mode through the shared spawn orchestrator, but is narrowed to
    // read-only tools — it cannot edit, so the writer stays the single writer.
    'review/run': async ({ before, after, diff, since, focus }) => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      const parentSessionId = await sessionCache.sessionGet('currentSessionId');
      if (!parentSessionId) return { ok: false, error: 'no-active-session' };
      const parent = await sessions.get(parentSessionId);
      const out = await requestReview({
        parentSessionId,
        parentDepth: parent?.depth ?? 0,
        before, after, diff,
        since: typeof since === 'string' ? since : undefined,
        focus: typeof focus === 'string' ? focus : undefined,
      });
      return { ok: true, result: out };
    },
  };
};
