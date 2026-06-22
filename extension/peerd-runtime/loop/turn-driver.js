// @ts-check
// peerd-runtime/loop/turn-driver — the agent turn driver, lifted from the
// service worker (background/service-worker.js §5 "Agent turn driver").
// makeTurnDriver(deps) returns { runAgentTurn, maybeAutoResume }; every
// IO/dependency is INJECTED (functional-core/imperative-shell) so the turn
// orchestration — ~530 lines previously reachable only through a real browser —
// can be unit-tested with fakes. The body is unchanged from the SW; only the
// binding source moved from the SW's closure scope to this deps object.
//
// why inject (not import): runAgentTurn closes over the SW's live instance graph
// (vault, sessions, the side-panel ports, the tool dispatcher, cost/failover
// helpers, ...). Injecting preserves exact behavior and keeps this module
// browser-free and testable.
//
// EXCEPTION — error CLASSES are imported, not injected: the loop-failure mapping
// branches on `e instanceof ProviderUsageLimitError` etc. and reads `.detail`/
// `.status` off the narrowed value. instanceof only narrows against a real
// constructor type, so these must be imported (an injected `any` defeats the
// narrowing). They're pure, stable, and lower in the dep graph — import-correct.
// (VaultLockedError stays injected: it's only thrown, never instanceof-checked.)

import {
  ProviderHttpError, ProviderKeyMissingError, ProviderUsageLimitError, UnknownProviderError,
} from '/peerd-provider/index.js';
import { SessionNotFoundError } from '../errors.js';

export const makeTurnDriver = (/** @type {any} */ deps) => {
  const {
    vault, VaultLockedError, sessionCache, resolveActiveProvider, resolvePermission,
    sessions, sessionState, turnSlots, buildTemporalBlock, memory, browser, originOfTabUrl,
    skillRegistry, renderSystemPrompt, resolveManifestAllow, buildToolContext,
    computeMainInstanceState, filterByDwebActive, filterByDwebEnabled, filterByInstanceState,
    filterDescriptorsByManifest, mainAgentDescriptors, listTools, settingsStore, DWEB_ENABLED,
    filterByGoalActive, goalActiveFor,
    dwebEngagedSessions, markDwebEngaged, dispatchToolCall, maybeNudgeDebuggerGrant, getTool,
    decideAction, listProviders, costOf, makeTurnCostTracker, uiConnected, uiPorts, auditLog,
    resolveFailoverChain, shouldFailover, callModel, postChatNote, runUserTurn, getSecret,
    safeFetch, REASONING_BUDGET_TOKENS, REASONING_EFFORT_LEVELS, DEFAULT_SETTINGS, trimEnricher,
    contextWindowFor, liveContextWindow, currentAppScope,
    checkpointMgr, detectInterruptedTurn,
  } = deps;

/**
 * Run one user turn. Lazily creates a session on first send. Streams
 * deltas to the side panel via the port (separate channel from the
 * state pushes so the UI can incrementally update without re-rendering
 * the whole session shape).
 */
const runAgentTurn = async (/** @type {any} */ { userText, attachments = null, sessionId: targetSessionId = null, synthetic = false, resume = false, activeTabId = null }) => {
  if (vault.isLocked()) throw new VaultLockedError();

  // Lazy session create — bind the chat to whatever provider/model the
  // user has selected in Settings (defaults to Anthropic). targetSessionId
  // re-enters a SPECIFIC parent session for an async-subagent reintegration
  // (DESIGN-11) WITHOUT touching currentSessionId — never switch the user's
  // active view (DECISIONS #20). The lazy-create path below only runs for a
  // genuinely fresh active chat (no target, no current).
  let sessionId = targetSessionId ?? await sessionCache.sessionGet('currentSessionId');
  if (!sessionId) {
    const ap = resolveActiveProvider();
    // Inherit the Plan/Act permission the user set before sending (cached
    // in storage.session) so a fresh chat opens in the chosen mode +
    // confirm setting rather than reverting to the read-only default
    // mid-conversation.
    const inherited = await resolvePermission(null);
    const created = await sessions.create({
      provider: ap.name,
      model: ap.model,
      permissionMode: inherited.mode,
      confirmActions: inherited.confirmActions,
    });
    sessionId = created.sessionId;
    await sessionCache.sessionSet('currentSessionId', sessionId);
    sessionState.set(created);
  }

  // Claim THIS session's turn slot. If this chat is already streaming,
  // the claim aborts that turn first (steer-live — the loop's catch-
  // AbortError path persists the partial with stopReason='aborted');
  // turns streaming in OTHER chats are untouched.
  const { controller: abortController, release: releaseTurnSlot } = turnSlots.claim(sessionId);

  // Build the per-turn temporal block: absolute now + a coarse, plain-
  // words elapsed since the user's previous message (only when the gap
  // is non-trivial). prevTurnAt lives in chrome.storage.session
  // (survives SW restart, dies on browser restart) and bumps to now()
  // so the *next* turn measures from here. First turn: prevTurnAt is
  // undefined → just the absolute timestamp.
  const TURN_AT_KEY = `turn.lastAt.${sessionId}`;
  const prevTurnAt = await sessionCache.sessionGet(TURN_AT_KEY);
  const turnNow = Date.now();
  const temporalBlock = buildTemporalBlock({
    lastTurnAt: typeof prevTurnAt === 'number' ? prevTurnAt : null,
    nowMs: turnNow,
  });
  await sessionCache.sessionSet(TURN_AT_KEY, turnNow);

  // Always-loaded memory block (V1.5). Keyed by the active tab origin —
  // peerd's "project" workspace is the browsing context, not a file
  // tree. loadAlwaysLoaded fetches only the user + this-workspace docs
  // and budget-trims to < ~200 lines; subtree memory stays on-demand.
  let memoryBlock = '';
  // Ephemeral "reorientation" context: the web page the user is looking at when
  // they sent this message. Only a REAL web page counts — on home (an extension
  // page) or any non-http tab there's nothing to reorient to, so the block
  // vanishes (the user's "back on home → gone" requirement, by construction).
  // Re-derived per turn from the live active tab; never persisted to history.
  let activeTabContext = null;
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    const ws = activeTab?.url ? originOfTabUrl(activeTab.url) : '';
    const loaded = await memory.loadAlwaysLoaded({ workspace: ws });
    memoryBlock = loaded.text;
    if (typeof activeTab?.url === 'string' && /^https?:\/\//i.test(activeTab.url)) {
      activeTabContext = { url: activeTab.url, title: (activeTab.title || '').slice(0, 200) };
    }
  } catch (e) {
    console.warn('[sw] memory load failed', e);
  }
  // Progressive disclosure, cheap half: build the skill DESCRIPTIONS
  // block once per turn (names + one-line descriptions only — bodies stay
  // on disk until load_skill fetches one). Collapses to '' when no skills
  // are installed, so the prompt placeholder costs nothing.
  const skillsBlock = await skillRegistry.describeForPrompt().catch((/** @type {any} */ e) => {
    console.error('[sw] skill descriptions failed', e);
    return '';
  });

  const getSystemPrompt = async () => {
    // why: re-read the session record at render time so a /system change
    // (set or clear) takes effect on the very next turn. The block is the
    // user's per-session augmentation — appended as <session_instructions>,
    // never replacing the base prompt (the base carries the security/
    // defense text). Absent → collapses to nothing. The per-change cache
    // break this causes is by design.
    const promptSession = await sessions.get(sessionId);
    return renderSystemPrompt({
      memoryBlock,
      temporalBlock,
      skillsBlock,
      customSystemPrompt: promptSession?.customSystemPrompt,
      // Ephemeral active-tab reorientation (null on home / non-web tabs).
      activeTab: activeTabContext,
    });
  };

  // Tool descriptors passed to the provider — name, description, and
  // JSON-schema. The Anthropic adapter rewrites these into Anthropic's
  // `tools` array shape.
  //
  // EXPOSURE CUTOVER: the MAIN agent's browser surface is do/get/check (+
  // list_tabs/open_tab). The low-level DOM/page tools are hidden here so a11y
  // trees, refs, and raw page content never enter the main context — they're
  // the runner's, reached only through do/get/check. The tools stay REGISTERED
  // (listTools is full); the runner still narrows from the full set via
  // getToolDescriptors. This filter is main-turn-only. See tools/exposure.js.
  //
  // SECOND cut: the session's tool MANIFEST (/tools — tools/manifests.js).
  // Intersecting here means the model never SEES an excluded tool; the
  // exposure gate re-refuses by name at dispatch (buildToolContext feeds it
  // the same record), so the descriptor filter is UX, the gate is the wall.
  // Re-read per turn so a mid-chat /tools change applies on the next turn —
  // the same freshness contract getSystemPrompt keeps for /system.
  const manifestSession = await sessions.get(sessionId);
  const sessionToolAllow = resolveManifestAllow(manifestSession?.toolManifest);

  // One ToolContext for the whole turn. The dispatcher reads from it
  // per tool call; we snapshot provider/vault state at turn start so
  // mid-turn changes (e.g. user adds a key while tools are firing)
  // don't surface inconsistent readings. exposure:'main' makes the
  // exposure gate refuse runner-only tools the model shouldn't reach.
  // Built BEFORE the descriptor list so refreshMainTools (below) can restamp
  // its instanceState each step — progressive disclosure.
  const toolContext = await buildToolContext({ exposure: 'main', sessionId, activeTabId });

  // THIRD cut: progressive disclosure. The vm/js/app SECONDARY ops are hidden
  // until the chat has a current instance of that kind (filterByInstanceState).
  // Recomputed PER STEP (passed to the loop as refreshTools) so an instance
  // created mid-turn reveals its ops on the very next model step — and the same
  // recompute restamps toolContext.instanceState so the sync exposure gate
  // stays in lockstep with what the model is shown. Entry + auto-creating tools
  // (vm_create/vm_boot, js_create/js_notebook, app_create/open/search) stay
  // always-on, so every family is bootstrappable in one call.
  const refreshMainTools = async () => {
    const instanceState = await computeMainInstanceState(sessionId);
    // why: build the descriptor list BEFORE mutating the shared gate state, so
    // a throw in the build can never leave toolContext.instanceState ahead of
    // the list the model was actually shown (the loop's catch keeps the prior
    // activeTools — this keeps the gate in lockstep with it). Assign last.
    // FOURTH cut: dweb tools (publish/discover/install) only when the dweb is on.
    // Runs BEFORE the .map (which drops the `dweb` flag) so the agent never sees
    // them on the store build (DWEB_ENABLED false) or with the setting off.
    // FIFTH cut: the dweb SECONDARY tools (sovereign controls + bridge guide) stay
    // hidden until this session has CALLED a dweb tool — engagement, not the
    // always-on network's peer presence. Composes after the dweb-enabled gate.
    // SIXTH cut: goal mode. complete_goal is registered always but revealed to
    // the model ONLY while a goal run is live for this session (goalActiveFor),
    // so a normal chat never sees it. Outermost so it composes over the rest.
    const descriptors = filterByGoalActive(
      filterByDwebActive(
        filterByDwebEnabled(
          filterByInstanceState(
            filterDescriptorsByManifest(mainAgentDescriptors(listTools()), sessionToolAllow),
            instanceState,
          ),
          DWEB_ENABLED && !!settingsStore.get().dwebEnabled,
        ),
        dwebEngagedSessions.has(sessionId),
      ),
      !!goalActiveFor?.(sessionId),
    ).map((/** @type {any} */ t) => ({ name: t.name, description: t.description, schema: t.schema }));
    toolContext.instanceState = instanceState;
    return descriptors;
  };
  const toolDescriptors = await refreshMainTools();
  const toolDispatch = async (/** @type {any} */ call) => {
    // Engagement trigger: any dweb tool call marks the session dweb-engaged, so
    // refreshMainTools reveals the SECONDARY dweb tools on the next step. The
    // entry tools (discover/share/install) are dweb_* too, so the first one the
    // agent calls flips it — dweb_discover is the natural opener.
    if (typeof call?.name === 'string' && call.name.startsWith('dweb_')) markDwebEngaged(sessionId);
    const result = await dispatchToolCall(call, /** @type {any} */ (toolContext));
    // If a CDP-backed tool reported the debugger isn't available, surface a
    // one-time "enable advanced automation" nudge to the side panel.
    maybeNudgeDebuggerGrant(result);
    return result;
  };
  // why: the loop's concurrent-dispatch scheduler partitions a multi-tool
  // turn by the SAME decideAction policy the dispatcher enforces — READ-
  // class calls (which never confirm) may run concurrently; anything that
  // writes or would need a confirmation round-trip stays serial, so two
  // side effects can't interleave and confirm modals never stack. Reads
  // the turn-start permission snapshot (toolContext.permission), matching
  // exactly what the dispatcher itself will consult per call.
  const classifyToolCall = (/** @type {string} */ name) => {
    const tool = getTool(name);
    if (!tool) return null;
    return decideAction({
      mode: /** @type {any} */ (toolContext.permission?.mode),
      confirmActions: toolContext.permission?.confirmActions,
      tool,
    });
  };

  let lastSession = null;
  // Cost/usage accumulation for this turn (feature 06) — the fold/persist/
  // push/halt logic lives in makeTurnCostTracker (peerd-runtime/cost); the
  // SW supplies the IO: persist via sessions.setCost, the live meter via
  // the side-panel port, and the hard-limit halt via THIS turn's
  // AbortController (same clean-abort path as Stop / steer-live, so the
  // loop unwinds through its existing branch — persists partial, yields
  // stopReason='aborted').
  const costSession = await sessions.get(sessionId);
  // why: keyless providers (Ollama) run on the user's own hardware — an
  // unknown local model id still costs $0, so the pricing fold is told
  // it's a local provider and resolves a KNOWN zero rate card instead of
  // "estimate unavailable". Keeps the CostChip honest at $0.00.
  const costProviderIsLocal = !!listProviders()
    .find((/** @type {any} */ p) => p.name === costSession?.provider)?.keyless;
  const costTracker = makeTurnCostTracker({
    costOf: (/** @type {any} */ model, /** @type {any} */ usage, /** @type {any} */ overrides) =>
      costOf(/** @type {any} */ (model), /** @type {any} */ (usage), /** @type {any} */ (overrides), { localProvider: costProviderIsLocal }),
    // why: price against the SESSION's model (the one that actually
    // produced the usage), not the current Settings selection — an old
    // chat keeps its original model even if the user later switches.
    model: costSession?.model,
    pricingOverrides: settingsStore.get().pricingOverrides,
    limitUsd: settingsStore.get().spendLimitUsd,
    initialSessionCost: costSession?.cost,
    persistCost: (/** @type {any} */ tally) => sessions.setCost(/** @type {any} */ (sessionId), /** @type {any} */ (tally)),
    onCost: (/** @type {any} */ info) => {
      if (!uiConnected()) return;
      // sessionId rides along so the panel only ticks the meter of the
      // chat actually being viewed (turns can stream in the background).
      uiPorts.broadcast(/** @type {any} */ ({ type: 'turn/cost', ...info, sessionId }));
    },
    onLimitExceeded: (/** @type {any} */ { sessionId: sid, spent, limitUsd }) => {
      if (uiConnected()) {
        uiPorts.broadcast({
          type: 'turn/spend-limit-reached', sessionId: sid, spent, limitUsd,
        });
      }
      auditLog.append({
        type: 'spend_limit_reached',
        sessionId: sid,
        details: { spent, limitUsd },
      }).catch(() => {});
      abortController.abort();
    },
  });
  if (uiConnected()) {
    uiPorts.broadcast({ type: 'turn/streaming', sessionId, streaming: true });
  }

  // Provider failover (switch-and-continue). The loop calls this as
  // callModel each step with the session's {provider, model}. When a
  // provider stays overloaded past the adapter's own retries, or returns a
  // hard usage limit, we switch to a configured fallback and keep going —
  // but ONLY before any model output has streamed this call (a mid-stream
  // switch would replay deltas the loop already consumed). It composes on
  // top of the adapter-level retries that run underneath it. `lastGood` is
  // per-turn: once a fallback works we stay on it for the rest of the turn
  // rather than re-failing the primary each step. The session record is left
  // untouched (cost prices against the original model; the next turn starts
  // fresh from the primary). A no-op pass-through when failover is off or
  // unconfigured (resolveFailoverChain returns just the primary).
  /** @type {{ provider: string, model: string } | null} */ let failoverLastGood = null;
  const callModelWithFailover = async function* (/** @type {any} */ modelArgs) {
    const start = failoverLastGood ?? { provider: modelArgs.provider, model: modelArgs.model };
    const chain = resolveFailoverChain(start);
    let lastErr;
    for (let i = 0; i < chain.length; i++) {
      const cand = chain[i];
      let streamedContent = false;
      try {
        for await (const ev of callModel({ ...modelArgs, provider: cand.provider, model: cand.model })) {
          // rate-limit-pause is the adapter's pre-stream backoff signal, not
          // model output — failover stays safe while only those have flowed.
          if (ev.type !== 'rate-limit-pause') streamedContent = true;
          yield ev;
        }
        failoverLastGood = cand;
        return;
      } catch (e) {
        lastErr = e;
        const isLast = i === chain.length - 1;
        // Can't fail over once real output streamed (would duplicate it);
        // the PRIMARY only triggers a switch on a failover-worthy error,
        // while a fallback already in the chain is advanced on any pre-stream
        // failure (a backup that's also down/keyless shouldn't dead-end).
        if (streamedContent || isLast) throw e;
        if (i === 0 && !shouldFailover(e)) throw e;
        const to = chain[i + 1];
        auditLog.append({
          type: 'provider_failover',
          sessionId,
          details: { from: cand.provider, to: to.provider, reason: (/** @type {{ name?: string }} */ (e))?.name ?? 'error' },
        }).catch(() => {});
        postChatNote(`${cand.provider} unavailable — switching to ${to.provider} and continuing…`);
      }
    }
    throw lastErr;
  };

  try {
    for await (const ev of runUserTurn({
      sessionId,
      userText,
      // why: a reintegration wake (DESIGN-11) rides a synthetic user turn —
      // hidden from the chat UI; the normal send path passes synthetic=false.
      synthetic,
      // why: auto-resume (maybeAutoResume) re-drives a turn the SW reclaimed
      // mid-flight — no new user message; the loop continues the persisted
      // history. Normal sends pass resume=false.
      resume,
      // why: already validated + shaped by loop/attachments.js in
      // agent/send (text payloads inlined there). The loop ships the
      // bytes this turn and persists the stripped metadata shape.
      ...(attachments ? { attachments } : {}),
      // why: the failover wrapper, not the bare registry callModel — so a
      // persistently-overloaded or out-of-credit provider switches to a
      // configured fallback mid-turn instead of failing the whole turn.
      callModel: callModelWithFailover,
      getSecret,
      safeFetch,
      sessions,
      getSystemPrompt,
      appendAudit: /** @type {any} */ (auditLog.append),
      tools: toolDescriptors,
      // why: progressive disclosure — the loop calls this each step to get the
      // current tool list, so an instance created mid-turn reveals its ops on
      // the next step (and restamps toolContext.instanceState for the gate).
      refreshTools: refreshMainTools,
      toolDispatch,
      classifyToolCall,
      // why: resolve from CURRENT settings at turn start (settings load
      // async and the user can dial reasoning/effort between turns). The
      // includes() guard normalizes junk that could only arrive via a
      // crafted transfer import (applyImport copies values verbatim) —
      // an invalid string would otherwise 400 every turn at the API.
      reasoning: {
        enabled: settingsStore.get().reasoningEnabled,
        budgetTokens: REASONING_BUDGET_TOKENS,
        effort: REASONING_EFFORT_LEVELS.includes(settingsStore.get().reasoningEffort)
          ? settingsStore.get().reasoningEffort
          : DEFAULT_SETTINGS.reasoningEffort,
      },
      signal: abortController.signal,
      // Long-session compression: when the history trim drops NEW
      // messages, the loop fires this (never awaited). We only queue;
      // the cheap summarisation call runs in the finally below, AFTER
      // the stream ends, so it can't race the turn's session writes.
      enrichTrimSummary: (/** @type {any} */ req) => trimEnricher.queue(/** @type {any} */ (req)),
      // why: the DYNAMIC trim trigger scales to THIS session's model
      // window. Resolved against the SAME session.model the cost tracker
      // prices against (an old chat keeps its original model). Resolution
      // order: user override → live provider value (provider Models APIs,
      // cached + non-blocking) → static table → null (unknown ⇒ falsy ⇒
      // planTrim falls back to its message-count backstop).
      contextWindow: /** @type {any} */ (contextWindowFor(/** @type {any} */ (costSession?.model), {
        overrides: settingsStore.get().contextWindowOverrides,
        live: liveContextWindow(/** @type {any} */ (costSession?.provider), /** @type {any} */ (costSession?.model)),
      })),
    })) {
      // Cost telemetry (feature 06) — handled BEFORE the panel guard so
      // the persisted session total and the hard-limit halt stay correct
      // even when the side panel is closed (a long agentic turn can run
      // with the panel hidden). Pricing is computed from the LOCAL table
      // (+ user overrides); no usage leaves the browser.
      if (ev.type === 'usage') {
        await costTracker.onUsage(ev);
        costTracker.maybeHalt(ev);
        continue;
      }
      if (!uiConnected()) continue;
      switch (ev.type) {
        case 'state':
          lastSession = ev.session;
          uiPorts.broadcast({ type: 'turn/state', session: ev.session });
          break;
        case 'delta':
          uiPorts.broadcast({
            type: 'turn/delta',
            sessionId: ev.sessionId,
            messageId: ev.messageId,
            text: ev.text,
          });
          break;
        case 'reasoning':
          uiPorts.broadcast({
            type: 'turn/reasoning',
            sessionId: ev.sessionId,
            messageId: ev.messageId,
            text: ev.text,
          });
          break;
        case 'tool-use':
          uiPorts.broadcast({
            type: 'turn/tool-use',
            sessionId: ev.sessionId,
            messageId: ev.messageId,
            toolUseId: ev.toolUseId,
            name: ev.name,
            input: ev.input,
          });
          break;
        case 'tool-result':
          uiPorts.broadcast({
            type: 'turn/tool-result',
            sessionId: ev.sessionId,
            toolUseId: ev.toolUseId,
            result: ev.result,
          });
          break;
        case 'error':
          uiPorts.broadcast({
            type: 'turn/error',
            sessionId: ev.sessionId,
            messageId: ev.messageId,
            error: ev.error,
          });
          break;
        case 'stop':
          uiPorts.broadcast({
            type: 'turn/stop',
            sessionId: ev.sessionId,
            messageId: ev.messageId,
            stopReason: ev.stopReason,
          });
          break;
        case 'rate-limit-pause':
          // why: forward so the side panel can render a "rate-limited,
          // retrying in Xs" indicator next to the in-flight message
          // instead of looking frozen during the wait. The adapter is
          // already sleeping; the UI doesn't need to do anything but
          // display the timing.
          uiPorts.broadcast({
            type: 'turn/rate-limit-pause',
            sessionId: ev.sessionId,
            messageId: ev.messageId,
            retryAfterMs: ev.retryAfterMs,
            attempt: ev.attempt,
          });
          break;
      }
    }
  } catch (e) {
    // Loop-level failure — typed errors get clean labels; anything else
    // surfaces as a generic provider error message.
    const error = e instanceof ProviderKeyMissingError ? 'provider-key-missing'
      : e instanceof ProviderUsageLimitError ? `provider-usage-limit${e.detail ? `: ${e.detail}` : ''}`
      : e instanceof ProviderHttpError ? `provider-http-${e.status}`
      : e instanceof UnknownProviderError ? 'unknown-provider'
      : e instanceof SessionNotFoundError ? 'session-not-found'
      : (/** @type {{ message?: string }} */ (e))?.message ?? 'unknown-error';
    if (uiConnected()) {
      uiPorts.broadcast({ type: 'turn/error', sessionId, error });
    }
  } finally {
    // Self-scoped: a superseded (steered) turn unwinding late can only
    // clear its own slot, never the newer turn that replaced it.
    releaseTurnSlot();
    // Drain any queued trim-summary enrichment now that the stream is
    // done — fire-and-forget, mechanical fallback already persisted, so
    // a failure here costs nothing but summary quality.
    trimEnricher.drain(sessionId)
      .catch((/** @type {any} */ e) => console.warn('[sw] trim enrichment failed', e));
    if (uiConnected()) {
      uiPorts.broadcast({ type: 'turn/streaming', sessionId, streaming: false });
    }
    // --- Feature 02: per-turn workspace snapshot ----------------------
    // why: snapshot AFTER every turn that could have touched files so
    // review's diffSince has a "before" to diff against. The capture is
    // a no-op (dedup'd) when nothing changed, so running it
    // unconditionally is cheap: one App workspace, one checkpoint per
    // modifying turn. Fire-and-forget — a snapshot failure must never
    // break the chat. (User-facing rollback over these snapshots was
    // removed 2026-06-12 — owner call, DESIGN-09.)
    (async () => {
      const scope = await currentAppScope(sessionId);
      if (!scope) return;
      await checkpointMgr.capture({ scope, label: null, meta: { turn: true } });
    })().catch((e) => console.warn('[sw] post-turn snapshot failed', e));
  }
  // Refresh the SW's session cache from the turn's final state — but only
  // when the user is still ON this chat. A turn finishing in a background
  // conversation must not clobber the cache for the one now in view.
  if (lastSession
      && (await sessionCache.sessionGet('currentSessionId')) === lastSession.sessionId) {
    sessionState.set(lastSession);
  }
};

// Per-SW-lifetime dedupe for auto-resume: the interrupted message id we've
// already resumed for each session, so reopening a chat repeatedly doesn't
// re-fire the same dead turn. A FRESH interruption (new markerId) resumes
// again. The map is empty on a cold SW — which is exactly right: a wake is
// precisely when we most want to resume the turn the eviction killed.
const autoResumedMarkers = new Map();

/**
 * Auto-resume (feature: robustness). If a session's last turn was cut off by
 * INFRASTRUCTURE (SW eviction mid-stream, early stream close, dispatch cut
 * short) and NOT by the user (a Stop is never resumed), drive one synthetic
 * continuation turn. Gated by the setting, an unlocked vault, and the session
 * not already streaming. Fire-and-forget; never throws.
 *
 * @param {string | null | undefined} sessionId
 */
const maybeAutoResume = async (sessionId) => {
  try {
    if (!settingsStore.get().autoResumeInterruptedTurns) return;
    if (!sessionId || vault.isLocked()) return;
    // Don't race a live turn — the loop is mid-stream, not interrupted.
    if (turnSlots.isBusy(sessionId)) return;
    const session = await sessions.get(sessionId);
    const verdict = detectInterruptedTurn(session);
    if (!verdict.resumable) return;
    if (autoResumedMarkers.get(sessionId) === verdict.markerId) return;
    autoResumedMarkers.set(sessionId, verdict.markerId);
    auditLog.append({
      type: 'turn_auto_resumed',
      sessionId,
      details: { reason: verdict.reason },
    }).catch(() => {});
    postChatNote('Resuming the previous turn — it was interrupted before it finished.');
    // resume:true → no new user message; the loop continues the persisted
    // history (resume notes + orphan-repaired tool results make it coherent).
    // Passing sessionId as the target re-enters THIS session without touching
    // the user's current view.
    runAgentTurn({ sessionId, resume: true })
      .catch((e) => console.error('[sw] auto-resume turn threw', e));
  } catch (e) {
    console.warn('[sw] maybeAutoResume failed', e);
  }
};

  return { runAgentTurn, maybeAutoResume };
};
