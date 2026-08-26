// @ts-check
// background/offscreen-actor-client.js: the privileged-host client for EVERY isolated
// agent loop (the heap split): ephemeral spawned reasoners (spawn.js) AND bound
// actors (the actor turn). Provider semantics stay in the isolated Worker; this
// client exposes exact inference open/read/cancel authority plus the existing
// tool-dispatch and loop-event routes.
//
// The security-critical route is 'actor/tool-dispatch': the worker's loop asks to run
// a tool; THIS builds the actor's instance-PINNED, gated tool context and dispatches
// there — the pin, the gate, the engine clients, the tabs, and the audit are ALL
// SW-side. It NEVER trusts the worker's call args (they may derive from injected
// instance/page output): it re-pins the bound instance and runs the full gate,
// with the same policy on every browser host.
//
// Pure shell — every IO injected — so it is unit-testable without a browser.

import { controllerToolDomain, CONTROLLER_TOOL_MANIFEST } from '/shared/controller-tool-manifest.js';
import { legacyToolAllowed } from '/shared/legacy-tool-allowlist.js';
import { structuredClonePayloadBytes } from '/shared/structured-clone-size.js';
import { parsePodShell, podGitRemoteIntents } from '/peerd-engine/authority.js';
import { createRepositoryToolAuthority } from './repository-tool-authority.js';
import { createVmToolAuthority } from './vm-tool-authority.js';
import { createNotebookToolAuthority } from './notebook-tool-authority.js';

const exactKeys = (
  /** @type {unknown} */ value, /** @type {readonly string[]} */ required,
  /** @type {readonly string[]} */ optional = ['relayToken'],
) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = /** @type {Record<string,unknown>} */ (value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
};

const sameClone = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
};

// An inbound dweb wake is reasoning over bytes chosen by a remote peer. Keep its
// useful read/moderation surface, but do not advertise any operation that can
// delegate, spend, sign/publish, install peer code, or change standing network
// policy. This is a POSITIVE set so a future dweb capability lands unavailable to
// inbound turns until somebody deliberately classifies it here.
/**
 * @param {Object} deps
 * @param {() => Promise<void>} [deps.ensureHost]
 * @param {() => Promise<void>} [deps.ensureOffscreen] legacy Chrome host alias
 * @param {(msg: object) => Promise<any>} deps.sendMessage
 * @param {(job: object, options: { signal?: AbortSignal, relay: (type: string, payload: any) => any|Promise<any> }) => Promise<any>} [deps.runOnChannel]
 * @param {{
 *   openInference:(input:unknown,grant:object)=>Promise<any>,
 *   readInferenceChunk:(input:unknown,grant:object)=>Promise<any>,
 *   cancelInference:(input:unknown,grant:object)=>Promise<any>,
 *   readModelContext:(input:unknown,grant:object)=>Promise<any>,
 *   openLocalGeneration:(input:unknown,grant:object)=>Promise<any>,
 *   readLocalGeneration:(input:unknown,grant:object)=>Promise<any>,
 *   cancelLocalGeneration:(input:unknown,grant:object)=>Promise<any>,
 *   closeOwner:(owner:object)=>Promise<void>,
 * }} deps.providerEgress
 * @param {{ get: (id: string) => Promise<any> }} deps.sessions
 * @param {(opts: object) => Promise<object>} deps.buildToolContext
 * @param {(call: object, ctx: object) => Promise<any>} deps.dispatchToolCall
 * @param {(call: object, ctx: object) => Promise<any>} [deps.prepareToolCall]
 * @param {(prepared: object, execution: object) => Promise<any>} [deps.settleToolCall]
 * @param {(call: any, actorType: string|undefined, instanceId: string|undefined) => void} deps.pinActorCall
 * @param {(ctx: any, allowedNames: Set<string>) => any} [deps.restrictCtxCapabilities]  phase 4:
 *   strip an actor ctx down to the capabilities its GRANTED tools need (capability-by-need),
 *   the analog of the actor's kind-scoped strip. Required to run tool-bearing spawned offscreen.
 * @param {(actorSessionId: string) => (number | undefined)} [deps.ownedTabFor]  a
 *   tab-backed WEB actor's currently-owned tab id (phase 3) — read per dispatch so a
 *   mid-turn navigate that adopts a tab (0→1) is seen by the NEXT tool call. undefined
 *   for engine/API actors (no tab) and the 0-tab web state.
 * @param {string} deps.EXPOSURE_ACTOR
 * @param {string} [deps.EXPOSURE_REVIEW]  issue 160 - the review-exemption marker. A review
 *   child's session record carries `review:true` (persisted SW-side at spawn); the
 *   tool-dispatch route re-stamps ctx.exposure from it so the tier gate admits the
 *   three instance reads on every dedicated-worker host.
 *   Optional and fail-closed: not injected → nothing is ever stamped.
 * @param {(name: string) => boolean} [deps.reviewToolAllowed] call-time reviewer
 *   allowlist. Optional and fail-closed for review records, so a persisted stale
 *   grant cannot widen the reviewer when the worker relays a call.
 * @param {() => number} [deps.now]
 * @param {(call: Record<string, any>) => void} [deps.recordModelCall]  the context
 *   inspector's capture hook — fed every delegated model call with the runMeta-derived
 *   identity (never the worker's own claim). Optional; defaults to a no-op.
 * @param {(msg: Record<string, any>) => void} [deps.broadcastOp]  announce each settled
 *   ACTOR tool dispatch on the UI ports ('actor/op' — bounded name/ok only).
 *   The isolated heap emits no turn/tool-use, so this is how the eval harness's OM2W
 *   recorder (and any activity view) sees what an actor did. Optional; defaults to a no-op.
 * @param {(sender: unknown) => boolean} [deps.isRelaySender]  is this message from the
 *   exact actor host? The three relay routes below refuse anything else. REQUIRED in
 *   production and fail-CLOSED by omission (an unwired client refuses every relay), because
 *   this is the boundary, not a hint — see the grants-map note for why the token alone is
 *   not sufficient.
 * @param {(sender: unknown) => boolean} [deps.isOffscreenSender] legacy Chrome sender alias
 * @param {() => string} [deps.mintRelayToken]  mints the per-run relay grant (below).
 *   Injected so the grant is testable without a browser; defaults to crypto.randomUUID.
 * @param {(sessionId: string) => Promise<string | null>} [deps.spendRefusalFor]  spend-limit
 *   preflight for a relayed model call: resolves a refusal MESSAGE when the run's owning
 *   chat session is past the user's hard cap, or null to proceed. Optional and
 *   fail-OPEN by omission (an unwired client behaves as before) — the cap is a coarse
 *   safety lever, and refusing every actor call because a dep is missing would break
 *   the lane outright.
 * @param {readonly string[]} [deps.inboundDwebToolNames] positive inbound grant,
 *   supplied from the runtime capability manifest; omission fails closed.
 * @param {number} [deps.maxModelRelaysPerRun]
 * @param {number} [deps.maxToolRelaysPerRun]
 * @param {number} [deps.maxLoopEventsPerRun]
 */
export const makeOffscreenActorClient = ({
  ensureHost, ensureOffscreen, sendMessage, runOnChannel, providerEgress,
  sessions, buildToolContext, dispatchToolCall, prepareToolCall, settleToolCall,
  pinActorCall, restrictCtxCapabilities, ownedTabFor, EXPOSURE_ACTOR, EXPOSURE_REVIEW,
  now = Date.now,
  reviewToolAllowed = () => false,
  recordModelCall = () => {},
  broadcastOp = (/** @type {any} */ _msg) => {},
  mintRelayToken = () => globalThis.crypto.randomUUID(),
  spendRefusalFor = undefined,
  isRelaySender, isOffscreenSender,
  inboundDwebToolNames = [],
  maxModelRelaysPerRun = 100,
  maxToolRelaysPerRun = 128,
  maxLoopEventsPerRun = 256,
}) => {
  const ensureActorHost = ensureHost ?? ensureOffscreen ?? (async () => {});
  const relaySenderAllowed = isRelaySender ?? isOffscreenSender ?? (() => false);
  const inboundDwebTools = new Set(inboundDwebToolNames);
  const modelRelayLimit = Number.isFinite(maxModelRelaysPerRun) && maxModelRelaysPerRun > 0
    ? Math.floor(maxModelRelaysPerRun) : 100;
  const toolRelayLimit = Number.isFinite(maxToolRelaysPerRun) && maxToolRelaysPerRun > 0
    ? Math.floor(maxToolRelaysPerRun) : 128;
  const loopEventLimit = Number.isFinite(maxLoopEventsPerRun) && maxLoopEventsPerRun > 0
    ? Math.floor(maxLoopEventsPerRun) : 256;
  let seq = 0;
  /**
   * @type {Map<string, { runId: string, actorSessionId: string, provider: string, model: string, maxOutputTokens?: number, providerOwner: object, inbound: boolean, allowedTools: Set<string> | null, actorSurface?: 'tools'|'code', relaySignal: AbortSignal, modelRelays: number, toolRelays: number, loopEvents: number, modelActive: boolean, modelStreamId: string | null, contextRead:boolean, actorExecutions:Map<string,any> }>} Firefox relay grants:
   * token → the identity of the run it was minted for.
   *
   * why a grant and not the message's own `actorSessionId`/`runId`: Firefox binds
   * these routes to its private in-process actor host, but the relay still needs a
   * run identity and liveness check that does not trust worker-controlled payloads.
   *
   * The token is minted SW-side per run, travels in the job to the offscreen runner, and
   * comes back on every relay call; identity is DERIVED from it, so the payload's claim
   * buys nothing. It is deleted when the run settles, which makes it a liveness check
   * too — a late or replayed relay from a finished run is refused, the same posture
   * an inference stream gets from its owner check.
   *
   * The Worker never receives the token (the runner holds it and stamps it on outbound
   * relays), so it stays a host-side binding, not a secret the untrusted heap can leak.
   *
   * Chrome does not serialize this token. Its service worker transfers a standard
   * MessageChannel endpoint to the exact offscreen WindowClient and closes the live
   * grant over that private channel. The offscreen job and its relays are never
   * registered on extension-wide runtime messaging.
   */
  const grants = new Map();
  /** @type {Set<string>} run ids a Stop/cancel already fired for. why: the actor card
   * appears before its first inference open. This closes the gap in which Stop can
   * win before a stream exists: a later open is refused, and an admitted stream is
   * closed through the provider authority's owner token. */
  const abortedRuns = new Set();
  /** @type {Map<string, (ev: object) => void>} runId → onEvent */
  const runOnEvent = new Map();
  /** @type {Map<string, { sessionId: string, label: string }>} runId → identity for the
   * context inspector: inference routes carry no session identity, so the
   * session (and a human label for WHOSE call this is) is stashed at run() time. */
  const runMeta = new Map();
  /**
   * @param {{ actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, probeOnly?: boolean, depth?: number, maxSteps?: number, maxOutputTokens?: number, tools?: any[], priorMessages?: any[], reasoning?: object, contextWindowOverrides?:Record<string,number>, budgetMs?: number, oneShot?: boolean, actorType?: string, backing?: string, actorSurface?: 'tools'|'code', tabOrigin?: string, origin?: string, inbound?: boolean }} job
   * @param {{ signal?: AbortSignal, onEvent?: (ev: object) => void }} [opts]
   */
  const run = async (job, { signal, onEvent } = {}) => {
    // A cancelled turn must not create a host, mint authority, or start a Worker.
    // why: Stop can win before an async actor reaches this client; sending abort
    // before actor/run exists cannot cancel the Worker that actor/run then creates.
    if (signal?.aborted) {
      return { ok: false, started: true, phase: 'startup', code: 'actor_run_aborted', error: 'actor run aborted', aborted: true };
    }
    try {
      await ensureActorHost();
    } catch (error) {
      return {
        ok: false, started: false, phase: 'startup', code: 'actor_host_unavailable',
        error: `actor host unavailable: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`,
      };
    }
    if (signal?.aborted) {
      return { ok: false, started: true, phase: 'startup', code: 'actor_run_aborted', error: 'actor run aborted', aborted: true };
    }
    const runId = `aw-${now().toString(36)}-${++seq}`;
    const relayToken = mintRelayToken();
    // This controller is the authoritative relay lifetime. Put it in the grant
    // itself so a route that already resolved the token can re-check authority
    // after every await, even after run() retires the Map entry.
    const relayController = new AbortController();
    // Only the SW caller can stamp `inbound:true`. From here onward the bit is
    // monotonic: the runner/Worker may echo it but can never widen its tool grant
    // or rebuild a trusted ctx. Unknown inbound actor kinds get no tools.
    const inbound = job.inbound === true;
    const tools = inbound
      ? (job.actorType === 'dweb' && Array.isArray(job.tools)
        ? job.tools.filter((tool) => inboundDwebTools.has(tool?.name))
        : [])
      : job.tools;
    const allowedTools = inbound
      ? new Set((tools ?? []).map((tool) => tool?.name).filter((name) => typeof name === 'string'))
      : null;
    const requestedMaxOutputTokens = job.maxOutputTokens;
    const grant = {
      runId, actorSessionId: job.actorSessionId,
      provider: job.provider, model: job.model,
      maxOutputTokens: typeof requestedMaxOutputTokens === 'number'
        && Number.isFinite(requestedMaxOutputTokens) && requestedMaxOutputTokens > 0
        ? Math.floor(requestedMaxOutputTokens) : undefined,
      providerOwner: Object.freeze({ runId }),
      inbound, allowedTools, relaySignal: relayController.signal,
      modelRelays: 0, toolRelays: 0, loopEvents: 0,
      modelActive: false, modelStreamId: null, contextRead: false,
      actorExecutions: new Map(),
      ...(job.actorSurface === 'code' || job.actorSurface === 'tools'
        ? { actorSurface: job.actorSurface }
        : {}),
    };
    // Firefox's direct in-process host uses the private token map. Chrome
    // binds the grant directly to one transferred MessageChannel closure.
    if (!runOnChannel) grants.set(relayToken, grant);
    if (onEvent) runOnEvent.set(runId, onEvent);
    runMeta.set(runId, {
      sessionId: job.actorSessionId,
      label: job.actorType ? `actor:${job.actorType}` : `actor d${job.depth ?? 1}`,
    });
    const abortRelays = () => {
      abortedRuns.add(runId);   // cover an inference open that has not reached the route yet
      relayController.abort();
      void providerEgress?.closeOwner(grant.providerOwner).catch(() => {});
    };
    const abortRun = () => {
      abortRelays();
      if (!runOnChannel) sendMessage({ type: 'actor/abort', runId }).catch(() => {});
    };
    if (signal && !signal.aborted) signal.addEventListener('abort', abortRun, { once: true });
    else if (signal?.aborted) abortRun();
    try {
      const result = runOnChannel
        ? await runOnChannel(
          { ...job, inbound, tools, runId },
          {
            signal,
            relay: (type, payload) => {
              const route = /** @type {Record<string, Function>} */ (routes)[type];
              if (!route) return { ok: false, error: `unknown actor relay: ${type}` };
              return route(payload, undefined, grant);
            },
          },
        )
        : await sendMessage({ type: 'actor/run', job: { ...job, inbound, tools, runId, relayToken } });
      // Stop / cancel cascade: `signal.aborted` HERE is the authoritative proof a Stop
      // hit THIS run — and the one place it's reliably observable. The worker unwinds an
      // abort several ways (a rejected relay, a stream error, or the
      // 'abort' message) and can even finish CLEANLY (no error event, empty reply) that
      // looks like a natural end at the result shape. Stamp only known no-reply
      // cancellations; unknown custody stays terminal. The caller then renders the actor
      // card 'cancelled' (not a blank 'ok'/'failed') and spawn.js records stopReason
      // 'aborted'. A run that produced text just before Stop (raced) keeps its result.
      if (signal?.aborted && result && !result.finalText && result.outcomeKnown !== false) {
        result.aborted = true;
      }
      return result;
    } finally {
      // Settlement is a cancellation boundary for every host relay, including a
      // runner-owned timeout/crash that never aborts the caller's turn signal.
      // Abort BEFORE retiring the grant so a route that already resolved it sees
      // the terminal signal and exits rather than continuing without a grant.
      abortRelays();
      // Drop the abort listener a completed-without-Stop run left attached (a no-op if
      // it already fired under {once:true}); keeps nothing dangling on the turn signal.
      signal?.removeEventListener('abort', abortRun);
      relayController.abort();
      await providerEgress?.closeOwner(grant.providerOwner).catch(() => {});
      if (typeof settleToolCall === 'function') {
        await Promise.allSettled([...grant.actorExecutions.values()].map(async (entry) => {
          if (entry.open !== true) return;
          entry.open = false;
          await settleToolCall(entry.prepared, { result: {
            ok: false,
            error: 'actor semantic execution host was lost before settlement',
            code: 'actor-tool-host-lost',
            outcomeKnown: entry.effectEntered !== true,
            retryable: entry.effectEntered !== true,
            outcomeKind: entry.effectEntered === true ? 'host-lost' : 'pre-effect-failure',
          } });
        }));
      }
      grant.actorExecutions.clear();
      // Retiring the grant is what makes it a liveness check: every relay for
      // this run is refused from here on, so a late/replayed one can't dispatch.
      if (!runOnChannel) grants.delete(relayToken);
      runOnEvent.delete(runId);
      runMeta.delete(runId);
      abortedRuns.delete(runId);
    }
  };

  /**
   * Resolve a relay's identity. Chrome passes the grant through a private channel
   * closure. Firefox requires its private host sender identity and a live grant
   * token. Every route treats a missing or retired grant as a hard refusal.
   * @param {{ relayToken?: unknown }} [msg]
   * @param {unknown} [sender]  the second argument makeDispatcher hands a handler
   * @returns {{ runId: string, actorSessionId: string, provider: string, model: string, maxOutputTokens?: number, providerOwner: object, inbound: boolean, allowedTools: Set<string> | null, actorSurface?: 'tools'|'code', relaySignal: AbortSignal, modelRelays: number, toolRelays: number, loopEvents: number, modelActive: boolean, modelStreamId: string | null, contextRead:boolean, actorExecutions:Map<string,any> } | null}
   */
  const grantFor = (msg, sender, boundGrant = null) => {
    if (boundGrant) return boundGrant;
    if (!relaySenderAllowed(sender)) return null;
    const token = msg?.relayToken;
    if (typeof token !== 'string' || token.length === 0) return null;
    return grants.get(token) ?? null;
  };

  /** Build the exact live actor context from SW-owned run and session custody. */
  const contextForTool = async (/** @type {any} */ grant, /** @type {any} */ call) => {
    const { actorSessionId } = grant;
    if (grant.inbound && (typeof call?.name !== 'string'
        || !grant.allowedTools?.has(call.name))) {
      return { ok: false, error: `tool_not_available_to_inbound_actor: ${call?.name}` };
    }
    const rec = await sessions.get(actorSessionId);
    if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
    if (!rec) return { ok: false, error: 'actor/tool-dispatch: unknown session' };
    if (rec.kind === 'spawned') {
      if (!restrictCtxCapabilities) {
        return { ok: false, error: 'actor/tool-dispatch: actor offscreen not wired' };
      }
      const persistedGrants = new Set(Array.isArray(rec.grantedTools) ? rec.grantedTools : []);
      const granted = grant.inbound
        ? new Set([...persistedGrants].filter((name) => grant.allowedTools?.has(name)))
        : persistedGrants;
      if (typeof call?.name !== 'string' || !granted.has(call.name)) {
        return { ok: false, error: `tool_not_available_to_actor: ${call?.name}` };
      }
      if (rec.review === true && !reviewToolAllowed(call.name)) {
        return { ok: false, error: `tool_not_available_to_reviewer: ${call.name}` };
      }
      const base = await buildToolContext({
        sessionId: actorSessionId,
        lifecycleTurnId: grant.runId,
        lifecycleUserInitiated: !grant.inbound,
        ...(grant.inbound ? { synthetic: true, trusted: false } : {}),
      });
      if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
      const audit = (/** @type {any} */ entry) => /** @type {any} */ (base).audit?.({
        ...entry,
        details: {
          ...(entry?.details ?? {}), parentSessionId: rec.parentSessionId,
          actorSessionId, depth: rec.depth,
        },
      });
      return { ok: true, actorSessionId, rec, ctx: restrictCtxCapabilities({
        ...base, audit, abortSignal: grant.relaySignal,
        ...(grant.inbound ? { synthetic: true, trusted: false, inbound: true } : {}),
        ...(rec.review === true && EXPOSURE_REVIEW ? { exposure: EXPOSURE_REVIEW } : {}),
      }, granted) };
    }
    if (rec.kind !== 'actor') {
      return { ok: false, error: 'actor/tool-dispatch: not an actor or actor session' };
    }
    const activeTabId = rec.actorType === 'web' && rec.backing !== 'api' && ownedTabFor
      ? ownedTabFor(actorSessionId) : undefined;
    if (grant.inbound && !restrictCtxCapabilities) {
      return { ok: false, error: 'actor/tool-dispatch: inbound capability filter not wired' };
    }
    const base = await buildToolContext({
      exposure: EXPOSURE_ACTOR, sessionId: actorSessionId, activeTabId,
      actorInstanceId: rec.instanceId, actorType: rec.actorType, actorBacking: rec.backing,
      lifecycleTurnId: grant.runId,
      lifecycleUserInitiated: !grant.inbound,
      ...(grant.actorSurface ? { actorSurface: grant.actorSurface } : {}),
      ...(grant.inbound ? { synthetic: true, trusted: false } : {}),
    });
    if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
    const stamped = {
      ...base, abortSignal: grant.relaySignal,
      ...(grant.inbound ? { synthetic: true, trusted: false, inbound: true } : {}),
    };
    const ctx = grant.inbound
      ? /** @type {Function} */ (restrictCtxCapabilities)(stamped, grant.allowedTools)
      : stamped;
    pinActorCall(call, rec.actorType, rec.instanceId);
    return { ok: true, actorSessionId, rec, ctx };
  };

  const domainEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string} */ domain,
    /** @type {string[]} */ toolNames,
    /** @type {string[]} */ fields,
  ) => {
    const entry = grant?.actorExecutions.get(msg.executionId);
    return grant && !grant.relaySignal.aborted
      && exactKeys(msg, ['executionId', ...fields])
      && entry?.open === true
      && controllerToolDomain(entry.toolName) === domain
      && toolNames.includes(entry.toolName) ? entry : null;
  };
  const vmEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ tools,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'vm', tools, fields);
    if (!entry) return null;
    entry.domainState.authority ??= createVmToolAuthority({
      call: entry.prepared.call, ctx: entry.prepared.ctx,
    });
    return entry;
  };
  const notebookEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ tools,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'notebook', tools, fields);
    if (!entry) return null;
    entry.domainState.authority ??= createNotebookToolAuthority({
      call: entry.prepared.call, ctx: entry.prepared.ctx,
      signal: /** @type {any} */ (grant).relaySignal,
    });
    return entry;
  };

  const runDomainEffect = async (
    /** @type {any} */ entry,
    /** @type {string} */ operation,
    /** @type {'read'|'control'|'commit'|'resource'} */ riskClass,
    /** @type {()=>Promise<any>|any} */ execute,
  ) => {
    if (entry.domainCalls.has(operation)) {
      return { ok: false, error: `${operation}: authority already used`, outcomeKnown: true };
    }
    entry.domainCalls.add(operation);
    entry.effectEntered = true;
    try { return { ok: true, value: await execute(), outcomeKnown: true }; }
    catch (cause) {
      const detail = /** @type {{message?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
      const replayable = riskClass === 'read' || riskClass === 'control';
      const outcomeKnown = replayable || detail?.outcomeKnown === true;
      if (!outcomeKnown) entry.unknownIrreversible = true;
      return {
        ok: false, error: detail?.message ?? String(cause), outcomeKnown,
        retryable: outcomeKnown && detail?.retryable !== false,
      };
    }
  };

  const routes = {
    /**
     * @param {{relayToken?:string,providerId?:string,modelId?:string,nativeBody?:object}} [msg]
     * @param {unknown} [sender]
     * @param {any} [boundGrant]
     */
    'actor/model-open-inference': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant) return { ok: false, error: 'actor/model-open-inference: unauthorized relay' };
      const { runId } = grant;
      const key = runId;
      if (grant.relaySignal.aborted || abortedRuns.has(key)) return { ok: false, error: 'aborted' };
      if (grant.modelActive) return {
        ok: false, error: 'actor/model-open-inference: another inference is active',
        code: 'actor_model_relay_busy', outcomeKnown: true, performed: false,
      };
      if (grant.modelRelays >= modelRelayLimit) return {
        ok: false, error: 'actor/model-open-inference: relay budget exhausted',
        code: 'actor_model_relay_limit', outcomeKnown: true, performed: false,
      };
      if (!providerEgress || !Number.isSafeInteger(grant.maxOutputTokens)
          || /** @type {number} */ (grant.maxOutputTokens) < 1) {
        return {
          ok: false, error: 'actor/model-open-inference: authority or output limit unavailable',
          code: 'actor_model_authority_unavailable', outcomeKnown: true, performed: false,
        };
      }
      grant.modelRelays += 1;
      grant.modelActive = true;
      try {
        // Spend-limit preflight, script/model-call's posture applied to the actor lane:
        // an actor's model calls spend the user's money on the OWNING chat session, so a
        // session past the hard cap must not be pushed further by its own actors. Without
        // this the cap bounded the orchestrator's turns only, and any actor fan-out
        // walked straight past it.
        if (spendRefusalFor) {
          const refusal = await spendRefusalFor(grant.actorSessionId).catch(() => null);
          if (refusal) {
            grant.modelActive = false;
            return { ok: false, error: refusal };
          }
        }
        if (grant.relaySignal.aborted || abortedRuns.has(key)) {
          grant.modelActive = false;
          return { ok: false, error: 'aborted' };
        }
        const meta = runMeta.get(key);
        if (meta) recordModelCall({
          provider: grant.provider,
          model: grant.model,
          maxTokens: grant.maxOutputTokens,
          sessionId: meta.sessionId,
          label: meta.label,
        });
        const result = await providerEgress.openInference({
          providerId: msg.providerId,
          modelId: msg.modelId,
          nativeBody: msg.nativeBody,
        }, {
          owner: grant.providerOwner,
          signal: grant.relaySignal,
          maxOutputTokens: grant.maxOutputTokens,
          permits: (/** @type {string} */ providerId, /** @type {string} */ modelId) => providerId === grant.provider
            && modelId === grant.model,
        });
        if (grant.relaySignal.aborted || abortedRuns.has(key)) {
          await providerEgress.closeOwner(grant.providerOwner).catch(() => {});
          return { ok: false, error: 'aborted' };
        }
        if (result?.ok !== true) grant.modelActive = false;
        else if (typeof result?.value?.streamId !== 'string'
            || result.value.streamId.length === 0) {
          grant.modelActive = false;
          return {
            ok: false, error: 'actor/model-open-inference: authority returned no stream',
            code: 'actor_model_stream_invalid', outcomeKnown: true,
          };
        }
        else {
          grant.modelStreamId = result.value.streamId;
          if (result.value.hasBody !== true) {
            await providerEgress.cancelInference({ streamId: grant.modelStreamId }, {
              owner: grant.providerOwner,
            }).catch(() => {});
            grant.modelActive = false;
            grant.modelStreamId = null;
          }
        }
        return result;
      } catch (error) {
        grant.modelActive = false;
        const failure = /** @type {{message?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (error);
        return {
          ok: false, error: failure?.message ?? String(error),
          outcomeKnown: failure?.outcomeKnown === true,
          ...(failure?.retryable === false || failure?.outcomeKnown !== true
            ? { retryable: false } : {}),
        };
      }
    },
    /**
     * @param {{relayToken?:string,streamId?:string}} [msg]
     * @param {unknown} [sender]
     * @param {any} [boundGrant]
     */
    'actor/model-read-inference-chunk': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant) return { ok: false, error: 'actor/model-read-inference-chunk: unauthorized relay' };
      if (!providerEgress || grant.relaySignal.aborted || abortedRuns.has(grant.runId)) {
        return { ok: false, error: 'aborted' };
      }
      if (typeof msg.streamId !== 'string' || msg.streamId !== grant.modelStreamId) {
        return {
          ok: false, error: 'actor/model-read-inference-chunk: stream is not active',
          code: 'actor_model_stream_invalid', outcomeKnown: true,
        };
      }
      const result = await providerEgress.readInferenceChunk({ streamId: msg.streamId }, {
        owner: grant.providerOwner, signal: grant.relaySignal,
      });
      if (result?.ok !== true || result?.value?.done === true) {
        grant.modelActive = false;
        grant.modelStreamId = null;
      }
      return result;
    },
    /**
     * @param {{relayToken?:string,streamId?:string}} [msg]
     * @param {unknown} [sender]
     * @param {any} [boundGrant]
     */
    'actor/model-cancel-inference': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant) return { ok: false, error: 'actor/model-cancel-inference: unauthorized relay' };
      if (!providerEgress) return {
        ok: false, error: 'actor/model-cancel-inference: authority unavailable',
        outcomeKnown: true,
      };
      if (typeof msg.streamId !== 'string' || msg.streamId !== grant.modelStreamId) {
        return {
          ok: false, error: 'actor/model-cancel-inference: stream is not active',
          code: 'actor_model_stream_invalid', outcomeKnown: true,
        };
      }
      const result = await providerEgress.cancelInference({ streamId: msg.streamId }, {
        owner: grant.providerOwner,
      });
      grant.modelActive = false;
      grant.modelStreamId = null;
      return result;
    },
    /** Exact resident-engine generation; it shares the model-call quota but not network fetch.
     * @param {any} msg @param {unknown} sender @param {any} boundGrant */
    'actor/model-open-local': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant || !providerEgress || grant.relaySignal.aborted
          || abortedRuns.has(grant?.runId)) {
        return { ok: false, error: 'actor/model-open-local: unauthorized relay' };
      }
      if (grant.modelActive || grant.modelRelays >= modelRelayLimit
          || !Number.isSafeInteger(grant.maxOutputTokens)
          || /** @type {number} */ (grant.maxOutputTokens) < 1) {
        return {
          ok: false, error: 'actor/model-open-local: relay unavailable',
          code: grant.modelActive ? 'actor_model_relay_busy' : 'actor_model_relay_limit',
          outcomeKnown: true, performed: false,
        };
      }
      grant.modelRelays += 1;
      grant.modelActive = true;
      const result = await providerEgress.openLocalGeneration({
        providerId: msg.providerId,
        modelId: msg.modelId,
        messages: msg.messages,
        system: msg.system,
        tools: msg.tools,
        maxTokens: msg.maxTokens,
      }, {
        owner: grant.providerOwner,
        signal: grant.relaySignal,
        maxOutputTokens: grant.maxOutputTokens,
        permits: (/** @type {string} */ providerId, /** @type {string} */ modelId) =>
          providerId === grant.provider && modelId === grant.model,
      });
      if (result?.ok !== true || typeof result?.value?.streamId !== 'string') {
        grant.modelActive = false;
        return result;
      }
      grant.modelStreamId = result.value.streamId;
      return result;
    },
    /** @param {any} msg @param {unknown} sender @param {any} boundGrant */
    'actor/model-read-local': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant || !providerEgress || grant.relaySignal.aborted
          || msg.streamId !== grant.modelStreamId) {
        return {
          ok: false, error: 'actor/model-read-local: stream is not active',
          code: 'actor_model_stream_invalid', outcomeKnown: true,
        };
      }
      const result = await providerEgress.readLocalGeneration({ streamId: msg.streamId }, {
        owner: grant.providerOwner,
      });
      if (result?.ok !== true || result?.value?.done === true) {
        grant.modelActive = false;
        grant.modelStreamId = null;
      }
      return result;
    },
    /** @param {any} msg @param {unknown} sender @param {any} boundGrant */
    'actor/model-cancel-local': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant || !providerEgress || msg.streamId !== grant.modelStreamId) {
        return {
          ok: false, error: 'actor/model-cancel-local: stream is not active',
          code: 'actor_model_stream_invalid', outcomeKnown: true,
        };
      }
      const result = await providerEgress.cancelLocalGeneration({ streamId: msg.streamId }, {
        owner: grant.providerOwner,
      });
      grant.modelActive = false;
      grant.modelStreamId = null;
      return result;
    },
    /**
     * @param {{relayToken?:string,providerId?:string,modelId?:string}} [msg]
     * @param {unknown} [sender]
     * @param {any} [boundGrant]
     */
    'actor/model-read-context': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant || !providerEgress || grant.contextRead
          || grant.relaySignal.aborted || abortedRuns.has(grant.runId)
          || msg.providerId !== grant.provider || msg.modelId !== grant.model) {
        return {
          ok: false, error: 'actor/model-read-context: authority refused',
          code: 'actor_model_context_denied', outcomeKnown: true,
        };
      }
      grant.contextRead = true;
      return providerEgress.readModelContext({
        providerId: msg.providerId, modelId: msg.modelId,
      }, {
        owner: grant.providerOwner,
        signal: grant.relaySignal,
        permitsProvider: (/** @type {string} */ providerId) => providerId === grant.provider,
      });
    },
    /** Frozen compatibility route. Controller-owned names are refused here. */
    'actor/tool-dispatch': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      let admitted = false;
      try {
        const grant = grantFor(msg, sender, boundGrant);
        if (!grant) return { ok: false, error: 'actor/tool-dispatch: unauthorized relay' };
        if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
        const call = msg.call;
        if (grant.toolRelays >= toolRelayLimit) return {
          ok: false, error: 'actor/tool-dispatch: relay budget exhausted',
          code: 'actor_tool_relay_limit', outcomeKnown: true, performed: false,
        };
        grant.toolRelays += 1;
        const admittedContext = await contextForTool(grant, call);
        if (admittedContext.ok !== true) return admittedContext;
        if (!legacyToolAllowed(call?.name)) {
          return { ok: false, error: `actor/tool-dispatch: tool is not legacy-owned: ${call?.name}` };
        }
        admitted = true;
        const result = await dispatchToolCall(call, admittedContext.ctx);
        if (admittedContext.rec.kind === 'actor') {
          try {
            broadcastOp({
              type: 'actor/op', sessionId: admittedContext.actorSessionId,
              name: typeof call?.name === 'string' && /^[a-z0-9_-]{1,64}$/.test(call.name)
                ? call.name : 'unknown',
              ok: result?.ok !== false,
            });
          } catch { /* display-only */ }
        }
        return { ok: true, result };
      } catch (e) {
        const failure = /** @type {{ message?: string, code?: string, outcomeKnown?: boolean, performed?: boolean }} */ (e);
        return {
          ok: false, error: failure?.message ?? String(e),
          ...(typeof failure?.code === 'string' ? { code: failure.code } : {}),
          ...(admitted ? {
            outcomeKnown: failure?.outcomeKnown === true,
            ...(typeof failure?.performed === 'boolean' ? { performed: failure.performed } : {}),
            ...(failure?.outcomeKnown === true ? {} : { retryable: false }),
          } : {}),
        };
      }
    },
    /** Admit one controller-owned tool without executing its semantics in the SW. */
    'actor/tool-prepare': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const call = msg.call;
      const domain = controllerToolDomain(call?.name);
      if (!grant || !exactKeys(msg, ['call']) || domain === null
          || legacyToolAllowed(call?.name) || typeof prepareToolCall !== 'function'
          || typeof settleToolCall !== 'function') {
        return { ok: false, error: 'actor/tool-prepare: unauthorized semantic owner' };
      }
      if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
      if (grant.toolRelays >= toolRelayLimit) return {
        ok: false, error: 'actor/tool-prepare: relay budget exhausted',
        code: 'actor_tool_relay_limit', outcomeKnown: true, performed: false,
      };
      grant.toolRelays += 1;
      const admittedContext = await contextForTool(grant, call);
      if (admittedContext.ok !== true) return admittedContext;
      const prepared = await prepareToolCall(call, admittedContext.ctx);
      if (prepared?.prepared !== true) return { ok: true, mode: 'result', result: prepared };
      const policy = CONTROLLER_TOOL_MANIFEST.tools[call.name];
      if (!policy || structuredClonePayloadBytes(prepared.args) > policy.argumentBytes) {
        return { ok: false, error: 'actor/tool-prepare: semantic arguments exceed authority limits' };
      }
      const executionId = `ae-${now().toString(36)}-${++seq}`;
      grant.actorExecutions.set(executionId, {
        open: true, effectEntered: false, unknownIrreversible: false,
        domainCalls: new Set(), domainState: {}, prepared,
        toolName: call.name,
      });
      const projection = domain === 'actor' ? {
        sessionId: admittedContext.ctx.session?.sessionId,
        sessionDepth: admittedContext.ctx.session?.depth ?? 0,
        sessionKind: admittedContext.ctx.session?.kind ?? 'spawned',
        inbound: admittedContext.ctx.inbound === true,
      } : domain === 'repository' ? {
        actorType: admittedContext.ctx.actorType,
        actorInstanceId: admittedContext.ctx.actorInstanceId,
      } : { sessionId: admittedContext.ctx.session?.sessionId };
      return {
        ok: true, mode: 'execute', executionId,
        callId: typeof call.id === 'string' && call.id ? call.id : executionId,
        toolName: call.name, args: prepared.args,
        projection,
      };
    },
    'actor/spawn-sync': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      const args = entry?.prepared?.call?.args;
      const expectedTools = Array.isArray(args?.tools) ? args.tools : undefined;
      const expectedMaxSteps = Number.isFinite(args?.maxSteps) ? args.maxSteps : undefined;
      const expectedMaxDepth = Number.isFinite(args?.maxDepth) ? args.maxDepth : undefined;
      if (!grant || !exactKeys(msg, ['executionId', 'task', 'allowRecursion'], [
        'relayToken', 'tools', 'maxSteps', 'maxDepth',
      ]) || !entry || entry.open !== true || entry.toolName !== 'actor_create'
          || args?.sync !== true || msg.task !== args?.task
          || msg.allowRecursion !== (args?.allowRecursion === true)
          || JSON.stringify(msg.tools) !== JSON.stringify(expectedTools)
          || msg.maxSteps !== expectedMaxSteps || msg.maxDepth !== expectedMaxDepth
          || entry.domainCalls.size > 0 || typeof msg.task !== 'string'
          || typeof msg.allowRecursion !== 'boolean'
          || (msg.tools !== undefined && (!Array.isArray(msg.tools)
            || msg.tools.some((/** @type {unknown} */ name) => typeof name !== 'string')))
          || (msg.maxSteps !== undefined && !Number.isFinite(msg.maxSteps))
          || (msg.maxDepth !== undefined && !Number.isFinite(msg.maxDepth))) {
        return { ok: false, error: 'actor/spawn-sync: authority mismatch', outcomeKnown: true };
      }
      entry.domainCalls.add('actor/spawn-sync');
      try {
        const ctx = entry.prepared.ctx;
        if (typeof ctx?.actorAuthority?.spawnSync !== 'function') {
          return { ok: true, value: { refused: true, result: 'actor_orchestrator_unavailable' } };
        }
        entry.effectEntered = true;
        return { ok: true, value: await ctx.actorAuthority.spawnSync({
          task: msg.task,
          ...(msg.tools === undefined ? {} : { tools: msg.tools }),
          ...(msg.maxSteps === undefined ? {} : { maxSteps: msg.maxSteps }),
          ...(msg.maxDepth === undefined ? {} : { maxDepth: msg.maxDepth }),
          allowRecursion: msg.allowRecursion,
          parentSessionId: ctx.session?.sessionId,
          parentDepth: ctx.session?.depth ?? 0,
          parentInbound: ctx.inbound === false ? false : true,
          parentToolUseId: entry.prepared.call?.id,
        }) };
      } catch (cause) {
        const failure = /** @type {{message?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
        return {
          ok: false, error: failure?.message ?? String(cause),
          outcomeKnown: failure?.outcomeKnown === true,
          retryable: failure?.outcomeKnown === true && failure?.retryable !== false,
        };
      }
    },
    'actor/spawn-async': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      const args = entry?.prepared?.call?.args;
      const expectedTools = Array.isArray(args?.tools) ? args.tools : undefined;
      const expectedMaxSteps = Number.isFinite(args?.maxSteps) ? args.maxSteps : undefined;
      const expectedMaxDepth = Number.isFinite(args?.maxDepth) ? args.maxDepth : undefined;
      if (!grant || !exactKeys(msg, ['executionId', 'task', 'allowRecursion'], [
        'relayToken', 'tools', 'maxSteps', 'maxDepth',
      ]) || !entry || entry.open !== true || entry.toolName !== 'actor_create'
          || args?.sync === true || msg.task !== args?.task
          || msg.allowRecursion !== (args?.allowRecursion === true)
          || JSON.stringify(msg.tools) !== JSON.stringify(expectedTools)
          || msg.maxSteps !== expectedMaxSteps || msg.maxDepth !== expectedMaxDepth
          || entry.domainCalls.size > 0 || typeof msg.task !== 'string'
          || typeof msg.allowRecursion !== 'boolean'
          || (msg.tools !== undefined && (!Array.isArray(msg.tools)
            || msg.tools.some((/** @type {unknown} */ name) => typeof name !== 'string')))
          || (msg.maxSteps !== undefined && !Number.isFinite(msg.maxSteps))
          || (msg.maxDepth !== undefined && !Number.isFinite(msg.maxDepth))) {
        return { ok: false, error: 'actor/spawn-async: authority mismatch', outcomeKnown: true };
      }
      entry.domainCalls.add('actor/spawn-async');
      try {
        const ctx = entry.prepared.ctx;
        if (typeof ctx?.actorAuthority?.spawnAsync !== 'function') {
          return { ok: true, value: { ok: false, error: 'async_actor_unavailable' } };
        }
        entry.effectEntered = true;
        return { ok: true, value: await ctx.actorAuthority.spawnAsync({
          task: msg.task,
          ...(msg.tools === undefined ? {} : { tools: msg.tools }),
          ...(msg.maxSteps === undefined ? {} : { maxSteps: msg.maxSteps }),
          ...(msg.maxDepth === undefined ? {} : { maxDepth: msg.maxDepth }),
          allowRecursion: msg.allowRecursion,
          parentSessionId: ctx.session?.sessionId,
          parentDepth: ctx.session?.depth ?? 0,
          parentInbound: ctx.inbound === false ? false : true,
          parentToolUseId: entry.prepared.call?.id,
        }) };
      } catch (cause) {
        const failure = /** @type {{message?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
        return {
          ok: false, error: failure?.message ?? String(cause),
          outcomeKnown: failure?.outcomeKnown === true,
          retryable: failure?.outcomeKnown === true && failure?.retryable !== false,
        };
      }
    },
    'actor/tasks-read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      if (!grant || !exactKeys(msg, ['executionId'])
          || !entry || entry.open !== true || entry.toolName !== 'actor_tasks'
          || entry.domainCalls.size > 0) {
        return { ok: false, error: 'actor/tasks-read: authority mismatch', outcomeKnown: true };
      }
      entry.domainCalls.add('actor/tasks-read');
      entry.effectEntered = true;
      try {
        const read = entry.prepared.ctx?.actorAuthority?.listTasks;
        return { ok: true, value: typeof read === 'function' ? await read() : [] };
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause), outcomeKnown: true, retryable: true };
      }
    },
    'actor/task-cancel': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      if (!grant || !exactKeys(msg, ['executionId', 'taskId'])
          || !entry || entry.open !== true || entry.toolName !== 'actor_cancel'
          || entry.domainCalls.size > 0 || typeof msg.taskId !== 'string' || !msg.taskId
          || msg.taskId !== entry.prepared.call?.args?.taskId) {
        return { ok: false, error: 'actor/task-cancel: authority mismatch', outcomeKnown: true };
      }
      entry.domainCalls.add('actor/task-cancel');
      entry.effectEntered = true;
      try {
        const cancel = entry.prepared.ctx?.actorAuthority?.cancelTask;
        return { ok: true, value: typeof cancel === 'function'
          ? await cancel(msg.taskId) : { ok: false, error: 'async_actor_unavailable' } };
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause), outcomeKnown: true, retryable: true };
      }
    },
    'actor/message-deliver': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      const args = entry?.prepared?.call?.args;
      const sessionKind = entry?.prepared?.ctx?.session?.kind;
      if (!grant || !exactKeys(msg, [
        'executionId', 'to', 'message', 'oneShot', 'awaitReply',
        'degradeToAsync', 'awaitCapMs',
      ]) || !entry || entry.open !== true || entry.toolName !== 'message_actor'
          || entry.domainCalls.size > 0 || typeof msg.to !== 'string'
          || msg.to !== args?.to || msg.message !== args?.message
          || msg.oneShot !== (args?.oneShot === true)
          || msg.awaitReply !== (sessionKind === 'spawned' || args?.await === true)
          || msg.degradeToAsync !== (args?.await === true && sessionKind !== 'spawned')
          || typeof msg.message !== 'string' || typeof msg.oneShot !== 'boolean'
          || typeof msg.awaitReply !== 'boolean' || typeof msg.degradeToAsync !== 'boolean'
          || !Number.isSafeInteger(msg.awaitCapMs) || msg.awaitCapMs < 1
          || msg.awaitCapMs > 3 * 60_000) {
        return { ok: false, error: 'actor/message-deliver: authority mismatch', outcomeKnown: true };
      }
      entry.domainCalls.add('actor/message-deliver');
      try {
        const ctx = entry.prepared.ctx;
        if (typeof ctx?.actorAuthority?.deliverMessage !== 'function') {
          return { ok: true, value: { ok: false, error: 'message_actor is not enabled' } };
        }
        entry.effectEntered = true;
        return { ok: true, value: await ctx.actorAuthority.deliverMessage({
          to: msg.to, message: msg.message, oneShot: msg.oneShot,
          senderSessionId: ctx.session?.sessionId,
          inbound: ctx.inbound === true,
          toolUseId: entry.prepared.call?.id,
          awaitReply: msg.awaitReply,
          awaitSignal: grant.relaySignal,
          degradeToAsync: msg.degradeToAsync,
          awaitCapMs: msg.awaitCapMs,
        }) };
      } catch (cause) {
        const failure = /** @type {{message?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
        return {
          ok: false, error: failure?.message ?? String(cause),
          outcomeKnown: failure?.outcomeKnown === true,
          retryable: failure?.outcomeKnown === true && failure?.retryable !== false,
        };
      }
    },
    'pod/resolve': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'pod', ['pod_exec'], ['podId']);
      if (!entry || msg.podId !== entry.prepared.call?.args?.podId) {
        return { ok: false, error: 'pod/resolve: authority mismatch', outcomeKnown: true };
      }
      const resolve = entry.prepared.ctx?.podClient?.resolveId;
      if (typeof resolve !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      const result = await runDomainEffect(entry, 'pod/resolve', 'read', () => resolve({
        sessionId: entry.prepared.ctx.session?.sessionId, podId: msg.podId,
      }));
      if (result.ok === true && typeof result.value === 'string') {
        entry.domainState.podId = result.value;
      }
      return result;
    },
    'pod/read-remote': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'pod', ['pod_exec'], ['podId']);
      const intent = entry ? podGitRemoteIntents(entry.prepared.call?.args?.command ?? '')[0] : null;
      if (!entry || typeof msg.podId !== 'string' || msg.podId !== entry.domainState.podId
          || !intent || intent.url) {
        return { ok: false, error: 'pod/read-remote: authority mismatch', outcomeKnown: true };
      }
      const readRemote = entry.prepared.ctx?.repositories?.getRemote;
      const result = await runDomainEffect(entry, 'pod/read-remote', 'read', () =>
        typeof readRemote === 'function'
          ? readRemote({ kind: 'pod', id: msg.podId }) : null);
      if (result.ok === true) entry.domainState.remote = result.value;
      return result;
    },
    'pod/confirm-git': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'pod', ['pod_exec'], ['op']);
      const intents = entry ? podGitRemoteIntents(entry.prepared.call?.args?.command ?? '') : [];
      const intent = intents.length === 1 ? intents[0] : null;
      const target = intent?.url ?? entry?.domainState?.remote?.url;
      if (!entry || typeof entry.domainState.podId !== 'string'
          || !intent || msg.op !== intent.op || typeof target !== 'string') {
        return { ok: false, error: 'pod/confirm-git: authority mismatch', outcomeKnown: true };
      }
      let origin;
      try { origin = new URL(target).origin; }
      catch { return { ok: false, error: 'pod/confirm-git: invalid remote', outcomeKnown: true }; }
      const confirm = entry.prepared.ctx?.confirm;
      if (typeof confirm !== 'function') {
        return { ok: true, value: false, outcomeKnown: true };
      }
      const result = await runDomainEffect(entry, 'pod/confirm-git', 'control', () => confirm({
        tool: 'pod_exec', kind: `git_${intent.op}`,
        sideEffect: intent.op === 'push' ? 'mutate_external' : 'write',
        origins: [origin],
        summary: intent.op === 'push'
          ? `Allow this one Pod job to push code and commit history to ${target}?`
          : `Allow this one Pod job to ${intent.op} ${target} through peerd's audited Git transport?`,
      }));
      if (result.ok === true && [true, 'yes_once', 'yes_session'].includes(result.value)) {
        entry.domainState.remoteGitGrant = { op: intent.op, url: target };
      }
      return result;
    },
    'pod/exec': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'pod', ['pod_exec'], [
        'command', 'podId', 'timeoutMs', 'background', 'remoteGitGrant',
      ]);
      const args = entry?.prepared?.call?.args;
      let program;
      let intents;
      try {
        program = parsePodShell(args?.command ?? '');
        intents = podGitRemoteIntents(args?.command ?? '');
      } catch {
        return { ok: false, error: 'pod/exec: invalid admitted command', outcomeKnown: true };
      }
      const expectedTimeout = Math.min(300_000, Math.max(1, Number(args?.timeoutMs) || 30_000));
      const expectedBackground = args?.background === true || program.background;
      const expectedGrant = intents.length === 1
        ? entry?.domainState?.remoteGitGrant ?? null : null;
      if (!entry || intents.length > 1 || typeof entry.domainState.podId !== 'string'
          || msg.command !== args?.command || msg.podId !== entry.domainState.podId
          || msg.timeoutMs !== expectedTimeout || msg.background !== expectedBackground
          || !sameClone(msg.remoteGitGrant, expectedGrant)) {
        return { ok: false, error: 'pod/exec: authority mismatch', outcomeKnown: true };
      }
      const execute = entry.prepared.ctx?.podClient?.exec;
      if (typeof execute !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'pod/exec', 'resource', () => execute(msg.command, {
        podId: msg.podId,
        timeoutMs: expectedTimeout,
        background: expectedBackground,
        remoteGitGrant: expectedGrant,
        signal: expectedBackground ? undefined : /** @type {any} */ (grant).relaySignal,
      }));
    },
    'pod/status': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'pod', ['pod_status'], [
        'podId', 'jobId', 'stream', 'offset', 'limit',
      ]);
      const args = entry?.prepared?.call?.args;
      if (!entry || msg.podId !== args?.podId || msg.jobId !== args?.jobId
          || msg.stream !== args?.stream || msg.offset !== args?.offset
          || msg.limit !== args?.limit) {
        return { ok: false, error: 'pod/status: authority mismatch', outcomeKnown: true };
      }
      const status = entry.prepared.ctx?.podClient?.status;
      if (typeof status !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'pod/status', 'read', () => status({
        sessionId: entry.prepared.ctx.session?.sessionId,
        podId: msg.podId, jobId: msg.jobId, stream: msg.stream,
        offset: msg.offset, limit: msg.limit,
      }));
    },
    'pod/cancel': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'pod', ['pod_cancel'], ['podId', 'jobId']);
      const args = entry?.prepared?.call?.args;
      if (!entry || typeof msg.jobId !== 'string' || msg.jobId !== args?.jobId
          || msg.podId !== args?.podId) {
        return { ok: false, error: 'pod/cancel: authority mismatch', outcomeKnown: true };
      }
      const cancel = entry.prepared.ctx?.podClient?.cancel;
      if (typeof cancel !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'pod/cancel', 'control', () => cancel(msg.jobId, {
        sessionId: entry.prepared.ctx.session?.sessionId, podId: msg.podId,
      }));
    },
    'pod/read-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'pod', ['pod_read'], ['podId', 'path']);
      const args = entry?.prepared?.call?.args;
      if (!entry || typeof msg.path !== 'string' || msg.path !== args?.path
          || msg.podId !== args?.podId) {
        return { ok: false, error: 'pod/read-file: authority mismatch', outcomeKnown: true };
      }
      const readFile = entry.prepared.ctx?.podClient?.readFile;
      if (typeof readFile !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'pod/read-file', 'read', () => readFile(msg.path, {
        sessionId: entry.prepared.ctx.session?.sessionId, podId: msg.podId,
      }));
    },
    'pod/write-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'pod', ['pod_write'], [
        'podId', 'path', 'content',
      ]);
      const args = entry?.prepared?.call?.args;
      if (!entry || typeof msg.path !== 'string' || typeof msg.content !== 'string'
          || msg.path !== args?.path || msg.content !== args?.content
          || msg.podId !== args?.podId) {
        return { ok: false, error: 'pod/write-file: authority mismatch', outcomeKnown: true };
      }
      const writeFile = entry.prepared.ctx?.podClient?.writeFile;
      if (typeof writeFile !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'pod/write-file', 'commit', () => writeFile(
        msg.path, msg.content, {
          sessionId: entry.prepared.ctx.session?.sessionId, podId: msg.podId,
        },
      ));
    },
    'repository/read-pod': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['pod_destroy'], ['podId']);
      if (!entry) return { ok: false, error: 'repository/read-pod: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/read-pod', 'read', () =>
        entry.domainState.authority.readPod(msg.podId));
    },
    'repository/destroy-pod': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['pod_destroy'], ['podId']);
      if (!entry) return { ok: false, error: 'repository/destroy-pod: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/destroy-pod', 'commit', () =>
        entry.domainState.authority.destroyPod(msg.podId));
    },
    'repository/read-status': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_history'], []);
      if (!entry) return { ok: false, error: 'repository/read-status: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/read-status', 'read', () =>
        entry.domainState.authority.readStatus());
    },
    'repository/read-history': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_history'], ['depth']);
      if (!entry) return { ok: false, error: 'repository/read-history: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/read-history', 'read', () =>
        entry.domainState.authority.readHistory(msg.depth));
    },
    'repository/read-remote': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(
        grant, msg, 'repository', ['repo_history', 'repo_remote'], [],
      );
      if (!entry) return { ok: false, error: 'repository/read-remote: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/read-remote', 'read', () =>
        entry.domainState.authority.readRemote());
    },
    'repository/read-diff': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_history'], ['from', 'to']);
      if (!entry) return { ok: false, error: 'repository/read-diff: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/read-diff', 'read', () =>
        entry.domainState.authority.readDiff(msg.from, msg.to));
    },
    'repository/confirm-restore': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_version'], ['to']);
      if (!entry) return { ok: false, error: 'repository/confirm-restore: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/confirm-restore', 'control', () =>
        entry.domainState.authority.confirmRestore(msg.to));
    },
    'repository/checkpoint': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_version'], ['message']);
      if (!entry) return { ok: false, error: 'repository/checkpoint: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/checkpoint', 'commit', () =>
        entry.domainState.authority.checkpoint(msg.message));
    },
    'repository/branch': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_version'], ['name']);
      if (!entry) return { ok: false, error: 'repository/branch: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/branch', 'commit', () =>
        entry.domainState.authority.branch(msg.name));
    },
    'repository/checkout': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_version'], ['name']);
      if (!entry) return { ok: false, error: 'repository/checkout: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/checkout', 'commit', () =>
        entry.domainState.authority.checkout(msg.name));
    },
    'repository/restore': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_version'], ['to']);
      if (!entry) return { ok: false, error: 'repository/restore: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/restore', 'commit', () =>
        entry.domainState.authority.restore(msg.to));
    },
    'repository/confirm-remote': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_remote'], [
        'op', 'target', 'branch',
      ]);
      if (!entry) return { ok: false, error: 'repository/confirm-remote: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/confirm-remote', 'control', () =>
        entry.domainState.authority.confirmRemote(msg.op, msg.target, msg.branch));
    },
    'repository/link': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_remote'], ['url']);
      if (!entry) return { ok: false, error: 'repository/link: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/link', 'commit', () =>
        entry.domainState.authority.link(msg.url));
    },
    'repository/fetch': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_remote'], ['target']);
      if (!entry) return { ok: false, error: 'repository/fetch: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/fetch', 'commit', () =>
        entry.domainState.authority.fetch(msg.target));
    },
    'repository/push': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'repository', ['repo_remote'], ['target', 'branch']);
      if (!entry) return { ok: false, error: 'repository/push: authority mismatch', outcomeKnown: true };
      entry.domainState.authority ??= createRepositoryToolAuthority({
        call: entry.prepared.call, ctx: entry.prepared.ctx,
        signal: /** @type {any} */ (grant).relaySignal,
      });
      return runDomainEffect(entry, 'repository/push', 'resource', () =>
        entry.domainState.authority.push(msg.target, msg.branch));
    },
    'vm/read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['vm_boot', 'vm_delete'], ['vmId']);
      if (!entry) return { ok: false, error: 'vm/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/read', 'read', () =>
        entry.domainState.authority.readVm(msg.vmId));
    },
    'vm/list': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['vm_boot'], []);
      if (!entry) return { ok: false, error: 'vm/list: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/list', 'read', () =>
        entry.domainState.authority.listVms());
    },
    'vm/set-default': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['vm_boot'], ['vmId']);
      if (!entry) return { ok: false, error: 'vm/set-default: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/set-default', 'control', () =>
        entry.domainState.authority.setDefaultVm(msg.vmId));
    },
    'vm/run': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['vm_boot'], ['command', 'timeoutMs', 'vmId']);
      if (!entry) return { ok: false, error: 'vm/run: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/run', 'resource', () =>
        entry.domainState.authority.runVm(msg.command, msg.timeoutMs, msg.vmId));
    },
    'vm/import-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['vm_import'], ['url', 'path', 'maxBytes']);
      if (!entry) return { ok: false, error: 'vm/import-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/import-file', 'resource', () =>
        entry.domainState.authority.importFile(msg.url, msg.path, msg.maxBytes));
    },
    'vm/write-text-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['vm_write_file'], ['path', 'content']);
      if (!entry) return { ok: false, error: 'vm/write-text-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/write-text-file', 'commit', () =>
        entry.domainState.authority.writeTextFile(msg.path, msg.content));
    },
    'vm/destroy': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['vm_delete'], ['vmId']);
      if (!entry) return { ok: false, error: 'vm/destroy: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/destroy', 'commit', () =>
        entry.domainState.authority.destroyVm(msg.vmId));
    },
    'notebook/read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(
        grant, msg, ['js_notebook', 'js_delete'], ['notebookId'],
      );
      if (!entry) return { ok: false, error: 'notebook/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/read', 'read', () =>
        entry.domainState.authority.readNotebook(msg.notebookId));
    },
    'notebook/list': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(grant, msg, ['js_notebook'], []);
      if (!entry) return { ok: false, error: 'notebook/list: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/list', 'read', () =>
        entry.domainState.authority.listNotebooks());
    },
    'notebook/set-default': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(grant, msg, ['js_notebook'], ['notebookId']);
      if (!entry) return { ok: false, error: 'notebook/set-default: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/set-default', 'control', () =>
        entry.domainState.authority.setDefaultNotebook(msg.notebookId));
    },
    'notebook/run': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(
        grant, msg, ['js_notebook'], ['code', 'timeoutMs', 'notebookId'],
      );
      if (!entry) return { ok: false, error: 'notebook/run: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/run', 'resource', () =>
        entry.domainState.authority.runNotebook(msg.code, msg.timeoutMs, msg.notebookId));
    },
    'notebook/write-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(
        grant, msg, ['js_write_file'], ['path', 'content', 'notebookId'],
      );
      if (!entry) return { ok: false, error: 'notebook/write-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/write-file', 'commit', () =>
        entry.domainState.authority.writeFile(msg.path, msg.content, msg.notebookId));
    },
    'notebook/read-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(
        grant, msg, ['js_read_file'], ['path', 'notebookId'],
      );
      if (!entry) return { ok: false, error: 'notebook/read-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/read-file', 'read', () =>
        entry.domainState.authority.readFile(msg.path, msg.notebookId));
    },
    'notebook/destroy': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(grant, msg, ['js_delete'], ['notebookId']);
      if (!entry) return { ok: false, error: 'notebook/destroy: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/destroy', 'commit', () =>
        entry.domainState.authority.destroyNotebook(msg.notebookId));
    },
    'actor/tool-settle': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      const policy = entry ? CONTROLLER_TOOL_MANIFEST.tools[entry.toolName] : null;
      if (!grant || !exactKeys(msg, ['executionId', 'result'])
          || !entry || entry.open !== true || !policy
          || structuredClonePayloadBytes(msg.result) > policy.resultBytes
          || typeof settleToolCall !== 'function') {
        return { ok: false, error: 'actor/tool-settle: authority mismatch', outcomeKnown: true };
      }
      entry.open = false;
      try {
        const executionResult = entry.unknownIrreversible === true ? {
          ok: false,
          error: 'Tool outcome unknown. Check authority state before retrying.',
          code: 'tool-outcome-unknown',
          outcomeKnown: false,
          retryable: false,
          outcomeKind: 'host-lost',
        } : msg.result;
        const result = await settleToolCall(entry.prepared, { result: executionResult });
        grant.actorExecutions.delete(msg.executionId);
        return { ok: true, result };
      } catch (cause) {
        return {
          ok: false, error: cause instanceof Error ? cause.message : String(cause),
          outcomeKnown: entry.effectEntered !== true,
          retryable: entry.effectEntered !== true,
        };
      }
    },
    /**
     * @param {{ relayToken?: string, event?: object }} [msg]
     * @param {unknown} [sender] - must be the offscreen document (see grantFor).
     */
    'actor/loop-event': (msg = {}, sender = undefined, boundGrant = null) => {
      // Lowest-authority of the three (it only feeds the actor card + cost meter),
      // but bound the same way: an unauthorized sender could otherwise inject
      // fabricated progress/cost events into another run's UI.
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant) return { ok: false, error: 'actor/loop-event: unauthorized relay' };
      if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
      if (grant.loopEvents >= loopEventLimit) return { ok: true, coalesced: true };
      grant.loopEvents += 1;
      try { if (msg.event) runOnEvent.get(grant.runId)?.(msg.event); } catch { /* never break the relay */ }
      return { ok: true };
    },
  };

  return { run, routes };
};
