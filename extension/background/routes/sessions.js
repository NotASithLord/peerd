// @ts-check
/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, context?: any) => Promise<any>>}
 */
export const makeSessionRoutes = (deps) => {
  const {
    vault, auditLog, sessions, sessionCache, turnSlots, makeAgentSendCustody, pushState,
    buildToolContext, applyComposer, commandSources, prepareUserAttachmentsWithDocs,
    convertDocAttachment,
    runAgentTurn, runInit, handleSystemCommand, handleToolsCommand,
    postChatNote, spawnActor, browser,
    startGoalRun, haltGoalRun, ensureSession, actorRecoveryReady, actorMessaging,
    actorLifecycle, admitSend,
    // The debug surface: the pure assembler + tree walk from
    // peerd-runtime/observability, the SW's live snapshot ring, and the
    // settings/channel/version identity the bundle stamps.
    settingsStore, contextSnapshots, assembleDebugBundle, childSessionIdsOf, CHANNEL,
  } = deps;

  const recoveryReadyForUserTurn = async () => {
    if (await actorRecoveryReady()) return true;
    postChatNote('Actor recovery is still being recorded. Wait a moment, then send again.');
    return false;
  };
  const awaitWithSignal = (/** @type {Promise<any>} */ operation,
    /** @type {AbortSignal|undefined} */ signal) => {
    if (!signal) return operation;
    if (signal.aborted) return Promise.reject(new DOMException('stopped', 'AbortError'));
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new DOMException('stopped', 'AbortError'));
      signal.addEventListener('abort', aborted, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  };

  const {
    validOperationId, operationWindowValid, sendFingerprint, unknownSend,
    sendReceiptStatus, withSendReceipt,
  } = makeAgentSendCustody(sessionCache);

  return {
    // --- agent ---
    'agent/stop': async () => {
      // Idempotent — silent if there's nothing in flight. Scoped to the
      // CURRENT chat: Stop must never reach across conversations and kill
      // a turn streaming elsewhere (turn slots are per-session).
      const sessionId = await sessionCache.sessionGet('currentSessionId');
      // Stop ends the whole goal run (not just the in-flight turn) so it can't
      // auto-continue after the abort. Awaited: haltGoalRun durably removes the
      // run's persisted record, so a Stop can't be undone by a resume() on the
      // next unlock even if the SW is torn down right after this handler returns.
      if (sessionId && haltGoalRun) await haltGoalRun(/** @type {any} */ (sessionId));
      if (sessionId && turnSlots.stop(sessionId)) {
        auditLog.append({ type: 'session_ended', details: { reason: 'user_stop' } })
          .catch(() => {});
      }
      // DESIGN-17 P1 — CASCADE the stop to this chat's in-flight ACTORS. They
      // run on their OWN turn slots (an actor is a separate session), so the line
      // above only aborted the orchestrator; without this, delegated VM/App/Notebook
      // work keeps mutating to completion after the user hit Stop — sharper now that
      // goal mode can autonomously drive actors. stopActorsFor bumps a per-
      // sender Stop generation (so an actor turn still QUEUED behind another on the
      // same slot skips when drained) AND returns the RUNNING actor sessions to
      // abort. Aborting a slot lands at its loop's next checkpoint (interruptible per
      // the spec); the aborted turn settles through the normal path, delivering a
      // "stopped before a reply" note and clearing its durable mailbox entry — so a
      // redrain can't resurrect it.
      if (sessionId && actorMessaging?.stopActorsFor) {
        for (const actorSessionId of actorMessaging.stopActorsFor(/** @type {any} */ (sessionId))) {
          if (turnSlots.stop(actorSessionId)) {
            auditLog.append({ type: 'actor_stopped', details: { actorSessionId, reason: 'user_stop_cascade' } }).catch(() => {});
          }
        }
      }
      // PR #134 phase 5 — cascade the Stop through the ACTOR subtree too.
      // Children run under their own turn slots now (spawn.js claims one per
      // child), so the line above never reached them; without this, spawned
      // work — including grandchildren, since one Stop must end the whole
      // delegation graph — kept running after the user hit Stop. stopSubtree
      // walks the live-children registry transitively and aborts each slot.
      // (Actor turns those children had in flight are already covered: the
      // actor bookkeeping is keyed by the lineage ROOT, i.e. this chat.)
      if (sessionId && actorLifecycle?.stopSubtree) {
        for (const childSessionId of actorLifecycle.stopSubtree(/** @type {any} */ (sessionId))) {
          auditLog.append({ type: 'actor_stopped', details: { childSessionId, reason: 'user_stop_cascade' } }).catch(() => {});
        }
      }
      return { ok: true };
    },

    'agent/send': async (
      /** @type {any} */ message = {}, /** @type {any} */ admission = undefined,
    ) => {
      const {
        text, attachments, goal = false, operationId = null, checkOnly = false,
      } = message;
      const activeTabSpecified = Object.hasOwn(message, 'activeTabId');
      const requestedActiveTabId = activeTabSpecified ? message.activeTabId : undefined;
      if (activeTabSpecified && !(requestedActiveTabId === null
          || Number.isSafeInteger(requestedActiveTabId) && requestedActiveTabId > 0)) {
        return { ok: false, error: 'agent-send-active-tab-invalid', outcomeKnown: true };
      }
      const sessionSpecified = Object.hasOwn(message, 'sessionId');
      const requestedSessionId = sessionSpecified ? message.sessionId : null;
      if (sessionSpecified && !(requestedSessionId === null
          || (typeof requestedSessionId === 'string' && requestedSessionId.length > 0))) {
        return { ok: false, error: 'agent-send-session-invalid', outcomeKnown: true };
      }
      if (checkOnly === true) {
        if (!validOperationId(operationId)) {
          return { ok: false, error: 'agent-send-operation-id-invalid', outcomeKnown: true };
        }
        return sendReceiptStatus(operationId, requestedSessionId);
      }
      const admitted = () => !admitSend || admitSend(admission);
      const stopped = () => ({
        ok: false,
        error: 'agent-send-stopped-before-dispatch',
        code: 'agent-send-stopped-before-dispatch',
        outcomeKnown: true,
        phase: 'pre-dispatch',
        retryable: false,
      });
      if (!admitted()) return stopped();
      if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: 'empty-message' };
      }
      if (operationId !== null && !validOperationId(operationId)) {
        return { ok: false, error: 'agent-send-operation-id-invalid' };
      }
      if (operationId && !operationWindowValid(operationId)) {
        return unknownSend(operationId, 'agent-send-operation-expired');
      }
      let boundSessionId = requestedSessionId;
      if (operationId) {
        const currentSessionId = await sessionCache.sessionGet('currentSessionId');
        if (sessionSpecified && (currentSessionId ?? null) !== requestedSessionId) {
          return {
            ok: false, error: 'agent-send-session-mismatch', outcomeKnown: true,
            retryable: false, operationId,
          };
        }
        if (!sessionSpecified) boundSessionId = currentSessionId ?? null;
      }
      // why: omission is not explicit null. Preserve it until context
      // preparation, which pins the foreground once immediately before the
      // sealed composer starts; explicit null stays no-tab and an explicit id
      // is never replaced by a later foreground target.
      const activeTabBinding = activeTabSpecified
        ? { activeTabId: requestedActiveTabId } : {};
      const binding = operationId ? {
        fingerprint: await sendFingerprint({
          text, attachments,
          activeTabSpecified,
          activeTabId: requestedActiveTabId,
          goal, sessionId: boundSessionId,
        }),
        sessionId: boundSessionId,
      } : { fingerprint: '', sessionId: null };
      return withSendReceipt(operationId, binding, async () => {
      const trimmed = text.trim();
      // Goal mode (the mode-row Goal toggle): run autonomous turns in THIS chat
      // until the agent calls complete_goal (or the cap / Stop). The goal is the
      // first, visible message; continuations are hidden synthetic turns, so the
      // work streams into the chat like a normal session. Ensure a session up
      // front (a fresh chat has none yet — same lazy-create the model turn does).
      if (goal === true) {
        if (!startGoalRun || !ensureSession) return { ok: false, error: 'goal-mode-unavailable' };
        if (!(await recoveryReadyForUserTurn())) return { ok: false, error: 'actor-recovery-pending' };
        try {
          const sessionId = boundSessionId ?? await ensureSession();
          if (boundSessionId && sessionId !== boundSessionId) {
            return { ok: false, error: 'agent-send-session-mismatch', outcomeKnown: true };
          }
          if (!admitted()) return stopped();
          await pushState();
          if (!admitted()) return stopped();
          await startGoalRun({ sessionId, goal: trimmed });
        } catch (e) {
          console.error('[sw] goal start threw', e);
          postChatNote(`Goal couldn't start: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
          return {
            ok: false, error: 'goal-start-outcome-unknown', outcomeKnown: false,
            outcomeKind: 'unknown', retryable: false,
          };
        }
        return { ok: true, handled: 'goal' };
      }
      // /init is handled in the SW, not sent to the model (feature 01) —
      // check it BEFORE composer expansion so the slash command short-
      // circuits the turn entirely (it drafts AGENTS.md, no model call).
      if (trimmed === '/init' || trimmed.startsWith('/init ')) {
        let initSessionId = boundSessionId;
        if (initSessionId === null) {
          if (typeof ensureSession !== 'function') {
            return { ok: false, error: 'init-session-unavailable', outcomeKnown: true };
          }
          initSessionId = await ensureSession({ exactFresh: true });
          if (!admitted()) return stopped();
        }
        let result;
        try {
          result = await runInit({
            sessionId: initSessionId,
            ...activeTabBinding,
          }, { signal: admission?.signal });
        }
        catch (e) {
          if (!admitted()) return stopped();
          console.error('[sw] /init threw', e);
          postChatNote(`/init failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
          return {
            ok: false, error: 'init-outcome-unknown', outcomeKnown: false,
            outcomeKind: 'unknown', retryable: false,
          };
        }
        if (!admitted()) return stopped();
        if (!result || typeof result !== 'object') {
          return {
            ok: false, error: 'init-outcome-unknown', code: 'init-outcome-unknown',
            outcomeKnown: false, outcomeKind: 'unknown', retryable: false,
            handled: 'init',
          };
        }
        if (result.ok !== true) {
          const cancelled = result.rejected === true || result.cancelled === true;
          const known = cancelled || result.outcomeKnown !== false;
          const code = cancelled ? 'init-cancelled'
            : typeof result.code === 'string' ? result.code
              : typeof result.error === 'string' ? result.error : 'init-failed';
          return {
            ok: false, error: code, code,
            outcomeKnown: known,
            outcomeKind: cancelled ? 'cancelled' : known ? 'known-failure' : 'unknown',
            retryable: cancelled || !known ? false : result.retryable !== false,
            handled: 'init',
          };
        }
        return { ok: true, handled: 'init' };
      }
      // /system [text|clear] — set/show/clear this chat's custom system-
      // prompt augmentation. SW-handled like /init; never reaches the model
      // as user text (it CHANGES what the model is told instead).
      if (trimmed === '/system' || trimmed.startsWith('/system ')) {
        try {
          await handleSystemCommand(
            trimmed.slice('/system'.length).trim(), boundSessionId,
          );
        }
        catch (e) {
          console.error('[sw] /system threw', e);
          postChatNote(`/system failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
          return {
            ok: false, error: 'system-command-outcome-unknown', outcomeKnown: false,
            outcomeKind: 'unknown', retryable: false,
          };
        }
        return { ok: true, handled: 'system' };
      }
      // /tools [preset|full|list] — set/show/clear this chat's tool
      // exposure manifest. SW-handled like /system; never reaches the model
      // (it CHANGES which tools the model is offered instead).
      if (trimmed === '/tools' || trimmed.startsWith('/tools ')) {
        try {
          await handleToolsCommand(
            trimmed.slice('/tools'.length).trim(), boundSessionId,
          );
        }
        catch (e) {
          console.error('[sw] /tools threw', e);
          postChatNote(`/tools failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
          return {
            ok: false, error: 'tools-command-outcome-unknown', outcomeKnown: false,
            outcomeKind: 'unknown', retryable: false,
          };
        }
        return { ok: true, handled: 'tools' };
      }
      // A user turn must not pass an uncommitted actor recovery receipt. Return
      // a typed retryable error instead of accepting and silently dropping it.
      if (!(await recoveryReadyForUserTurn())) return { ok: false, error: 'actor-recovery-pending' };
      // A normal (non-goal) user message while a goal run is live means the user
      // is steering / taking over. Halt only after this send is accepted so a
      // recovery pause cannot discard the draft and stop the user's goal too.
      if (haltGoalRun) {
        const curSid = boundSessionId ?? await sessionCache.sessionGet('currentSessionId');
        // Awaited: durably forget the run so a steer-takeover can't be undone by
        // a resume() on the next unlock (parity with agent/stop; #60).
        if (curSid) await haltGoalRun(/** @type {any} */ (curSid));
      }
      // Composer expansion (feature 04): rewrite /commands and @-references
      // BEFORE the turn starts. @tab/@file pulls (possibly untrusted)
      // content; the resolvers wrap it (<untrusted_web_content>/<peerd_file>)
      // and apply the denylist origin gate. Build a tool context for them.
      let userText = trimmed;
      try {
        // why: the receipt accepted one chat and one browser target. Composer
        // IO must use those exact bindings even if the user switches either
        // surface while the sealed composer is loading.
        const ctx = await buildToolContext({
          sessionId: boundSessionId,
          ...activeTabBinding,
          signal: admission?.signal,
        });
        const applied = await applyComposer(
          { text: userText, commandSources, ctx },
          { signal: admission?.signal },
        );
        userText = applied.text;
        // Reference authority emits the audit from the actual host read. The
        // controller's refs report is UX metadata and is not trusted as proof.
        if (applied.command) {
          auditLog.append({
            type: 'composer_command',
            details: { command: applied.command, found: applied.commandFound },
          }).catch(() => {});
        }
      } catch (e) {
        if (!admitted()) return stopped();
        console.error('[sw] applyComposer failed before model dispatch', e);
        return {
          ok: false,
          error: 'turn-compose-unavailable',
          code: typeof /** @type {{code?:unknown}} */ (e)?.code === 'string'
            ? /** @type {{code:string}} */ (e).code : 'turn-compose-unavailable',
          outcomeKnown: true,
          phase: 'pre-dispatch',
          retryable: true,
        };
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
          // Office/e-book attachments are CONVERTED to Markdown on the way
          // through (the offscreen doc reader — the same converter read_doc
          // uses), so by the time the pure inlining step runs they are
          // ordinary text. Validate-then-convert-then-inline is sequenced
          // inside prepareUserAttachmentsWithDocs.
          const prepared = await awaitWithSignal(prepareUserAttachmentsWithDocs({
            text: userText, attachments, convert: convertDocAttachment,
            signal: admission?.signal,
          }), admission?.signal);
          userText = prepared.text;
          turnAttachments = prepared.attachments;
        } catch (e) {
          if (!admitted()) return stopped();
          return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
        }
      }
      // why: Stop can arrive while composer or document IO is suspended; the
      // ingress generation must still fence the eventual model admission.
      if (!admitted()) return stopped();
      // Fire and forget — the side panel doesn't await; it watches the
      // port for streaming events. Returning immediately keeps the
      // message-channel cycle short.
      const settlement = runAgentTurn({
        userText, attachments: turnAttachments, ...activeTabBinding,
        ...(boundSessionId ? { sessionId: boundSessionId } : {}),
      });
      if (!operationId) {
        settlement.catch((/** @type {unknown} */ e) =>
          console.error('[sw] runAgentTurn threw', e));
        return { ok: true };
      }
      return {
        __agentSendSettlement: settlement,
        response: { ok: true },
      };
      });
    },

    // The debug bundle: one session's whole debugging story as one JSON
    // payload (the panel does the file save). Root transcript + every
    // descendant actor/actor session, the audit slice for that set,
    // cost, secret-free settings, live context snapshots, provenance.
    // Read-only over the user's own data; the export itself is audited.
    'session/debugBundle': async ({ sessionId } = {}) => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, error: 'sessionId-required' };
      }
      const session = await sessions.get(sessionId);
      if (!session) return { ok: false, error: 'session-not-found' };
      // why the STORE list (not the session/list route): the route hides
      // actor/actor rows from the chat list; the bundle wants exactly those.
      const rows = await sessions.list();
      const childIds = childSessionIdsOf(rows, sessionId);
      const childSessions = (await Promise.all(childIds.map((/** @type {string} */ id) => sessions.get(id))))
        .filter(Boolean);
      const idSet = new Set([sessionId, ...childIds]);
      const auditEntries = (await auditLog.list())
        .filter((/** @type {any} */ e) => e.sessionId && idSet.has(e.sessionId));
      const settings = settingsStore.get();
      // R4: the bundle's audit slice is a checkable artifact — run the hash
      // chain verification and stamp the result into provenance.
      const auditChain = await (auditLog.verify?.().catch(() => null)) ?? null;
      const bundle = assembleDebugBundle({
        session, childSessions, auditEntries, settings, auditChain,
        contextSnapshots: contextSnapshots.snapshotsForMany([sessionId, ...childIds]),
        channel: CHANNEL,
        appVersion: browser.runtime.getManifest?.().version ?? 'unknown',
        now: Date.now(),
        limits: { auditMaxEntries: settings.auditLogMaxEntries, ...contextSnapshots.limits() },
      });
      return { ok: true, bundle };
    },

    // --- spawned actors ---
    //
    // The peerd.runtime.runAgent shim (an App/Notebook the agent built embedding its
    // own agent) posts here. Notebook tabs are extension-origin pages, so
    // runtime.onMessage reaches us directly — the caller is already
    // authenticated as our own extension. The parent is whichever chat
    // session is current; the actor inherits its depth (+1), permission
    // mode, and provider key through the orchestrator. If an artifact makes
    // several calls, each creates its own child session and runs
    // independently. (The model's OWN parallel work goes through the
    // actor_create tool, not this path.)
    'actor/spawn': async ({ task, tools, maxSteps, maxDepth, allowRecursion }) => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      if (typeof task !== 'string' || !task.trim()) {
        return { ok: false, error: 'task-required' };
      }
      const parentSessionId = await sessionCache.sessionGet('currentSessionId');
      if (!parentSessionId) return { ok: false, error: 'no-active-session' };
      const parent = await sessions.get(parentSessionId);
      const out = await spawnActor({
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
  };
};
