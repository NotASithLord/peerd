// @ts-check
// Authority-kernel bridge for the pure orchestrator loop hosted by the sealed
// semantic controller. The controller receives transcript text and opaque
// binary references; every effect and every authority-bearing lookup stays in
// this service-worker closure.

const TURN_EVENT_QUEUE_CAP = 8;
const OPAQUE_PREFIX = 'peerd-controller-opaque:';
const ABORT_CLEANUP_OPERATIONS = new Set(['turn.abort.finalize', 'turn.finalize']);

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
    'preflightReply',
  ];
  const out = /** @type {Record<string, unknown>} */ ({});
  for (const key of keys) if (ctx[key] !== undefined) out[key] = ctx[key];
  return out;
};

/**
 * @param {Object} deps
 * @param {() => Promise<{call:(capability:string,payload:unknown,options?:any)=>Promise<any>}>} deps.getClient
 * @param {() => string} [deps.newId]
 */
export const makeControllerTurnBridge = ({
  getClient,
  newId = () => crypto.randomUUID(),
}) => {
  /** @type {Map<string, any>} */
  const runs = new Map();

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
              || !sameClone(args.tools ?? [], run.tools)) {
            return failed('model/tool/system pin mismatch', true);
          }
          run.modelToolCalls.clear();
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
        case 'turn.tool.dispatch': {
          const call = jsonUnwire(value.callJson, 'tool call');
          if (!isRecord(call) || typeof call.id !== 'string' || typeof call.name !== 'string'
              || !run.toolNames.has(call.name)) {
            return failed('tool grant mismatch', true);
          }
          const issued = run.modelToolCalls.get(call.id);
          let issuedArgs = {};
          try { issuedArgs = issued?.inputBuf ? JSON.parse(issued.inputBuf) : {}; }
          catch { issuedArgs = {}; }
          if (!issued || issued.name !== call.name || !sameClone(issuedArgs, call.args)) {
            return failed('tool call was not issued by the pinned model stream', true);
          }
          run.modelToolCalls.delete(call.id);
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
    const run = {
      runId, sessionId: ctx.sessionId, ctx, events, signal: localAbort.signal,
      opaque: new Map(), models: new Map(), modelToolCalls: new Map(),
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
      for (const run of runs.values()) run.events.close();
      runs.clear();
    },
    activeCount: () => runs.size,
  });
};
