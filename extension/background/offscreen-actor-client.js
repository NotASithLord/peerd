// @ts-check
// background/offscreen-actor-client.js: the privileged-host client for EVERY isolated
// agent loop (the heap split): ephemeral spawned reasoners (spawn.js) AND bound
// actors (the actor turn). Provider semantics stay in the isolated Worker; this
// client exposes exact inference and named domain-authority routes. The worker
// receives no generic tool, browser, storage, credential, or fetch authority.
//
// Pure shell — every IO injected — so it is unit-testable without a browser.

import {
  CONTROLLER_AUTHORITY_MANIFEST,
  controllerAuthorityClassAllowed,
} from '/shared/controller-authority-manifest.js';
import { structuredClonePayloadBytes } from '/shared/structured-clone-size.js';
import {
  normalizeHostEffectOutcome,
  stampHostEffectVerdict,
} from '/shared/tool-execution-protocol.js';
import { HOST_EFFECT_OUTCOME } from './host-effect-verdict.js';
import { parsePodShell, podGitRemoteIntents } from '/peerd-engine/authority.js';
import { bindRepositoryToolAuthority } from './repository-tool-authority.js';
import { bindVmToolAuthority } from './vm-tool-authority.js';
import { bindNotebookToolAuthority } from './notebook-tool-authority.js';
import { bindAppToolAuthority } from './app-tool-authority.js';
import { bindPersistenceToolAuthority } from './persistence-tool-authority.js';
import { bindPageToolAuthority } from './page-tool-authority.js';
import { bindResourceToolAuthority } from './resource-tool-authority.js';
import { bindSiteClientToolAuthority } from './site-client-tool-authority.js';
import { bindExecutionToolAuthority } from './execution-tool-authority.js';
import { bindEditingToolAuthority } from './editing-tool-authority.js';
import { bindIntrospectionToolAuthority } from './introspection-tool-authority.js';
import { bindScheduleToolAuthority } from './schedule-tool-authority.js';
import { bindDwebToolAuthority } from './dweb-tool-authority.js';
import {
  isPageProgramSemanticTool,
} from '/shared/page-program-authority.js';

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

/** @returns {boolean} */
const sameClone = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && sameClone(Reflect.get(left, key), Reflect.get(right, key)));
  }
  if (left instanceof ArrayBuffer || right instanceof ArrayBuffer) {
    if (!(left instanceof ArrayBuffer) || !(right instanceof ArrayBuffer)
        || left.byteLength !== right.byteLength) return false;
    const leftBytes = new Uint8Array(left);
    const rightBytes = new Uint8Array(right);
    return leftBytes.every((byte, index) => byte === rightBytes[index]);
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)
        || left.constructor !== right.constructor || left.byteLength !== right.byteLength) return false;
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return leftBytes.every((byte, index) => byte === rightBytes[index]);
  }
  const leftRecord = /** @type {Record<string,unknown>} */ (left);
  const rightRecord = /** @type {Record<string,unknown>} */ (right);
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameClone(leftRecord[key], rightRecord[key]));
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
 * @param {(call: object, ctx: object, descriptor?:object) => Promise<any>} [deps.prepareToolCall]
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
 * @param {readonly object[]} [deps.pageProgramToolDescriptors] authority-only
 *   policy projections for the fixed page-code semantic helpers.
 * @param {number} [deps.maxModelRelaysPerRun]
 * @param {number} [deps.maxToolRelaysPerRun]
 * @param {number} [deps.maxLoopEventsPerRun]
 * @param {number} [deps.settlementCleanupMs]
 */
export const makeOffscreenActorClient = ({
  ensureHost, ensureOffscreen, sendMessage, runOnChannel, providerEgress,
  sessions, buildToolContext, prepareToolCall, settleToolCall,
  pinActorCall, restrictCtxCapabilities, ownedTabFor, EXPOSURE_ACTOR,
  now = Date.now,
  recordModelCall = () => {},
  broadcastOp = (/** @type {any} */ _msg) => {},
  mintRelayToken = () => globalThis.crypto.randomUUID(),
  spendRefusalFor = undefined,
  isRelaySender, isOffscreenSender,
  inboundDwebToolNames = [],
  pageProgramToolDescriptors = [],
  maxModelRelaysPerRun = 100,
  maxToolRelaysPerRun = 128,
  maxLoopEventsPerRun = 256,
  settlementCleanupMs = 250,
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
  const cleanupFuseMs = Number.isFinite(settlementCleanupMs) && settlementCleanupMs > 0
    ? Math.floor(settlementCleanupMs) : 250;
  const boundedCleanup = (/** @type {Promise<unknown>} */ pending) =>
    new Promise((resolve) => {
      let finished = false;
      const finish = (/** @type {unknown} */ value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), cleanupFuseMs);
      pending.then(finish, () => finish(undefined));
    });
  let seq = 0;
  /**
   * @type {Map<string, { runId: string, actorSessionId: string, provider: string, model: string, maxOutputTokens?: number, providerOwner: object, inbound: boolean, allowedTools: Set<string> | null, toolDescriptors:Map<string,any>, pageProgramToolDescriptors:Map<string,any>, actorSurface?: 'tools'|'code', relaySignal: AbortSignal, modelRelays: number, toolRelays: number, loopEvents: number, modelActive: boolean, modelStreamId: string | null, contextRead:boolean, actorExecutions:Map<string,any> }>} Firefox relay grants:
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
   * @param {{ actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, probeOnly?: boolean, depth?: number, maxSteps?: number, maxOutputTokens?: number, tools?: any[], priorMessages?: any[], reasoningEnabled?: boolean, reasoningEffort?: string, contextWindowOverrides?:Record<string,number>, budgetMs?: number, oneShot?: boolean, actorType?: string, backing?: string, actorSurface?: 'tools'|'code', tabOrigin?: string, origin?: string, inbound?: boolean }} job
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
      toolDescriptors: new Map((tools ?? []).map((tool) => [tool?.name, tool])),
      pageProgramToolDescriptors: new Map(pageProgramToolDescriptors
        .filter((tool) => isPageProgramSemanticTool(/** @type {any} */ (tool)?.name))
        .map((tool) => [/** @type {any} */ (tool).name, tool])),
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
      // Stop/host loss closes new exact effects synchronously. Settlement may
      // still join or retry its frozen result, but no effect can enter behind it.
      for (const entry of grant.actorExecutions.values()) entry.effectsOpen = false;
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
      try {
        abortRelays();
        // Drop the abort listener a completed-without-Stop run left attached (a no-op if
        // it already fired under {once:true}); keeps nothing dangling on the turn signal.
        signal?.removeEventListener('abort', abortRun);
        relayController.abort();
        if (providerEgress?.closeOwner) {
          await boundedCleanup(Promise.resolve().then(() =>
            providerEgress.closeOwner(grant.providerOwner)));
        }
        if (typeof settleToolCall === 'function') {
          await Promise.allSettled([...grant.actorExecutions.values()].map(async (entry) => {
            if (entry.open !== true) return;
            const cleanupResult = entry.hasSettlementResult === true
              ? entry.settlementResult
              : {
                ok: false,
                error: 'actor semantic execution host was lost before settlement',
                code: 'actor-tool-host-lost',
                outcomeKnown: entry.effectEntered !== true,
                retryable: entry.effectEntered !== true,
                outcomeKind: entry.effectEntered === true ? 'host-lost' : 'pre-effect-failure',
              };
            // why: cleanup joins or starts the one durable attempt but cannot let a
            // user hook pin provider custody and a live relay grant forever.
            await boundedCleanup(settleActorExecution(grant, entry, cleanupResult));
          }));
        }
      } finally {
        grant.actorExecutions.clear();
        // Retiring the grant is what makes it a liveness check: every relay for
        // this run is refused from here on, so a late/replayed one can't dispatch.
        if (!runOnChannel) grants.delete(relayToken);
        runOnEvent.delete(runId);
        runMeta.delete(runId);
        abortedRuns.delete(runId);
      }
    }
  };

  /**
   * Resolve a relay's identity. Chrome passes the grant through a private channel
   * closure. Firefox requires its private host sender identity and a live grant
   * token. Every route treats a missing or retired grant as a hard refusal.
   * @param {{ relayToken?: unknown }} [msg]
   * @param {unknown} [sender]  the second argument makeDispatcher hands a handler
   * @returns {{ runId: string, actorSessionId: string, provider: string, model: string, maxOutputTokens?: number, providerOwner: object, inbound: boolean, allowedTools: Set<string> | null, toolDescriptors:Map<string,any>, pageProgramToolDescriptors:Map<string,any>, actorSurface?: 'tools'|'code', relaySignal: AbortSignal, modelRelays: number, toolRelays: number, loopEvents: number, modelActive: boolean, modelStreamId: string | null, contextRead:boolean, actorExecutions:Map<string,any> } | null}
   */
  const grantFor = (msg, sender, boundGrant = null) => {
    if (boundGrant) return boundGrant;
    if (!relaySenderAllowed(sender)) return null;
    const token = msg?.relayToken;
    if (typeof token !== 'string' || token.length === 0) return null;
    return grants.get(token) ?? null;
  };

  /** Build the exact live actor context from SW-owned run and session custody. */
  const contextForTool = async (
    /** @type {any} */ grant,
    /** @type {any} */ call,
    /** @type {{pageProgram?:boolean}} */ options = {},
  ) => {
    const { actorSessionId } = grant;
    if (grant.inbound && (typeof call?.name !== 'string'
        || !grant.allowedTools?.has(call.name))) {
      return { ok: false, error: `tool_not_available_to_inbound_actor: ${call?.name}` };
    }
    const rec = await sessions.get(actorSessionId);
    if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
    if (!rec) return { ok: false, error: 'actor/tool-prepare: unknown session' };
    if (rec.kind === 'spawned') {
      if (!restrictCtxCapabilities) {
        return { ok: false, error: 'actor/tool-prepare: actor offscreen not wired' };
      }
      const persistedGrants = new Set(Array.isArray(rec.grantedTools) ? rec.grantedTools : []);
      const granted = grant.inbound
        ? new Set([...persistedGrants].filter((name) => grant.allowedTools?.has(name)))
        : persistedGrants;
      if (typeof call?.name !== 'string' || !granted.has(call.name)) {
        return { ok: false, error: `tool_not_available_to_actor: ${call?.name}` };
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
      }, granted) };
    }
    if (rec.kind !== 'actor') {
      return { ok: false, error: 'actor/tool-prepare: not an actor or actor session' };
    }
    const activeTabId = rec.actorType === 'web' && rec.backing !== 'api' && ownedTabFor
      ? ownedTabFor(actorSessionId) : undefined;
    if (grant.inbound && !restrictCtxCapabilities) {
      return { ok: false, error: 'actor/tool-prepare: inbound capability filter not wired' };
    }
    const base = await buildToolContext({
      exposure: EXPOSURE_ACTOR, sessionId: actorSessionId, activeTabId,
      actorInstanceId: rec.instanceId, actorType: rec.actorType, actorBacking: rec.backing,
      lifecycleTurnId: grant.runId,
      lifecycleUserInitiated: !grant.inbound,
      ...(options.pageProgram === true
        ? { actorSurface: 'tools' }
        : grant.actorSurface ? { actorSurface: grant.actorSurface } : {}),
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
    /** @type {string[]} */ fields,
  ) => {
    const entry = grant?.actorExecutions.get(msg.executionId);
    return entryEffectsAllowed(grant, entry)
      && exactKeys(msg, ['executionId', ...fields])
      && entry.authorityClass === domain ? entry : null;
  };

  const entryEffectsAllowed = (/** @type {any} */ grant, /** @type {any} */ entry) => {
    if (!grant || grant.relaySignal.aborted || entry?.open !== true
        || entry.effectsOpen !== true) return false;
    const seen = new Set();
    let current = entry;
    while (typeof current.parentExecutionId === 'string') {
      if (seen.has(current.executionId)) return false;
      seen.add(current.executionId);
      current = grant.actorExecutions.get(current.parentExecutionId);
      if (!current || current.open !== true || current.effectsOpen !== true) return false;
    }
    return true;
  };

  const closeEntryEffects = (
    /** @type {any} */ grant,
    /** @type {any} */ entry,
    /** @type {Set<string>} */ seen = new Set(),
  ) => {
    if (!entry || seen.has(entry.executionId)) return;
    seen.add(entry.executionId);
    entry.effectsOpen = false;
    for (const childId of entry.childExecutionIds ?? []) {
      closeEntryEffects(grant, grant.actorExecutions.get(childId), seen);
    }
  };
  const propagateSettledCustody = (/** @type {any} */ grant, /** @type {any} */ entry) => {
    const effectEntered = entry.effectEntered === true;
    const unknown = entry.unknownIrreversible === true || entry.effectPending > 0
      || entry.pendingIrreversible > 0;
    const settledIrreversible = entry.settledIrreversible === true;
    const effectVerdictObserved = entry.effectVerdictObserved === true;
    const seen = new Set([entry.executionId]);
    let parentId = entry.parentExecutionId;
    while (typeof parentId === 'string') {
      const parent = grant.actorExecutions.get(parentId);
      if (!parent || seen.has(parent.executionId)) return;
      seen.add(parent.executionId);
      if (effectEntered) parent.effectEntered = true;
      if (unknown) parent.unknownIrreversible = true;
      if (settledIrreversible) parent.settledIrreversible = true;
      if (effectVerdictObserved) parent.effectVerdictObserved = true;
      parentId = parent.parentExecutionId;
    }
  };
  const repositoryEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'repository', fields);
    if (!entry) return null;
    bindRepositoryToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
      signal: /** @type {any} */ (grant).relaySignal,
    });
    return entry;
  };
  const vmEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'vm', fields);
    if (!entry) return null;
    bindVmToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
    });
    return entry;
  };
  const notebookEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'notebook', fields);
    if (!entry) return null;
    bindNotebookToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
      signal: /** @type {any} */ (grant).relaySignal,
    });
    return entry;
  };
  const appEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'app', fields);
    if (!entry) return null;
    bindAppToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
      signal: /** @type {any} */ (grant).relaySignal,
    });
    return entry;
  };
  const persistenceEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'persistence', fields);
    if (!entry) return null;
    bindPersistenceToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
    });
    return entry;
  };
  const pageEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields = [],
  ) => {
    const entry = domainEntry(grant, msg, 'page', fields);
    if (!entry) return null;
    bindPageToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
      signal: /** @type {any} */ (grant).relaySignal,
      ...(typeof msg.pageProgramSemanticToken === 'string'
        ? { pageProgramSemanticToken: msg.pageProgramSemanticToken }
        : {}),
    });
    return entry;
  };
  const resourceEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'resource', fields);
    if (!entry) return null;
    bindResourceToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
      signal: /** @type {any} */ (grant).relaySignal,
    });
    return entry;
  };
  const siteClientEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'siteclient', fields);
    if (!entry) return null;
    bindSiteClientToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
      signal: /** @type {any} */ (grant).relaySignal,
    });
    return entry;
  };
  const executionEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'execution', fields);
    if (!entry) return null;
    bindExecutionToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
      signal: /** @type {any} */ (grant).relaySignal,
    });
    return entry;
  };
  const editingEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'editing', fields);
    if (!entry) return null;
    bindEditingToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
    });
    return entry;
  };
  const introspectionEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'introspection', fields);
    if (!entry) return null;
    bindIntrospectionToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
    });
    return entry;
  };
  const scheduleEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'schedule', fields);
    if (!entry) return null;
    bindScheduleToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
      signal: /** @type {any} */ (grant).relaySignal,
    });
    return entry;
  };
  const dwebEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainEntry(grant, msg, 'dweb', fields);
    if (!entry) return null;
    bindDwebToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.prepared.ctx,
      signal: /** @type {any} */ (grant).relaySignal,
    });
    return entry;
  };

  const runDomainEffect = async (
    /** @type {any} */ entry,
    /** @type {string} */ operation,
    /** @type {'read'|'control'|'commit'|'resource'} */ riskClass,
    /** @type {()=>Promise<any>|any} */ execute,
    /** @type {boolean} */ recordEffectVerdict = false,
    /** @type {{fulfilled?:(value:any)=>unknown,rejected?:(cause:unknown)=>unknown}|null} */ effectOutcome = null,
  ) => {
    if (entry.domainCalls.has(operation)) {
      return { ok: false, error: `${operation}: authority already used`, outcomeKnown: true };
    }
    const replayable = riskClass === 'read' || riskClass === 'control';
    if ((!replayable || recordEffectVerdict)
        && (typeof effectOutcome?.fulfilled !== 'function'
          || typeof effectOutcome?.rejected !== 'function')) {
      return {
        ok: false, error: `${operation}: effect verdict contract unavailable`,
        outcomeKnown: true, retryable: false,
      };
    }
    entry.domainCalls.add(operation);
    if (!replayable || recordEffectVerdict) entry.effectVerdictObserved = true;
    entry.effectEntered = true;
    entry.effectPending += 1;
    if (!replayable) entry.pendingIrreversible += 1;
    try {
      const value = await execute();
      if (!replayable || recordEffectVerdict) {
        const verdict = normalizeHostEffectOutcome(effectOutcome?.fulfilled?.(value));
        if (verdict === 'performed') entry.settledIrreversible = true;
        else if (verdict === 'unknown') entry.unknownIrreversible = true;
      }
      return { ok: true, value, outcomeKnown: true };
    }
    catch (cause) {
      const detail = /** @type {{message?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
      const verdict = replayable && !recordEffectVerdict ? 'not-performed'
        : normalizeHostEffectOutcome(effectOutcome?.rejected?.(cause));
      if (verdict === 'performed') entry.settledIrreversible = true;
      const outcomeKnown = replayable || verdict !== 'unknown';
      if (!outcomeKnown) entry.unknownIrreversible = true;
      return {
        ok: false, error: detail?.message ?? String(cause), outcomeKnown,
        retryable: verdict === 'not-performed' && detail?.retryable !== false,
      };
    } finally {
      entry.effectPending = Math.max(0, entry.effectPending - 1);
      if (!replayable) {
        entry.pendingIrreversible = Math.max(0, entry.pendingIrreversible - 1);
      }
    }
  };

  const runDirectActorEffect = async (
    /** @type {any} */ entry,
    /** @type {string} */ operation,
    /** @type {'read'|'control'|'commit'} */ riskClass,
    /** @type {()=>Promise<any>|any} */ execute,
    /** @type {{fulfilled?:(value:any)=>unknown,rejected?:(cause:unknown)=>unknown}|null} */ effectOutcome = null,
  ) => {
    const result = await runDomainEffect(
      entry, operation, riskClass, execute, false, effectOutcome,
    );
    return result.ok === true ? { ok: true, value: result.value } : result;
  };

  const settleActorExecution = (
    /** @type {any} */ grant,
    /** @type {any} */ entry,
    /** @type {unknown} */ result,
  ) => {
    // Settlement freezes the result and synchronously closes every effect route.
    // Durable persistence may retry, but authority can never reopen around it.
    closeEntryEffects(grant, entry);
    if (entry.settling) return entry.settling;
    if (entry.hasReportedSettlementResult !== true) {
      entry.reportedSettlementResult = structuredClone(result);
      entry.hasReportedSettlementResult = true;
      const liveChildren = [...entry.childExecutionIds]
        .map((id) => grant.actorExecutions.get(id))
        .filter((child) => child?.open === true);
      const pending = entry.effectPending > 0;
      const alreadyUnknown = entry.unknownIrreversible === true;
      const descendantEffect = liveChildren.some((child) =>
        child.effectEntered === true || child.effectPending > 0
        || child.unknownIrreversible === true);
      if (pending || descendantEffect) entry.unknownIrreversible = true;
      const effectStateKnown = entry.unknownIrreversible !== true
        && !pending && liveChildren.length === 0;
      let effectiveResult = entry.reportedSettlementResult;
      if (!effectStateKnown) {
        const effectWasAlreadyUnknown = alreadyUnknown
          && !pending && liveChildren.length === 0;
        effectiveResult = {
          ok: false,
          error: effectWasAlreadyUnknown
            ? 'Tool outcome unknown. Check authority state before retrying.'
            : 'Tool execution settled while exact authority remained active.',
          code: effectWasAlreadyUnknown
            ? 'tool-outcome-unknown' : 'actor-tool-effect-pending',
          outcomeKnown: false,
          retryable: false,
          outcomeKind: 'host-lost',
        };
      } else if (entry.effectVerdictObserved === true
          || effectiveResult && typeof effectiveResult === 'object'
          && !Array.isArray(effectiveResult)
          && (Object.hasOwn(effectiveResult, 'performed')
            || Object.hasOwn(effectiveResult, 'effectEntered')
            || /** @type {any} */ (effectiveResult).outcomeKind === 'effect-completed')) {
        // why: the isolated semantic heap may shape content, but only the SW
        // observed whether an exact irreversible/resource operation completed.
        effectiveResult = stampHostEffectVerdict(effectiveResult, {
          effectEntered: entry.effectEntered === true,
          performed: entry.settledIrreversible === true,
          invalidCode: 'actor-tool-result-invalid-after-effect',
          invalidError: entry.settledIrreversible === true
            ? 'Actor semantic result was invalid after an irreversible effect completed.'
            : 'Actor semantic result was invalid.',
        });
      }
      entry.settlementResult = structuredClone(effectiveResult);
      entry.hasSettlementResult = true;
    }
    const pending = (async () => {
      try {
        const settled = await /** @type {Function} */ (settleToolCall)(
          entry.prepared, { result: entry.settlementResult },
        );
        // A child may be unlinked after durable settlement, but its custody
        // facts remain part of the parent page_code execution forever.
        propagateSettledCustody(grant, entry);
        entry.open = false;
        grant.actorExecutions.delete(entry.executionId);
        if (typeof entry.parentExecutionId === 'string') {
          grant.actorExecutions.get(entry.parentExecutionId)
            ?.childExecutionIds?.delete(entry.executionId);
        }
        return { ok: true, result: settled };
      } catch (cause) {
        return {
          ok: false, error: cause instanceof Error ? cause.message : String(cause),
          outcomeKnown: entry.effectEntered !== true,
          retryable: entry.effectEntered !== true,
        };
      } finally {
        entry.settling = null;
      }
    })();
    entry.settling = pending;
    return pending;
  };

  const preparationStillLive = (
    /** @type {any} */ grant,
    /** @type {boolean} */ nested,
    /** @type {string|undefined} */ parentExecutionId,
    /** @type {any} */ parent,
  ) => !grant.relaySignal.aborted && (!nested
    || (grant.actorExecutions.get(parentExecutionId) === parent
      && entryEffectsAllowed(grant, parent)));

  const retirePreparedWithoutAuthority = (/** @type {any} */ prepared) => {
    if (prepared?.prepared !== true || typeof settleToolCall !== 'function') return;
    const result = {
      ok: false,
      error: 'actor tool preparation lost its live authority before execution',
      code: 'actor-tool-prepare-aborted',
      outcomeKnown: true,
      retryable: true,
      outcomeKind: 'pre-effect-failure',
    };
    void boundedCleanup(Promise.resolve().then(() =>
      settleToolCall(prepared, { result })));
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
          grant.modelActive = false;
          grant.modelStreamId = null;
          await boundedCleanup(Promise.resolve().then(() =>
            providerEgress.closeOwner(grant.providerOwner)));
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
      if (grant.relaySignal.aborted || abortedRuns.has(grant.runId)) {
        grant.modelActive = false;
        grant.modelStreamId = null;
        await boundedCleanup(Promise.resolve().then(() =>
          providerEgress.closeOwner(grant.providerOwner)));
        return { ok: false, error: 'aborted' };
      }
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
    /** Admit one controller-owned tool without executing its semantics in the SW. */
    'actor/tool-prepare': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const call = msg.call;
      const domain = msg.authorityClass;
      const pageProgramParentExecutionId = msg.pageProgramParentExecutionId;
      const nestedPageProgram = typeof pageProgramParentExecutionId === 'string'
        && pageProgramParentExecutionId.length > 0;
      const parent = nestedPageProgram
        ? grant?.actorExecutions.get(pageProgramParentExecutionId) : null;
      if (!grant || !exactKeys(
        msg, ['call', 'authorityClass'], ['relayToken', 'pageProgramParentExecutionId'],
      )
          || !controllerAuthorityClassAllowed(domain)
          || typeof prepareToolCall !== 'function'
          || typeof settleToolCall !== 'function'
          || (nestedPageProgram && (!entryEffectsAllowed(grant, parent)
            || parent.toolName !== 'page_code' || parent.authorityClass !== 'page'
            || !isPageProgramSemanticTool(call?.name)))) {
        return { ok: false, error: 'actor/tool-prepare: unauthorized semantic owner' };
      }
      if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
      if (grant.toolRelays >= toolRelayLimit) return {
        ok: false, error: 'actor/tool-prepare: relay budget exhausted',
        code: 'actor_tool_relay_limit', outcomeKnown: true, performed: false,
      };
      grant.toolRelays += 1;
      const admittedContext = await contextForTool(grant, call, {
        pageProgram: nestedPageProgram,
      });
      if (admittedContext.ok !== true) return admittedContext;
      if (!preparationStillLive(
        grant, nestedPageProgram, pageProgramParentExecutionId, parent,
      )) {
        return { ok: false, error: grant.relaySignal.aborted
          ? 'aborted' : 'actor/tool-prepare: parent authority retired' };
      }
      const descriptor = nestedPageProgram
        ? grant.pageProgramToolDescriptors.get(call?.name)
        : grant.toolDescriptors.get(call?.name);
      if (nestedPageProgram && !descriptor) {
        return { ok: false, error: 'actor/tool-prepare: authority policy is unavailable' };
      }
      const prepared = await prepareToolCall(
        call, admittedContext.ctx, descriptor,
      );
      if (!preparationStillLive(
        grant, nestedPageProgram, pageProgramParentExecutionId, parent,
      )) {
        retirePreparedWithoutAuthority(prepared);
        return { ok: false, error: grant.relaySignal.aborted
          ? 'aborted' : 'actor/tool-prepare: parent authority retired' };
      }
      if (prepared?.prepared !== true) return { ok: true, mode: 'result', result: prepared };
      const policy = CONTROLLER_AUTHORITY_MANIFEST.tools[domain];
      if (!policy || structuredClonePayloadBytes(prepared.args) > policy.argumentBytes) {
        retirePreparedWithoutAuthority(prepared);
        return { ok: false, error: 'actor/tool-prepare: semantic arguments exceed authority limits' };
      }
      let authorityCall;
      try {
        // why: the model-issued call remains the admission proof, while exact
        // authority compares against the post-hook args sent to the isolated
        // semantic executor.
        authorityCall = Object.freeze({
          ...call, args: structuredClone(prepared.args),
        });
      } catch {
        retirePreparedWithoutAuthority(prepared);
        return { ok: false, error: 'actor/tool-prepare: semantic arguments are not cloneable' };
      }
      const executionId = `ae-${now().toString(36)}-${++seq}`;
      grant.actorExecutions.set(executionId, {
        executionId,
        open: true, effectsOpen: true, settling: null,
        hasReportedSettlementResult: false, reportedSettlementResult: undefined,
        hasSettlementResult: false, settlementResult: undefined,
        effectEntered: false, effectPending: 0, pendingIrreversible: 0,
        settledIrreversible: false, unknownIrreversible: false,
        effectVerdictObserved: false,
        parentExecutionId: nestedPageProgram ? pageProgramParentExecutionId : null,
        childExecutionIds: new Set(),
        domainCalls: new Set(), domainState: {}, prepared,
        call: authorityCall, toolName: call.name, authorityClass: domain,
      });
      if (nestedPageProgram) parent.childExecutionIds.add(executionId);
      const projection = domain === 'actor' ? {
        sessionId: admittedContext.ctx.session?.sessionId,
        sessionDepth: admittedContext.ctx.session?.depth ?? 0,
        sessionKind: admittedContext.ctx.session?.kind ?? 'spawned',
        inbound: admittedContext.ctx.inbound === true,
      } : domain === 'repository' ? {
        actorType: admittedContext.ctx.actorType,
        actorInstanceId: admittedContext.ctx.actorInstanceId,
      } : domain === 'persistence' ? {
        sessionId: admittedContext.ctx.session?.sessionId,
        activeTabOrigin: admittedContext.ctx.activeTab?.origin,
        goalActive: !!admittedContext.ctx.todoStore,
      } : domain === 'resource' ? {
        sessionId: admittedContext.ctx.session?.sessionId,
        runtimeCapabilities: admittedContext.ctx.runtimeCapabilities,
      } : domain === 'execution' ? {
        sessionId: admittedContext.ctx.session?.sessionId,
        sessionKind: admittedContext.ctx.session?.kind ?? 'spawned',
      } : call.name === 'load_skill' ? {
        sessionId: admittedContext.ctx.session?.sessionId,
        messageCount: admittedContext.ctx.session?.messageCount ?? 0,
        trimCovered: admittedContext.ctx.session?.trimCovered ?? 0,
      } : domain === 'dweb' ? {
        sessionId: admittedContext.ctx.session?.sessionId,
        dwebAvailable: admittedContext.ctx.dweb != null,
      } : { sessionId: admittedContext.ctx.session?.sessionId };
      return {
        ok: true, mode: 'execute', executionId,
        callId: typeof call.id === 'string' && call.id ? call.id : executionId,
        toolName: call.name, args: authorityCall.args,
        projection,
      };
    },
    'actor/spawn-sync': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      const args = entry?.call?.args;
      const expectedTools = Array.isArray(args?.tools) ? args.tools : undefined;
      const expectedMaxSteps = Number.isFinite(args?.maxSteps) ? args.maxSteps : undefined;
      const expectedMaxDepth = Number.isFinite(args?.maxDepth) ? args.maxDepth : undefined;
      if (!entryEffectsAllowed(grant, entry)
          || !exactKeys(msg, ['executionId', 'task', 'allowRecursion'], [
        'relayToken', 'tools', 'maxSteps', 'maxDepth',
      ])
          || entry.toolName !== 'actor_create'
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
      const ctx = entry.prepared.ctx;
      if (typeof ctx?.actorAuthority?.spawnSync !== 'function') {
        entry.domainCalls.add('actor/spawn-sync');
        entry.effectEntered = true;
        entry.effectVerdictObserved = true;
        return { ok: true, value: { refused: true, result: 'actor_orchestrator_unavailable' } };
      }
      return runDirectActorEffect(entry, 'actor/spawn-sync', 'commit', () =>
        ctx.actorAuthority.spawnSync({
          task: msg.task,
          ...(msg.tools === undefined ? {} : { tools: msg.tools }),
          ...(msg.maxSteps === undefined ? {} : { maxSteps: msg.maxSteps }),
          ...(msg.maxDepth === undefined ? {} : { maxDepth: msg.maxDepth }),
          allowRecursion: msg.allowRecursion,
          parentSessionId: ctx.session?.sessionId,
          parentDepth: ctx.session?.depth ?? 0,
          parentInbound: ctx.inbound === false ? false : true,
          parentToolUseId: entry.call?.id,
        }), HOST_EFFECT_OUTCOME.actorResult);
    },
    'actor/spawn-async': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      const args = entry?.call?.args;
      const expectedTools = Array.isArray(args?.tools) ? args.tools : undefined;
      const expectedMaxSteps = Number.isFinite(args?.maxSteps) ? args.maxSteps : undefined;
      const expectedMaxDepth = Number.isFinite(args?.maxDepth) ? args.maxDepth : undefined;
      if (!entryEffectsAllowed(grant, entry)
          || !exactKeys(msg, ['executionId', 'task', 'allowRecursion'], [
        'relayToken', 'tools', 'maxSteps', 'maxDepth',
      ])
          || entry.toolName !== 'actor_create'
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
      const ctx = entry.prepared.ctx;
      if (typeof ctx?.actorAuthority?.spawnAsync !== 'function') {
        entry.domainCalls.add('actor/spawn-async');
        entry.effectEntered = true;
        entry.effectVerdictObserved = true;
        return { ok: true, value: { ok: false, error: 'async_actor_unavailable' } };
      }
      return runDirectActorEffect(entry, 'actor/spawn-async', 'commit', () =>
        ctx.actorAuthority.spawnAsync({
          task: msg.task,
          ...(msg.tools === undefined ? {} : { tools: msg.tools }),
          ...(msg.maxSteps === undefined ? {} : { maxSteps: msg.maxSteps }),
          ...(msg.maxDepth === undefined ? {} : { maxDepth: msg.maxDepth }),
          allowRecursion: msg.allowRecursion,
          parentSessionId: ctx.session?.sessionId,
          parentDepth: ctx.session?.depth ?? 0,
          parentInbound: ctx.inbound === false ? false : true,
          parentToolUseId: entry.call?.id,
        }), HOST_EFFECT_OUTCOME.actorResult);
    },
    'actor/tasks-read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      if (!entryEffectsAllowed(grant, entry) || !exactKeys(msg, ['executionId'])
          || entry.toolName !== 'actor_tasks'
          || entry.domainCalls.size > 0) {
        return { ok: false, error: 'actor/tasks-read: authority mismatch', outcomeKnown: true };
      }
      const read = entry.prepared.ctx?.actorAuthority?.listTasks;
      return runDirectActorEffect(entry, 'actor/tasks-read', 'read', () =>
        typeof read === 'function' ? read() : []);
    },
    'actor/task-cancel': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      if (!entryEffectsAllowed(grant, entry) || !exactKeys(msg, ['executionId', 'taskId'])
          || entry.toolName !== 'actor_cancel'
          || entry.domainCalls.size > 0 || typeof msg.taskId !== 'string' || !msg.taskId
          || msg.taskId !== entry.call?.args?.taskId) {
        return { ok: false, error: 'actor/task-cancel: authority mismatch', outcomeKnown: true };
      }
      const cancel = entry.prepared.ctx?.actorAuthority?.cancelTask;
      return runDirectActorEffect(entry, 'actor/task-cancel', 'control', () =>
        typeof cancel === 'function'
          ? cancel(msg.taskId) : { ok: false, error: 'async_actor_unavailable' });
    },
    'actor/message-deliver': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      const args = entry?.call?.args;
      const sessionKind = entry?.prepared?.ctx?.session?.kind;
      if (!entryEffectsAllowed(grant, entry) || !exactKeys(msg, [
        'executionId', 'to', 'message', 'oneShot', 'awaitReply',
        'degradeToAsync', 'awaitCapMs',
      ])
          || entry.toolName !== 'message_actor'
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
      const ctx = entry.prepared.ctx;
      if (typeof ctx?.actorAuthority?.deliverMessage !== 'function') {
        entry.domainCalls.add('actor/message-deliver');
        entry.effectEntered = true;
        entry.effectVerdictObserved = true;
        return { ok: true, value: { ok: false, error: 'message_actor is not enabled' } };
      }
      return runDirectActorEffect(entry, 'actor/message-deliver', 'commit', () =>
        ctx.actorAuthority.deliverMessage({
          to: msg.to, message: msg.message, oneShot: msg.oneShot,
          senderSessionId: ctx.session?.sessionId,
          inbound: ctx.inbound === true,
          toolUseId: entry.call?.id,
          awaitReply: msg.awaitReply,
          awaitSignal: /** @type {any} */ (grant).relaySignal,
          degradeToAsync: msg.degradeToAsync,
          awaitCapMs: msg.awaitCapMs,
        }), HOST_EFFECT_OUTCOME.actorResult);
    },
    'pod/resolve': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'pod', ['podId']);
      if (!entry || msg.podId !== entry.call?.args?.podId) {
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
      const entry = domainEntry(grant, msg, 'pod', ['podId']);
      const intent = entry ? podGitRemoteIntents(entry.call?.args?.command ?? '')[0] : null;
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
      const entry = domainEntry(grant, msg, 'pod', ['op']);
      const intents = entry ? podGitRemoteIntents(entry.call?.args?.command ?? '') : [];
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
      const entry = domainEntry(grant, msg, 'pod', [
        'command', 'podId', 'timeoutMs', 'background', 'remoteGitGrant',
      ]);
      const args = entry?.call?.args;
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
      }), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'pod/status': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = domainEntry(grant, msg, 'pod', [
        'podId', 'jobId', 'stream', 'offset', 'limit',
      ]);
      const args = entry?.call?.args;
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
      const entry = domainEntry(grant, msg, 'pod', ['podId', 'jobId']);
      const args = entry?.call?.args;
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
      const entry = domainEntry(grant, msg, 'pod', ['podId', 'path']);
      const args = entry?.call?.args;
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
      const entry = domainEntry(grant, msg, 'pod', [
        'podId', 'path', 'content',
      ]);
      const args = entry?.call?.args;
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
      ), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'repository/read-pod': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['podId']);
      if (!entry) return { ok: false, error: 'repository/read-pod: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/read-pod', 'read', () =>
        entry.domainState.authority.readPod(msg.podId));
    },
    'repository/destroy-pod': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['podId']);
      if (!entry) return { ok: false, error: 'repository/destroy-pod: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/destroy-pod', 'commit', () =>
        entry.domainState.authority.destroyPod(msg.podId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'repository/read-status': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, []);
      if (!entry) return { ok: false, error: 'repository/read-status: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/read-status', 'read', () =>
        entry.domainState.authority.readStatus());
    },
    'repository/read-history': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['depth']);
      if (!entry) return { ok: false, error: 'repository/read-history: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/read-history', 'read', () =>
        entry.domainState.authority.readHistory(msg.depth));
    },
    'repository/read-remote': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, []);
      if (!entry) return { ok: false, error: 'repository/read-remote: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/read-remote', 'read', () =>
        entry.domainState.authority.readRemote());
    },
    'repository/read-diff': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['from', 'to']);
      if (!entry) return { ok: false, error: 'repository/read-diff: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/read-diff', 'read', () =>
        entry.domainState.authority.readDiff(msg.from, msg.to));
    },
    'repository/confirm-restore': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['to']);
      if (!entry) return { ok: false, error: 'repository/confirm-restore: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/confirm-restore', 'control', () =>
        entry.domainState.authority.confirmRestore(msg.to));
    },
    'repository/checkpoint': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['message']);
      if (!entry) return { ok: false, error: 'repository/checkpoint: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/checkpoint', 'commit', () =>
        entry.domainState.authority.checkpoint(msg.message), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'repository/branch': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['name']);
      if (!entry) return { ok: false, error: 'repository/branch: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/branch', 'commit', () =>
        entry.domainState.authority.branch(msg.name), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'repository/checkout': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['name']);
      if (!entry) return { ok: false, error: 'repository/checkout: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/checkout', 'commit', () =>
        entry.domainState.authority.checkout(msg.name), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'repository/restore': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['to']);
      if (!entry) return { ok: false, error: 'repository/restore: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/restore', 'commit', () =>
        entry.domainState.authority.restore(msg.to), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'repository/confirm-remote': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, [
        'op', 'target', 'branch',
      ]);
      if (!entry) return { ok: false, error: 'repository/confirm-remote: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/confirm-remote', 'control', () =>
        entry.domainState.authority.confirmRemote(msg.op, msg.target, msg.branch));
    },
    'repository/link': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['url']);
      if (!entry) return { ok: false, error: 'repository/link: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/link', 'commit', () =>
        entry.domainState.authority.link(msg.url), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'repository/fetch': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['target']);
      if (!entry) return { ok: false, error: 'repository/fetch: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/fetch', 'commit', () =>
        entry.domainState.authority.fetch(msg.target), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'repository/push': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = repositoryEntry(grant, msg, ['target', 'branch']);
      if (!entry) return { ok: false, error: 'repository/push: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/push', 'resource', () =>
        entry.domainState.authority.push(msg.target, msg.branch), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'vm/read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['vmId']);
      if (!entry) return { ok: false, error: 'vm/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/read', 'read', () =>
        entry.domainState.authority.readVm(msg.vmId));
    },
    'vm/list': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, []);
      if (!entry) return { ok: false, error: 'vm/list: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/list', 'read', () =>
        entry.domainState.authority.listVms());
    },
    'vm/set-default': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['vmId']);
      if (!entry) return { ok: false, error: 'vm/set-default: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/set-default', 'control', () =>
        entry.domainState.authority.setDefaultVm(msg.vmId));
    },
    'vm/run': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['command', 'timeoutMs', 'vmId']);
      if (!entry) return { ok: false, error: 'vm/run: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/run', 'resource', () =>
        entry.domainState.authority.runVm(msg.command, msg.timeoutMs, msg.vmId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'vm/import-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['url', 'path', 'maxBytes']);
      if (!entry) return { ok: false, error: 'vm/import-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/import-file', 'resource', () =>
        entry.domainState.authority.importFile(msg.url, msg.path, msg.maxBytes), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'vm/write-text-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['path', 'content']);
      if (!entry) return { ok: false, error: 'vm/write-text-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/write-text-file', 'commit', () =>
        entry.domainState.authority.writeTextFile(msg.path, msg.content), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'vm/destroy': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = vmEntry(grant, msg, ['vmId']);
      if (!entry) return { ok: false, error: 'vm/destroy: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/destroy', 'commit', () =>
        entry.domainState.authority.destroyVm(msg.vmId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'notebook/read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(
        grant, msg, ['notebookId'],
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
      const entry = notebookEntry(grant, msg, []);
      if (!entry) return { ok: false, error: 'notebook/list: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/list', 'read', () =>
        entry.domainState.authority.listNotebooks());
    },
    'notebook/set-default': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(grant, msg, ['notebookId']);
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
        grant, msg, ['code', 'timeoutMs', 'notebookId'],
      );
      if (!entry) return { ok: false, error: 'notebook/run: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/run', 'resource', () =>
        entry.domainState.authority.runNotebook(msg.code, msg.timeoutMs, msg.notebookId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'notebook/write-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(
        grant, msg, ['path', 'content', 'notebookId'],
      );
      if (!entry) return { ok: false, error: 'notebook/write-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/write-file', 'commit', () =>
        entry.domainState.authority.writeFile(msg.path, msg.content, msg.notebookId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'notebook/read-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = notebookEntry(
        grant, msg, ['path', 'notebookId'],
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
      const entry = notebookEntry(grant, msg, ['notebookId']);
      if (!entry) return { ok: false, error: 'notebook/destroy: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/destroy', 'commit', () =>
        entry.domainState.authority.destroyNotebook(msg.notebookId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'app/update': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, [
        'appId', 'name', 'html', 'tags', 'entryFile',
      ]);
      if (!entry) return { ok: false, error: 'app/update: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/update', 'commit', () =>
        entry.domainState.authority.updateApp(
          msg.appId, msg.name, msg.html, msg.tags, msg.entryFile,
        ), false, HOST_EFFECT_OUTCOME.valueResult);
    },
    'app/open': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, ['appId']);
      if (!entry) return { ok: false, error: 'app/open: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/open', 'resource', () =>
        entry.domainState.authority.openApp(msg.appId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'app/search': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, ['query']);
      if (!entry) return { ok: false, error: 'app/search: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/search', 'read', () =>
        entry.domainState.authority.searchApps(msg.query));
    },
    'app/read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, ['appId']);
      if (!entry) return { ok: false, error: 'app/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/read', 'read', () =>
        entry.domainState.authority.readApp(msg.appId));
    },
    'app/delete': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, ['appId']);
      if (!entry) return { ok: false, error: 'app/delete: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/delete', 'commit', () =>
        entry.domainState.authority.deleteApp(msg.appId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'app/write-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(
        grant, msg, ['appId', 'path', 'content'],
      );
      if (!entry) return { ok: false, error: 'app/write-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/write-file', 'commit', () =>
        entry.domainState.authority.writeFile(msg.appId, msg.path, msg.content), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'app/read-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, ['appId', 'path']);
      if (!entry) return { ok: false, error: 'app/read-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/read-file', 'read', () =>
        entry.domainState.authority.readFile(msg.appId, msg.path));
    },
    'app/list-files': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, ['appId']);
      if (!entry) return { ok: false, error: 'app/list-files: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/list-files', 'read', () =>
        entry.domainState.authority.listFiles(msg.appId));
    },
    'app/delete-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, ['appId', 'path']);
      if (!entry) return { ok: false, error: 'app/delete-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/delete-file', 'commit', () =>
        entry.domainState.authority.deleteFile(msg.appId, msg.path), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'app/observe': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, []);
      if (!entry) return { ok: false, error: 'app/observe: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/observe', 'read', () =>
        entry.domainState.authority.observeRuntime());
    },
    'app/act': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, ['action', 'params']);
      if (!entry) return { ok: false, error: 'app/act: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/act', 'resource', () =>
        entry.domainState.authority.actRuntime(msg.action, msg.params), false, HOST_EFFECT_OUTCOME.runResult);
    },
    'app/run-code': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = appEntry(grant, msg, ['code', 'timeoutMs']);
      if (!entry) return { ok: false, error: 'app/run-code: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/run-code', 'resource', () =>
        entry.domainState.authority.runCode(msg.code, msg.timeoutMs), false, HOST_EFFECT_OUTCOME.runResult);
    },
    'memory/read-scope': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = persistenceEntry(grant, msg, ['scope']);
      if (!entry) return { ok: false, error: 'memory/read-scope: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'memory/read-scope', 'read', () =>
        entry.domainState.authority.readMemoryScope(msg.scope));
    },
    'memory/read-subtree': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = persistenceEntry(
        grant, msg, ['workspace', 'subpath'],
      );
      if (!entry) return { ok: false, error: 'memory/read-subtree: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'memory/read-subtree', 'read', () =>
        entry.domainState.authority.readMemorySubtree(msg.workspace, msg.subpath));
    },
    'memory/write': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = persistenceEntry(grant, msg, ['scope', 'body']);
      if (!entry) return { ok: false, error: 'memory/write: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'memory/write', 'commit', () =>
        entry.domainState.authority.writeMemory(msg.scope, msg.body), false, HOST_EFFECT_OUTCOME.memoryResult);
    },
    'todo/read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = persistenceEntry(
        grant, msg, [],
      );
      if (!entry) return { ok: false, error: 'todo/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'todo/read', 'read', () =>
        entry.domainState.authority.readTodos());
    },
    'todo/replace': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = persistenceEntry(
        grant, msg, ['version', 'todos'],
      );
      if (!entry) return { ok: false, error: 'todo/replace: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'todo/replace', 'commit', () =>
        entry.domainState.authority.replaceTodos(msg.version, msg.todos), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'page/open-tab': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/open-tab: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/open-tab', 'resource', () =>
        entry.domainState.authority.openProtectedBackgroundTab(), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'page/read': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/read', 'read', () =>
        entry.domainState.authority.readOwnedPage());
    },
    'page/snapshot': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/snapshot: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/snapshot', 'read', () =>
        entry.domainState.authority.captureOwnedAccessibilityTree());
    },
    'page/read-state': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/read-state: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/read-state', 'read', () =>
        entry.domainState.authority.readOwnedFrameworkState());
    },
    'page/watch-changes': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/watch-changes: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/watch-changes', 'read', () =>
        entry.domainState.authority.drainOwnedDomChanges());
    },
    'page/query-dom': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/query-dom: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/query-dom', 'read', () =>
        entry.domainState.authority.queryOwnedDom());
    },
    'page/navigate': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/navigate: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/navigate', 'resource', () =>
        entry.domainState.authority.navigateOwnedTab(), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'page/fill': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/fill: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/fill', 'resource', () =>
        entry.domainState.authority.fillOwnedTarget(), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'page/click': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/click: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/click', 'resource', () =>
        entry.domainState.authority.clickOwnedTarget(), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'page/login': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/login: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/login', 'resource', () =>
        entry.domainState.authority.performConfirmedOwnedLogin(), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'page/run-program': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(
        grantFor(msg, sender, boundGrant), msg, ['pageProgramSemanticToken'],
      );
      if (!entry || typeof msg.pageProgramSemanticToken !== 'string'
          || msg.pageProgramSemanticToken.length < 8
          || msg.pageProgramSemanticToken.length > 128) {
        return { ok: false, error: 'page/run-program: authority mismatch', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'page/run-program', 'resource', () =>
        entry.domainState.authority.runOwnedPageProgram(), false, HOST_EFFECT_OUTCOME.runResult);
    },
    'page/capture-foreground': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/capture-foreground: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/capture-foreground', 'read', () =>
        entry.domainState.authority.captureForegroundPixels());
    },
    'page/capture-owned': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = pageEntry(grantFor(msg, sender, boundGrant), msg);
      if (!entry) return { ok: false, error: 'page/capture-owned: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/capture-owned', 'read', () =>
        entry.domainState.authority.captureOwnedTabPixels());
    },
    'resource/confirm-web-write': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = resourceEntry(
        grantFor(msg, sender, boundGrant), msg, ['url', 'method'],
      );
      if (!entry) return { ok: false, error: 'resource/confirm-web-write: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/confirm-web-write', 'control', () =>
        entry.domainState.authority.confirmWebWrite(msg.url, msg.method), true, HOST_EFFECT_OUTCOME.confirmation);
    },
    'resource/request-web-text': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = resourceEntry(
        grantFor(msg, sender, boundGrant), msg, ['url', 'method', 'headers', 'body'],
      );
      if (!entry) return { ok: false, error: 'resource/request-web-text: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/request-web-text', 'resource', () =>
        entry.domainState.authority.requestWebText({
          url: msg.url, method: msg.method, headers: msg.headers, body: msg.body,
        }), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'resource/extract-markdown': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = resourceEntry(
        grantFor(msg, sender, boundGrant), msg, ['html', 'url'],
      );
      if (!entry) return { ok: false, error: 'resource/extract-markdown: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/extract-markdown', 'read', () =>
        entry.domainState.authority.extractReadableMarkdown(msg.html, msg.url));
    },
    'resource/extract-document': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = resourceEntry(
        grantFor(msg, sender, boundGrant), msg, ['url', 'format', 'engine'],
      );
      if (!entry) return { ok: false, error: 'resource/extract-document: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/extract-document', 'read', () =>
        entry.domainState.authority.extractDocument({
          url: msg.url, format: msg.format, engine: msg.engine,
        }));
    },
    'resource/spill-result': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = resourceEntry(grantFor(msg, sender, boundGrant), msg, [
        'url', 'format', 'text', 'producer', 'fenced', 'originLabel',
      ]);
      if (!entry) return { ok: false, error: 'resource/spill-result: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/spill-result', 'control', () =>
        entry.domainState.authority.spillResult({
          url: msg.url, format: msg.format, text: msg.text,
          producer: msg.producer, fenced: msg.fenced, originLabel: msg.originLabel,
        }));
    },
    'resource/read-result': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = resourceEntry(grantFor(msg, sender, boundGrant), msg, ['key']);
      if (!entry) return { ok: false, error: 'resource/read-result: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/read-result', 'read', () =>
        entry.domainState.authority.readResult(msg.key));
    },
    'site-client/read': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = siteClientEntry(grantFor(msg, sender, boundGrant), msg, ['origin']);
      if (!entry) return { ok: false, error: 'site-client/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'site-client/read', 'read', () =>
        entry.domainState.authority.readStoredClient(msg.origin));
    },
    'site-client/run': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = siteClientEntry(
        grantFor(msg, sender, boundGrant), msg, ['origin', 'code', 'timeoutMs'],
      );
      if (!entry) return { ok: false, error: 'site-client/run: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'site-client/run', 'resource', () =>
        entry.domainState.authority.runStoredClient(msg.origin, msg.code, msg.timeoutMs), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'site-client/commit': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = siteClientEntry(grantFor(msg, sender, boundGrant), msg, ['origin']);
      if (!entry) return { ok: false, error: 'site-client/commit: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'site-client/commit', 'commit', () =>
        entry.domainState.authority.commitConfirmedClient(msg.origin), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'site-client/capture-start': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = siteClientEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'site-client/capture-start: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'site-client/capture-start', 'resource', () =>
        entry.domainState.authority.startOwnedCapture(), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'site-client/capture-stop': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = siteClientEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'site-client/capture-stop: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'site-client/capture-stop', 'resource', () =>
        entry.domainState.authority.stopOwnedCapture(), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/create-webvm': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = executionEntry(grantFor(msg, sender, boundGrant), msg, ['plan']);
      if (!entry) return { ok: false, error: 'execution/create-webvm: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/create-webvm', 'commit', () =>
        entry.domainState.authority.createWebVm(msg.plan), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/create-notebook': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = executionEntry(grantFor(msg, sender, boundGrant), msg, ['plan']);
      if (!entry) return { ok: false, error: 'execution/create-notebook: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/create-notebook', 'commit', () =>
        entry.domainState.authority.createNotebook(msg.plan), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/create-pod': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = executionEntry(grantFor(msg, sender, boundGrant), msg, ['plan']);
      if (!entry) return { ok: false, error: 'execution/create-pod: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/create-pod', 'commit', () =>
        entry.domainState.authority.createPod(msg.plan), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/create-app': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = executionEntry(grantFor(msg, sender, boundGrant), msg, ['plan']);
      if (!entry) return { ok: false, error: 'execution/create-app: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/create-app', 'commit', () =>
        entry.domainState.authority.createApp(msg.plan), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/run-script': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = executionEntry(grantFor(msg, sender, boundGrant), msg, [
        'code', 'actors', 'provider', 'workspace', 'timeoutMs',
      ]);
      if (!entry) return { ok: false, error: 'execution/run-script: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/run-script', 'resource', () =>
        entry.domainState.authority.runHeadlessScript({
          code: msg.code, actors: msg.actors, provider: msg.provider,
          workspace: msg.workspace, timeoutMs: msg.timeoutMs,
        }), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/spill-script': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = executionEntry(
        grantFor(msg, sender, boundGrant), msg, ['text', 'fenced', 'originLabel'],
      );
      if (!entry) return { ok: false, error: 'execution/spill-script: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/spill-script', 'control', () =>
        entry.domainState.authority.spillScriptValue({
          text: msg.text, fenced: msg.fenced, originLabel: msg.originLabel,
        }));
    },
    'editing/read-target': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = editingEntry(
        grantFor(msg, sender, boundGrant), msg, ['kind', 'targetId', 'path'],
      );
      if (!entry) return { ok: false, error: 'editing/read-target: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'editing/read-target', 'read', () =>
        entry.domainState.authority.readEditTarget({
          kind: msg.kind, targetId: msg.targetId, path: msg.path,
        }));
    },
    'editing/write-target': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = editingEntry(grantFor(msg, sender, boundGrant), msg, [
        'kind', 'targetId', 'path', 'content',
      ]);
      if (!entry) return { ok: false, error: 'editing/write-target: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'editing/write-target', 'commit', () =>
        entry.domainState.authority.writeEditTarget({
          kind: msg.kind, targetId: msg.targetId, path: msg.path, content: msg.content,
        }), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'introspection/actor-roster': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = introspectionEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'introspection/actor-roster: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/actor-roster', 'read', () =>
        entry.domainState.authority.readActorRoster());
    },
    'introspection/provider-posture': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = introspectionEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'introspection/provider-posture: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/provider-posture', 'read', () =>
        entry.domainState.authority.readProviderPosture());
    },
    'introspection/storage-snapshot': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = introspectionEntry(grantFor(msg, sender, boundGrant), msg, ['prefix']);
      if (!entry) return { ok: false, error: 'introspection/storage-snapshot: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/storage-snapshot', 'read', () =>
        entry.domainState.authority.readStorageSnapshot(msg.prefix));
    },
    'introspection/automatable-tabs': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = introspectionEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'introspection/automatable-tabs: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/automatable-tabs', 'read', () =>
        entry.domainState.authority.readAutomatableTabs());
    },
    'introspection/denylist-patterns': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = introspectionEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'introspection/denylist-patterns: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/denylist-patterns', 'read', () =>
        entry.domainState.authority.readDenylistPatterns());
    },
    'introspection/audit-entries': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = introspectionEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'introspection/audit-entries: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/audit-entries', 'read', () =>
        entry.domainState.authority.readAuditEntries());
    },
    'introspection/installed-skill': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = introspectionEntry(grantFor(msg, sender, boundGrant), msg, ['name']);
      if (!entry) return { ok: false, error: 'introspection/installed-skill: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/installed-skill', 'read', () =>
        entry.domainState.authority.readInstalledSkill(msg.name));
    },
    'schedule/read-routines': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = scheduleEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'schedule/read-routines: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'schedule/read-routines', 'read', () =>
        entry.domainState.authority.readRoutines());
    },
    'schedule/arm-confirmed-routine': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = scheduleEntry(
        grantFor(msg, sender, boundGrant), msg,
        ['prompt', 'every', 'dailyAt', 'mode'],
      );
      if (!entry) return { ok: false, error: 'schedule/arm-confirmed-routine: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'schedule/arm-confirmed-routine', 'commit', () =>
        entry.domainState.authority.armConfirmedRoutine({
          prompt: msg.prompt, every: msg.every, dailyAt: msg.dailyAt, mode: msg.mode,
        }), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'schedule/cancel-routine': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = scheduleEntry(grantFor(msg, sender, boundGrant), msg, ['id']);
      if (!entry) return { ok: false, error: 'schedule/cancel-routine: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'schedule/cancel-routine', 'commit', () =>
        entry.domainState.authority.cancelRoutine(msg.id), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'dweb/discover-apps': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = dwebEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'dweb/discover-apps: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/discover-apps', 'read', () =>
        entry.domainState.authority.discoverApps());
    },
    'dweb/publish-confirmed-app': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = dwebEntry(grantFor(msg, sender, boundGrant), msg, ['appId']);
      if (!entry) return { ok: false, error: 'dweb/publish-confirmed-app: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/publish-confirmed-app', 'commit', () =>
        entry.domainState.authority.publishConfirmedApp(msg.appId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'dweb/install-confirmed-app': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = dwebEntry(grantFor(msg, sender, boundGrant), msg, ['uri', 'name']);
      if (!entry) return { ok: false, error: 'dweb/install-confirmed-app: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/install-confirmed-app', 'commit', () =>
        entry.domainState.authority.installConfirmedApp(msg.uri, msg.name), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'dweb/read-peers': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = dwebEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'dweb/read-peers: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/read-peers', 'read', () =>
        entry.domainState.authority.readPeers());
    },
    'dweb/set-peer-blocked': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = dwebEntry(
        grantFor(msg, sender, boundGrant), msg, ['did', 'block', 'reason'],
      );
      if (!entry) return { ok: false, error: 'dweb/set-peer-blocked: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/set-peer-blocked', 'commit', () =>
        entry.domainState.authority.setPeerBlocked(msg.did, msg.block, msg.reason), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'dweb/set-discovery-enabled': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = dwebEntry(grantFor(msg, sender, boundGrant), msg, ['enabled']);
      if (!entry) return { ok: false, error: 'dweb/set-discovery-enabled: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/set-discovery-enabled', 'commit', () =>
        entry.domainState.authority.setDiscoveryEnabled(msg.enabled), false, HOST_EFFECT_OUTCOME.fulfilledResult);
    },
    'dweb/run-mesh-program': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = dwebEntry(
        grantFor(msg, sender, boundGrant), msg, ['code', 'timeoutMs'],
      );
      if (!entry) return { ok: false, error: 'dweb/run-mesh-program: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/run-mesh-program', 'resource', () =>
        entry.domainState.authority.runMeshProgram(msg.code, msg.timeoutMs), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'actor/tool-settle': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = grant?.actorExecutions.get(msg.executionId);
      const policy = entry
        ? CONTROLLER_AUTHORITY_MANIFEST.tools[entry.authorityClass] : null;
      if (!grant || !exactKeys(msg, ['executionId', 'result'])
          || !entry || entry.open !== true || !policy
          || structuredClonePayloadBytes(msg.result) > policy.resultBytes
          || typeof settleToolCall !== 'function') {
        return { ok: false, error: 'actor/tool-settle: authority mismatch', outcomeKnown: true };
      }
      if (entry.hasReportedSettlementResult === true
          && !sameClone(entry.reportedSettlementResult, msg.result)) {
        return { ok: false, error: 'actor/tool-settle: result mismatch', outcomeKnown: true };
      }
      return settleActorExecution(grant, entry, msg.result);
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
