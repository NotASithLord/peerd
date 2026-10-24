import { evalIn } from './e2e-harness.mjs';
import { createConsentDiagnostics } from './network-consent-cold.mjs';

// why: blank TargetInfo URLs cannot prove a sealed worker's script identity.
export const observeCatalogWorkerIdentity = async (child, connection) => {
  const evidence = { phase: 'catalog-worker-identity', parents: [], workers: [], lifecycle: [], errors: [] };
  const diagnostic = createConsentDiagnostics(evidence, () => {}, 2_000);
  const send = (method, params = {}, sessionId, budget = 2_000) => diagnostic(
    `${method} session=${sessionId ?? 'browser'}`,
    () => connection.send(method, params, sessionId), budget);
  const entries = new Map(), pending = new Set();
  let parentSessionId, parentTargetId, closing = false;
  const origin = `chrome-extension://${child.sw.id}`;
  const recordError = error => evidence.errors.push(String(error?.stack ?? error).slice(0, 3_000));
  const release = async entry => {
    const commands = [
      ...(entry.breakpoint ? [['Debugger.removeBreakpoint', { breakpointId: entry.breakpoint }]] : []),
      ...(entry.waitingForDebugger && !entry.startupReleased ? [['Runtime.runIfWaitingForDebugger', {}]] : []),
      ...(entry.paused ? [['Debugger.resume', {}]] : []),
      ...(entry.debuggerEnabled ? [['Debugger.disable', {}]] : []),
    ];
    for (const [method, params] of commands) {
      try { await send(method, params, entry.sessionId); }
      catch (error) { if (!entry.destroyed) recordError(error); }
    }
    entry.released = true;
  };
  const install = async (params, parentEnvelope) => {
    const { targetInfo, sessionId, waitingForDebugger } = params;
    const entry = { targetId: targetInfo.targetId, sessionId, parentSessionId: parentEnvelope,
      parentTargetId, targetInfo, waitingForDebugger, at: Date.now(), scripts: [], destroyed: false };
    entries.set(sessionId, entry);
    evidence.workers.push(entry);
    let onPause;
    const paused = new Promise(resolve => { onPause = resolve; });
    entry.onPause = onPause;
    try {
      if (targetInfo.parentId && targetInfo.parentId !== parentTargetId) throw new Error('Worker parent target mismatch');
      if (closing) return;
      await send('Runtime.enable', {}, sessionId);
      let reply;
      const expression = "(() => { 'use strict'; return { href: globalThis.location.href, name: globalThis.name, constructorName: globalThis.constructor?.name }; })()";
      if (waitingForDebugger) {
        await send('Debugger.enable', {}, sessionId);
        entry.debuggerEnabled = true;
        entry.breakpoint = (await send('Debugger.setInstrumentationBreakpoint',
          { instrumentation: 'beforeScriptExecution' }, sessionId)).breakpointId;
        if (typeof entry.breakpoint !== 'string') throw new Error('Worker first-script breakpoint is missing');
        await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        entry.startupReleased = true;
        const pause = await diagnostic(`worker first-script pause target=${entry.targetId}`, () => paused, 5_000);
        const frame = pause.callFrames?.[0];
        entry.pause = { reason: pause.reason, url: frame?.url, scriptId: frame?.location?.scriptId };
        if (pause.reason !== 'instrumentation' || !frame?.callFrameId) throw new Error('Worker did not pause before its first script');
        await send('Debugger.removeBreakpoint', { breakpointId: entry.breakpoint }, sessionId);
        entry.breakpoint = null;
        reply = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId,
          expression, returnByValue: true }, sessionId);
      } else {
        reply = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      }
      if (reply.exceptionDetails || typeof reply.result?.value?.href !== 'string') throw new Error('Native worker location was not readable');
      entry.native = reply.result.value;
      entry.role = entry.native.href === `${origin}/offscreen/controller-worker.js` ? 'controller'
        : entry.native.href === `${origin}/offscreen/actor-worker.js` ? 'actor' : 'other';
      entry.identityReadAt = Date.now();
    } catch (error) { entry.error = String(error); recordError(error); }
    finally { delete entry.onPause; await release(entry); }
  };
  const track = promise => {
    pending.add(promise);
    promise.then(() => pending.delete(promise), error => { pending.delete(promise); recordError(error); });
  };
  const listener = (method, params, message) => {
    if (method === 'Target.attachedToTarget' && parentSessionId && message.sessionId === parentSessionId
        && params.targetInfo?.type === 'worker') {
      track(install(params, message.sessionId));
      return;
    }
    if (method === 'Target.targetDestroyed') {
      for (const entry of entries.values()) if (entry.targetId === params.targetId) {
        entry.destroyed = true; entry.destroyedAt = Date.now();
        evidence.lifecycle.push({ method, targetId: entry.targetId, at: Date.now() });
      }
    }
    if (method === 'Target.detachedFromTarget') {
      const detached = entries.get(params.sessionId);
      if (detached) {
        detached.detachedAt = Date.now();
        evidence.lifecycle.push({ method, targetId: detached.targetId, at: Date.now() });
      }
    }
    const entry = entries.get(message.sessionId);
    if (!entry) return;
    if (method === 'Debugger.scriptParsed' && entry.scripts.length < 20) {
      entry.scripts.push({ scriptId: params.scriptId, url: params.url, at: Date.now() });
    }
    if (method === 'Debugger.paused') { entry.paused = true; entry.onPause?.(params); }
    if (method === 'Debugger.resumed') entry.paused = false;
  };
  const close = async () => {
    closing = true;
    try { await diagnostic('worker identity drain', () => Promise.allSettled([...pending]), 5_000); }
    catch (error) { recordError(error); }
    for (const entry of entries.values()) if (!entry.released && !entry.destroyed) await release(entry);
    if (parentSessionId) {
      try { await send('Target.setAutoAttach', { autoAttach: false,
        waitForDebuggerOnStart: false, flatten: true }, parentSessionId); }
      catch (error) { recordError(error); }
      try { await send('Target.detachFromTarget', { sessionId: parentSessionId }); }
      catch (error) { recordError(error); }
    }
    connection.off(listener);
    return evidence;
  };
  connection.on(listener);
  try {
    const contexts = await diagnostic('native offscreen contexts', () => evalIn(child.page,
      "(async () => { 'use strict'; return chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }); })()", true));
    if (contexts.length !== 1 || String(contexts[0].documentUrl).split('#')[0] !== `${origin}/offscreen/offscreen.html`) {
      throw new Error('One exact native offscreen context is required');
    }
    const targets = await send('Target.getTargets');
    const matching = targets.targetInfos.filter(target => target.url === contexts[0].documentUrl);
    if (matching.length !== 1) throw new Error('The exact native offscreen target is missing');
    const pages = await diagnostic('native offscreen target inventory', () => fetch(
      `http://127.0.0.1:${child.port}/json/list`, { signal: AbortSignal.timeout(2_000) }).then(reply => reply.json()));
    const target = matching[0];
    if (!pages.some(page => page.id === target.targetId && page.url === contexts[0].documentUrl)) {
      throw new Error('The native offscreen target inventories do not agree');
    }
    parentTargetId = target.targetId;
    parentSessionId = (await send('Target.attachToTarget', { targetId: parentTargetId, flatten: true })).sessionId;
    evidence.parents.push({ context: contexts[0], target, parentSessionId });
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true,
      flatten: true, filter: [{ type: 'worker' }, { exclude: true }] }, parentSessionId);
    await diagnostic('existing worker identity drain', () => Promise.allSettled([...pending]), 5_000);
    return { snapshot: () => JSON.parse(JSON.stringify(evidence)), close };
  } catch (error) { await close(); throw error; }
};
