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
  sessions, buildToolContext, dispatchToolCall, pinActorCall, restrictCtxCapabilities, ownedTabFor, EXPOSURE_ACTOR, EXPOSURE_REVIEW, now = Date.now,
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
   * @type {Map<string, { runId: string, actorSessionId: string, provider: string, model: string, maxOutputTokens?: number, providerOwner: object, inbound: boolean, allowedTools: Set<string> | null, actorSurface?: 'tools'|'code', relaySignal: AbortSignal, modelRelays: number, toolRelays: number, loopEvents: number, modelActive: boolean, modelStreamId: string | null, contextRead:boolean }>} Firefox relay grants:
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
   * @returns {{ runId: string, actorSessionId: string, provider: string, model: string, maxOutputTokens?: number, providerOwner: object, inbound: boolean, allowedTools: Set<string> | null, actorSurface?: 'tools'|'code', relaySignal: AbortSignal, modelRelays: number, toolRelays: number, loopEvents: number, modelActive: boolean, modelStreamId: string | null, contextRead:boolean } | null}
   */
  const grantFor = (msg, sender, boundGrant = null) => {
    if (boundGrant) return boundGrant;
    if (!relaySenderAllowed(sender)) return null;
    const token = msg?.relayToken;
    if (typeof token !== 'string' || token.length === 0) return null;
    return grants.get(token) ?? null;
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
    /**
     * @param {{ relayToken?: string, call?: any }} [msg] - SW-side ctx build + gate + dispatch.
     * @param {unknown} [sender] - must be the offscreen document (see grantFor).
     */
    'actor/tool-dispatch': async (msg = {}, sender = undefined, boundGrant = null) => {
      let admitted = false;
      try {
        // The session comes from the offscreen-pinned GRANT, not the message. This is
        // the route that builds an instance-pinned, tool-granting context, so a caller
        // that could name its own session would inherit any actor's pin and toolset.
        const grant = grantFor(msg, sender, boundGrant);
        if (!grant) return { ok: false, error: 'actor/tool-dispatch: unauthorized relay' };
        if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
        if (grant.toolRelays >= toolRelayLimit) return {
          ok: false, error: 'actor/tool-dispatch: relay budget exhausted',
          code: 'actor_tool_relay_limit', outcomeKnown: true, performed: false,
        };
        grant.toolRelays += 1;
        const { actorSessionId } = grant;
        const call = msg.call;
        // Descriptor narrowing makes the model unlikely to ask; this check is the
        // authority wall. The grant's set was minted from the SW-stamped inbound
        // job, never from this relayed call or the Worker holding peer content.
        if (grant.inbound && (typeof call?.name !== 'string' || !grant.allowedTools?.has(call.name))) {
          return { ok: false, error: `tool_not_available_to_inbound_actor: ${call?.name}` };
        }
        const rec = await sessions.get(actorSessionId);
        if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
        if (!rec) return { ok: false, error: 'actor/tool-dispatch: unknown session' };

        // Phase 4 — a spawned child is a tool-bearing EPHEMERAL actor. Its toolset is the
        // NARROWED-GENERAL set persisted at spawn (rec.grantedTools), not an instance
        // pin. Rebuild its restricted ctx SW-side EXACTLY as the in-SW spawn path does
        // (buildToolContext → audit-tag → abortSignal → restrictCtxCapabilities over the
        // granted set) and re-check the relayed call against grantedTools first — the
        // worker's call args (shaped by tool output it read) are never trusted, the same
        // defense-in-depth as the actor pin.
        if (rec.kind === 'spawned') {
          if (!restrictCtxCapabilities) return { ok: false, error: 'actor/tool-dispatch: actor offscreen not wired' };
          const persistedGrants = new Set(Array.isArray(rec.grantedTools) ? rec.grantedTools : []);
          const granted = grant.inbound
            ? new Set([...persistedGrants].filter((name) => grant.allowedTools?.has(name)))
            : persistedGrants;
          if (typeof call?.name !== 'string' || !granted.has(call.name)) return { ok: false, error: `tool_not_available_to_actor: ${call?.name}` };
          // Layer 2 of the clean-context review contract: re-evaluate the live
          // positive allowlist at call time. The record's grantedTools may be
          // stale or corrupt; it is never sufficient authority for a reviewer.
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
          // Stamp the child lineage on every audit its tools emit (parity with spawn.js's taggedAudit).
          const audit = (/** @type {any} */ entry) => /** @type {any} */ (base).audit?.({ ...entry, details: { ...(entry?.details ?? {}), parentSessionId: rec.parentSessionId, actorSessionId, depth: rec.depth } });
          // #160: re-stamp the review-exemption marker from the PERSISTED record
          // (spawn.js writes rec.review SW-side at create; no worker or model arg
          // can reach it). why here: this route rebuilds ctx from the record alone,
          // so without the stamp the tier gate saw exposure undefined and refused
          // the three instance reads — the exemption only worked on the in-SW
          // fallback path. Fail-closed: rec.review !== true, or no injected
          // EXPOSURE_REVIEW, stamps nothing.
          const ctx = restrictCtxCapabilities({
            ...base, audit, abortSignal: grant.relaySignal,
            // Monotonic backstop: even a miswired context builder cannot erase
            // the provenance attached to this live SW grant.
            ...(grant.inbound ? { synthetic: true, trusted: false, inbound: true } : {}),
            ...(rec.review === true && EXPOSURE_REVIEW ? { exposure: EXPOSURE_REVIEW } : {}),
          }, granted);
          admitted = true;
          const result = await dispatchToolCall(call, ctx);
          return { ok: true, result };
        }

        if (rec.kind !== 'actor') return { ok: false, error: 'actor/tool-dispatch: not an actor or actor session' };
        // Phase 3: a WEB actor (kind 'web', backing tab) OWNS one tab; its DOM tools
        // must target THAT tab and the origin/denylist gate must see its origin.
        // Resolve the owned tab id HERE, per dispatch (never trust the worker), so a
        // mid-turn navigate that adopts a tab is seen by the next call. buildToolContext
        // FAILS CLOSED if the id is stale (leaves activeTab unset — never the user's
        // foreground). An API actor (backing 'api') has no tab → activeTabId stays
        // undefined; an engine actor acts on its instance → also undefined.
        const activeTabId = (rec.actorType === 'web' && rec.backing !== 'api' && ownedTabFor)
          ? ownedTabFor(/** @type {string} */ (actorSessionId))
          : undefined;
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
        // Stop/cancel belongs to the ACTOR TURN, not only spawned children.
        // Thread the live SW-owned signal into every bound context so a
        // page_code/a2a_run/site_client_run tool cannot outlive the reasoning
        // worker that invoked it.
        const stamped = {
          ...base,
          abortSignal: grant.relaySignal,
          ...(grant.inbound ? { synthetic: true, trusted: false, inbound: true } : {}),
        };
        // Strip the ctx's closures as well as its descriptors: an injected model
        // cannot recover a2a_run's mesh-signing worker through a forged tool call.
        const ctx = grant.inbound
          ? /** @type {(ctx: any, allowedNames: Set<string>) => any} */ (restrictCtxCapabilities)(
            stamped, /** @type {Set<string>} */ (grant.allowedTools),
          )
          : stamped;
        // Re-pin to the BOUND instance — the worker's call args are never trusted.
        // (A no-op for web DOM tools, whose numeric-tab pin the GATE enforces via
        // ctx.activeTab; still runs so engine/edit_file calls normalize.)
        pinActorCall(call, rec.actorType, rec.instanceId);
        admitted = true;
        const result = await dispatchToolCall(call, ctx);
        // Announce the settled dispatch — pure, privacy-minimal observability.
        // Arguments can contain form text, credentials, or attacker-derived
        // bytes, so no UI port receives them.
        // why: an OFFSCREEN actor turn emits no turn/tool-use broadcast (that
        // path is turn-driver's, in-SW only) — without this the eval harness's
        // OM2W recorder can't see the actor's page actions. Best-effort.
        try {
          broadcastOp({
            type: 'actor/op', sessionId: actorSessionId,
            name: typeof call?.name === 'string' && /^[a-z0-9_-]{1,64}$/.test(call.name)
              ? call.name : 'unknown',
            ok: result?.ok !== false,
          });
        } catch { /* display-only */ }
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
