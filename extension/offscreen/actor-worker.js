// @ts-check
// offscreen/actor-worker.js — the ONE Worker that runs any non-orchestrator agent
// loop in its own heap (the heap split): an ephemeral reasoning actor (tools:[],
// so the tool-relay below never fires) OR a bound actor (VM / Notebook / App / web,
// tool-bearing). Imperative shell over actor-worker-core. Provider semantics run
// HERE and pull from an exact SW-owned inference stream; tool effects still relay
// to the SW, which holds the key, engine clients, instance pin, and gate. The
// untrusted instance/page output stays in this heap. Module worker → strict.
import { runUserTurn } from '/peerd-runtime/loop/agent-loop.js';
import { makeInMemorySessions, makeRelayedToolDispatch, runActorLoop, makeActorSummaryFence } from '/peerd-runtime/actor/actor-worker-core.js';
import { hydrateToolDescriptors } from '/peerd-runtime/semantic.js';
import {
  callModel as callProviderModel,
  contextWindowFor,
  providerModelContextWindow,
} from '/peerd-provider/controller.js';
import { AGENT_PROGRAM, isExecutionDescription } from '/shared/execution-protocol.js';
import { createActorModelEgress } from './actor-model-egress.js';
import { ACTOR_WORKER_PROTOCOL } from './actor-worker-protocol.js';

let seq = 0;
let runId = '';
/** @type {Map<string, (v: any) => void>} rid → pending model-authority resolver */
const modelPending = new Map();
/** @type {Map<string, (v: any) => void>} rid → pending tool-dispatch resolver */
const toolPending = new Map();
const abort = new AbortController();
let hasRun = false;

self.addEventListener('message', async (/** @type {MessageEvent} */ ev) => {
  const m = /** @type {any} */ (ev.data);
  if (!m || typeof m !== 'object') return;

  if (m.type === 'probe') {
    self.postMessage({
      type: 'probe-response',
      protocol: ACTOR_WORKER_PROTOCOL,
      rid: m.rid,
      canaryAbsent: typeof m.canaryName === 'string' && !(m.canaryName in globalThis),
    });
    return;
  }

  if (m.type === 'model-open-inference-response'
      || m.type === 'model-read-inference-chunk-response'
      || m.type === 'model-cancel-inference-response'
      || m.type === 'model-open-local-response'
      || m.type === 'model-read-local-response'
      || m.type === 'model-cancel-local-response'
      || m.type === 'model-read-context-response') {
    modelPending.get(m.rid)?.(m.reply);
    modelPending.delete(m.rid);
    return;
  }
  if (m.type === 'tool-response') { toolPending.get(m.rid)?.(m.reply); toolPending.delete(m.rid); return; }
  if (m.type === 'abort') {
    abort.abort();
    // Unwind a worker BLOCKED awaiting the SW (model OR tool) so it doesn't park
    // until the host's budget timer.
    for (const resolve of modelPending.values()) resolve({ error: 'aborted' });
    for (const resolve of toolPending.values()) resolve({ ok: false, error: 'aborted' });
    modelPending.clear(); toolPending.clear();
    return;
  }

  if (m.type === 'run') {
    if (hasRun) {
      self.postMessage({ type: 'error', runId, error: 'actor worker refused a second run' });
      return;
    }
    hasRun = true;
    const execution = m.execution;
    const program = execution?.program;
    const state = execution?.state;
    const metadata = execution?.metadata;
    if (!isExecutionDescription(execution)
        || program?.kind !== AGENT_PROGRAM
        || typeof execution.input !== 'string'
        || typeof metadata?.sessionId !== 'string'
        || !state || typeof state !== 'object'
        || !Array.isArray(state.messages)) {
      self.postMessage({ type: 'error', runId: execution?.id ?? '', error: 'actor worker received an invalid execution description' });
      return;
    }
    runId = execution.id;
    const openInference = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `mo-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-open-inference-request', rid, runId,
        providerId: request.providerId,
        modelId: request.modelId,
        nativeBody: request.nativeBody,
      });
    });
    const readInferenceChunk = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `mr-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-read-inference-chunk-request', rid, runId,
        streamId: request.streamId,
      });
    });
    const cancelInference = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `mx-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-cancel-inference-request', rid, runId,
        streamId: request.streamId,
      });
    });
    const readModelContext = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `mw-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-read-context-request', rid, runId,
        providerId: request.providerId,
        modelId: request.modelId,
      });
    });
    const openLocalGeneration = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `lo-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-open-local-request', rid, runId,
        providerId: request.providerId,
        modelId: request.modelId,
        messages: request.messages,
        system: request.system,
        tools: request.tools,
        maxTokens: request.maxTokens,
      });
    });
    const readLocalGeneration = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `lr-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-read-local-request', rid, runId, streamId: request.streamId,
      });
    });
    const cancelLocalGeneration = (/** @type {any} */ request) => new Promise((resolve) => {
      const rid = `lx-${++seq}`;
      modelPending.set(rid, resolve);
      self.postMessage({
        type: 'model-cancel-local-request', rid, runId, streamId: request.streamId,
      });
    });
    const requestTool = (/** @type {object} */ call) => new Promise((resolve) => {
      const rid = `tc-${++seq}`;
      toolPending.set(rid, resolve);
      self.postMessage({ type: 'tool-request', rid, runId, call });
    });
    try {
      // Seed the actor's PRIOR history — a bound actor is stateful across turns.
      const sessions = makeInMemorySessions({
        sessionId: metadata.sessionId,
        provider: program.provider,
        model: program.model,
        depth: metadata.depth,
        messages: state.messages,
      });
      const modelEgress = createActorModelEgress({
        openInference, readInferenceChunk, cancelInference, readModelContext,
        openLocalGeneration, readLocalGeneration, cancelLocalGeneration,
      });
      const liveWindow = await providerModelContextWindow(program.provider, program.model, {
        modelEgress, signal: abort.signal,
      });
      const contextWindow = contextWindowFor(program.model, {
        overrides: program.contextWindowOverrides,
        live: liveWindow ?? undefined,
      });
      // Provider/model/output policy is pinned twice: this SW-authored program
      // fixes semantic selection here, and the SW grant independently rejects a
      // mismatched native request before credentials or network are reachable.
      const callModel = (/** @type {any} */ args) => callProviderModel({
        ...args,
        provider: program.provider,
        model: program.model,
        ...(program.maxOutputTokens != null
          ? { maxTokens: program.maxOutputTokens }
          : {}),
        modelEgress,
      });
      const toolDispatch = makeRelayedToolDispatch(requestTool);
      // Phase 3: a WEB/API actor self-fences its own untrusted-provenance rolling
      // summary. The SW's closure (over a policy-reduced live tab origin) can't
      // cross postMessage, so rebuild it here from the pure fence fns using the
      // turn-start provenance.
      const fenceActorSummary = makeActorSummaryFence({
        actorType: metadata.actorType,
        backing: metadata.backing,
        tabOrigin: metadata.tabOrigin,
        origin: metadata.origin,
      });
      const result = await runActorLoop(
        {
          runUserTurn, sessions, callModel, toolDispatch,
          getSystemPrompt: () => program.systemPrompt,
          appendAudit: async () => {},
          onEvent: (/** @type {object} */ event) => self.postMessage({ type: 'loop-event', runId, event }),
          tools: hydrateToolDescriptors(
            Array.isArray(m.tools) ? m.tools : [], m.runtimeCapabilities,
          ),
          ...(fenceActorSummary ? { fenceActorSummary } : {}),
        },
        {
          sessionId: metadata.sessionId,
          userText: execution.input,
          maxSteps: program.maxSteps,
          oneShot: metadata.oneShot,
          signal: abort.signal,
          reasoning: program.reasoning,
          ...(contextWindow == null ? {} : { contextWindow }),
          inbound: metadata.inbound === true,
          preflightReply: metadata.preflightReply,
        },
      );
      // why the worker does NOT stamp `aborted`: a Stop unwinds the loop cleanly (the
      // relay rejects, the loop stops with an empty reply), but whether that counts as
      // a cancellation vs a raced-but-completed turn is decided at the SW client, which
      // sees BOTH the authoritative Stop signal AND whether any reply came back
      // (signal.aborted && !finalText). A stamp here — ignorant of finalText — would
      // mislabel a turn that produced a real reply just before Stop as 'cancelled'.
      self.postMessage({ type: 'done', runId, result });
    } catch (e) {
      self.postMessage({ type: 'error', runId, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
    }
  }
});

// Posted only after the complete module graph evaluated and the listener above
// was installed. The host validates this plus a per-run realm canary before it
// sends any model input or grants tool relays.
self.postMessage({
  type: 'ready',
  protocol: ACTOR_WORKER_PROTOCOL,
  realm: {
    dedicatedWorker: globalThis.constructor?.name === 'DedicatedWorkerGlobalScope',
    window: typeof window !== 'undefined',
    document: typeof document !== 'undefined',
    browser: 'browser' in globalThis,
    chrome: 'chrome' in globalThis,
  },
});
