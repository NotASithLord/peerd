// @ts-check
// Authority-kernel bridge for the pure orchestrator loop hosted by the sealed
// semantic controller. The controller receives transcript text and opaque
// binary references; every effect and every authority-bearing lookup stays in
// this service-worker closure.

import {
  TOOL_EXECUTION_PROTOCOL,
  createToolEffectQuota,
  parseToolExecutionRequest,
  toolEffectLossSemantics,
  toolExecutionResultAllowed,
} from '../shared/tool-execution-protocol.js';
import {
  CONTROLLER_TOOL_MANIFEST,
  controllerHostsTool,
} from '../shared/controller-tool-manifest.js';

const TURN_EVENT_QUEUE_CAP = 8;
const OPAQUE_PREFIX = 'peerd-controller-opaque:';
const ABORT_CLEANUP_OPERATIONS = new Set([
  'turn.tool.settle', 'turn.abort.finalize', 'turn.finalize',
]);
const DIGEST = /^[a-f0-9]{64}$/;
const EFFECT_OPERATION = /^[a-z][a-z0-9.-]{0,127}$/;
const TURN_DEADLINE_MS = 30 * 60_000;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value !== null
  && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} left @param {unknown} right */
const sameClone = (left, right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
};

const known = (/** @type {unknown} */ value) => ({
  ok: true, value, outcomeKnown: true,
});
const failed = (/** @type {unknown} */ cause, /** @type {boolean} */ outcomeKnown) => ({
  ok: false,
  code: 'turn-kernel-call-failed',
  error: cause instanceof Error ? cause.message : String(cause),
  outcomeKnown,
});
const jsonWire = (/** @type {unknown} */ value) => JSON.stringify(value);
const jsonUnwire = (/** @type {unknown} */ value, /** @type {string} */ label) => {
  if (typeof value !== 'string') throw new Error(`${label} wire payload is invalid`);
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} wire payload is invalid`); }
};
const digestJson = async (/** @type {unknown} */ value) => {
  const bytes = new TextEncoder().encode(jsonWire(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
const unknown = (/** @type {any} */ run, /** @type {unknown} */ cause) => {
  run.nestedUnknown = true;
  return failed(cause, false);
};

const makeEventQueue = () => {
  /** @type {{value:unknown,ack:()=>void}[]} */
  const values = [];
  /** @type {Array<(value:{done:boolean,value?:unknown,ack?:()=>void})=>void>} */
  const readers = [];
  /** @type {Array<()=>void>} */
  const writers = [];
  /** @type {Set<()=>void>} */
  const acks = new Set();
  let closed = false;
  const releaseWriter = () => writers.shift()?.();
  return {
    push: async (/** @type {unknown} */ value) => {
      if (closed) throw new Error('turn event stream is closed');
      let resolveAck = () => {};
      const acked = new Promise((resolve) => { resolveAck = () => resolve(undefined); });
      let settled = false;
      const ack = () => {
        if (settled) return;
        settled = true;
        acks.delete(ack);
        resolveAck();
      };
      acks.add(ack);
      const entry = { value, ack };
      if (readers.length > 0) {
        readers.shift()?.({ done: false, ...entry });
        await acked;
        return;
      }
      while (values.length >= TURN_EVENT_QUEUE_CAP && !closed) {
        await new Promise((resolve) => {
          writers.push(() => resolve(undefined));
        });
      }
      if (closed) { ack(); throw new Error('turn event stream is closed'); }
      values.push(entry);
      await acked;
    },
    next: () => {
      if (values.length > 0) {
        const entry = values.shift();
        releaseWriter();
        return Promise.resolve({ done: false, ...entry });
      }
      if (closed) return Promise.resolve({ done: true });
      return new Promise((resolve) => readers.push(resolve));
    },
    close: () => {
      if (closed) return;
      closed = true;
      while (readers.length > 0) readers.shift()?.({ done: true });
      while (writers.length > 0) releaseWriter();
      for (const ack of [...acks]) ack();
      values.length = 0;
    },
  };
};

/** @param {Record<string, any>} ctx */
const controllerCtx = (ctx) => {
  const keys = [
    'userText', 'synthetic', 'resume', 'contextMessage', 'reasoning',
    'actorReply', 'contextWindow', 'oneShot', 'maxSteps', 'persistDeltas',
    'preflightReply', 'runtimeCapabilities',
  ];
  const out = /** @type {Record<string, unknown>} */ ({});
  for (const key of keys) if (ctx[key] !== undefined) out[key] = ctx[key];
  return out;
};

/**
 * @param {Object} deps
 * @param {() => Promise<{call:(capability:string,payload:unknown,options?:any)=>Promise<any>}>} deps.getClient
 * @param {() => string} [deps.newId]
 * @param {(call:Record<string,any>,ctx:Record<string,any>,binding:Record<string,any>)=>
 *   Promise<null|{mode:'result',result:unknown}|{mode:'execute',custody:unknown,args:unknown,
 *   projection:Record<string,unknown>,manifestDigest:string,attempt?:number}>} [deps.prepareToolCall]
 * @param {(input:{custody:unknown,operation:string,payload:unknown,call:Record<string,any>,
 *   ctx:Record<string,any>,binding:Record<string,any>})=>Promise<any>} [deps.handleToolEffect]
 * @param {(input:{custody:unknown,result:Record<string,any>,call:Record<string,any>,
 *   ctx:Record<string,any>,binding:Record<string,any>})=>Promise<any>} [deps.settleToolCall]
 * @param {(value:unknown)=>Promise<string>} [deps.digestArgs]
 * @param {ReturnType<import('../shared/tool-execution-protocol.js').compileToolEffectManifest>}
 *   [deps.toolManifest]
 * @param {()=>number} [deps.now]
 */
export const makeControllerTurnBridge = ({
  getClient,
  newId = () => crypto.randomUUID(),
  prepareToolCall,
  handleToolEffect,
  settleToolCall,
  digestArgs = digestJson,
  toolManifest = CONTROLLER_TOOL_MANIFEST,
  now = Date.now,
}) => {
  /** @type {Map<string, any>} */
  const runs = new Map();
  /** @type {Map<string, number>} */
  const sessionGenerations = new Map();
  const protocolEnabled = typeof prepareToolCall === 'function'
    && typeof handleToolEffect === 'function' && typeof settleToolCall === 'function';
  if (!toolManifest || toolManifest.protocol !== TOOL_EXECUTION_PROTOCOL
      || typeof toolManifest.digest !== 'string' || !isRecord(toolManifest.tools)) {
    throw new TypeError('controller-tool-manifest-invalid');
  }

  const executionCustody = (/** @type {any} */ entry) => {
    if (entry.pendingIrreversible > 0 || entry.unknownIrreversible === true) {
      return { outcomeKnown: false, retryable: false };
    }
    return {
      outcomeKnown: true,
      retryable: entry.settledIrreversible !== true,
    };
  };
  const executionFailure = (
    /** @type {any} */ entry,
    /** @type {string} */ code,
    /** @type {string} */ error,
  ) => {
    const state = executionCustody(entry);
    return {
      protocol: TOOL_EXECUTION_PROTOCOL,
      executionId: entry.executionId,
      argsDigest: entry.argsDigest,
      ok: false,
      code,
      error,
      outcomeKnown: state.outcomeKnown,
      effectEntered: entry.effectEntered === true,
      retryable: state.retryable,
      phase: 'run',
    };
  };

  const mintOpaque = (
    /** @type {any} */ run,
    /** @type {'attachment'|'tool-image'} */ kind,
    /** @type {string} */ value,
  ) => {
    const token = `${OPAQUE_PREFIX}${run.runId}:${newId()}`;
    run.opaque.set(token, { kind, value });
    return token;
  };
  const externalizeAttachments = (/** @type {any} */ run, /** @type {unknown} */ attachments) =>
    Array.isArray(attachments) ? attachments.map((attachment) => {
      if (!isRecord(attachment) || attachment.data === undefined) return attachment;
      if (typeof attachment.data !== 'string') {
        throw new Error('binary attachment must remain kernel-owned');
      }
      return { ...attachment, data: mintOpaque(run, 'attachment', attachment.data) };
    }) : attachments;
  const externalizeToolResult = (/** @type {any} */ run, /** @type {unknown} */ result) => {
    if (!isRecord(result) || !Array.isArray(result.images)) return result;
    return {
      ...result,
      images: result.images.map((image) => {
        if (!isRecord(image) || image.data === undefined) return image;
        if (typeof image.data !== 'string') {
          throw new Error('binary tool image must remain kernel-owned');
        }
        return { ...image, data: mintOpaque(run, 'tool-image', image.data) };
      }),
    };
  };
  const redeem = (
    /** @type {any} */ run,
    /** @type {unknown} */ token,
    /** @type {'attachment'|'tool-image'} */ kind,
  ) => {
    if (typeof token !== 'string') return token;
    const opaque = run.opaque.get(token);
    return opaque?.kind === kind ? opaque.value : token;
  };
  const rehydrateData = (
    /** @type {any} */ run,
    /** @type {Record<string, any>} */ value,
    /** @type {'attachment'|'tool-image'} */ kind,
  ) => value.data === undefined
    ? value : { ...value, data: redeem(run, value.data, kind) };
  const rehydrateImages = (/** @type {any} */ run, /** @type {unknown} */ images) =>
    Array.isArray(images) ? images.map((image) => isRecord(image)
      ? rehydrateData(run, image, 'tool-image') : image) : images;
const rehydrateModelArgs = (/** @type {any} */ run, /** @type {Record<string, any>} */ args) => ({
  ...args,
  signal: run.signal,
    messages: Array.isArray(args.messages) ? args.messages.map((message) => {
      if (!isRecord(message)) return message;
      return {
        ...message,
        ...(Array.isArray(message.attachments) ? {
          attachments: message.attachments.map((attachment) => isRecord(attachment)
            ? rehydrateData(run, attachment, 'attachment')
            : attachment),
        } : {}),
        ...(Array.isArray(message.toolResults) ? {
          toolResults: message.toolResults.map((result) => isRecord(result)
            ? { ...result, images: rehydrateImages(run, result.images) } : result),
        } : {}),
      };
    }) : args.messages,
  });
  const rehydrateEvent = (/** @type {any} */ run, /** @type {unknown} */ event) => {
    if (!isRecord(event) || event.type !== 'tool-result' || !isRecord(event.result)) return event;
    return {
      ...event,
      result: { ...event.result, images: rehydrateImages(run, event.result.images) },
    };
  };
  const rehydrateMessage = (/** @type {any} */ run, /** @type {unknown} */ message) => {
    if (!isRecord(message)) return message;
    return {
      ...message,
      ...(Array.isArray(message.attachments) ? {
        attachments: message.attachments.map((attachment) => isRecord(attachment)
          ? rehydrateData(run, attachment, 'attachment')
          : attachment),
      } : {}),
      ...(Array.isArray(message.toolResults) ? {
        toolResults: message.toolResults.map((result) => isRecord(result)
          ? { ...result, images: rehydrateImages(run, result.images) } : result),
      } : {}),
    };
  };
  const externalizeSession = (/** @type {any} */ run, /** @type {unknown} */ session) => {
    if (!isRecord(session) || !Array.isArray(session.messages)) return session;
    return {
      ...session,
      messages: session.messages.map((message) => {
        if (!isRecord(message)) return message;
        return {
          ...message,
          ...(Array.isArray(message.attachments)
            ? { attachments: externalizeAttachments(run, message.attachments) } : {}),
          ...(Array.isArray(message.toolResults) ? {
            toolResults: message.toolResults.map((result) => externalizeToolResult(run, result)),
          } : {}),
        };
      }),
    };
  };
  const externalizeSessionWire = (/** @type {any} */ run, /** @type {unknown} */ session) =>
    jsonWire(externalizeSession(run, session));
  const classificationsFor = (/** @type {any} */ run, /** @type {any[]} */ tools) => {
    const result = /** @type {Record<string, unknown>} */ ({});
    for (const descriptor of tools) {
      if (typeof descriptor?.name !== 'string') continue;
      try { result[descriptor.name] = run.ctx.classifyToolCall?.(descriptor.name) ?? null; }
      catch { result[descriptor.name] = null; }
    }
    return result;
  };
  const setTools = (/** @type {any} */ run, /** @type {unknown} */ tools) => {
    run.tools = Array.isArray(tools) ? tools : [];
    run.toolNames = new Set(run.tools.map((/** @type {any} */ tool) => tool?.name)
      .filter((/** @type {unknown} */ name) => typeof name === 'string'));
    run.classifications = classificationsFor(run, run.tools);
  };
  const authorityTools = (/** @type {unknown} */ tools) => Array.isArray(tools)
    ? tools.map((tool) => ({
      name: tool?.name,
      primitive: tool?.primitive,
      sideEffect: tool?.sideEffect,
      ...(tool?.dispatch === undefined ? {} : { dispatch: tool.dispatch }),
      ...(tool?.retryClass === undefined ? {} : { retryClass: tool.retryClass }),
      ...(tool?.dweb === undefined ? {} : { dweb: tool.dweb }),
    })) : [];
  const dispatchIsConcurrencySafe = (/** @type {any} */ run, /** @type {string} */ name) => {
    let verdict = null;
    try { verdict = run.ctx.classifyToolCall?.(name) ?? null; } catch { verdict = null; }
    if (!verdict) return name === 'actor_create';
    if (verdict.confirm === true) return false;
    return verdict.actionClass === 'read' || name === 'actor_create';
  };
  const scheduleDispatch = async (
    /** @type {any} */ run,
    /** @type {boolean} */ concurrencySafe,
    /** @type {() => Promise<any>} */ dispatch,
  ) => {
    const invoke = () => {
      if (run.signal.aborted) throw Object.assign(
        new DOMException('controller turn stopped before tool dispatch', 'AbortError'),
        { code: 'turn-tool-not-dispatched' },
      );
      return dispatch();
    };
    if (concurrencySafe) {
      const promise = Promise.resolve(run.dispatchBarrier).then(invoke);
      run.activeSafeDispatches.add(promise);
      run.activeDispatches.add(promise);
      try { return await promise; }
      finally {
        run.activeSafeDispatches.delete(promise);
        run.activeDispatches.delete(promise);
      }
    }
    const prior = run.dispatchBarrier;
    const safeBefore = [...run.activeSafeDispatches];
    const promise = Promise.allSettled([prior, ...safeBefore]).then(invoke);
    run.dispatchBarrier = promise.catch(() => {});
    run.activeDispatches.add(promise);
    try { return await promise; }
    finally { run.activeDispatches.delete(promise); }
  };
  const acquireDispatch = async (
    /** @type {any} */ run,
    /** @type {boolean} */ concurrencySafe,
  ) => {
    let releaseHold = () => {};
    const released = new Promise((resolve) => {
      releaseHold = () => resolve(undefined);
    });
    const prior = run.dispatchBarrier;
    const safeBefore = concurrencySafe ? [] : [...run.activeSafeDispatches];
    const started = (concurrencySafe
      ? Promise.resolve(prior) : Promise.allSettled([prior, ...safeBefore]))
      .then(() => {
        if (run.signal.aborted) throw Object.assign(
          new DOMException('controller turn stopped before tool preparation', 'AbortError'),
          { code: 'turn-tool-not-dispatched' },
        );
      });
    const hold = started.then(() => released);
    hold.catch(() => {});
    if (!concurrencySafe) run.dispatchBarrier = hold.catch(() => {});
    if (concurrencySafe) run.activeSafeDispatches.add(hold);
    run.activeDispatches.add(hold);
    let releasedOnce = false;
    const release = () => {
      if (releasedOnce) return;
      releasedOnce = true;
      releaseHold();
      run.activeDispatches.delete(hold);
      run.activeSafeDispatches.delete(hold);
    };
    try { await started; }
    catch (cause) { release(); throw cause; }
    return release;
  };
  const issuedToolCall = (
    /** @type {any} */ run,
    /** @type {Record<string, any>} */ call,
    /** @type {Map<string, any>} */ calls = run.modelToolCalls,
  ) => {
    if (typeof call.id !== 'string' || typeof call.name !== 'string'
        || !run.toolNames.has(call.name)) return null;
    const issued = calls.get(call.id);
    let issuedArgs = {};
    try { issuedArgs = issued?.inputBuf ? JSON.parse(issued.inputBuf) : {}; }
    catch { issuedArgs = {}; }
    return issued && issued.name === call.name && sameClone(issuedArgs, call.args ?? {})
      ? issued : null;
  };
  const cleanupPrepared = async (/** @type {any} */ run, /** @type {string} */ code) => {
    const entries = [...run.preparedExecutions.values()];
    run.preparedExecutions.clear();
    for (const entry of entries) {
      const needsSettlement = entry.open === true;
      entry.open = false;
      const state = executionCustody(entry);
      const outcomeKnown = state.outcomeKnown;
      if (!outcomeKnown) run.nestedUnknown = true;
      try {
        if (needsSettlement) await settleToolCall?.({
          custody: entry.custody,
          result: executionFailure(
            entry,
            code,
            outcomeKnown
              ? 'Tool execution stopped with a known effect state.'
              : 'Tool outcome unknown. Check state before retrying.',
          ),
          call: entry.call,
          ctx: run.ctx,
          binding: entry.binding,
        });
      } catch { if (!outcomeKnown) run.nestedUnknown = true; }
      finally { entry.release(); }
    }
  };
  const recordModelEvent = (/** @type {any} */ run, /** @type {any} */ event) => {
    if (event?.type === 'tool-use-start'
        && typeof event.id === 'string' && typeof event.name === 'string') {
      run.modelToolCalls.set(event.id, { name: event.name, inputBuf: '' });
    } else if (event?.type === 'tool-use-delta' && typeof event.id === 'string') {
      const pending = run.modelToolCalls.get(event.id);
      if (pending && typeof event.partialJson === 'string') pending.inputBuf += event.partialJson;
    }
  };
  const assertRunPayload = (/** @type {unknown} */ payload, /** @type {any} */ context) => {
    if (!isRecord(payload) || typeof payload.runId !== 'string') return null;
    const run = runs.get(payload.runId);
    if (!run || run.sessionId !== context.authority.sessionId
        || context.capability !== 'turn.run') return null;
    return { run, value: isRecord(payload.value) ? payload.value : {} };
  };

  const authorize = (/** @type {unknown} */ payload) => {
    if (!isRecord(payload) || typeof payload.runId !== 'string'
        || typeof payload.sessionId !== 'string' || !runs.has(payload.runId)) return null;
    const run = runs.get(payload.runId);
    if (run.sessionId !== payload.sessionId) return null;
    return {
      ownerId: 'peerd-authority-kernel', sessionId: payload.sessionId,
      instanceId: null, origin: null, target: 'orchestrator-turn', replayClass: 'E',
    };
  };

  const handleKernelCall = async (
    /** @type {string} */ operation,
    /** @type {unknown} */ payload,
    /** @type {any} */ context,
  ) => {
    const parsed = assertRunPayload(payload, context);
    if (!parsed) return {
      ok: false, code: 'turn-run-authority-mismatch', outcomeKnown: true,
    };
    const { run, value } = parsed;
    if ((context.signal.aborted || run.signal.aborted)
        && !ABORT_CLEANUP_OPERATIONS.has(operation)) return {
      ok: false, code: 'turn-run-aborted', outcomeKnown: true,
    };
    const sameSession = () => value.sessionId === run.sessionId;
    try {
      switch (operation) {
        case 'turn.session.get':
          if (!sameSession()) return failed('session authority mismatch', true);
          try {
            const session = await run.ctx.sessions.get(run.sessionId);
            if (run.ctx.resume === true && run.currentAssistantId === null) {
              const trailing = session?.messages?.at?.(-1);
              run.resumeAssistantId = trailing?.role === 'assistant'
                && trailing?.streaming === true && typeof trailing.id === 'string'
                ? trailing.id : null;
            }
            return known(externalizeSessionWire(
              run, session,
            ));
          }
          catch (cause) { return failed(cause, true); }
        case 'turn.session.append':
          if (!sameSession()) return failed('session authority mismatch', true);
          try {
            const message = /** @type {any} */ (rehydrateMessage(
              run, jsonUnwire(value.messageJson, 'session message'),
            ));
            const session = await run.ctx.sessions.appendMessage(
              run.sessionId, message,
            );
            run.resumeAssistantId = null;
            if (message?.role === 'assistant' && typeof message.id === 'string') {
              run.currentAssistantId = message.id;
            }
            return known(externalizeSessionWire(run, session));
          } catch (cause) { return unknown(run, cause); }
        case 'turn.session.update-assistant':
          {
          if (!sameSession() || typeof value.messageId !== 'string') {
            return failed('session authority mismatch', true);
          }
          let patch;
          try { patch = jsonUnwire(value.patchJson, 'session patch'); }
          catch (cause) { return failed(cause, true); }
          const resumeFinalize = value.messageId === run.resumeAssistantId
            && isRecord(patch) && Object.keys(patch).length === 1
            && patch.streaming === false;
          if (value.messageId !== run.currentAssistantId && !resumeFinalize) {
            return failed('session authority mismatch', true);
          }
          try {
            await run.ctx.sessions.updateAssistantMessage(
              run.sessionId, value.messageId, patch,
            );
            if (resumeFinalize) run.resumeAssistantId = null;
            return known(null);
          } catch (cause) { return unknown(run, cause); }
          }
        case 'turn.session.set-trim':
          if (!sameSession()) return failed('session authority mismatch', true);
          try {
            await run.ctx.sessions.setTrimSummary?.(
              run.sessionId, jsonUnwire(value.stateJson, 'trim state'),
            );
            return known(null);
          } catch (cause) { return unknown(run, cause); }
        case 'turn.prompt.get': {
          const prompt = await run.ctx.getSystemPrompt();
          run.system = prompt;
          return known(prompt);
        }
        case 'turn.tools.refresh': {
          const tools = await run.ctx.refreshTools();
          setTools(run, tools);
          return known({
            toolsJson: jsonWire(run.tools), classifications: run.classifications,
          });
        }
        case 'turn.audit.append':
          try { return known(await run.ctx.appendAudit(value.entry)); }
          catch (cause) { return failed(cause, true); }
        case 'turn.trim.enrich':
          try { return known(run.ctx.enrichTrimSummary?.(value.request)); }
          catch (cause) { return failed(cause, true); }
        case 'turn.model.open': {
          if (run.models.size !== 0) return failed('overlapping model stream refused', true);
          const session = await run.ctx.sessions.get(run.sessionId);
          const args = /** @type {Record<string, any>} */ (
            jsonUnwire(value.requestJson, 'model request')
          );
          if (!session || args.provider !== session.provider || args.model !== session.model
              || typeof run.system !== 'string' || args.system !== run.system
              || !sameClone(authorityTools(args.tools), run.tools)) {
            return failed('model/tool/system pin mismatch', true);
          }
          run.modelToolCalls.clear();
          run.legacyToolCalls.clear();
          const modelId = newId();
          const hydrated = rehydrateModelArgs(run, args);
          const iterator = run.ctx.callModel(hydrated)[Symbol.asyncIterator]();
          run.models.set(modelId, iterator);
          return known({ modelId });
        }
        case 'turn.model.next': {
          const iterator = run.models.get(value.modelId);
          if (!iterator) return failed('model stream is not active', true);
          try {
            const next = await iterator.next();
            if (next.done) {
              run.models.delete(value.modelId);
              return known({ done: true });
            }
            recordModelEvent(run, next.value);
            return known({ done: false, event: next.value });
          } catch (cause) {
            run.models.delete(value.modelId);
            return failed(cause, true);
          }
        }
        case 'turn.model.cancel': {
          const iterator = run.models.get(value.modelId);
          run.models.delete(value.modelId);
          if (iterator?.return) await iterator.return();
          return known(null);
        }
        case 'turn.tool.prepare': {
          if (!protocolEnabled) return known({ mode: 'legacy' });
          const call = jsonUnwire(value.callJson, 'tool call');
          if (!isRecord(call) || !issuedToolCall(run, call)) {
            return failed('tool call was not issued by the pinned model stream', true);
          }
          const issued = run.modelToolCalls.get(call.id);
          run.modelToolCalls.delete(call.id);
          const release = await acquireDispatch(
            run, dispatchIsConcurrencySafe(run, call.name),
          );
          const executionId = newId();
          const deadlineAt = Number.isSafeInteger(context.deadlineAt)
            ? Number(context.deadlineAt) : now() + TURN_DEADLINE_MS;
          const modelArgsDigest = await digestArgs(call.args ?? {});
          const baseBinding = Object.freeze({
            runId: run.runId,
            callId: call.id,
            sessionId: run.sessionId,
            turnGeneration: run.turnGeneration,
            toolName: call.name,
            executionId,
            modelArgsDigest,
            deadlineAt,
            signal: run.signal,
          });
          let prepared;
          try {
            prepared = await prepareToolCall?.(call, run.ctx, baseBinding);
          } catch (cause) {
            release();
            return failed(cause, true);
          }
          if (prepared === null) {
            run.legacyToolCalls.set(call.id, issued);
            release();
            return known({ mode: 'legacy' });
          }
          if (!isRecord(prepared)) {
            release();
            return failed('tool preparation result is invalid', true);
          }
          if (prepared.mode === 'result') {
            release();
            return known({
              mode: 'result',
              resultJson: jsonWire(externalizeToolResult(run, prepared.result)),
            });
          }
          const attempt = prepared.attempt ?? 0;
          if (prepared.mode !== 'execute' || !Object.hasOwn(prepared, 'custody')
              || !isRecord(prepared.projection)
              || typeof prepared.manifestDigest !== 'string'
              || !DIGEST.test(prepared.manifestDigest)
              || !Number.isSafeInteger(attempt) || Number(attempt) < 0) {
            release();
            return unknown(run, 'tool execution preparation is invalid');
          }
          let argsDigest;
          try { argsDigest = await digestArgs(prepared.args); }
          catch (cause) { release(); return failed(cause, true); }
          if (!DIGEST.test(argsDigest)) {
            release();
            return failed('tool argument digest is invalid', true);
          }
          const binding = Object.freeze({ ...baseBinding, argsDigest });
          const request = {
            protocol: TOOL_EXECUTION_PROTOCOL,
            executionId,
            runId: run.runId,
            callId: call.id,
            sessionId: run.sessionId,
            turnGeneration: run.turnGeneration,
            attempt: Number(attempt),
            toolName: call.name,
            argsDigest,
            manifestDigest: prepared.manifestDigest,
            args: prepared.args,
            projection: prepared.projection,
          };
          const parsedRequest = parseToolExecutionRequest(request, toolManifest);
          if (!parsedRequest) {
            release();
            return failed('tool execution request is outside its manifest', true);
          }
          run.preparedExecutions.set(executionId, {
            executionId, argsDigest, binding, call, custody: prepared.custody,
            deadlineAt, release, open: true, effectEntered: false, effectPending: 0,
            pendingIrreversible: 0, settledIrreversible: false,
            unknownIrreversible: false, policy: parsedRequest.policy,
            quota: createToolEffectQuota(parsedRequest.policy),
          });
          return known({ mode: 'execute', requestJson: jsonWire(request), deadlineAt });
        }
        case 'turn.tool.effect': {
          const entry = run.preparedExecutions.get(value.executionId);
          if (!entry || entry.open !== true || value.argsDigest !== entry.argsDigest
              || value.turnGeneration !== run.turnGeneration
              || typeof value.operation !== 'string'
              || !EFFECT_OPERATION.test(value.operation)) {
            return failed('tool effect grant mismatch', true);
          }
          if (run.signal.aborted || context.signal?.aborted || entry.deadlineAt <= now()) {
            return failed('tool effect grant settled', true);
          }
          const effectPolicy = entry.policy.effects.find(
            (/** @type {any} */ effect) => effect.operation === value.operation,
          );
          if (!effectPolicy) return known({
            ok: false, code: 'tool-effect-denied', outcomeKnown: true,
          });
          if (entry.effectPending >= entry.quota.pendingCap) return known({
            ok: false, code: 'tool-effect-concurrency-exhausted', outcomeKnown: true,
          });
          const admitted = entry.quota.admit(value.operation, value.effectPayload);
          if (admitted.ok !== true) return known(admitted);
          const replayable = effectPolicy.riskClass === 'read'
            || effectPolicy.riskClass === 'control';
          entry.effectEntered = true;
          entry.effectPending += 1;
          if (!replayable) entry.pendingIrreversible += 1;
          let result;
          try {
            result = await handleToolEffect?.({
              custody: entry.custody,
              operation: value.operation,
              payload: value.effectPayload,
              call: entry.call,
              ctx: run.ctx,
              binding: entry.binding,
            });
          } catch (cause) {
            const loss = toolEffectLossSemantics(effectPolicy.riskClass, 'during');
            result = {
              ok: false,
              code: 'tool-effect-kernel-lost',
              error: cause instanceof Error ? cause.message : String(cause),
              outcomeKnown: loss.outcomeKnown,
              retryable: loss.retryable,
            };
          }
          entry.effectPending = Math.max(0, entry.effectPending - 1);
          if (!replayable) {
            entry.pendingIrreversible = Math.max(0, entry.pendingIrreversible - 1);
          }
          const observed = entry.quota.observe(value.operation, result);
          if (observed.ok !== true) {
            const loss = toolEffectLossSemantics(effectPolicy.riskClass, 'during');
            if (!loss.outcomeKnown) {
              entry.unknownIrreversible = true;
              run.nestedUnknown = true;
            }
            return known({
              ok: false,
              code: observed.code,
              outcomeKnown: loss.outcomeKnown,
              retryable: loss.retryable,
            });
          }
          if (result.outcomeKnown !== true && !replayable) {
            entry.unknownIrreversible = true;
            run.nestedUnknown = true;
          }
          if (!replayable && result.outcomeKnown === true
              && (result.ok === true || result.retryable !== true)) {
            entry.settledIrreversible = true;
          }
          if (entry.open !== true || run.signal.aborted
              || context.signal?.aborted || entry.deadlineAt <= now()) {
            const loss = toolEffectLossSemantics(
              effectPolicy.riskClass, result.outcomeKnown === true ? 'after' : 'during',
            );
            if (!loss.outcomeKnown) run.nestedUnknown = true;
            return known({
              ok: false, code: 'tool-effect-grant-settled',
              outcomeKnown: loss.outcomeKnown, retryable: loss.retryable,
            });
          }
          return known(result);
        }
        case 'turn.tool.settle': {
          const entry = run.preparedExecutions.get(value.executionId);
          if (!entry || entry.open !== true || value.argsDigest !== entry.argsDigest
              || value.turnGeneration !== run.turnGeneration) {
            return failed('tool settlement grant mismatch', true);
          }
          const reported = jsonUnwire(value.resultJson, 'tool execution result');
          const validReported = isRecord(reported)
            && toolExecutionResultAllowed(reported, entry.policy.resultBytes)
            && reported.executionId === entry.executionId
            && reported.argsDigest === entry.argsDigest;
          entry.open = false;
          const effectEntered = entry.effectEntered === true;
          const state = executionCustody(entry);
          const pending = entry.effectPending > 0;
          const result = !validReported ? executionFailure(
            entry,
            'tool-execution-result-invalid',
            state.outcomeKnown
              ? 'Tool executor returned an invalid result with a known effect state.'
              : 'Tool outcome unknown. Check state before retrying.',
          ) : !state.outcomeKnown ? executionFailure(
            entry,
            reported.code ?? 'tool-outcome-unknown',
            'Tool outcome unknown. Check state before retrying.',
          ) : pending ? executionFailure(
            entry,
            'tool-effect-pending',
            'Tool execution ended while a replay-safe effect was pending.',
          ) : reported.outcomeKnown === true ? {
            ...reported,
            effectEntered,
            ...(reported.ok === false && state.retryable === false
              ? { retryable: false } : {}),
          } : executionFailure(
            entry,
            reported.code,
            effectEntered
              ? 'Tool execution stopped after the kernel observed its effect.'
              : 'Tool execution interrupted before its effect.',
          );
          if (/** @type {any} */ (result).outcomeKnown !== true) run.nestedUnknown = true;
          try {
            const settledResult = await settleToolCall?.({
              custody: entry.custody,
              result,
              call: entry.call,
              ctx: run.ctx,
              binding: entry.binding,
            });
            return known(jsonWire(externalizeToolResult(run, settledResult)));
          } catch (cause) {
            return unknown(run, cause);
          } finally {
            run.preparedExecutions.delete(entry.executionId);
            entry.release();
          }
        }
        case 'turn.tool.dispatch': {
          const call = jsonUnwire(value.callJson, 'tool call');
          if (!isRecord(call) || typeof call.id !== 'string' || typeof call.name !== 'string'
              || !run.toolNames.has(call.name)) {
            return failed('tool grant mismatch', true);
          }
          if (controllerHostsTool(call.name)) {
            return {
              ok: false, code: 'turn-controller-tool-legacy-dispatch-refused',
              error: 'controller-owned tool requires finite execution', outcomeKnown: true,
            };
          }
          if (!issuedToolCall(run, call)
              && !issuedToolCall(run, call, run.legacyToolCalls)) {
            return failed('tool call was not issued by the pinned model stream', true);
          }
          run.modelToolCalls.delete(call.id);
          run.legacyToolCalls.delete(call.id);
          try {
            const result = await scheduleDispatch(
              run,
              dispatchIsConcurrencySafe(run, call.name),
              () => run.ctx.toolDispatch(call),
            );
            if (result?.outcomeKnown === false) run.nestedUnknown = true;
            return known(jsonWire(externalizeToolResult(run, result)));
          } catch (cause) {
            return /** @type {{code?:string}} */ (cause)?.code === 'turn-tool-not-dispatched'
              ? failed(cause, true) : unknown(run, cause);
          }
        }
        case 'turn.event':
          await run.events.push(rehydrateEvent(
            run, jsonUnwire(value.eventJson, 'turn event'),
          ));
          return known(null);
        case 'turn.abort.finalize': {
          const outcomeUnknown = value.outcomeKnown === false;
          if (!sameSession() || typeof value.messageId !== 'string'
              || value.messageId !== run.currentAssistantId
              || (value.content !== undefined && typeof value.content !== 'string')
              || (outcomeUnknown && (typeof value.error !== 'string'
                || typeof value.code !== 'string' || value.retryable !== false))) {
            return failed('abort finalization authority mismatch', true);
          }
          if (run.abortFinalized) return failed('abort already finalized', true);
          run.abortFinalized = true;
          run.currentAssistantId = null;
          try {
            await run.ctx.sessions.updateAssistantMessage(run.sessionId, value.messageId, {
              ...(value.content === undefined ? {} : { content: value.content }),
              streaming: false,
              ...(outcomeUnknown ? {
                error: value.error,
                errorCode: value.code,
                outcomeKnown: false,
                retryable: false,
              } : { stopReason: 'aborted' }),
            });
            await run.events.push(outcomeUnknown ? {
              type: 'error', sessionId: run.sessionId, messageId: value.messageId,
              error: value.error, code: value.code,
              outcomeKnown: false, retryable: false,
            } : {
              type: 'stop', sessionId: run.sessionId,
              messageId: value.messageId, stopReason: 'aborted',
            });
            return known(null);
          } catch (cause) { return unknown(run, cause); }
        }
        case 'turn.finalize':
          if (run.signal.aborted && run.activeDispatches.size > 0) {
            return unknown(run, 'a dispatched operation remained active after Stop');
          }
          if (run.preparedExecutions.size > 0) {
            await cleanupPrepared(run, 'tool-execution-unsettled');
          }
          await Promise.allSettled([run.dispatchBarrier, ...run.activeSafeDispatches]);
          return run.nestedUnknown
            ? unknown(run, 'a kernel operation crossed dispatch without a known outcome')
            : known(null);
        default:
          return { ok: false, code: 'turn-kernel-operation-denied', outcomeKnown: true };
      }
    } catch (cause) {
      return operation.startsWith('turn.session.') && operation !== 'turn.session.get'
        ? unknown(run, cause) : failed(cause, true);
    }
  };

  const runUserTurn = async function* (/** @type {Record<string, any>} */ ctx) {
    if (typeof ctx?.sessionId !== 'string' || !ctx.sessionId) {
      throw new Error('controller turn requires a sessionId');
    }
    const runId = newId();
    const events = makeEventQueue();
    const localAbort = new AbortController();
    const onAbort = () => localAbort.abort();
    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
    if (ctx.signal?.aborted) localAbort.abort();
    const turnGeneration = (sessionGenerations.get(ctx.sessionId) ?? 0) + 1;
    sessionGenerations.set(ctx.sessionId, turnGeneration);
    const run = {
      runId, sessionId: ctx.sessionId, turnGeneration,
      ctx, events, abort: localAbort, signal: localAbort.signal,
      opaque: new Map(), models: new Map(), modelToolCalls: new Map(),
      legacyToolCalls: new Map(),
      preparedExecutions: new Map(),
      tools: [], toolNames: new Set(), classifications: {}, system: null,
      nestedUnknown: false, abortFinalized: false,
      currentAssistantId: null, resumeAssistantId: null,
      dispatchBarrier: Promise.resolve(),
      activeDispatches: new Set(), activeSafeDispatches: new Set(),
    };
    setTools(run, ctx.tools);
    const cleanCtx = controllerCtx(ctx);
    if (ctx.attachments !== undefined) {
      cleanCtx.attachments = externalizeAttachments(run, ctx.attachments);
    }
    runs.set(runId, run);
    let settled;
    try {
      const client = await getClient();
      settled = client.call('turn.run', {
        runId, sessionId: ctx.sessionId,
        maxSteps: cleanCtx.maxSteps,
        ctxJson: jsonWire(cleanCtx),
        toolsJson: jsonWire(run.tools),
        classifications: run.classifications,
      }, { signal: localAbort.signal, timeoutMs: 30 * 60_000 });
      settled.finally(() => events.close()).catch(() => {});
      while (true) {
        const next = await events.next();
        if (next.done) break;
        try { yield next.value; }
        finally { next.ack?.(); }
      }
      const result = await settled;
      if (result?.ok !== true) {
        const error = new Error(result?.error ?? result?.code ?? 'semantic turn controller failed');
        Object.assign(error, {
          code: result?.code ?? 'controller-turn-failed',
          outcomeKnown: result?.outcomeKnown === true,
          ...(result?.retryable === false ? { retryable: false } : {}),
        });
        throw error;
      }
    } finally {
      localAbort.abort();
      ctx.signal?.removeEventListener?.('abort', onAbort);
      events.close();
      await cleanupPrepared(run, 'tool-execution-controller-lost');
      runs.delete(runId);
      for (const iterator of run.models.values()) {
        try { await iterator.return?.(); } catch { /* detached provider cleanup */ }
      }
      run.models.clear();
      run.opaque.clear();
    }
  };

  return Object.freeze({
    authorize,
    handleKernelCall,
    runUserTurn,
    close: () => {
      for (const run of runs.values()) {
        run.abort.abort();
        run.events.close();
        void cleanupPrepared(run, 'tool-execution-kernel-closed');
      }
      runs.clear();
      sessionGenerations.clear();
    },
    activeCount: () => runs.size,
  });
};
