// @ts-check

import { makeSerialLane } from '../shared/cold-util.js';
import { parseHookDocument } from '../shared/hook-document.js';
import {
  HookRecordsLimitError,
  projectSemanticHookManifest,
} from '../shared/semantic-hook-manifest.js';
import {
  KERNEL_ADMINISTRATIVE_ROUTE_NAMES,
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
  validAdministrativeHookRecord,
} from '../shared/kernel-feature-policy.js';
import { createKernelAdministrativeMemory } from './kernel-administrative-memory.js';
import { createKernelFeatureControl } from './kernel-feature-control.js';

const success = (/** @type {unknown} */ value = null) => Object.freeze({
  ok: true, outcomeKnown: true, value,
});
const failure = (/** @type {string} */ code, /** @type {boolean} */ outcomeKnown,
  /** @type {unknown} */ cause = undefined) => Object.freeze({
  ok: false,
  code,
  error: /** @type {{message?:string}} */ (cause)?.message ?? code,
  outcomeKnown,
});
/** @returns {boolean} */
const sameValue = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
      || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = /** @type {Record<string,any>} */ (left);
  const rightRecord = /** @type {Record<string,any>} */ (right);
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameValue(leftRecord[key], rightRecord[key]));
};
const routeFrom = (/** @type {any} */ context) => {
  const request = context?.request;
  return request?.cluster === 'administrative' && typeof request?.route === 'string'
    ? request.route : '';
};

/** @param {Object} deps
 * @param {(payload:unknown,options?:any)=>Promise<any>} deps.callFeature
 * @param {{get:(key:string)=>Promise<any>,set:(key:string,value:any)=>Promise<any>}} deps.kv
 * @param {{append:(entry:any)=>Promise<any>}} deps.auditLog
 * @param {(store:string)=>void} deps.canWrite
 * @param {(text:string,options:any)=>Promise<any>} deps.commitSkill
 * @param {()=>Promise<any>} deps.probeMemoryTab
 * @param {()=>Promise<any[]>} deps.listApps
 * @param {{get:(store:string,key:string)=>Promise<any>,transact:(stores:string[],operation:Function)=>Promise<any>}} deps.idb
 * @param {(prompt:any,signal?:AbortSignal)=>Promise<any>} deps.confirm
 * @param {()=>Promise<string|null>|string|null} deps.currentSessionId
 * @param {()=>Promise<void>|void} deps.assertMemoryInitAllowed
 * @param {(text:string)=>unknown} deps.postChatNote
 * @param {number} [deps.probeTimeoutMs]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 * @param {()=>number} [deps.now]
 */
export const createKernelAdministrativeControl = (deps) => {
  if (typeof deps.callFeature !== 'function' || typeof deps.canWrite !== 'function'
      || typeof deps.commitSkill !== 'function' || typeof deps.probeMemoryTab !== 'function'
      || typeof deps.listApps !== 'function' || typeof deps.confirm !== 'function'
      || typeof deps.currentSessionId !== 'function'
      || typeof deps.assertMemoryInitAllowed !== 'function'
      || typeof deps.postChatNote !== 'function') {
    throw new TypeError('kernel-administrative-control-config-invalid');
  }
  const memory = createKernelAdministrativeMemory({
    idb: /** @type {any} */ (deps.idb),
    confirm: deps.confirm,
    currentSessionId: deps.currentSessionId,
    canWrite: () => deps.canWrite('memory'),
    assertAllowed: deps.assertMemoryInitAllowed,
    now: deps.now,
  });
  const hookWrites = makeSerialLane();
  const routeLanes = Object.freeze({
    'hooks/save': hookWrites,
    'hooks/remove': hookWrites,
    'hooks/toggle': hookWrites,
    'skills/installLocal': makeSerialLane(),
    'memory/init': makeSerialLane(),
  });
  const readHooks = async () => {
    const records = await deps.kv.get('hooks.user.v1');
    return Array.isArray(records) ? records : [];
  };
  const writeHooks = async (/** @type {any[]} */ records) => {
    deps.canWrite('hooks');
    await deps.kv.set('hooks.user.v1', records);
  };
  const hookSource = (/** @type {any} */ message) => typeof message?.markdown === 'string'
    ? { markdown: message.markdown }
    : { record: message?.record };
  const hookRecord = (/** @type {any} */ source) => source?.markdown !== undefined
    ? parseHookDocument(source.markdown)
    : source?.record;
  const mutateHooks = async (/** @type {string} */ operation, /** @type {any} */ payload) => {
    const records = await readHooks();
    if (operation === 'administrative.hooks.save') {
      const record = hookRecord(payload.source);
      if (!validAdministrativeHookRecord(record)) throw new TypeError('hook-source-invalid');
      const next = records.filter((candidate) => candidate?.id !== record.id);
      next.push(record);
      projectSemanticHookManifest(next);
      await writeHooks(next);
      deps.auditLog.append({ type: 'hook_added', details: {
        id: record.id, event: record.event, kind: record.kind,
      } }).catch(() => {});
      return { ok: true, id: record.id };
    }
    if (operation === 'administrative.hooks.remove') {
      await writeHooks(records.filter((record) => record?.id !== payload.id));
      deps.auditLog.append({ type: 'hook_removed', details: { id: payload.id } }).catch(() => {});
      return { ok: true };
    }
    const index = records.findIndex((record) => record?.id === payload.id);
    if (index < 0) return { ok: false, error: 'not-found' };
    const next = [...records];
    next[index] = { ...next[index], enabled: payload.enabled };
    // Recovery mutations stay possible if an older build already stored an
    // oversized policy. Only enabling can increase live semantic work.
    if (payload.enabled) projectSemanticHookManifest(next);
    await writeHooks(next);
    deps.auditLog.append({
      type: payload.enabled ? 'hook_enabled' : 'hook_disabled', details: { id: payload.id },
    }).catch(() => {});
    return { ok: true };
  };
  const expectedEffect = (/** @type {string} */ operation, /** @type {any} */ payload,
    /** @type {any} */ context) => {
    const route = routeFrom(context);
    const expected = context?.message;
    if (!expected) return false;
    if (operation === 'administrative.hooks.save' && route === 'hooks/save') {
      return sameValue(hookSource(expected), payload.source);
    }
    if (operation === 'administrative.hooks.remove' && route === 'hooks/remove') {
      return typeof expected.id === 'string' && expected.id === payload.id;
    }
    if (operation === 'administrative.hooks.toggle' && route === 'hooks/toggle') {
      return typeof expected.id === 'string' && expected.id === payload.id
        && typeof expected.enabled === 'boolean' && expected.enabled === payload.enabled;
    }
    if (operation === 'administrative.skills.commit' && route === 'skills/installLocal') {
      const origin = typeof expected.origin === 'string' ? expected.origin : 'local';
      return typeof expected.text === 'string' && expected.text === payload.text
        && origin === payload.origin && (expected.replace === true) === payload.replace;
    }
    return route === 'memory/init' && operation.startsWith('administrative.memory.');
  };
  const probeTimeoutMs = Math.max(1, Math.min(deps.probeTimeoutMs ?? 3_000, 10_000));
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const boundedProbe = (/** @type {()=>Promise<any>} */ operation,
    /** @type {unknown} */ fallback) => new Promise((resolve) => {
    let settled = false;
    const finish = (/** @type {unknown} */ value) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      resolve(value);
    };
    const timer = setTimeoutFn(() => finish(fallback), probeTimeoutMs);
    Promise.resolve().then(operation).then(finish, () => finish(fallback));
  });
  const handleEffect = async (/** @type {string} */ operation, /** @type {any} */ payload,
    /** @type {any} */ context) => {
    if (context?.signal?.aborted) return failure('administrative-call-aborted', true);
    if (operation === 'administrative.hooks.read') {
      try { return success(await readHooks()); }
      catch (cause) { return failure('administrative-hooks-read-failed', true, cause); }
    }
    if (operation.startsWith('administrative.hooks.')) {
      if (!expectedEffect(operation, payload, context)) {
        return failure('administrative-effect-substitution', true);
      }
      try { return success(await mutateHooks(operation, payload)); }
      catch (cause) {
        if (cause instanceof HookRecordsLimitError) {
          return failure('administrative-hooks-limit', true, cause);
        }
        try { deps.canWrite('hooks'); }
        catch (refusal) { return failure('administrative-write-refused', true, refusal); }
        return failure('administrative-hooks-write-unknown', false, cause);
      }
    }
    if (operation === 'administrative.skills.commit') {
      if (!expectedEffect(operation, payload, context)) {
        return failure('administrative-effect-substitution', true);
      }
      try { deps.canWrite('skills'); }
      catch (cause) { return failure('administrative-write-refused', true, cause); }
      try {
        const skill = await deps.commitSkill(payload.text, {
          source: 'local', origin: payload.origin, replace: payload.replace,
        });
        return success({ ok: true, skill });
      } catch (cause) {
        if (/** @type {{name?:unknown}} */ (cause)?.name === 'SkillExistsError') {
          return success({
            ok: false, error: 'already-installed',
            detail: /** @type {{message?:string}} */ (cause)?.message ?? String(cause),
          });
        }
        return failure('administrative-skill-install-unknown', false, cause);
      }
    }
    if (operation === 'administrative.memory.probeTab') {
      const value = await boundedProbe(deps.probeMemoryTab, {
        tab: null,
        warning: '/init skipped the browser page because the probe did not finish.',
      });
      return success(value);
    }
    if (operation === 'administrative.memory.listApps') {
      const apps = await boundedProbe(deps.listApps, []);
      return success(Array.isArray(apps) ? apps.map((app) => ({
        id: typeof app?.id === 'string' ? app.id : '',
        ...(typeof app?.name === 'string' ? { name: app.name } : {}),
        ...(typeof app?.description === 'string' ? { description: app.description } : {}),
      })).filter((app) => app.id) : []);
    }
    if (operation === 'administrative.memory.commitInit') {
      if (!expectedEffect(operation, payload, context)) {
        return failure('administrative-effect-substitution', true);
      }
      try { return success(await memory.commitInit(payload, context.signal)); }
      catch (cause) { return failure('administrative-memory-write-unknown', false, cause); }
    }
    if (operation === 'administrative.memory.note') {
      try { await deps.postChatNote(payload.text); } catch {}
      return success();
    }
    return failure('kernel-operation-denied', true);
  };
  const feature = createKernelFeatureControl({
    call: (/** @type {string} */ _capability, /** @type {unknown} */ payload,
      /** @type {any} */ options) => deps.callFeature(payload, options),
    handleEffect,
  });
  const dispatch = (/** @type {string} */ route, /** @type {any} */ message = {},
    /** @type {any} */ options = undefined) => {
    const operation = async () => {
      if (route === 'memory/init') {
        await deps.assertMemoryInitAllowed();
        deps.canWrite('memory');
      }
      const result = await feature.dispatch('administrative', route, message, options);
      return result?.ok === true && Object.hasOwn(result, 'value') ? result.value : result;
    };
    return routeLanes[/** @type {keyof typeof routeLanes} */ (route)]?.(operation) ?? operation();
  };
  const routes = Object.freeze(Object.fromEntries(KERNEL_ADMINISTRATIVE_ROUTE_NAMES.map((route) => [
    route,
    route === 'memory/init'
      ? (/** @type {any} */ message = {}) => {
        void dispatch(route, message, { timeoutMs: 30 * 60_000 }).then((result) => {
          if (result?.ok === true) return;
          deps.postChatNote(`/init failed: ${result?.error ?? result?.code ?? 'feature unavailable'}`);
        }, (cause) => {
          deps.postChatNote(`/init failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
        return { ok: true };
      }
      : (/** @type {any} */ message = {}) => dispatch(route, message),
  ])));
  return Object.freeze({
    routes,
    authorize: feature.authorize,
    handleKernelCall: feature.handleKernelCall,
  });
};
