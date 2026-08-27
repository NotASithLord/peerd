// @ts-check
// peerd-runtime/loop/turn-authority-driver — the service-worker turn shell.
// makeTurnAuthorityDriver(deps) returns { runAgentTurn, maybeAutoResume }; every
// privileged IO is INJECTED (functional-core/imperative-shell) so the authority
// orchestration can be unit-tested with fakes. Pure permission, spend-limit and
// replay policy live beside this shell instead of arriving through the semantic
// owner.
//
// why inject privileged dependencies: runAgentTurn closes over the SW's live
// instance graph (vault, sessions, ports and exact tool custody). Injection
// keeps this module browser-free and testable without hiding authority behind a
// generic callback surface.
//
import {
  ActorCredentialBoundaryError, ACTOR_CREDENTIAL_BOUNDARY_FAILURE, SessionNotFoundError,
} from '../errors.js';
import {
  actorIsolationForTurn,
} from '../actor/isolation.js';
import { classifyBrowserAutomationTarget } from '../tools/browser-automation-policy.js';
import { findDenylistMatch } from '../../peerd-egress/denylist/denylist.js';
import { decideAction } from '../permissions/policy.js';
import { makeTurnCostTracker } from '../cost/turn-tracker.js';
import { detectInterruptedTurn } from './resume-detect.js';
import {
  CONTROLLER_AUTHORITY_MANIFEST,
  controllerAuthorityClassAllowed,
} from '../../shared/controller-authority-manifest.js';
import { toolExecutionResultAllowed } from '../../shared/tool-execution-protocol.js';

const UNKNOWN_TURN_ERROR = 'Turn outcome unknown. Check the session before retrying.';
const providerFailureFrom = (/** @type {unknown} */ value) => {
  if (typeof value !== 'string') return null;
  if (value === 'provider-key-missing' || value === 'unknown-provider'
      || /^provider-http-[1-5][0-9]{2}$/.test(value)
      || value === 'provider-usage-limit'
      || value.startsWith('provider-usage-limit: ')) return value;
  return null;
};

/**
 * Reduce the foreground tab to safe, minimal prompt context.
 * @param {{ url?: string } | null | undefined} tab
 * @param {readonly string[]} denylist
 * @returns {{ workspace: string, activeTab: { url: string, title: string } | null, protectedTab: 'private_network'|'sensitive_site'|null }}
 */
export const safeForegroundTabContext = (tab, denylist = []) => {
  const verdict = classifyBrowserAutomationTarget(tab?.url);
  if (!verdict.allowed) {
    const protectedTab = verdict.reason === 'private_network' || verdict.reason === 'cloud_metadata'
      ? 'private_network'
      : null;
    return { workspace: '', activeTab: null, protectedTab };
  }
  let hostname = '';
  try { hostname = new URL(/** @type {string} */ (tab?.url)).hostname; } catch {
    return { workspace: '', activeTab: null, protectedTab: null };
  }
  if (findDenylistMatch(hostname, denylist)) {
    return { workspace: '', activeTab: null, protectedTab: 'sensitive_site' };
  }
  // Origin only. Paths and titles are page-controlled and can contain reset
  // tokens, private document names, newlines, or prompt-fence text.
  return {
    workspace: verdict.origin,
    activeTab: { url: verdict.origin, title: '' },
    protectedTab: null,
  };
};

export const makeTurnAuthorityDriver = (/** @type {any} */ deps) => {
  const {
    vault, VaultLockedError, sessionCache, ensureActiveProvider, resolvePermission,
    sessions, turnSlots, memory, browser,
    skillRegistry, renderSystemPrompt, buildToolContext,
    settingsStore, DWEB_ENABLED, goalActiveFor,
    dwebEngagedSessions, prepareToolCall, settleToolCall,
    uiConnected, uiPorts, auditLog,
    postChatNote, runUserTurn,
    trimEnricher,
    getDenylist = () => [],
    // Prewalk (loop/prewalk.js), both optional so actor/test drivers stay
    // inert: reconcilePrewalk applies a pending planning→executing model swap
    // (or restores stale state) at the TURN boundary — before pricing,
    // context-window and reasoning resolve, so all three see the swapped
    // model; maybePrewalkSwap is the per-tool-call gate that flips the phase.
    reconcilePrewalk = null,
    // Engine-actor prewalk: swaps a VM/Notebook/App actor to its cheap executor
    // from its second turn onward. Optional so actor/test drivers stay inert.
    reconcileEngineActor = null,
    // Lifecycle recovery notices (lifecycle/boot.js drainNoticesFor):
    // read-once per session, folded into the leading <context> message so the
    // AGENT hears the same §14 semantic distinction the user's chat note
    // carried — including the do-not-repeat instruction for outcome_unknown.
    // Optional so actor/test drivers stay inert.
    drainRecoveryNotices = null,
    // Live execution-boundary capability. Null keeps older test harnesses inert.
    getActorIsolation = () => null,
    // The service-worker shell hydrates durable actor-host health before a
    // turn may snapshot it. Tests and non-browser callers stay synchronous.
    waitForActorIsolation = async () => {},
    getRuntimeCapabilities = () => null,
    // The controller is the sole owner of inventory and exposure semantics.
    // The driver never reconstructs a local fallback from an authority graph.
    projectToolDescriptors,
  } = deps;

/**
 * Run one user turn. Lazily creates a session on first send. Streams
 * deltas to the side panel via the port (separate channel from the
 * state pushes so the UI can incrementally update without re-rendering
 * the whole session shape).
 */
const runAgentTurn = async (/** @type {any} */ { userText, attachments = null, sessionId: targetSessionId = null, synthetic = false, trusted = false, resume = false, activeTabId = null, oneShot = false, actorReply = null, captureTurnSnapshot = false, onBeforeRelease = null, turnLease = null }) => {
  if (vault.isLocked()) throw new VaultLockedError();
  // why before session work: a cold background page starts fail-closed while
  // durable actor-host health loads. Sampling that sentinel would falsely tell
  // the model actors are unavailable and can consume a mailbox wake for good.
  await waitForActorIsolation();
  const lifecycleTurnId = crypto.randomUUID();

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
  const isActorSession = turnSession?.kind === 'actor';
  const isSpawnedSession = turnSession?.kind === 'spawned';
  // Defensive backstop for auto-resume and any future caller: actor sessions
  // are driven only by the dedicated-worker host. Reaching this in-background
  // turn driver is a refusal, never a degraded execution mode.
  if (isActorSession || isSpawnedSession) {
    auditLog.append({
      type: 'actor_background_turn_refused',
      sessionId,
      details: { reason: 'dedicated_worker_required', performed: false },
    }).catch(() => {});
    releaseTurnSlot();
    return;
  }
  // why snapshot: an unavailable boundary stays unavailable to the model for
  // this whole turn even if a user retry repairs it mid-turn. That keeps the
  // system prompt, descriptor list, and dispatch story coherent. A boundary
  // that fails after the turn starts can still remove tools immediately.
  const actorIsolationAtTurnStart = getActorIsolation();
  const effectiveActorIsolation = () =>
    actorIsolationForTurn(actorIsolationAtTurnStart, getActorIsolation());
  // The prompt and tool descriptors for one model step must describe one
  // isolation state. refreshMainTools advances this snapshot only after it has
  // built the matching descriptor list. Dispatch still checks live state and
  // fails closed if the worker boundary changes after the model call starts.
  let actorIsolationForModelStep = effectiveActorIsolation();
  // Build the per-turn temporal block: absolute now + a coarse, plain-
  // words elapsed since the user's previous message (only when the gap
  // is non-trivial). prevTurnAt lives in chrome.storage.session
  // (survives SW restart, dies on browser restart) and bumps to now()
  // so the *next* turn measures from here. First turn: prevTurnAt is
  // undefined → just the absolute timestamp.
  const TURN_AT_KEY = `turn.lastAt.${sessionId}`;
  const prevTurnAt = await sessionCache.sessionGet(TURN_AT_KEY);
  const turnNow = Date.now();
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
  /** @type {'private_network'|'sensitive_site'|null} */
  let protectedTabContext = null;
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    const safeTab = safeForegroundTabContext(activeTab, getDenylist());
    activeTabContext = safeTab.activeTab;
    protectedTabContext = safeTab.protectedTab;
    const loaded = await memory.loadAlwaysLoaded({ workspace: safeTab.workspace });
    memoryBlock = loaded.text;
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

  // design 01 (prompt-cache stability): the per-turn-volatile temporal + active-tab
  // values ride to the sealed controller as exact projections. The controller
  // renders the LEADING <context> message beside the semantic loop, so the main
  // system string stays byte-stable and its prefix caches.
  // Residual invalidator: memoryBlock (above) is keyed to the LIVE foreground
  // origin, so the system prefix is byte-stable per (session x foreground
  // workspace) — a mid-session origin switch re-renders the memory block and
  // costs one cache write before it caches again. Acceptable; the volatile
  // seconds-clock (the real per-turn bust) is what moved out.
  // Interruption-recovery notices ride the same per-turn context message:
  // volatile, delivered once, never part of the cached system prefix.
  let recoveryBlock = '';
  if (typeof drainRecoveryNotices === 'function') {
    recoveryBlock = await Promise.resolve(drainRecoveryNotices(sessionId))
      .catch(() => '');
  }
  const runtimeCapabilities = getRuntimeCapabilities();
  // Snapshot session-authored prompt inputs once per turn. The controller
  // owns all model-facing composition; authority supplies only bounded state
  // projections. Actor-host availability remains live per model step so a
  // failed boundary can immediately correct the next prompt and tool surface.
  const promptSession = await sessions.get(sessionId);
  const promptContext = Object.freeze({
    memoryBlock,
    // design 01: the MAIN system string must be byte-stable to cache, so the
    // orchestrator's volatile temporal bytes ride a leading <context> message.
    temporalBlock: '',
    skillsBlock,
    customSystemPrompt: promptSession?.customSystemPrompt,
    appRole: promptSession?.appRole,
    prewalkPlanning: promptSession?.prewalk?.phase === 'planning',
    runtimeCapabilities,
  });
  const getSystemPrompt = () => renderSystemPrompt({
    ...promptContext,
    actorIsolation: actorIsolationForModelStep,
  });

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
  const turnPermission = await resolvePermission(manifestSession);

  const toolContextArgs = {
    exposure: 'main', sessionId, activeTabId, synthetic, trusted,
    lifecycleTurnId, lifecycleUserInitiated: synthetic !== true,
  };
  /** @type {Promise<any>|null} */
  let toolContextReady = null;
  const getToolContext = () => {
    toolContextReady ??= Promise.resolve(buildToolContext(toolContextArgs)).then((context) => {
      context.permission = turnPermission;
      context.abortSignal = abortController.signal;
      return context;
    });
    return toolContextReady;
  };
  /** @type {Map<string,any>} */
  let currentToolDescriptorsByName = new Map();

  // Recomputed PER STEP (the loop's refreshTools): the dweb-engagement and
  // goal cuts below change mid-turn, so the advertised list must follow.
  const refreshMainTools = async () => {
    const isolation = effectiveActorIsolation();
    if (typeof projectToolDescriptors !== 'function') {
      throw new TypeError('controller tool projection unavailable');
    }
    const descriptors = await projectToolDescriptors({
      surface: 'main', toolManifest: manifestSession?.toolManifest,
      dwebEnabled: DWEB_ENABLED && !!settingsStore.get().dwebEnabled,
      dwebEngaged: dwebEngagedSessions.has(sessionId),
      goalActive: !!goalActiveFor?.(sessionId),
      actorIsolation: isolation, runtimeCapabilities,
    });
    currentToolDescriptorsByName = new Map(descriptors.map(
      (/** @type {any} */ descriptor) => [descriptor.name, descriptor],
    ));
    actorIsolationForModelStep = isolation;
    return descriptors;
  };
  const refreshTools = refreshMainTools;
  const toolDescriptors = await refreshTools();
  const toolExecution = typeof prepareToolCall === 'function'
    && typeof settleToolCall === 'function' ? Object.freeze({
      prepare: async (/** @type {any} */ call, /** @type {any} */ binding) => {
        const authorityClass = binding?.authorityClass;
        if (!controllerAuthorityClassAllowed(authorityClass)) return null;
        const toolContext = await getToolContext();
        const prepared = await prepareToolCall(call, toolContext, binding?.descriptor);
        if (prepared?.prepared !== true) return { mode: 'result', result: prepared };
        const projection = authorityClass === 'actor'
          ? {
              sessionId: toolContext.session?.sessionId,
              sessionDepth: toolContext.session?.depth ?? 0,
              sessionKind: toolContext.session?.kind ?? 'chat',
              inbound: toolContext.inbound === true,
            }
            : authorityClass === 'repository'
              ? {
                sessionId: toolContext.session?.sessionId,
                actorType: toolContext.actorType,
                actorInstanceId: toolContext.actorInstanceId,
              }
            : authorityClass === 'persistence'
              ? {
                sessionId: toolContext.session?.sessionId,
                activeTabOrigin: toolContext.activeTab?.origin,
                goalActive: !!toolContext.todoStore,
              }
              : authorityClass === 'resource'
                ? {
                  sessionId: toolContext.session?.sessionId,
                  runtimeCapabilities: toolContext.runtimeCapabilities,
                }
              : authorityClass === 'execution'
                ? {
                  sessionId: toolContext.session?.sessionId,
                  sessionKind: toolContext.session?.kind ?? 'chat',
                }
              : authorityClass === 'introspection'
                ? {
                  sessionId: toolContext.session?.sessionId,
                  messageCount: toolContext.session?.messageCount ?? 0,
                  trimCovered: toolContext.session?.trimCovered ?? 0,
                }
                : authorityClass === 'dweb'
                  ? {
                    sessionId: toolContext.session?.sessionId,
                    dwebAvailable: toolContext.dweb != null,
                  }
                  : ['pod', 'vm', 'notebook', 'app', 'page', 'siteclient', 'schedule']
                      .includes(authorityClass)
                    ? { sessionId: toolContext.session?.sessionId }
                    : {};
        return {
          mode: 'execute',
          // why ctx is explicit: the controller bridge binds finite named
          // authority methods from this in-memory custody object. Keeping it
          // only inside `prepared` made every production domain binder see an
          // empty context even though settlement still had the full record.
          custody: { prepared, authorityClass, ctx: prepared.ctx },
          args: prepared.args,
          projection,
          manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
        };
      },
      settle: async (/** @type {any} */ custody, /** @type {any} */ reported) => {
        const policy = CONTROLLER_AUTHORITY_MANIFEST.tools[custody?.authorityClass];
        if (!policy || !toolExecutionResultAllowed(reported, policy.resultBytes)) {
          throw new Error('tool execution result is invalid');
        }
        const result = reported.ok === true ? reported.value : {
          ok: false,
          error: reported.error ?? reported.code,
          code: reported.code,
          outcomeKnown: reported.outcomeKnown,
          retryable: reported.retryable,
          outcomeKind: reported.outcomeKnown === true
            ? 'pre-effect-failure' : 'host-lost',
        };
        return settleToolCall(custody.prepared, { result });
      },
    }) : null;
  // why: the loop's concurrent-dispatch scheduler partitions a multi-tool
  // turn by the SAME decideAction policy the dispatcher enforces — READ-
  // class calls (which never confirm) may run concurrently; anything that
  // writes or would need a confirmation round-trip stays serial, so two
  // side effects can't interleave and confirm modals never stack.
  const classifyToolCall = (/** @type {string} */ name) => {
    const tool = currentToolDescriptorsByName.get(name);
    if (!tool) return null;
    return decideAction({
      mode: /** @type {any} */ (turnPermission?.mode),
      confirmActions: turnPermission?.confirmActions,
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
  // why: reuse the record resolved at turn start instead of reading the
  // session again at the accounting boundary.
  const costSession = turnSession;
  const costTracker = makeTurnCostTracker({
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
      previousTurnAt: typeof prevTurnAt === 'number' ? prevTurnAt : null,
      turnNow,
      activeTabContext,
      protectedTabContext,
      recoveryBlock,
      // why: already validated + shaped by loop/attachments.js in
      // agent/send (text payloads inlined there). The loop ships the
      // bytes this turn and persists the stripped metadata shape.
      ...(attachments ? { attachments } : {}),
      // Provider selection, failover, encoding, and response interpretation
      // are controller semantics. The worker passes only user configuration;
      // the controller proposes a finite plan that model authority pins before
      // the first egress request.
      providerFailoverEnabled: settingsStore.get().providerFailoverEnabled === true,
      providerFallbacks: Array.isArray(settingsStore.get().providerFallbacks)
        ? [...settingsStore.get().providerFallbacks] : [],
      // Only orchestrator turns reach this driver. Actor sessions are refused
      // above and use the dedicated-worker host.
      sessions,
      getSystemPrompt,
      appendAudit: /** @type {any} */ (auditLog.append),
      postChatNote,
      tools: toolDescriptors,
      runtimeCapabilities,
      // why: the loop calls this before each model step, then re-renders the
      // system prompt against the isolation snapshot selected here. Mid-turn
      // exposure changes therefore update the prompt and tools together.
      refreshTools,
      ...(toolExecution ? { toolExecution } : {}),
      classifyToolCall,
      // Reasoning normalization is provider/model semantics. Authority passes
      // only the user settings snapshot; the sealed controller applies its
      // fixed budget and accepted effort vocabulary before model egress.
      reasoningEnabled: settingsStore.get().reasoningEnabled === true,
      reasoningEffort: settingsStore.get().reasoningEffort,
      signal: abortController.signal,
      // Long-session compression: when the history trim drops NEW
      // messages, the loop fires this (never awaited). We only queue;
      // the cheap summarisation call runs in the finally below, AFTER
      // the stream ends, so it can't race the turn's session writes.
      enrichTrimSummary: (/** @type {any} */ req) => trimEnricher.queue(/** @type {any} */ (req)),
      // Model-window metadata and provider response interpretation are sealed
      // controller semantics. The worker supplies only the user's overrides;
      // the controller reads a bounded provider projection through model egress.
      contextWindowOverrides: settingsStore.get().contextWindowOverrides,
      // Pricing tables and provider-local classification are model semantics.
      // The sealed controller prices each provider usage event; the SW only
      // validates/folds that bounded amount and retains spend-limit custody.
      pricingOverrides: settingsStore.get().pricingOverrides,
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
          {
          const outcomeUnknown = ev.outcomeKnown === false;
          const visibleError = outcomeUnknown
            ? UNKNOWN_TURN_ERROR
            : ev.error;
          uiPorts.broadcast({
            type: 'turn/error',
            sessionId: ev.sessionId,
            messageId: ev.messageId,
            error: visibleError,
            ...(typeof ev.code === 'string' ? { code: ev.code } : {}),
            ...(typeof ev.outcomeKnown === 'boolean' ? { outcomeKnown: ev.outcomeKnown } : {}),
            ...(outcomeUnknown ? { retryable: false } : {}),
          });
          }
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
    const detail = /** @type {{code?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (e);
    const providerFailure = providerFailureFrom(detail?.code);
    const technicalError = providerFailure
      ?? (e instanceof SessionNotFoundError ? 'session-not-found'
      : e instanceof ActorCredentialBoundaryError ? ACTOR_CREDENTIAL_BOUNDARY_FAILURE
      : (/** @type {{ message?: string }} */ (e))?.message ?? 'unknown-error');
    const outcomeUnknown = detail?.outcomeKnown === false;
    const error = outcomeUnknown ? UNKNOWN_TURN_ERROR : technicalError;
    turnOk = false;
    let messageId;
    if (outcomeUnknown) {
      try {
        const durable = await sessions.get(sessionId);
        const trailing = [...(durable?.messages ?? [])].reverse().find(
          (message) => message?.role === 'assistant' && message?.streaming === true,
        );
        if (typeof trailing?.id === 'string') {
          messageId = trailing.id;
          lastSession = await sessions.updateAssistantMessage(sessionId, messageId, {
            streaming: false,
            error,
            ...(typeof detail?.code === 'string' ? { errorCode: detail.code } : {}),
            outcomeKnown: false,
            retryable: false,
          });
          if (uiConnected()) uiPorts.broadcast({ type: 'turn/state', session: lastSession });
        }
      } catch {}
    }
    if (uiConnected()) {
      uiPorts.broadcast({
        type: 'turn/error', sessionId, messageId, error,
        ...(typeof detail?.code === 'string' ? { code: detail.code } : {}),
        ...(typeof detail?.outcomeKnown === 'boolean' ? { outcomeKnown: detail.outcomeKnown } : {}),
        ...(outcomeUnknown ? { retryable: false } : {}),
      });
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
    }
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
