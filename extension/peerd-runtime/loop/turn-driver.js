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
import {
  ActorCredentialBoundaryError, ACTOR_CREDENTIAL_BOUNDARY_FAILURE, SessionNotFoundError,
} from '../errors.js';
// Pure policy helpers (not IO) — direct import is the gates.js precedent, and
// keeps the actor turn setup readable. Flag-gated so they're inert when off.
import { EXPOSURE_ACTOR, actorDescriptors, filterActorSurface, pinActorCall } from '../tools/exposure.js';
// The prewalk planning nudge (loop/prewalk.js) — appended to the system
// prompt only while session.prewalk.phase === 'planning'. Pure text; the
// swap/restore IO rides the injected reconcilePrewalk/maybePrewalkSwap deps.
import { PREWALK_NUDGE } from './prewalk.js';
// Pure helper (no IO) — imported directly, like PREWALK_NUDGE above. Builds the
// per-turn ephemeral <context> message (temporal + active tab) that keeps the
// main system string byte-stable and prompt-cacheable (design 01).
import { buildTemporalContext } from './system-prompt.js';
import { DWEB_INBOUND_TOOL_NAMES } from '../actor/capability-manifest.js';

/**
 * The in-SW fallback's positive inbound authority check. Kept pure/exported so
 * the hidden-tool forgery case is pinned without constructing a whole turn.
 * @param {{ isActor: boolean, inbound: boolean, actorType?: string, name?: string }} input
 */
export const inboundActorCallAllowed = ({ isActor, inbound, actorType, name }) =>
  !(isActor && inbound && actorType === 'dweb')
  || (typeof name === 'string' && DWEB_INBOUND_TOOL_NAMES.includes(name));

// pinActorCall moved to tools/exposure.js (shared with the offscreen actor tool
// relay, a security seam — one implementation, no drift).

export const makeTurnDriver = (/** @type {any} */ deps) => {
  const {
    vault, VaultLockedError, sessionCache, ensureActiveProvider, resolvePermission,
    sessions, sessionState, turnSlots, buildTemporalBlock, memory, browser, originOfTabUrl,
    skillRegistry, renderSystemPrompt, resolveManifestAllow, buildToolContext,
    filterByDwebActive, filterByDwebEnabled,
    filterDescriptorsByManifest, mainAgentDescriptors, listTools, settingsStore, DWEB_ENABLED,
    filterByGoalActive, goalActiveFor,
    dwebEngagedSessions, markDwebEngaged, dispatchToolCall, maybeNudgeDebuggerGrant, getTool,
    decideAction, listProviders, costOf, makeTurnCostTracker, uiConnected, uiPorts, auditLog,
    resolveFailoverChain, shouldFailover, callModel, postChatNote, runUserTurn, getSecret,
    safeFetch, REASONING_BUDGET_TOKENS, REASONING_EFFORT_LEVELS, DEFAULT_SETTINGS, trimEnricher,
    contextWindowFor, liveContextWindow, currentAppScope,
    checkpointMgr, detectInterruptedTurn,
    // The context inspector's capture hook (optional; a no-op default so the
    // driver never depends on the debug surface being wired).
    recordModelCall = () => {},
    // Prewalk (loop/prewalk.js), both optional so actor/test drivers stay
    // inert: reconcilePrewalk applies a pending planning→executing model swap
    // (or restores stale state) at the TURN boundary — before pricing,
    // context-window and reasoning resolve, so all three see the swapped
    // model; maybePrewalkSwap is the per-tool-call gate that flips the phase.
    reconcilePrewalk = null,
    maybePrewalkSwap = null,
    // Engine-actor prewalk: swaps a VM/Notebook/App actor to its cheap executor
    // from its second turn onward. Optional so actor/test drivers stay inert.
    reconcileEngineActor = null,
    // Lifecycle recovery notices (lifecycle/boot.js drainNoticesFor):
    // read-once per session, folded into the leading <context> message so the
    // AGENT hears the same §14 semantic distinction the user's chat note
    // carried — including the do-not-repeat instruction for outcome_unknown.
    // Optional so actor/test drivers stay inert.
    drainRecoveryNotices = null,
  } = deps;

/**
 * Run one user turn. Lazily creates a session on first send. Streams
 * deltas to the side panel via the port (separate channel from the
 * state pushes so the UI can incrementally update without re-rendering
 * the whole session shape).
 */
const runAgentTurn = async (/** @type {any} */ { userText, attachments = null, sessionId: targetSessionId = null, synthetic = false, trusted = false, resume = false, activeTabId = null, display = null, oneShot = false, actorReply = null, actorSurface = null, captureTurnSnapshot = false, onBeforeRelease = null, turnLease = null }) => {
  if (vault.isLocked()) throw new VaultLockedError();

  // Lazy session create — bind the chat to whatever provider/model the user
  // has configured (no provider is assumed on a fresh install; see
  // ensureActiveProvider below). targetSessionId
  // re-enters a SPECIFIC parent session for an async-actor reintegration
  // (DESIGN-11) WITHOUT touching currentSessionId — never switch the user's
  // active view (DECISIONS #20). The lazy-create path below only runs for a
  // genuinely fresh active chat (no target, no current).
  let sessionId = targetSessionId ?? await sessionCache.sessionGet('currentSessionId');
  if (!sessionId) {
    // ensureActiveProvider (async): when the user hasn't explicitly chosen a
    // provider, bind this fresh chat to the first USABLE one (keyed-with-key, or
    // a reachable keyless daemon) instead of a keyless-Anthropic guess — matching
    // what the model picker shows. No-op (returns the explicit choice) when a
    // provider is already selected, so the common path adds no probes.
    const ap = await ensureActiveProvider();
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
  const { controller: abortController, release: releaseTurnSlot } = turnLease ?? turnSlots.claim(sessionId);

  // DESIGN-17: resolve the session kind ONCE (authoritative, persisted — robust
  // even when re-driven by auto-resume). An actor turn runs the SAME wrapper
  // (cost/clamp/scheduler/key/egress below) but a kind-aware per-turn SETUP: no
  // user-tab/memory context, an actor-only descriptor list + tuned prompt, the
  // 'actor' exposure marker, and the per-instance pin. Reused for cost.
  let turnSession = sessionId ? await sessions.get(sessionId) : null;
  // Prewalk turn-boundary reconcile: apply a pending executor swap (so THIS
  // turn's model/pricing/window all read the executor), or restore a stale
  // planner (a run that died without its run-end restore). Best-effort — a
  // reconcile failure runs the turn on the unreconciled record. Two disjoint
  // paths: the goal-run reconcile for a CHAT session, and the engine-actor
  // reconcile for an ENGINE actor (VM/Notebook/App) — the actor swaps to its
  // cheap executor from its second turn onward. A web/dweb/spawned actor
  // carries no prewalk and is untouched.
  if (turnSession?.prewalk) {
    try {
      if (turnSession.kind !== 'actor' && typeof reconcilePrewalk === 'function') {
        turnSession = (await reconcilePrewalk(turnSession)) ?? turnSession;
      } else if (turnSession.kind === 'actor' && typeof reconcileEngineActor === 'function') {
        turnSession = (await reconcileEngineActor(turnSession)) ?? turnSession;
      }
    } catch (e) { console.warn('[turn] prewalk reconcile failed', e); }
  }
  const isActor = turnSession?.kind === 'actor';
  /** @type {string|undefined} */
  const actorType = isActor ? turnSession.actorType : undefined;
  /** @type {string|undefined} */
  const actorInstanceId = isActor ? turnSession.instanceId : undefined;
  // DESIGN-18: a web actor's backing — 'api' (origin-owned, fetch-only, no tab) vs the
  // default tab backing. Threaded to buildToolContext so the gate refuses DOM tools and
  // the egress boundary scopes to the FIXED origin for an API actor.
  /** @type {'tab'|'api'|undefined} */
  const actorBacking = isActor ? turnSession.backing : undefined;
  // Firefox has no offscreen actor host, so a bound actor can reach this
  // in-service-worker loop. Keep the live provider credentials out of that
  // loop frame just as the spawned-actor fallback does. The model wrapper
  // below restores them only at the provider-call boundary. This narrows
  // custody but does not create heap isolation; that contract is tracked
  // separately in #305.
  const loopCredentials = isActor
    ? {
      getSecret: async () => { throw new ActorCredentialBoundaryError('secret'); },
      safeFetch: async () => { throw new ActorCredentialBoundaryError('provider-network'); },
    }
    : { getSecret, safeFetch };

  // DESIGN-17 P1 glass pane. When an actor turn was triggered by a LIVE
  // message_actor (display set; absent on a boot redrain), re-emit its stream as
  // a turn/actor-* family keyed to that tool_use card — the orchestrator renders
  // the actor's work inline (the actor live-view, for an actor). The plain
  // turn/* below are dropped anyway (an actor session is never the viewed chat);
  // these carry the card correlation. fromIndex is the actor session length
  // BEFORE this turn appends its message, so the card shows just THIS exchange —
  // not the actor's whole accumulated history (it is a long-lived actor).
  const actorDisplay = (display && isActor) ? display : null;
  const displayFromIndex = actorDisplay ? (turnSession?.messages?.length ?? 0) : 0;
  if (actorDisplay && uiConnected()) {
    uiPorts.broadcast({
      type: 'turn/actor-start',
      parentToolUseId: actorDisplay.parentToolUseId,
      sessionId, fromIndex: displayFromIndex,
      kind: actorDisplay.kind, instanceId: actorDisplay.instanceId, name: actorDisplay.name,
    });
  }

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
  // why: an ACTOR has no user-workspace memory and no foreground-tab
  // reorientation — its context is its INSTANCE, not the user's browsing. Pulling
  // the user's current page + that origin's memory into an actor turn would be
  // both wrong context AND a leak (esp. for an App actor rendering attacker
  // content). So an actor turn skips the foreground query entirely.
  if (!isActor) {
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
  }
  // Progressive disclosure, cheap half: build the skill DESCRIPTIONS
  // block once per turn (names + one-line descriptions only — bodies stay
  // on disk until load_skill fetches one). Collapses to '' when no skills
  // are installed, so the prompt placeholder costs nothing. An actor gets
  // none — its prompt is the tuned, kind-specific block, not the user's skills.
  const skillsBlock = isActor ? '' : await skillRegistry.describeForPrompt().catch((/** @type {any} */ e) => {
    console.error('[sw] skill descriptions failed', e);
    return '';
  });

  // design 01 (prompt-cache stability): the per-turn-volatile temporal + active-tab
  // bytes ride a LEADING <context> message in the stream, NOT the cached system
  // block, so the main system string stays byte-stable and its prefix caches. Built
  // here (temporalBlock + the foreground tab), handed to the loop, prepended each
  // step. An actor keeps its temporal block embedded in its own per-turn prompt
  // (see getSystemPrompt), so it takes no context message — '' skips the injection.
  // Residual invalidator: memoryBlock (above) is keyed to the LIVE foreground
  // origin, so the system prefix is byte-stable per (session x foreground
  // workspace) — a mid-session origin switch re-renders the memory block and
  // costs one cache write before it caches again. Acceptable; the volatile
  // seconds-clock (the real per-turn bust) is what moved out.
  // Interruption-recovery notices ride the same per-turn context message:
  // volatile, delivered once, never part of the cached system prefix. An
  // actor turn skips them (notices are parented to the CHAT session).
  let recoveryBlock = '';
  if (!isActor && typeof drainRecoveryNotices === 'function') {
    recoveryBlock = await Promise.resolve(drainRecoveryNotices(sessionId))
      .catch(() => '');
  }
  const contextMessage = isActor
    ? ''
    : [buildTemporalContext({ temporalBlock, activeTab: activeTabContext }), recoveryBlock]
      .filter(Boolean).join('\n\n');

  const getSystemPrompt = async () => {
    // why: re-read the session record at render time so a /system change
    // (set or clear) takes effect on the very next turn. The block is the
    // user's per-session augmentation — appended as <session_instructions>,
    // never replacing the base prompt (the base carries the security/
    // defense text). Absent → collapses to nothing. The per-change cache
    // break this causes is by design.
    const promptSession = await sessions.get(sessionId);
    // Prewalk: the planning nudge rides the prompt ONLY during the planning
    // phase. Because the prompt re-renders per turn, the executor's first
    // turn simply never contains it — the "prune the planning instruction"
    // half of the handoff falls out of the render, no history surgery.
    const prewalkBlock = !isActor && promptSession?.prewalk?.phase === 'planning'
      ? `\n\n${PREWALK_NUDGE}`
      : '';
    return (await renderSystemPrompt({
      memoryBlock,
      // design 01: the MAIN system string must be byte-stable to cache, so the
      // orchestrator's volatile temporal bytes ride a leading <context> message
      // (contextMessage below) instead of the system block. An ACTOR re-renders
      // its system prompt per turn and keeps embedding the block (relocating it
      // there too would need offscreen-worker plumbing — deferred). '' for the
      // main path collapses the {{TEMPORAL_BLOCK}} placeholder cleanly.
      temporalBlock: isActor ? temporalBlock : '',
      skillsBlock,
      customSystemPrompt: promptSession?.customSystemPrompt,
      // DESIGN-17: an actor gets a kind-specific tuned block appended (the base
      // template — incl. all the security/defense text — survives verbatim).
      // DESIGN-18: backing distinguishes a tab-backed web actor (DOM lore) from an
      // API actor (fetch-only origin lore) — both are actorType:'web'. instanceId lets
      // an API actor's lore name the ONE origin it owns.
      // PR #119: a tab web actor's action surface ('tools'|'code'), resolved by
      // buildToolContext from the setting — the prompt teaches page.* for 'code'.
      // #241: schemaReply rides the SAME stamp — buildToolContext sets it from the
      // setting that arms the reply validator, so an actor is never told to emit
      // the envelope by a build that wouldn't validate it (or vice versa).
      ...(isActor ? {
        actorType, backing: actorBacking, instanceId: actorInstanceId,
        actorSurface: toolContext.actorSurface, schemaReply: toolContext.schemaReply,
        effectiveTools: toolDescriptors.map((/** @type {any} */ tool) => tool.name),
        inbound: toolContext.inbound === true,
      } : {}),
    // why await: renderSystemPrompt is async — concatenating the un-awaited
    // promise would bake "[object Promise]" into the prompt.
    })) + prewalkBlock;
  };

  // Tool descriptors passed to the provider — name, description, and
  // JSON-schema. The Anthropic adapter rewrites these into Anthropic's
  // `tools` array shape.
  //
  // EXPOSURE CUTOVER: the MAIN agent's browser surface is message_actor (+
  // actor_list/open_tab). The low-level DOM/page tools are hidden here so a11y
  // trees, refs, and raw page content never enter the main context — they're
  // the web actor's, reached only by messaging a tab's actor. The tools stay
  // REGISTERED (listTools is full); the actor narrows from the full set via
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
  // exposure gate refuse actor-only tools the model shouldn't reach.
  //
  // DESIGN-17: an actor turn builds an 'actor' ctx instead — the keyless,
  // kind-scoped, instance-pinned tool context (buildToolContext applies the
  // capability strip + sets actorInstanceId/actorType). `synthetic` +
  // `trusted` ride onto BOTH: buildToolContext folds them into ctx.inbound, the
  // message_actor sender gate's untrusted-origin signal (synthetic AND not a
  // trusted first-party continuation → inbound → refused).
  const toolContext = await buildToolContext(isActor
    ? {
      exposure: EXPOSURE_ACTOR, sessionId, activeTabId, synthetic, trusted,
      actorInstanceId, actorType, actorBacking,
      ...(actorSurface ? { actorSurface } : {}),
    }
    : { exposure: 'main', sessionId, activeTabId, synthetic, trusted });
  // why: thread THIS turn's abort signal onto the tool ctx so a tool that can
  // block IN-BAND unwinds on Stop / the turn timeout instead of parking the
  // turn — message_actor with await:true (which resolves the actor's reply into
  // the tool result), and a headless script run. The offscreen actor path
  // already gets its own signal; this closes the same gap for the orchestrator,
  // whose awaited web delegation must stay cancellable. The controller aborts on
  // Stop (turnSlots.claim → abortController.abort()).
  toolContext.abortSignal = abortController.signal;

  // Recomputed PER STEP (the loop's refreshTools): the dweb-engagement and
  // goal cuts below change mid-turn, so the advertised list must follow.
  const refreshMainTools = async () => {
    // THIRD cut: dweb tools (publish/discover/install) only when the dweb is on.
    // Runs BEFORE the .map (which drops the `dweb` flag) so the agent never sees
    // them on the store build (DWEB_ENABLED false) or with the setting off.
    // FOURTH cut: the dweb SECONDARY tools (sovereign controls + bridge guide) stay
    // hidden until this session has CALLED a dweb tool — engagement, not the
    // always-on network's peer presence. Composes after the dweb-enabled gate.
    // FIFTH cut: goal mode. complete_goal is registered always but revealed to
    // the model ONLY while a goal run is live for this session (goalActiveFor),
    // so a normal chat never sees it. Outermost so it composes over the rest.
    // SIXTH cut (DESIGN-17): the actor surface. The actor-only instance tier
    // (writes AND the fenced reads) LEAVES the main agent (it delegates via
    // message_actor, which it keeps). Outermost so it composes over everything.
    const descriptors = filterActorSurface(
      filterByGoalActive(
        filterByDwebActive(
          filterByDwebEnabled(
            filterDescriptorsByManifest(mainAgentDescriptors(listTools()), sessionToolAllow),
            DWEB_ENABLED && !!settingsStore.get().dwebEnabled,
          ),
          dwebEngagedSessions.has(sessionId),
        ),
        !!goalActiveFor?.(sessionId),
      ),
    ).map((/** @type {any} */ t) => ({ name: t.name, description: t.description, schema: t.schema }));
    return descriptors;
  };
  // DESIGN-17: an actor sees a FIXED set — its own kind's toolset (no
  // progressive disclosure; the actor gate is the wall). REPLACE both the
  // initial descriptors AND the per-step refresh below — otherwise the actor
  // would lose all its instance tools on step 2+. Intersected with the actor's
  // inherited tool MANIFEST (sessionToolAllow, above) so the list is honest: a
  // browse-only chat's web actor is shown only the read DOM tools, matching the
  // gate (which refuses click/type for it). null manifest passes through unchanged.
  const refreshActorTools = async () => {
    const descriptors = filterDescriptorsByManifest(
      actorDescriptors(listTools(), actorType, actorBacking, toolContext.actorSurface),
      sessionToolAllow,
    );
    const inboundAllowed = new Set(DWEB_INBOUND_TOOL_NAMES);
    return (toolContext.inbound === true && actorType === 'dweb'
      ? descriptors.filter((/** @type {any} */ tool) => inboundAllowed.has(tool.name))
      : descriptors)
      .map((/** @type {any} */ t) => ({ name: t.name, description: t.description, schema: t.schema }));
  };
  const refreshTools = isActor ? refreshActorTools : refreshMainTools;
  const toolDescriptors = await refreshTools();
  const toolDispatch = async (/** @type {any} */ call) => {
    // The descriptor filter is model guidance; this is the in-SW fallback's
    // authority wall. A remote-peer wake may use only the positive inbound
    // dweb subset even if it forges a hidden tool name.
    if (!inboundActorCallAllowed({
      isActor, inbound: toolContext.inbound === true, actorType, name: call?.name,
    })) {
      return { ok: false, error: `tool_not_available_to_inbound_actor: ${call?.name}` };
    }
    // DESIGN-17 per-instance pin: force an actor's instance-target arg to its
    // BOUND instance before dispatch, so it can only ever touch its own (the gate
    // is the backstop). Runs first — before the gate chain sees the args.
    if (isActor) pinActorCall(call, actorType, actorInstanceId);
    // Engagement trigger: any dweb tool call marks the session dweb-engaged, so
    // refreshMainTools reveals the SECONDARY dweb tools on the next step. The
    // entry tools (discover/share/install) are dweb_* too, so the first one the
    // agent calls flips it — dweb_discover is the natural opener.
    if (typeof call?.name === 'string' && call.name.startsWith('dweb_')) markDwebEngaged(sessionId);
    const result = await dispatchToolCall(call, /** @type {any} */ (toolContext));
    // If a CDP-backed tool reported the debugger isn't available, surface a
    // one-time "enable advanced automation" nudge to the side panel.
    maybeNudgeDebuggerGrant(result);
    // Prewalk swap gate: a successful mutating call while the session is in
    // its planning phase may flip it to 'executing' (the model swap itself
    // applies at the next turn's reconcile). Awaited so the phase write can't
    // race this turn's remaining dispatches; a gate failure never breaks the
    // tool result. Main turns only — actors have no prewalk state.
    if (!isActor && typeof maybePrewalkSwap === 'function') {
      try { await maybePrewalkSwap({ sessionId, name: call?.name, ok: /** @type {any} */ (result)?.ok === true }); }
      catch (e) { console.warn('[turn] prewalk swap gate failed', e); }
    }
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
  /** @type {{ messages: any[], usage: any } | null} */
  let turnSnapshot = null;
  // Turn outcome, returned so an outer driver (goal mode — loop/goal-runner.js)
  // can tell a clean turn from a failed/aborted one instead of blindly
  // re-entering. lastStopReason is captured BEFORE the panel guard below (the
  // 'stop' case in the switch only runs when the UI is connected).
  let lastStopReason = null;
  let turnOk = true;
  // Cost/usage accumulation for this turn (feature 06) — the fold/persist/
  // push/halt logic lives in makeTurnCostTracker (peerd-runtime/cost); the
  // SW supplies the IO: persist via sessions.setCost, the live meter via
  // the side-panel port, and the hard-limit halt via THIS turn's
  // AbortController (same clean-abort path as Stop / steer-live, so the
  // loop unwinds through its existing branch — persists partial, yields
  // stopReason='aborted').
  // why: reuse the record resolved at turn start (also the kind source) — a
  // actor is a SEPARATE session, so makeTurnCostTracker's per-session limitUsd
  // gives N actors N independent caps (the documented P0 cost posture).
  const costSession = turnSession;
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
      // DESIGN-17 P1: surface an actor turn's spend on its card — delegated work
      // is not free. Caps stay per-session (the spec's posture); this only makes the
      // spend VISIBLE. info.turn is THIS exchange's tally (the actor accumulates
      // across messages; the card shows just this turn).
      if (actorDisplay) {
        uiPorts.broadcast(/** @type {any} */ ({ type: 'turn/actor-cost', parentToolUseId: actorDisplay.parentToolUseId, cost: info.turn }));
      }
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
    // Pin the first candidate to the persisted turn record. The loop normally
    // forwards those same values, but the in-SW actor is not a trust boundary:
    // it must not select another keyed adapter by colliding with broker fields.
    // Later calls stay on a successful failover candidate for this turn.
    const start = failoverLastGood ?? {
      provider: costSession?.provider ?? modelArgs.provider,
      model: costSession?.model ?? modelArgs.model,
    };
    const chain = resolveFailoverChain(start);
    // The context inspector sees main turns and the bound-actor in-SW
    // fallback here. Offscreen actors use the actor/model-call relay; spawned
    // in-SW children use their capped wrapper.
    // record() is contractually non-throwing; label with the provider the
    // call will actually start on.
    recordModelCall({
      ...modelArgs,
      provider: start.provider,
      model: start.model,
      sessionId,
      label: isActor ? `actor ${actorType ?? 'bound'} (in-SW)` : 'main',
    });
    // why: the Ollama adapter reads `ollamaHost` to reach a remote daemon (issue
    // #104). Thread it from settings for every candidate; non-ollama adapters
    // ignore the extra arg. (The configured host is also on the egress allowlist.)
    const ollamaHost = settingsStore.get().ollamaHost;
    let lastErr;
    for (let i = 0; i < chain.length; i++) {
      const cand = chain[i];
      let streamedContent = false;
      try {
        // The loop forwards its credential fields with every model call. For
        // an in-SW actor those fields are throwing stubs, so all broker-owned
        // fields must come AFTER modelArgs. Reversing this order lets the loop
        // change credential custody, provider choice, or cancellation.
        for await (const ev of callModel({
          ...modelArgs,
          ollamaHost,
          provider: cand.provider,
          model: cand.model,
          signal: abortController.signal,
          getSecret,
          safeFetch,
        })) {
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
        const aborted = abortController.signal.aborted
          || (/** @type {{ name?: string }} */ (e))?.name === 'AbortError';
        // Can't fail over once real output streamed (would duplicate it);
        // the PRIMARY only triggers a switch on a failover-worthy error,
        // while a fallback already in the chain is advanced on any pre-stream
        // failure (a backup that's also down/keyless shouldn't dead-end).
        // A Stop is never provider unavailability. Refuse to read another
        // provider key or emit a misleading failover note after cancellation.
        if (aborted || streamedContent || isLast) throw e;
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
      // why: an actor's reply-wake carries WHO replied so the chat can render
      // it as its own attributed bubble — `synthetic` alone also marks hidden
      // plumbing turns (resume/truncation nudges) and can't be un-hidden.
      ...(actorReply ? { actorReply } : {}),
      // why: auto-resume (maybeAutoResume) re-drives a turn the SW reclaimed
      // mid-flight — no new user message; the loop continues the persisted
      // history. Normal sends pass resume=false.
      resume,
      // design 01: the per-turn ephemeral <context> message (temporal + active
      // tab), prepended as message[0] each step. '' (actors) → the loop's own
      // length>0 guard skips the injection.
      contextMessage,
      // why: already validated + shaped by loop/attachments.js in
      // agent/send (text payloads inlined there). The loop ships the
      // bytes this turn and persists the stripped metadata shape.
      ...(attachments ? { attachments } : {}),
      // why: the failover wrapper, not the bare registry callModel — so a
      // persistently-overloaded or out-of-credit provider switches to a
      // configured fallback mid-turn instead of failing the whole turn.
      callModel: callModelWithFailover,
      // Bound actors on the in-SW fallback get throwing stubs. Main turns keep
      // the live functions. callModelWithFailover brokers the real credentials
      // at the provider boundary for both paths.
      ...loopCredentials,
      sessions,
      getSystemPrompt,
      appendAudit: /** @type {any} */ (auditLog.append),
      tools: toolDescriptors,
      // why: the loop calls this each step to get the current tool list, so a
      // mid-turn exposure change (dweb engagement, goal start/stop) shows on
      // the next step. An actor uses a fixed-set refresh (the gate is the wall).
      refreshTools,
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
      // why: one-shot actor delegations (message_actor oneShot) — after the first
      // clean tool round the loop synthesizes the reply from the result and stops,
      // skipping the redundant summarize inference. false for every normal turn.
      oneShot,
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
      // Capture the final stop reason for the return value BEFORE the panel
      // guard (the switch's 'stop' case is panel-only). 'aborted' here = Stop /
      // steer / a spend-limit halt — an outer goal loop must not re-drive it.
      if (ev.type === 'stop') lastStopReason = ev.stopReason;
      // The production loop turns provider failures into stream events. Fold
      // their outcome before the UI guard so background and Goal turns fail
      // even when no panel is connected.
      if (ev.type === 'error') turnOk = false;
      if (!uiConnected()) continue;
      switch (ev.type) {
        case 'state':
          lastSession = ev.session;
          uiPorts.broadcast({ type: 'turn/state', session: ev.session });
          // Glass pane: the full actor-session snapshot drives the inline card
          // (collapsed, per-step — not per-delta, to keep the actor's micro-
          // actions low-noise as the spec's display stream prescribes). Carry the
          // card meta (fromIndex/kind/…) too, so a panel that connects mid-turn and
          // MISSED turn/actor-start can still self-seed the card from this push.
          if (actorDisplay) uiPorts.broadcast({ type: 'turn/actor-state', parentToolUseId: actorDisplay.parentToolUseId, session: ev.session, fromIndex: displayFromIndex, kind: actorDisplay.kind, instanceId: actorDisplay.instanceId, name: actorDisplay.name });
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
          if (actorDisplay) uiPorts.broadcast({ type: 'turn/actor-error', parentToolUseId: actorDisplay.parentToolUseId, sessionId: ev.sessionId, error: ev.error });
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
      : e instanceof ActorCredentialBoundaryError ? ACTOR_CREDENTIAL_BOUNDARY_FAILURE
      : (/** @type {{ message?: string }} */ (e))?.message ?? 'unknown-error';
    turnOk = false;
    if (uiConnected()) {
      uiPorts.broadcast({ type: 'turn/error', sessionId, error });
      // Glass pane: a LOOP-level failure (provider error etc.) never reached the
      // stream's 'error' case, so the actor card would otherwise close as 'ok'.
      // Surface it as a failed card.
      if (actorDisplay) uiPorts.broadcast({ type: 'turn/actor-error', parentToolUseId: actorDisplay.parentToolUseId, sessionId, error });
    }
  } finally {
    // release() drains the next queued wake synchronously. An opted-in caller
    // therefore gets an immutable transcript + exact turn-usage snapshot while
    // this claim still owns the slot; a later read could include turn B in turn
    // A's reply or contribution. The extra IDB read is actor-only and opt-in.
    if (captureTurnSnapshot === true) {
      try {
        const settled = await sessions.get(sessionId);
        turnSnapshot = {
          messages: [...(settled?.messages ?? [])],
          usage: { ...costTracker.turn() },
        };
      } catch (e) { console.warn('[turn] pre-release snapshot failed', e); }
    }
    // A shell may also need to atomically consume in-memory turn state (for
    // example an origin-lock stop report) before the next wake clears it.
    if (typeof onBeforeRelease === 'function') {
      try { await onBeforeRelease(); }
      catch (e) { console.warn('[turn] pre-release snapshot failed', e); }
    }
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
      // Glass pane: close the actor card's live state (stops its spinner). An
      // ABORT (Stop cascade / spend-limit) yields a clean stopReason='aborted' with
      // turnOk still true, so carry `aborted` explicitly — the reducer renders it as
      // a 'cancelled' card (not a misleading green 'ok'). ok=false marks a failure.
      if (actorDisplay) uiPorts.broadcast({ type: 'turn/actor-done', parentToolUseId: actorDisplay.parentToolUseId, sessionId, ok: turnOk, aborted: lastStopReason === 'aborted' });
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
  // why: the outcome lets goal mode stop on a failed/aborted turn rather than
  // re-driving a broken condition up to the cap. Normal sends ignore it.
  return {
    ok: turnOk,
    stopReason: lastStopReason,
    ...(turnSnapshot ? { turnSnapshot } : {}),
  };
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
    // Don't double-drive a session a Goal run owns: goalRunner.resume() re-drives
    // its OWN interrupted turn after an SW respawn, so auto-resume firing for the
    // same session would contend the turn slot (a spurious aborted turn / a
    // narrowly-windowed goal-run halt). The goal loop is the authority here.
    if (goalActiveFor?.(sessionId)) return;
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
