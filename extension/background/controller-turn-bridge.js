// @ts-check
// Authority-kernel bridge for the pure orchestrator loop hosted by the sealed
// semantic controller. The controller receives transcript text and opaque
// binary references; every effect and every authority-bearing lookup stays in
// this service-worker closure.

import {
  TOOL_EXECUTION_PROTOCOL,
  normalizeHostEffectOutcome,
  parseToolExecutionRequest,
  stampHostEffectVerdict,
  toolExecutionResultAllowed,
} from '../shared/tool-execution-protocol.js';
import { HOST_EFFECT_OUTCOME } from './host-effect-verdict.js';
import {
  CONTROLLER_AUTHORITY_MANIFEST,
  controllerAuthorityClassAllowed,
} from '../shared/controller-authority-manifest.js';
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

const TURN_EVENT_QUEUE_CAP = 8;
const OPAQUE_PREFIX = 'peerd-controller-opaque:';
const ABORT_CLEANUP_OPERATIONS = new Set([
  'turn.model.cancel-inference', 'turn.model.cancel-local',
  'turn.tool.settle', 'turn.abort.finalize', 'turn.finalize',
]);
const DIGEST = /^[a-f0-9]{64}$/;
const TURN_DEADLINE_MS = 30 * 60_000;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value !== null
  && typeof value === 'object' && !Array.isArray(value);

const exactOptionalKeys = (
  /** @type {Record<string,any>|null} */ value,
  /** @type {string[]} */ required,
  /** @type {string[]} */ optional = [],
) => !!value && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

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
    'userText', 'synthetic', 'resume', 'previousTurnAt', 'turnNow',
    'activeTabContext', 'protectedTabContext', 'recoveryBlock',
    'reasoningEnabled', 'reasoningEffort',
    'actorReply', 'contextWindow', 'oneShot', 'maxSteps', 'persistDeltas',
    'preflightReply', 'runtimeCapabilities', 'providerFailoverEnabled',
    'providerFallbacks', 'contextWindowOverrides', 'pricingOverrides',
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
 * @param {(input:{custody:unknown,result:Record<string,any>,call:Record<string,any>,
 *   ctx:Record<string,any>,binding:Record<string,any>})=>Promise<any>} [deps.settleToolCall]
 * @param {(value:unknown)=>Promise<string>} [deps.digestArgs]
 * @param {ReturnType<import('../shared/tool-execution-protocol.js').compileToolEffectManifest>}
 *   [deps.toolManifest]
 * @param {()=>number} [deps.now]
 * @param {ReturnType<import('./provider-egress-authority.js').createProviderEgressAuthority>}
 *   [deps.providerEgress]
 * @param {number} [deps.cleanupTimeoutMs]
 */
export const makeControllerTurnBridge = ({
  getClient,
  newId = () => crypto.randomUUID(),
  prepareToolCall,
  settleToolCall,
  digestArgs = digestJson,
  toolManifest = CONTROLLER_AUTHORITY_MANIFEST,
  providerEgress,
  now = Date.now,
  cleanupTimeoutMs = 250,
}) => {
  /** @type {Map<string, any>} */
  const runs = new Map();
  /** @type {Map<string, number>} */
  const sessionGenerations = new Map();
  const runIsLive = (/** @type {any} */ run) =>
    runs.get(run.runId) === run && run.signal.aborted !== true;
  if (!toolManifest || toolManifest.protocol !== TOOL_EXECUTION_PROTOCOL
      || typeof toolManifest.digest !== 'string' || !isRecord(toolManifest.tools)) {
    throw new TypeError('controller-authority-manifest-invalid');
  }
  const cleanupFuseMs = Number.isFinite(cleanupTimeoutMs) && cleanupTimeoutMs > 0
    ? Math.floor(cleanupTimeoutMs) : 250;
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
  const openProviderCustody = async (
    /** @type {any} */ run,
    /** @type {()=>Promise<any>} */ open,
  ) => {
    let result;
    try {
      result = await open();
    } finally {
      // why: even a rejected admission may have made owner-scoped provider
      // state visible before failing. Advance custody so finalization cannot
      // reuse a close that completed while the admission was still pending.
      run.providerCustodyGeneration += 1;
      if (run.signal.aborted) await closeProviderOwner(run);
    }
    if (!run.signal.aborted) return result;
    return { ok: false, code: 'turn-run-aborted', outcomeKnown: true };
  };

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
    run.toolDescriptors = new Map(run.tools.map((/** @type {any} */ tool) => [tool?.name, tool]));
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
  const cleanupPrepared = async (
    /** @type {any} */ run,
    /** @type {string} */ code,
    /** @type {{detachSettlement?:boolean}} */ options = {},
  ) => {
    const entries = [...run.preparedExecutions.values()];
    run.preparedExecutions.clear();
    for (const entry of entries) {
      const needsSettlement = entry.open === true;
      entry.open = false;
      const state = executionCustody(entry);
      const outcomeKnown = state.outcomeKnown;
      if (!outcomeKnown) run.nestedUnknown = true;
      const settle = async () => {
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
      };
      if (options.detachSettlement) {
        // why: emergency kernel teardown must not wait forever on an arbitrary
        // asynchronous post-tool hook. Provider custody is released on the
        // awaited lane below; this best-effort settlement owns no authority.
        void settle().catch(() => {
          if (!outcomeKnown) run.nestedUnknown = true;
        });
        entry.release();
        continue;
      }
      try { await settle(); }
      catch { if (!outcomeKnown) run.nestedUnknown = true; }
      finally { entry.release(); }
    }
  };
  const closeProviderOwner = (/** @type {any} */ run) => {
    // why: bridge shutdown and ordinary turn finalization can race. One exact
    // bounded close per custody generation makes cleanup idempotent without
    // masking a stream admitted after Stop's prior close already settled.
    if (run.providerClose
        && run.providerCloseGeneration === run.providerCustodyGeneration) {
      return run.providerClose;
    }
    run.providerCloseGeneration = run.providerCustodyGeneration;
    run.providerClose = providerEgress?.closeOwner
      ? boundedCleanup(Promise.resolve().then(() => providerEgress.closeOwner(run.providerOwner)))
      : Promise.resolve();
    return run.providerClose;
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
  const redeemModelOpaque = (/** @type {any} */ run, /** @type {string} */ token) => {
    const opaque = run.opaque.get(token);
    return opaque?.kind === 'attachment' || opaque?.kind === 'tool-image'
      ? opaque.value : null;
  };
  const modelCandidate = (/** @type {any} */ value) => isRecord(value)
    && typeof value.provider === 'string' && value.provider.length > 0
    && value.provider.length <= 64
    && typeof value.model === 'string' && value.model.length > 0
    && value.model.length <= 256
    ? { provider: value.provider, model: value.model } : null;
  const modelGrant = (/** @type {any} */ run) => ({
    owner: run.providerOwner,
    signal: run.signal,
    maxOutputTokens: run.maxOutputTokens,
    permits: (/** @type {string} */ providerId, /** @type {string} */ modelId) =>
      run.modelCandidates.some((/** @type {any} */ candidate) =>
        candidate.provider === providerId && candidate.model === modelId),
    permitsProvider: (/** @type {string} */ providerId) =>
      run.modelCandidates.some((/** @type {any} */ candidate) => candidate.provider === providerId),
    redeemOpaque: (/** @type {string} */ token) => redeemModelOpaque(run, token),
  });
  const domainExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string} */ domain,
    /** @type {string[]} */ businessKeys,
    /** @type {string[]} */ optionalKeys = [],
  ) => {
    if (!exactOptionalKeys(value, [
      'executionId', 'argsDigest', 'turnGeneration', ...businessKeys,
    ], optionalKeys)) return null;
    const entry = run.preparedExecutions.get(value.executionId);
    if (!entry || entry.open !== true || entry.domain !== domain
        || value.argsDigest !== entry.argsDigest
        || value.turnGeneration !== run.turnGeneration) return null;
    return entry;
  };
  const runDomainEffect = async (
    /** @type {any} */ run,
    /** @type {any} */ entry,
    /** @type {string} */ operation,
    /** @type {'read'|'control'|'commit'|'resource'} */ riskClass,
    /** @type {()=>Promise<any>|any} */ execute,
    /** @type {boolean} */ recordEffectVerdict = false,
    /** @type {{fulfilled?:(value:any)=>unknown,rejected?:(cause:unknown)=>unknown}|null} */ effectOutcome = null,
  ) => {
    if (entry.domainCalls.has(operation)) {
      return failed('domain authority operation already used', true);
    }
    const replayable = riskClass === 'read' || riskClass === 'control';
    if ((!replayable || recordEffectVerdict)
        && (typeof effectOutcome?.fulfilled !== 'function'
          || typeof effectOutcome?.rejected !== 'function')) {
      return failed('domain effect verdict contract is unavailable', true);
    }
    entry.domainCalls.add(operation);
    if (!replayable || recordEffectVerdict) entry.effectVerdictObserved = true;
    entry.effectEntered = true;
    entry.effectPending += 1;
    if (!replayable) entry.pendingIrreversible += 1;
    let result;
    try { result = await execute(); }
    catch (cause) {
      entry.effectPending = Math.max(0, entry.effectPending - 1);
      if (!replayable) entry.pendingIrreversible = Math.max(0, entry.pendingIrreversible - 1);
      const detail = /** @type {{outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
      const verdict = replayable && !recordEffectVerdict ? 'not-performed'
        : normalizeHostEffectOutcome(effectOutcome?.rejected?.(cause));
      if (verdict === 'performed') entry.settledIrreversible = true;
      const outcomeKnown = replayable || verdict !== 'unknown';
      if (!outcomeKnown) {
        entry.unknownIrreversible = true;
        run.nestedUnknown = true;
      }
      return {
        ok: false,
        code: 'domain-authority-operation-lost',
        error: cause instanceof Error ? cause.message : String(cause),
        outcomeKnown,
        retryable: verdict === 'not-performed' && detail?.retryable !== false,
      };
    }
    entry.effectPending = Math.max(0, entry.effectPending - 1);
    if (!replayable) entry.pendingIrreversible = Math.max(0, entry.pendingIrreversible - 1);
    if (!replayable || recordEffectVerdict) {
      const verdict = normalizeHostEffectOutcome(effectOutcome?.fulfilled?.(result));
      if (verdict === 'performed') entry.settledIrreversible = true;
      else if (verdict === 'unknown') {
        entry.unknownIrreversible = true;
        run.nestedUnknown = true;
      }
    }
    return known(result);
  };
  const repositoryExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'repository', fields);
    if (!entry) return null;
    bindRepositoryToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const vmExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
    /** @type {string[]} */ optional = [],
  ) => {
    const entry = domainExecutionEntry(run, value, 'vm', fields, optional);
    if (!entry) return null;
    bindVmToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx,
    });
    return entry;
  };
  const notebookExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'notebook', fields);
    if (!entry) return null;
    bindNotebookToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const appExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'app', fields);
    if (!entry) return null;
    bindAppToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const persistenceExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'persistence', fields);
    if (!entry) return null;
    bindPersistenceToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx,
    });
    return entry;
  };
  const pageExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
  ) => {
    const entry = domainExecutionEntry(run, value, 'page', []);
    if (!entry) return null;
    bindPageToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const resourceExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'resource', fields);
    if (!entry) return null;
    bindResourceToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const siteClientExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'siteclient', fields);
    if (!entry) return null;
    bindSiteClientToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const executionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'execution', fields);
    if (!entry) return null;
    bindExecutionToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const editingEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'editing', fields);
    if (!entry) return null;
    bindEditingToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx,
    });
    return entry;
  };
  const introspectionExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'introspection', fields);
    if (!entry) return null;
    bindIntrospectionToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx,
    });
    return entry;
  };
  const scheduleExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'schedule', fields);
    if (!entry) return null;
    bindScheduleToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
  };
  const dwebExecutionEntry = (
    /** @type {any} */ run,
    /** @type {Record<string,any>} */ value,
    /** @type {string[]} */ fields,
  ) => {
    const entry = domainExecutionEntry(run, value, 'dweb', fields);
    if (!entry) return null;
    bindDwebToolAuthority(entry.domainState, {
      call: entry.call, ctx: entry.custody?.ctx, signal: run.signal,
    });
    return entry;
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
        case 'turn.model.bind': {
          if (run.modelCandidates.length !== 0 || !Array.isArray(value.candidates)
              || value.candidates.length < 1 || value.candidates.length > 8) {
            return failed('model plan already bound or invalid', true);
          }
          const session = await run.ctx.sessions.get(run.sessionId);
          const candidates = value.candidates.map(modelCandidate);
          if (!session || candidates.some((candidate) => candidate === null)
              || candidates[0]?.provider !== session.provider
              || (session.model && candidates[0]?.model !== session.model)) {
            return failed('model plan primary mismatch', true);
          }
          const allowedFallbacks = run.ctx.providerFailoverEnabled === true
            && Array.isArray(run.ctx.providerFallbacks)
            ? new Set(run.ctx.providerFallbacks.filter(
              (/** @type {unknown} */ name) => typeof name === 'string',
            ))
            : new Set();
          const seen = new Set([session.provider]);
          for (const candidate of candidates.slice(1)) {
            if (!candidate || !allowedFallbacks.has(candidate.provider)
                || seen.has(candidate.provider)) {
              return failed('model plan fallback mismatch', true);
            }
            seen.add(candidate.provider);
          }
          if (!session.model) {
            try {
              await run.ctx.sessions.update(run.sessionId, { model: candidates[0]?.model });
            } catch (cause) { return unknown(run, cause); }
          }
          run.modelCandidates = candidates;
          return known({ candidates });
        }
        case 'turn.model.open-inference': {
          if (!providerEgress || run.modelCandidates.length === 0) {
            return failed('model egress unavailable', true);
          }
          run.modelToolCalls.clear();
          return openProviderCustody(run, () =>
            providerEgress.openInference(value, modelGrant(run)));
        }
        case 'turn.model.read-inference':
          return providerEgress
            ? providerEgress.readInferenceChunk(value, modelGrant(run))
            : failed('model egress unavailable', true);
        case 'turn.model.cancel-inference':
          return providerEgress
            ? providerEgress.cancelInference(value, modelGrant(run))
            : failed('model egress unavailable', true);
        case 'turn.model.read-inventory':
          return providerEgress
            ? providerEgress.readModelInventory(value, modelGrant(run))
            : failed('model egress unavailable', true);
        case 'turn.model.read-context':
          return providerEgress
            ? providerEgress.readModelContext(value, modelGrant(run))
            : failed('model egress unavailable', true);
        case 'turn.model.open-local':
          return providerEgress
            ? openProviderCustody(run, () =>
              providerEgress.openLocalGeneration(value, modelGrant(run)))
            : failed('local model egress unavailable', true);
        case 'turn.model.read-local':
          return providerEgress
            ? providerEgress.readLocalGeneration(value, modelGrant(run))
            : failed('local model egress unavailable', true);
        case 'turn.model.cancel-local':
          return providerEgress
            ? providerEgress.cancelLocalGeneration(value, modelGrant(run))
            : failed('local model egress unavailable', true);
        case 'turn.model.observe-event':
          if (value.type === 'tool-use-start'
              && typeof value.id === 'string' && typeof value.name === 'string') {
            recordModelEvent(run, value);
            return known(null);
          }
          if (value.type === 'tool-use-delta'
              && typeof value.id === 'string' && typeof value.partialJson === 'string'
              && value.partialJson.length <= 256 * 1024) {
            recordModelEvent(run, value);
            return known(null);
          }
          return failed('model event observation invalid', true);
        case 'turn.model.observe-failover': {
          const from = modelCandidate(value.from);
          const to = modelCandidate(value.to);
          if (!from || !to || !modelGrant(run).permits(from.provider, from.model)
              || !modelGrant(run).permits(to.provider, to.model)) {
            return failed('model failover observation invalid', true);
          }
          run.ctx.appendAudit({
            type: 'provider_failover', sessionId: run.sessionId,
            details: { from: from.provider, to: to.provider, reason: String(value.reason ?? 'error').slice(0, 128) },
          }).catch(() => {});
          run.ctx.postChatNote?.(`${from.provider} unavailable; switching to ${to.provider} and continuing…`);
          return known(null);
        }
        case 'turn.tool.prepare': {
          const call = jsonUnwire(value.callJson, 'tool call');
          if (!isRecord(call) || !issuedToolCall(run, call)
              || !controllerAuthorityClassAllowed(value.authorityClass)) {
            return failed('tool call was not issued by the pinned model stream', true);
          }
          run.modelToolCalls.delete(call.id);
          const release = await acquireDispatch(
            run, dispatchIsConcurrencySafe(run, call.name),
          );
          if (!runIsLive(run)) {
            release();
            return failed('controller tool preparation lost its live run', true);
          }
          const executionId = newId();
          const deadlineAt = Number.isSafeInteger(context.deadlineAt)
            ? Number(context.deadlineAt) : now() + TURN_DEADLINE_MS;
          const modelArgsDigest = await digestArgs(call.args ?? {});
          if (!runIsLive(run)) {
            release();
            return failed('controller tool preparation lost its live run', true);
          }
          const baseBinding = Object.freeze({
            runId: run.runId,
            callId: call.id,
            sessionId: run.sessionId,
            turnGeneration: run.turnGeneration,
            toolName: call.name,
            executionId,
            modelArgsDigest,
            authorityClass: value.authorityClass,
            descriptor: run.toolDescriptors.get(call.name),
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
          const retirePrepared = (
            /** @type {string} */ error,
            /** @type {string} */ argsDigest = modelArgsDigest,
            /** @type {Record<string,any>} */ settledCall = call,
          ) => {
            release();
            if (!isRecord(prepared) || !Object.hasOwn(prepared, 'custody')
                || typeof settleToolCall !== 'function') return;
            const binding = Object.freeze({ ...baseBinding, argsDigest });
            // why: preparation may already have opened lifecycle/confirmation
            // custody. A Stop or invalid post-hook projection cannot leave that
            // record orphaned merely because exact authority was never inserted.
            void boundedCleanup(Promise.resolve().then(() => settleToolCall({
              custody: /** @type {Record<string,any>} */ (prepared).custody,
              result: {
                protocol: TOOL_EXECUTION_PROTOCOL,
                executionId,
                argsDigest,
                ok: false,
                code: 'tool-execution-prepare-aborted',
                error,
                outcomeKnown: true,
                effectEntered: false,
                retryable: true,
                phase: 'startup',
              },
              call: settledCall,
              ctx: run.ctx,
              binding,
            })));
          };
          if (!runIsLive(run)) {
            retirePrepared('Tool preparation completed after its run stopped.');
            return failed('controller tool preparation lost its live run', true);
          }
          if (prepared === null) {
            release();
            return failed('controller tool preparation unavailable', true);
          }
          if (!isRecord(prepared)) {
            release();
            return failed('tool preparation result is invalid', true);
          }
          if (prepared.mode === 'result') {
            release();
            if (run.signal.aborted || runs.get(run.runId) !== run) {
              return failed('controller turn stopped during tool preparation', true);
            }
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
            retirePrepared('Tool preparation returned an invalid authority projection.');
            return unknown(run, 'tool execution preparation is invalid');
          }
          let argsDigest;
          let effectiveArgs;
          let authorityCall;
          try {
            // why: a trusted hook may retain its returned object. Clone once
            // before the asynchronous digest so later mutations cannot split
            // the digest, controller request, and exact authority snapshot.
            effectiveArgs = structuredClone(prepared.args);
            argsDigest = await digestArgs(effectiveArgs);
            // why: hooks may rewrite arguments after the model-issued call is
            // admitted. The original digest remains in baseBinding; exact
            // domain authority binds the separately-digested effective args.
            authorityCall = Object.freeze({
              ...call, args: effectiveArgs,
            });
          }
          catch (cause) {
            retirePrepared(
              'Tool preparation arguments could not be frozen for exact authority.',
            );
            return failed(cause, true);
          }
          if (!runIsLive(run)) {
            retirePrepared(
              'Tool preparation completed after its run stopped.', argsDigest, authorityCall,
            );
            return failed('controller tool preparation lost its live run', true);
          }
          if (!DIGEST.test(argsDigest)) {
            retirePrepared('Tool preparation produced an invalid argument digest.');
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
            authorityClass: value.authorityClass,
            argsDigest,
            manifestDigest: prepared.manifestDigest,
            args: effectiveArgs,
            projection: prepared.projection,
          };
          const parsedRequest = parseToolExecutionRequest(request, toolManifest);
          if (!parsedRequest) {
            retirePrepared(
              'Tool preparation fell outside its exact authority manifest.',
              argsDigest,
              authorityCall,
            );
            return failed('tool execution request is outside its manifest', true);
          }
          if (!runIsLive(run)) {
            retirePrepared(
              'Tool preparation completed after its run stopped.', argsDigest, authorityCall,
            );
            return failed('controller tool preparation lost its live run', true);
          }
          run.preparedExecutions.set(executionId, {
            executionId, argsDigest, binding, call: authorityCall, custody: prepared.custody,
            deadlineAt, release, open: true, effectEntered: false, effectPending: 0,
            pendingIrreversible: 0, settledIrreversible: false,
            unknownIrreversible: false, effectVerdictObserved: false,
            policy: parsedRequest.policy,
            domain: parsedRequest.authorityClass,
            domainCalls: new Set(), domainState: {},
          });
          if (run.signal.aborted || runs.get(run.runId) !== run) {
            // why: Stop may settle the outer controller call while a policy or
            // confirmation hook is still preparing custody. Settle that late
            // preparation immediately; it must never escape into an effect.
            await cleanupPrepared(run, 'tool-execution-stopped-before-effect');
            return failed('controller turn stopped during tool preparation', true);
          }
          return known({ mode: 'execute', requestJson: jsonWire(request), deadlineAt });
        }
        case 'turn.goal.complete': {
          const entry = domainExecutionEntry(
            run, value, 'local', ['summary'],
          );
          const expected = typeof entry?.call?.args?.summary === 'string'
            ? entry.call.args.summary.trim() : '';
          const complete = entry?.custody?.ctx?.completeGoalRun;
          if (!entry || typeof value.summary !== 'string' || value.summary !== expected
              || typeof complete !== 'function') {
            return failed('goal completion authority mismatch', true);
          }
          return runDomainEffect(run, entry, operation, 'control', () => ({
            ended: complete(value.summary) === true,
          }));
        }
        case 'turn.actor.spawn-sync':
        case 'turn.actor.spawn-async': {
          const entry = domainExecutionEntry(run, value, 'actor', [
            'task', 'allowRecursion',
          ], ['tools', 'maxSteps', 'maxDepth']);
          const args = entry?.call?.args;
          const expectedTools = Array.isArray(args?.tools) ? args.tools : undefined;
          const expectedMaxSteps = Number.isFinite(args?.maxSteps) ? args.maxSteps : undefined;
          const expectedMaxDepth = Number.isFinite(args?.maxDepth) ? args.maxDepth : undefined;
          if (!entry || typeof value.task !== 'string'
              || value.task !== args?.task
              || value.allowRecursion !== (args?.allowRecursion === true)
              || (operation === 'turn.actor.spawn-sync') !== (args?.sync === true)
              || !sameClone(value.tools, expectedTools)
              || value.maxSteps !== expectedMaxSteps
              || value.maxDepth !== expectedMaxDepth
              || typeof value.allowRecursion !== 'boolean'
              || (value.tools !== undefined && (!Array.isArray(value.tools)
                || value.tools.some((/** @type {unknown} */ name) => typeof name !== 'string')))
              || (value.maxSteps !== undefined && !Number.isFinite(value.maxSteps))
              || (value.maxDepth !== undefined && !Number.isFinite(value.maxDepth))) {
            return failed('actor spawn authority mismatch', true);
          }
          const ctx = entry.custody?.ctx;
          const actorAuthority = ctx?.actorAuthority;
          const spawn = operation === 'turn.actor.spawn-sync'
            ? actorAuthority?.spawnSync : actorAuthority?.spawnAsync;
          if (typeof spawn !== 'function') {
            return known({ ok: false, error: 'actor_orchestrator_unavailable', outcomeKnown: true });
          }
          return runDomainEffect(run, entry, operation, 'resource', () => spawn({
            task: value.task,
            ...(value.tools === undefined ? {} : { tools: value.tools }),
            ...(value.maxSteps === undefined ? {} : { maxSteps: value.maxSteps }),
            ...(value.maxDepth === undefined ? {} : { maxDepth: value.maxDepth }),
            allowRecursion: value.allowRecursion,
            parentSessionId: ctx.session?.sessionId,
            parentDepth: ctx.session?.depth ?? 0,
            parentInbound: ctx.inbound === false ? false : true,
            parentToolUseId: entry.call.id,
          }), false, HOST_EFFECT_OUTCOME.actorResult);
        }
        case 'turn.actor.tasks': {
          const entry = domainExecutionEntry(run, value, 'actor', [], []);
          if (!entry) return failed('actor tasks authority mismatch', true);
          const list = entry.custody?.ctx?.actorAuthority?.listTasks;
          return runDomainEffect(run, entry, operation, 'read', () =>
            typeof list === 'function' ? list() : []);
        }
        case 'turn.actor.cancel': {
          const entry = domainExecutionEntry(run, value, 'actor', ['taskId']);
          if (!entry || typeof value.taskId !== 'string' || !value.taskId
              || value.taskId !== entry.call?.args?.taskId) {
            return failed('actor cancel authority mismatch', true);
          }
          const cancel = entry.custody?.ctx?.actorAuthority?.cancelTask;
          return runDomainEffect(run, entry, operation, 'control', () =>
            typeof cancel === 'function'
              ? cancel(value.taskId) : { ok: false, error: 'async_actor_unavailable' });
        }
        case 'turn.actor.message': {
          const entry = domainExecutionEntry(run, value, 'actor', [
            'to', 'message', 'oneShot', 'awaitReply', 'degradeToAsync', 'awaitCapMs',
          ]);
          const args = entry?.call?.args;
          const sessionKind = entry?.custody?.ctx?.session?.kind;
          if (!entry || typeof value.to !== 'string' || typeof value.message !== 'string'
              || value.to !== args?.to || value.message !== args?.message
              || value.oneShot !== (args?.oneShot === true)
              || value.awaitReply !== (sessionKind === 'spawned' || args?.await === true)
              || value.degradeToAsync !== (args?.await === true && sessionKind !== 'spawned')
              || typeof value.oneShot !== 'boolean' || typeof value.awaitReply !== 'boolean'
              || typeof value.degradeToAsync !== 'boolean'
              || !Number.isSafeInteger(value.awaitCapMs) || value.awaitCapMs < 1
              || value.awaitCapMs > 3 * 60_000) {
            return failed('actor message authority mismatch', true);
          }
          const ctx = entry.custody?.ctx;
          const messageActor = ctx?.actorAuthority?.deliverMessage;
          if (typeof messageActor !== 'function') {
            return known({ ok: false, error: 'message_actor is not enabled', outcomeKnown: true });
          }
          return runDomainEffect(run, entry, operation, 'resource', () => messageActor({
            to: value.to,
            message: value.message,
            oneShot: value.oneShot,
            senderSessionId: ctx.session?.sessionId,
            inbound: ctx.inbound === true,
            toolUseId: entry.call.id,
            awaitReply: value.awaitReply,
            awaitSignal: run.signal,
            degradeToAsync: value.degradeToAsync,
            awaitCapMs: value.awaitCapMs,
          }), false, HOST_EFFECT_OUTCOME.actorResult);
        }
        case 'turn.pod.resolve': {
          const entry = domainExecutionEntry(run, value, 'pod', ['podId']);
          if (!entry || value.podId !== entry.call?.args?.podId) {
            return failed('Pod resolution authority mismatch', true);
          }
          const ctx = entry.custody?.ctx;
          if (typeof ctx?.podClient?.resolveId !== 'function') {
            return failed('pod_unavailable', true);
          }
          const result = /** @type {any} */ (await runDomainEffect(
            run, entry, operation, 'read', () =>
              ctx.podClient.resolveId({ sessionId: ctx.session?.sessionId, podId: value.podId }),
          ));
          if (result?.ok === true && typeof result.value === 'string') {
            entry.domainState.podId = result.value;
          }
          return result;
        }
        case 'turn.pod.read-remote': {
          const entry = domainExecutionEntry(run, value, 'pod', ['podId']);
          const intent = entry ? podGitRemoteIntents(entry.call?.args?.command ?? '')[0] : null;
          if (!entry || typeof value.podId !== 'string'
              || value.podId !== entry.domainState.podId
              || !intent || intent.url) {
            return failed('Pod remote authority mismatch', true);
          }
          const readRemote = entry.custody?.ctx?.repositories?.getRemote;
          const result = /** @type {any} */ (await runDomainEffect(
            run, entry, operation, 'read', () => typeof readRemote === 'function'
              ? readRemote({ kind: 'pod', id: value.podId }) : null,
          ));
          if (result?.ok === true) entry.domainState.remote = result.value;
          return result;
        }
        case 'turn.pod.confirm-git': {
          const entry = domainExecutionEntry(run, value, 'pod', ['op']);
          const intents = entry ? podGitRemoteIntents(entry.call?.args?.command ?? '') : [];
          const intent = intents.length === 1 ? intents[0] : null;
          const target = intent?.url ?? entry?.domainState?.remote?.url;
          if (!entry || typeof entry.domainState.podId !== 'string'
              || !intent || value.op !== intent.op || typeof target !== 'string') {
            return failed('Pod Git confirmation authority mismatch', true);
          }
          let origin;
          try { origin = new URL(target).origin; }
          catch { return failed('Pod Git remote is invalid', true); }
          const confirm = entry.custody?.ctx?.confirm;
          if (typeof confirm !== 'function') return known(false);
          const result = /** @type {any} */ (await runDomainEffect(
            run, entry, operation, 'control', () => confirm({
            tool: 'pod_exec', kind: `git_${intent.op}`,
            sideEffect: intent.op === 'push' ? 'mutate_external' : 'write',
            origins: [origin],
            summary: intent.op === 'push'
              ? `Allow this one Pod job to push code and commit history to ${target}?`
              : `Allow this one Pod job to ${intent.op} ${target} through peerd's audited Git transport?`,
            }),
          ));
          if (result?.ok === true
              && [true, 'yes_once', 'yes_session'].includes(result.value)) {
            entry.domainState.remoteGitGrant = { op: intent.op, url: target };
          }
          return result;
        }
        case 'turn.pod.exec': {
          const entry = domainExecutionEntry(run, value, 'pod', [
            'command', 'podId', 'timeoutMs', 'background', 'remoteGitGrant',
          ]);
          const args = entry?.call?.args;
          let program;
          let intents;
          try {
            program = parsePodShell(args?.command ?? '');
            intents = podGitRemoteIntents(args?.command ?? '');
          } catch { return failed('Pod command authority mismatch', true); }
          const expectedTimeout = Math.min(300_000, Math.max(1, Number(args?.timeoutMs) || 30_000));
          const expectedBackground = args?.background === true || program.background;
          const expectedGrant = intents.length === 1
            ? entry?.domainState?.remoteGitGrant ?? null : null;
          if (!entry || intents.length > 1 || typeof entry.domainState.podId !== 'string'
              || value.command !== args?.command || value.podId !== entry.domainState.podId
              || value.timeoutMs !== expectedTimeout || value.background !== expectedBackground
              || !sameClone(value.remoteGitGrant, expectedGrant)) {
            return failed('Pod execution authority mismatch', true);
          }
          const execute = entry.custody?.ctx?.podClient?.exec;
          if (typeof execute !== 'function') return failed('pod_unavailable', true);
          return runDomainEffect(run, entry, operation, 'resource', () => execute(value.command, {
            podId: value.podId,
            timeoutMs: expectedTimeout,
            background: expectedBackground,
            remoteGitGrant: expectedGrant,
            signal: expectedBackground ? undefined : run.signal,
          }), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.pod.status': {
          const entry = domainExecutionEntry(run, value, 'pod', [
            'podId', 'jobId', 'stream', 'offset', 'limit',
          ]);
          const args = entry?.call?.args;
          if (!entry || value.podId !== args?.podId || value.jobId !== args?.jobId
              || value.stream !== args?.stream || value.offset !== args?.offset
              || value.limit !== args?.limit) {
            return failed('Pod status authority mismatch', true);
          }
          const readStatus = entry.custody?.ctx?.podClient?.status;
          if (typeof readStatus !== 'function') return failed('pod_unavailable', true);
          return runDomainEffect(run, entry, operation, 'read', () => readStatus({
            sessionId: entry.custody.ctx.session?.sessionId,
            podId: value.podId, jobId: value.jobId, stream: value.stream,
            offset: value.offset, limit: value.limit,
          }));
        }
        case 'turn.pod.cancel': {
          const entry = domainExecutionEntry(run, value, 'pod', [
            'podId', 'jobId',
          ]);
          const args = entry?.call?.args;
          if (!entry || typeof value.jobId !== 'string' || value.jobId !== args?.jobId
              || value.podId !== args?.podId) {
            return failed('Pod cancellation authority mismatch', true);
          }
          const cancel = entry.custody?.ctx?.podClient?.cancel;
          if (typeof cancel !== 'function') return failed('pod_unavailable', true);
          return runDomainEffect(run, entry, operation, 'control', () => cancel(value.jobId, {
            sessionId: entry.custody.ctx.session?.sessionId, podId: value.podId,
          }));
        }
        case 'turn.pod.read-file': {
          const entry = domainExecutionEntry(run, value, 'pod', ['podId', 'path']);
          const args = entry?.call?.args;
          if (!entry || typeof value.path !== 'string' || value.path !== args?.path
              || value.podId !== args?.podId) {
            return failed('Pod file-read authority mismatch', true);
          }
          const readFile = entry.custody?.ctx?.podClient?.readFile;
          if (typeof readFile !== 'function') return failed('pod_unavailable', true);
          return runDomainEffect(run, entry, operation, 'read', () => readFile(value.path, {
            sessionId: entry.custody.ctx.session?.sessionId, podId: value.podId,
          }));
        }
        case 'turn.pod.write-file': {
          const entry = domainExecutionEntry(run, value, 'pod', [
            'podId', 'path', 'content',
          ]);
          const args = entry?.call?.args;
          if (!entry || typeof value.path !== 'string' || typeof value.content !== 'string'
              || value.path !== args?.path || value.content !== args?.content
              || value.podId !== args?.podId) {
            return failed('Pod file-write authority mismatch', true);
          }
          const writeFile = entry.custody?.ctx?.podClient?.writeFile;
          if (typeof writeFile !== 'function') return failed('pod_unavailable', true);
          return runDomainEffect(run, entry, operation, 'commit', () => writeFile(
            value.path, value.content, {
              sessionId: entry.custody.ctx.session?.sessionId, podId: value.podId,
            },
          ), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.repository.read-pod': {
          const entry = repositoryExecutionEntry(run, value, ['podId']);
          if (!entry) return failed('repository Pod read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readPod(value.podId));
        }
        case 'turn.repository.destroy-pod': {
          const entry = repositoryExecutionEntry(run, value, ['podId']);
          if (!entry) return failed('repository Pod destroy authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.destroyPod(value.podId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.repository.read-status': {
          const entry = repositoryExecutionEntry(run, value, []);
          if (!entry) return failed('repository status authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readStatus());
        }
        case 'turn.repository.read-history': {
          const entry = repositoryExecutionEntry(run, value, ['depth']);
          if (!entry) return failed('repository history authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readHistory(value.depth));
        }
        case 'turn.repository.read-remote': {
          const entry = repositoryExecutionEntry(
            run, value, [],
          );
          if (!entry) return failed('repository remote-read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readRemote());
        }
        case 'turn.repository.read-diff': {
          const entry = repositoryExecutionEntry(
            run, value, ['from', 'to'],
          );
          if (!entry) return failed('repository diff authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readDiff(value.from, value.to));
        }
        case 'turn.repository.confirm-restore': {
          const entry = repositoryExecutionEntry(run, value, ['to']);
          if (!entry) return failed('repository restore confirmation mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.domainState.authority.confirmRestore(value.to));
        }
        case 'turn.repository.checkpoint': {
          const entry = repositoryExecutionEntry(run, value, ['message']);
          if (!entry) return failed('repository checkpoint authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.checkpoint(value.message), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.repository.branch': {
          const entry = repositoryExecutionEntry(run, value, ['name']);
          if (!entry) return failed('repository branch authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.branch(value.name), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.repository.checkout': {
          const entry = repositoryExecutionEntry(run, value, ['name']);
          if (!entry) return failed('repository checkout authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.checkout(value.name), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.repository.restore': {
          const entry = repositoryExecutionEntry(run, value, ['to']);
          if (!entry) return failed('repository restore authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.restore(value.to), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.repository.confirm-remote': {
          const entry = repositoryExecutionEntry(
            run, value, ['op', 'target', 'branch'],
          );
          if (!entry) return failed('repository remote confirmation mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.domainState.authority.confirmRemote(value.op, value.target, value.branch));
        }
        case 'turn.repository.link': {
          const entry = repositoryExecutionEntry(run, value, ['url']);
          if (!entry) return failed('repository link authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.link(value.url), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.repository.fetch': {
          const entry = repositoryExecutionEntry(run, value, ['target']);
          if (!entry) return failed('repository fetch authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.fetch(value.target), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.repository.push': {
          const entry = repositoryExecutionEntry(
            run, value, ['target', 'branch'],
          );
          if (!entry) return failed('repository push authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.push(value.target, value.branch), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.vm.read': {
          const entry = vmExecutionEntry(run, value, ['vmId']);
          if (!entry) return failed('VM read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readVm(value.vmId));
        }
        case 'turn.vm.list': {
          const entry = vmExecutionEntry(run, value, []);
          if (!entry) return failed('VM list authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.listVms());
        }
        case 'turn.vm.set-default': {
          const entry = vmExecutionEntry(run, value, ['vmId']);
          if (!entry) return failed('VM default authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.domainState.authority.setDefaultVm(value.vmId));
        }
        case 'turn.vm.run': {
          const entry = vmExecutionEntry(
            run, value, ['command', 'timeoutMs'], ['vmId'],
          );
          if (!entry) return failed('VM run authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.runVm(value.command, value.timeoutMs, value.vmId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.vm.import-file': {
          const entry = vmExecutionEntry(
            run, value, ['url', 'path', 'maxBytes'],
          );
          if (!entry) return failed('VM import authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.importFile(value.url, value.path, value.maxBytes), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.vm.write-text-file': {
          const entry = vmExecutionEntry(
            run, value, ['path', 'content'],
          );
          if (!entry) return failed('VM file-write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.writeTextFile(value.path, value.content), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.vm.destroy': {
          const entry = vmExecutionEntry(run, value, ['vmId']);
          if (!entry) return failed('VM destroy authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.destroyVm(value.vmId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.notebook.read': {
          const entry = notebookExecutionEntry(
            run, value, ['notebookId'],
          );
          if (!entry) return failed('Notebook read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readNotebook(value.notebookId));
        }
        case 'turn.notebook.list': {
          const entry = notebookExecutionEntry(run, value, []);
          if (!entry) return failed('Notebook list authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.listNotebooks());
        }
        case 'turn.notebook.set-default': {
          const entry = notebookExecutionEntry(
            run, value, ['notebookId'],
          );
          if (!entry) return failed('Notebook default authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.domainState.authority.setDefaultNotebook(value.notebookId));
        }
        case 'turn.notebook.run': {
          const entry = notebookExecutionEntry(
            run, value, ['code', 'timeoutMs', 'notebookId'],
          );
          if (!entry) return failed('Notebook run authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.runNotebook(
              value.code, value.timeoutMs, value.notebookId,
            ), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.notebook.write-file': {
          const entry = notebookExecutionEntry(
            run, value, ['path', 'content', 'notebookId'],
          );
          if (!entry) return failed('Notebook file-write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.writeFile(
              value.path, value.content, value.notebookId,
            ), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.notebook.read-file': {
          const entry = notebookExecutionEntry(
            run, value, ['path', 'notebookId'],
          );
          if (!entry) return failed('Notebook file-read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readFile(value.path, value.notebookId));
        }
        case 'turn.notebook.destroy': {
          const entry = notebookExecutionEntry(run, value, ['notebookId']);
          if (!entry) return failed('Notebook destroy authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.destroyNotebook(value.notebookId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.app.update': {
          const entry = appExecutionEntry(
            run, value, ['appId', 'name', 'html', 'tags', 'entryFile'],
          );
          if (!entry) return failed('App update authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.updateApp(
              value.appId, value.name, value.html, value.tags, value.entryFile,
            ), false, HOST_EFFECT_OUTCOME.valueResult);
        }
        case 'turn.app.open': {
          const entry = appExecutionEntry(run, value, ['appId']);
          if (!entry) return failed('App open authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.openApp(value.appId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.app.search': {
          const entry = appExecutionEntry(run, value, ['query']);
          if (!entry) return failed('App search authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.searchApps(value.query));
        }
        case 'turn.app.read': {
          const entry = appExecutionEntry(run, value, ['appId']);
          if (!entry) return failed('App read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readApp(value.appId));
        }
        case 'turn.app.delete': {
          const entry = appExecutionEntry(run, value, ['appId']);
          if (!entry) return failed('App delete authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.deleteApp(value.appId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.app.write-file': {
          const entry = appExecutionEntry(
            run, value, ['appId', 'path', 'content'],
          );
          if (!entry) return failed('App file-write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.writeFile(value.appId, value.path, value.content), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.app.read-file': {
          const entry = appExecutionEntry(
            run, value, ['appId', 'path'],
          );
          if (!entry) return failed('App file-read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readFile(value.appId, value.path));
        }
        case 'turn.app.list-files': {
          const entry = appExecutionEntry(run, value, ['appId']);
          if (!entry) return failed('App file-list authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.listFiles(value.appId));
        }
        case 'turn.app.delete-file': {
          const entry = appExecutionEntry(
            run, value, ['appId', 'path'],
          );
          if (!entry) return failed('App file-delete authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.deleteFile(value.appId, value.path), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.app.observe': {
          const entry = appExecutionEntry(run, value, []);
          if (!entry) return failed('App observe authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.observeRuntime());
        }
        case 'turn.app.act': {
          const entry = appExecutionEntry(run, value, ['action', 'params']);
          if (!entry) return failed('App action authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.actRuntime(value.action, value.params), false, HOST_EFFECT_OUTCOME.runResult);
        }
        case 'turn.app.run-code': {
          const entry = appExecutionEntry(
            run, value, ['code', 'timeoutMs'],
          );
          if (!entry) return failed('App code authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.runCode(value.code, value.timeoutMs), false, HOST_EFFECT_OUTCOME.runResult);
        }
        case 'turn.memory.read-scope': {
          const entry = persistenceExecutionEntry(run, value, ['scope']);
          if (!entry) return failed('memory read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readMemoryScope(value.scope));
        }
        case 'turn.memory.read-subtree': {
          const entry = persistenceExecutionEntry(
            run, value, ['workspace', 'subpath'],
          );
          if (!entry) return failed('memory subtree authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readMemorySubtree(value.workspace, value.subpath));
        }
        case 'turn.memory.write': {
          const entry = persistenceExecutionEntry(
            run, value, ['scope', 'body'],
          );
          if (!entry) return failed('memory write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.writeMemory(value.scope, value.body), false, HOST_EFFECT_OUTCOME.memoryResult);
        }
        case 'turn.todo.read': {
          const entry = persistenceExecutionEntry(
            run, value, [],
          );
          if (!entry) return failed('todo read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readTodos());
        }
        case 'turn.todo.replace': {
          const entry = persistenceExecutionEntry(
            run, value, ['version', 'todos'],
          );
          if (!entry) return failed('todo replace authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.replaceTodos(value.version, value.todos), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.page.open-tab': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page open authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.openProtectedBackgroundTab(), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.page.read': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readOwnedPage());
        }
        case 'turn.page.snapshot': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page snapshot authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.captureOwnedAccessibilityTree());
        }
        case 'turn.page.read-state': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page state authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readOwnedFrameworkState());
        }
        case 'turn.page.watch-changes': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page watch authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.drainOwnedDomChanges());
        }
        case 'turn.page.query-dom': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page query authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.queryOwnedDom());
        }
        case 'turn.page.navigate': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page navigation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.navigateOwnedTab(), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.page.fill': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page fill authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.fillOwnedTarget(), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.page.click': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page click authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.clickOwnedTarget(), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.page.login': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page login authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.performConfirmedOwnedLogin(), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.page.run-program': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page program authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.runOwnedPageProgram(), false, HOST_EFFECT_OUTCOME.runResult);
        }
        case 'turn.page.capture-foreground': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page foreground capture authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.captureForegroundPixels());
        }
        case 'turn.page.capture-owned': {
          const entry = pageExecutionEntry(run, value);
          if (!entry) return failed('page owned capture authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.captureOwnedTabPixels());
        }
        case 'turn.resource.confirm-web-write': {
          const entry = resourceExecutionEntry(run, value, ['url', 'method']);
          if (!entry) return failed('web write confirmation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.domainState.authority.confirmWebWrite(value.url, value.method), true, HOST_EFFECT_OUTCOME.confirmation);
        }
        case 'turn.resource.request-web-text': {
          const entry = resourceExecutionEntry(
            run, value, ['url', 'method', 'headers', 'body'],
          );
          if (!entry) return failed('web resource authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.requestWebText({
              url: value.url, method: value.method, headers: value.headers, body: value.body,
            }), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.resource.extract-markdown': {
          const entry = resourceExecutionEntry(run, value, ['html', 'url']);
          if (!entry) return failed('markdown extraction authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.extractReadableMarkdown(value.html, value.url));
        }
        case 'turn.resource.extract-document': {
          const entry = resourceExecutionEntry(
            run, value, ['url', 'format', 'engine'],
          );
          if (!entry) return failed('document extraction authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.extractDocument({
              url: value.url, format: value.format, engine: value.engine,
            }));
        }
        case 'turn.resource.spill-result': {
          const entry = resourceExecutionEntry(run, value, [
            'url', 'format', 'text', 'producer', 'fenced', 'originLabel',
          ]);
          if (!entry) return failed('result spill authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.domainState.authority.spillResult({
              url: value.url, format: value.format, text: value.text,
              producer: value.producer, fenced: value.fenced,
              originLabel: value.originLabel,
            }));
        }
        case 'turn.resource.read-result': {
          const entry = resourceExecutionEntry(run, value, ['key']);
          if (!entry) return failed('result read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readResult(value.key));
        }
        case 'turn.site-client.read': {
          const entry = siteClientExecutionEntry(run, value, ['origin']);
          if (!entry) return failed('site-client read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readStoredClient(value.origin));
        }
        case 'turn.site-client.run': {
          const entry = siteClientExecutionEntry(
            run, value, ['origin', 'code', 'timeoutMs'],
          );
          if (!entry) return failed('site-client run authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.runStoredClient(
              value.origin, value.code, value.timeoutMs,
            ), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.site-client.commit': {
          const entry = siteClientExecutionEntry(run, value, ['origin']);
          if (!entry) return failed('site-client write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.commitConfirmedClient(value.origin), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.site-client.capture-start': {
          const entry = siteClientExecutionEntry(run, value, []);
          if (!entry) return failed('site capture start authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.startOwnedCapture(), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.site-client.capture-stop': {
          const entry = siteClientExecutionEntry(run, value, []);
          if (!entry) return failed('site capture stop authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.stopOwnedCapture(), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.create-webvm': {
          const entry = executionEntry(run, value, ['plan']);
          if (!entry) return failed('webvm creation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.createWebVm(value.plan), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.create-notebook': {
          const entry = executionEntry(run, value, ['plan']);
          if (!entry) return failed('notebook creation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.createNotebook(value.plan), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.create-pod': {
          const entry = executionEntry(run, value, ['plan']);
          if (!entry) return failed('pod creation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.createPod(value.plan), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.create-app': {
          const entry = executionEntry(run, value, ['plan']);
          if (!entry) return failed('app creation authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.createApp(value.plan), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.run-script': {
          const entry = executionEntry(run, value, [
            'code', 'actors', 'provider', 'workspace', 'timeoutMs',
          ]);
          if (!entry) return failed('headless script authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.runHeadlessScript({
              code: value.code, actors: value.actors, provider: value.provider,
              workspace: value.workspace, timeoutMs: value.timeoutMs,
            }), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.execution.spill-script': {
          const entry = executionEntry(
            run, value, ['text', 'fenced', 'originLabel'],
          );
          if (!entry) return failed('script spill authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'control', () =>
            entry.domainState.authority.spillScriptValue({
              text: value.text, fenced: value.fenced, originLabel: value.originLabel,
            }));
        }
        case 'turn.editing.read-target': {
          const entry = editingEntry(run, value, ['kind', 'targetId', 'path']);
          if (!entry) return failed('edit target read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readEditTarget({
              kind: value.kind, targetId: value.targetId, path: value.path,
            }));
        }
        case 'turn.editing.write-target': {
          const entry = editingEntry(
            run, value, ['kind', 'targetId', 'path', 'content'],
          );
          if (!entry) return failed('edit target write authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.writeEditTarget({
              kind: value.kind, targetId: value.targetId,
              path: value.path, content: value.content,
            }), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.introspection.actor-roster': {
          const entry = introspectionExecutionEntry(run, value, []);
          if (!entry) return failed('actor roster authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readActorRoster());
        }
        case 'turn.introspection.provider-posture': {
          const entry = introspectionExecutionEntry(run, value, []);
          if (!entry) return failed('provider posture authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readProviderPosture());
        }
        case 'turn.introspection.storage-snapshot': {
          const entry = introspectionExecutionEntry(run, value, ['prefix']);
          if (!entry) return failed('storage inspection authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readStorageSnapshot(value.prefix));
        }
        case 'turn.introspection.automatable-tabs': {
          const entry = introspectionExecutionEntry(run, value, []);
          if (!entry) return failed('tab inspection authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readAutomatableTabs());
        }
        case 'turn.introspection.denylist-patterns': {
          const entry = introspectionExecutionEntry(run, value, []);
          if (!entry) return failed('denylist inspection authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readDenylistPatterns());
        }
        case 'turn.introspection.audit-entries': {
          const entry = introspectionExecutionEntry(run, value, []);
          if (!entry) return failed('audit inspection authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readAuditEntries());
        }
        case 'turn.introspection.installed-skill': {
          const entry = introspectionExecutionEntry(run, value, ['name']);
          if (!entry) return failed('skill read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readInstalledSkill(value.name));
        }
        case 'turn.schedule.read-routines': {
          const entry = scheduleExecutionEntry(run, value, []);
          if (!entry) return failed('schedule read authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readRoutines());
        }
        case 'turn.schedule.arm-confirmed-routine': {
          const entry = scheduleExecutionEntry(
            run, value, ['prompt', 'every', 'dailyAt', 'mode'],
          );
          if (!entry) return failed('schedule arm authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.armConfirmedRoutine({
              prompt: value.prompt, every: value.every,
              dailyAt: value.dailyAt, mode: value.mode,
            }), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.schedule.cancel-routine': {
          const entry = scheduleExecutionEntry(run, value, ['id']);
          if (!entry) return failed('schedule cancel authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.cancelRoutine(value.id), false, HOST_EFFECT_OUTCOME.okResult);
        }
        case 'turn.dweb.discover-apps': {
          const entry = dwebExecutionEntry(run, value, []);
          if (!entry) return failed('dweb discovery authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.discoverApps());
        }
        case 'turn.dweb.publish-confirmed-app': {
          const entry = dwebExecutionEntry(run, value, ['appId']);
          if (!entry) return failed('dweb publish authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.publishConfirmedApp(value.appId), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.dweb.install-confirmed-app': {
          const entry = dwebExecutionEntry(run, value, ['uri', 'name']);
          if (!entry) return failed('dweb install authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.installConfirmedApp(value.uri, value.name), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.dweb.read-peers': {
          const entry = dwebExecutionEntry(run, value, []);
          if (!entry) return failed('dweb peer authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'read', () =>
            entry.domainState.authority.readPeers());
        }
        case 'turn.dweb.set-peer-blocked': {
          const entry = dwebExecutionEntry(
            run, value, ['did', 'block', 'reason'],
          );
          if (!entry) return failed('dweb block authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.setPeerBlocked(value.did, value.block, value.reason), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.dweb.set-discovery-enabled': {
          const entry = dwebExecutionEntry(run, value, ['enabled']);
          if (!entry) return failed('dweb policy authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'commit', () =>
            entry.domainState.authority.setDiscoveryEnabled(value.enabled), false, HOST_EFFECT_OUTCOME.fulfilledResult);
        }
        case 'turn.dweb.run-mesh-program': {
          const entry = dwebExecutionEntry(run, value, ['code', 'timeoutMs']);
          if (!entry) return failed('mesh program authority mismatch', true);
          return runDomainEffect(run, entry, operation, 'resource', () =>
            entry.domainState.authority.runMeshProgram(value.code, value.timeoutMs), false, HOST_EFFECT_OUTCOME.okResult);
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
          const semanticResult = !validReported ? executionFailure(
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
          const result = state.outcomeKnown && !pending
            && entry.effectVerdictObserved === true
            ? stampHostEffectVerdict(semanticResult, {
                effectEntered,
                performed: entry.settledIrreversible === true,
                invalidCode: 'tool-execution-result-invalid-after-effect',
                invalidError: entry.settledIrreversible === true
                  ? 'Tool executor returned an invalid result after an irreversible effect completed.'
                  : 'Tool executor returned an invalid result.',
              })
            : semanticResult;
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
      opaque: new Map(), modelToolCalls: new Map(),
      providerOwner: Object.freeze({ runId }), modelCandidates: [],
      maxOutputTokens: Number.isSafeInteger(ctx.maxOutputTokens)
        ? Math.max(1, Math.min(64_000, Number(ctx.maxOutputTokens))) : 64_000,
      preparedExecutions: new Map(),
      providerClose: null,
      providerCustodyGeneration: 0, providerCloseGeneration: -1,
      tools: [], toolNames: new Set(), toolDescriptors: new Map(),
      classifications: {}, system: null,
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
      try {
        await cleanupPrepared(run, 'tool-execution-controller-lost', {
          detachSettlement: true,
        });
      }
      finally {
        try { await closeProviderOwner(run); }
        finally {
          runs.delete(runId);
          run.opaque.clear();
        }
      }
    }
  };

  return Object.freeze({
    authorize,
    handleKernelCall,
    runUserTurn,
    close: async () => {
      const providerCleanup = [];
      for (const run of runs.values()) {
        run.abort.abort();
        run.events.close();
        await cleanupPrepared(run, 'tool-execution-kernel-closed', {
          detachSettlement: true,
        });
        providerCleanup.push(closeProviderOwner(run));
      }
      runs.clear();
      sessionGenerations.clear();
      await Promise.allSettled(providerCleanup);
    },
    activeCount: () => runs.size,
  });
};
