#!/usr/bin/env bun
// A fresh profile, real vault and Home onboarding. Observe every future host
// before its scripts run; status/lease records are corroboration, never the
// zero-network oracle. Restart means physical MV3 worker retirement + unlock,
// not a claim about a complete browser-process restart.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attach, evalIn, launchPeerd, PASSPHRASE, rpc, waitFor } from './e2e-harness.mjs';

export const REPORT = resolve('artifacts/e2e/network-consent-cold.json');
const BINDING = '__peerdConsentTransportObserved';
// Transparent native constructor observers: no application API is stubbed,
// no connection is prevented, and successful construction still uses Chrome.
export const OBSERVER_SOURCE = `(() => {
  if (globalThis.__peerdConsentObserverInstalled) return;
  globalThis.__peerdConsentObserverInstalled = true;
  const emit = (kind, details = {}) => globalThis.${BINDING}(JSON.stringify({
    kind, href: globalThis.location?.href ?? '', ...details,
  }));
  for (const name of ['WebSocket', 'RTCPeerConnection']) {
    const native = globalThis[name];
    if (typeof native !== 'function') continue;
    globalThis[name] = new Proxy(native, { construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      emit(name, name === 'WebSocket' ? { url: String(args[0]) } : {});
      return instance;
    } });
  }
  emit('observer-ready', { rtc: typeof RTCPeerConnection === 'function', socket: typeof WebSocket === 'function' });
})()`;

// Stage markers diagnose target retirement; only the native observer proves construction.
export const RTC_CANARY_SOURCE = `(() => {
  const mark = stage => globalThis.${BINDING}(JSON.stringify({
    kind: 'rtc-canary', stage, href: globalThis.location?.href ?? '',
  }));
  mark('entry');
  mark('before-construct');
  const pc = new RTCPeerConnection({iceServers: []});
  mark('constructed');
  pc.close();
  mark('closed');
  return true;
})()`;

export const rtcCanaryComplete = (events, sessionId) => {
  const stages = events.filter(event => event.sessionId === sessionId)
    .filter(event => event.kind === 'rtc-canary' || event.kind === 'RTCPeerConnection')
    .map(event => event.kind === 'rtc-canary' ? event.stage : event.kind);
  const start = stages.indexOf('entry');
  const end = stages.indexOf('closed', start);
  return start >= 0 && end >= start
    && stages.slice(start, end + 1).join(',') === 'entry,before-construct,RTCPeerConnection,constructed,closed';
};

// Never retain console arguments, exception values, source, or arbitrary messages.
export const lifecycleErrorLabels = values => [...new Set(values.flatMap(value =>
  String(value ?? '').match(/\b(?:feature-lease-host-(?:start|stop|prepare|close|heartbeat)-timeout|feature-host-retirement-store-timeout|feature-lease-start-failed|feature-lease-stop-unknown)\b/g) ?? []))];

export const leaseDiagnostic = snapshot => ({
  locked: snapshot?.locked === true,
  leases: Object.fromEntries(Object.entries(snapshot?.leases ?? {}).slice(0, 16).map(([scope, state]) => [
    scope.slice(0, 80), Object.fromEntries(['generation', 'status', 'durable', 'hostEpoch', 'poisonedHostEpoch']
      .filter(key => ['string', 'number', 'boolean'].includes(typeof state?.[key]))
      .map(key => [key, typeof state[key] === 'string' ? state[key].slice(0, 100) : state[key]])),
  ])),
});

export const assertNoTransport = (events, label) => {
  const traffic = events.filter(event => ['WebSocket', 'RTCPeerConnection', 'native-websocket'].includes(event.kind));
  if (traffic.length) throw new Error(`${label}: transport before consent: ${JSON.stringify(traffic)}`);
};

const requireResult = (condition, message) => { if (!condition) throw new Error(message); };
class ObserverClosedError extends Error {
  constructor() { super('Consent observer closed'); this.name = 'ObserverClosedError'; }
}

class ObserverDetachedError extends ObserverClosedError {
  constructor(sessionId) { super(); this.message = `Consent observer target detached: ${sessionId}`; this.name = 'ObserverDetachedError'; }
}

// Host deadlines remain effective when a renderer is paused or its socket disappears.
export const createConsentDiagnostics = (evidence, persist, timeoutMs = 15_000) => {
  let sequence = 0;
  evidence.commands = [];
  return async (label, operation, budgetMs = timeoutMs, signal = undefined) => {
    const entry = { id: ++sequence, label, phase: evidence.phase, started: Date.now(), status: 'pending' };
    evidence.commands.push(entry);
    if (evidence.commands.length > 256) evidence.commands.shift();
    persist();
    let timer, aborted;
    try {
      const cancellation = signal ? new Promise((_, reject) => {
        aborted = () => reject(signal.reason);
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
      }) : new Promise(() => {});
      const result = await Promise.race([
        cancellation,
        Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Consent deadline: ${label}`)), budgetMs); }),
      ]);
      entry.status = 'complete';
      return result;
    } catch (error) {
      entry.status = error instanceof ObserverClosedError ? 'cancelled' : 'failed';
      entry.error = String(error?.stack ?? error);
      throw error;
    } finally {
      clearTimeout(timer);
      if (aborted) signal.removeEventListener('abort', aborted);
      entry.finished = Date.now(); persist();
    }
  };
};

export async function attachConsentObserver(url, diagnostic, connect = attach) {
  let attachExpired = false;
  return diagnostic('observer attach', async () => {
    const value = await connect(url);
    if (attachExpired) { value.close(); throw new Error('Consent observer attach expired'); }
    return value;
  }).catch(error => { attachExpired = true; throw error; });
}

// Startup-paused workers need a first-script trap;
// inject on that script's call frame before releasing application code.
export async function instrumentPausedTarget(connection, sessionId, diagnostic, recordPause = (/** @type {any} */ _pause) => {}) {
  const send = (method, params = {}) => connection.send(method, params, sessionId);
  let pause;
  let ready;
  const paused = new Promise(resolve => { pause = resolve; });
  const observed = new Promise(resolve => { ready = resolve; });
  const listener = (method, params, message) => {
    if (message.sessionId !== sessionId) return;
    if (method === 'Debugger.paused') {
      const frame = params.callFrames?.[0];
      recordPause({ reason: String(params.reason).slice(0, 64),
        url: String(frame?.url ?? '').slice(0, 256),
        scriptId: String(frame?.location?.scriptId ?? '').slice(0, 64),
        lineNumber: frame?.location?.lineNumber, columnNumber: frame?.location?.columnNumber });
      pause(params);
    }
    if (method === 'Runtime.bindingCalled' && params.name === BINDING) {
      try { if (JSON.parse(params.payload).kind === 'observer-ready') ready(); } catch {}
    }
  };
  connection.on(listener);
  let breakpoint;
  let failure;
  try {
    await send('Debugger.enable');
    breakpoint = (await send('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' })).breakpointId;
    requireResult(typeof breakpoint === 'string', 'Target pre-execution breakpoint missing');
    await send('Runtime.runIfWaitingForDebugger');
    const event = await diagnostic(`target first-script pause session=${sessionId}`, () => paused);
    requireResult(event.reason === 'instrumentation' && event.callFrames?.[0]?.callFrameId,
      'Target did not stop before script execution');
    // Removing the one-shot trap keeps this frame paused while avoiding a trap in the injected script.
    await send('Debugger.removeBreakpoint', { breakpointId: breakpoint });
    breakpoint = null;
    const evaluate = (stage, expression) => diagnostic(`target ${stage} session=${sessionId}`, () =>
      send('Debugger.evaluateOnCallFrame', { callFrameId: event.callFrames[0].callFrameId,
        expression, returnByValue: true }));
    const probe = await evaluate('call-frame probe', '1');
    requireResult(!probe.exceptionDetails && probe.result?.value === 1, 'Target call-frame probe failed');
    const result = await evaluate('observer injection', `${OBSERVER_SOURCE}; globalThis.__peerdConsentObserverInstalled === true`);
    requireResult(!result.exceptionDetails && result.result?.value === true, 'Target observer injection failed');
    await diagnostic(`target observer ready session=${sessionId}`, () => observed);
  } catch (error) { failure = error; throw error; }
  finally {
    connection.off(listener);
    if (!failure) {
      let cleanupFailure;
      for (const [method, params] of [
        ...(breakpoint ? [['Debugger.removeBreakpoint', { breakpointId: breakpoint }]] : []),
        ['Debugger.resume', {}], ['Debugger.disable', {}],
      ]) {
        try { await send(method, params); } catch (error) { cleanupFailure ??= error; }
      }
      if (cleanupFailure) throw cleanupFailure;
    }
  }
}

export const ROOT_TARGET_FILTER = ['page', 'iframe', 'other', 'service_worker', 'shared_worker']
  .map(type => ({ type })).concat([{ exclude: true }]);
export const CHILD_TARGET_FILTER = ['worker', 'shared_worker', 'iframe']
  .map(type => ({ type })).concat([{ exclude: true }]);

export async function observeHosts(ctx, evidence, diagnostic, persist, connect = attach) {
  const version = await diagnostic('observer browser endpoint', () => fetch(`http://127.0.0.1:${ctx.port}/json/version`, { signal: AbortSignal.timeout(15_000) }).then(r => r.json()));
  const connection = await attachConsentObserver(version.webSocketDebuggerUrl, diagnostic, connect);
  const nativeSend = connection.send.bind(connection);
  const lifetime = new AbortController();
  const cancelled = new ObserverClosedError();
  let closing = false;
  const scopes = new Map();
  const activeDiagnostic = (label, operation, budgetMs = undefined, signal = lifetime.signal) => closing
    ? Promise.reject(cancelled)
    : diagnostic(label, operation, budgetMs, signal);
  const scopedDiagnostic = (sessionId, label, operation, budgetMs = undefined, signal = lifetime.signal) => {
    const scope = scopes.get(sessionId);
    if (scope?.detached) return Promise.reject(scope.reason);
    return activeDiagnostic(label, operation, budgetMs, scope ? AbortSignal.any([scope.signal, signal]) : signal);
  };
  connection.send = (method, params = {}, sessionId, signal = lifetime.signal) => scopedDiagnostic(sessionId,
    `${method} session=${sessionId ?? 'browser'}`, () => {
      if (closing) throw cancelled;
      const scope = scopes.get(sessionId);
      if (scope?.detached) throw scope.reason;
      lifetime.signal.throwIfAborted();
      return nativeSend(method, params, sessionId);
    }, undefined, signal);
  const sessions = new Map();
  const owners = new Map();
  const readiness = new Map();
  const installing = new Set();
  const retirements = new Map();
  let revision = 0;
  let closePromise;
  const origin = `chrome-extension://${ctx.sw.id}/`;
  const ownedUrl = url => String(url ?? '').startsWith(origin) || String(url ?? '').startsWith(`blob:${origin}`);
  const lifecycle = record => {
    evidence.lifecycle ??= [];
    evidence.lifecycle.push({ at: Date.now(), phase: evidence.phase, ...record });
    if (evidence.lifecycle.length > 128) evidence.lifecycle.shift();
    persist();
  };
  // why: closing only explains our own cancellation, never a real protocol failure.
  const failed = error => { if (error !== cancelled && !(error instanceof ObserverDetachedError)) { evidence.observerErrors.push(String(error?.stack ?? error)); persist(); } };
  const retire = (sessionId, destroyed = false) => {
    const scope = scopes.get(sessionId);
    if (!scope || scope.excluded || closing) return;
    if (destroyed) { scope.destroyed = true; scope.destroyedReady(); }
    if (scope.detached) return;
    scope.detached = true; revision++;
    retirements.set(sessionId, scope);
    if (!scope.ready && !closing) failed(new Error(`Unobserved target detached: ${scope.target.targetId}`));
    // Preserve already-queued protocol rejections before cancelling this target's waits.
    const cancelling = new Promise(resolve => setTimeout(resolve, 0)).then(() => scope.controller.abort(scope.reason));
    installing.add(cancelling);
    cancelling.finally(() => installing.delete(cancelling));
    if (owners.get(scope.target.targetId) === sessionId) owners.delete(scope.target.targetId);
    sessions.delete(sessionId); readiness.delete(sessionId);
  };
  const install = async ({ sessionId, targetInfo, waitingForDebugger }) => {
    lifetime.signal.throwIfAborted();
    if (owners.has(targetInfo.targetId)) {
      await connection.send('Target.detachFromTarget', { sessionId });
      return;
    }
    requireResult(scopes.size < 256, 'Consent observer target budget exceeded');
    const controller = new AbortController();
    let destroyedReady;
    const destroyedWait = new Promise(resolve => { destroyedReady = resolve; });
    scopes.set(sessionId, { controller, signal: AbortSignal.any([lifetime.signal, controller.signal]),
      reason: new ObserverDetachedError(sessionId), target: targetInfo, ready: false, detached: false,
      destroyed: false, destroyedReady, destroyedWait, excluded: false });
    revision++;
    owners.set(targetInfo.targetId, sessionId);
    sessions.set(sessionId, targetInfo);
    let markReady;
    const ready = new Promise(resolve => { markReady = resolve; });
    readiness.set(sessionId, markReady);
    evidence.targets ??= [];
    evidence.targets.push({ at: Date.now(), sessionId, targetId: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url, waitingForDebugger });
    persist();
    const send = (method, params = {}) => connection.send(method, params, sessionId);
    try {
      // Blank offscreen/worker URLs can become extension-owned on first script.
      // Root owns service workers; descendants only discover frames and workers.
      if (targetInfo.url && targetInfo.url !== 'about:blank' && !ownedUrl(targetInfo.url)) {
        scopes.get(sessionId).excluded = true;
        if (waitingForDebugger) await send('Runtime.runIfWaitingForDebugger');
        await connection.send('Target.detachFromTarget', { sessionId });
        sessions.delete(sessionId);
        owners.delete(targetInfo.targetId);
        readiness.delete(sessionId); scopes.delete(sessionId);
        return;
      }
      await send('Runtime.enable');
      await send('Runtime.addBinding', { name: BINDING });
      await send('Network.enable');
      // Runtime.enable can create the current context before registration. Cover it
      // immediately; Page.enable keeps the preload active for future documents.
      const pageTarget = ['page', 'iframe', 'other'].includes(targetInfo.type);
      if (pageTarget) {
        await send('Page.enable');
        await send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SOURCE, runImmediately: true });
      }
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true,
        flatten: true, filter: CHILD_TARGET_FILTER });
      if (waitingForDebugger && ['worker', 'shared_worker', 'service_worker'].includes(targetInfo.type)) {
        // The pre-execution trap exclusively owns release.
        await instrumentPausedTarget(connection, sessionId,
          (label, operation, budgetMs = undefined) => scopedDiagnostic(sessionId, label, operation, budgetMs), pause => {
          evidence.pauses ??= [];
          if (evidence.pauses.length < 32) evidence.pauses.push({ sessionId, phase: evidence.phase, at: Date.now(), ...pause });
          persist();
        });
      } else if (pageTarget) {
        await scopedDiagnostic(sessionId, `page observer ready session=${sessionId}`, () => ready);
        if (waitingForDebugger) {
          await send('Runtime.runIfWaitingForDebugger');
        }
      } else {
        const result = await send('Runtime.evaluate', { expression: OBSERVER_SOURCE, returnByValue: true });
        if (result.exceptionDetails) throw new Error(`observer injection failed: ${JSON.stringify(result.exceptionDetails)}`);
      }
    } catch (error) { failed(error); }
    finally { readiness.delete(sessionId); }
  };
  const listener = (method, params, message) => {
    if (method === 'Target.targetDestroyed') {
      lifecycle({ method, targetId: params.targetId });
      for (const [sessionId, scope] of scopes) if (scope.target.targetId === params.targetId) retire(sessionId, true);
    } else if (['Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Inspector.detached'].includes(method)) {
      lifecycle({ method, sessionId: message.sessionId, targetId: params.targetId, executionContextId: params.executionContextId });
    } else if (['Runtime.exceptionThrown', 'Runtime.consoleAPICalled'].includes(method)) {
      const labels = lifecycleErrorLabels(method === 'Runtime.exceptionThrown'
        ? [params.exceptionDetails?.text, params.exceptionDetails?.exception?.description]
        : (params.args ?? []).map(arg => arg.description ?? arg.value));
      if (labels.length || method === 'Runtime.exceptionThrown') lifecycle({ method, sessionId: message.sessionId, labels });
    } else if (method === 'Target.attachedToTarget') {
      if (closing) {
        lifecycle({ method: 'Target.attachedToTarget', sessionId: params.sessionId,
          targetId: params.targetInfo?.targetId, duringTeardown: true });
        return;
      }
      const pending = install(params);
      installing.add(pending);
      pending.then(() => installing.delete(pending), error => { installing.delete(pending); failed(error); });
    } else if (method === 'Target.detachedFromTarget') {
      const target = sessions.get(params.sessionId);
      lifecycle({ method, sessionId: params.sessionId, targetId: target?.targetId ?? params.targetId });
      if (target && owners.get(target.targetId) === params.sessionId) retire(params.sessionId);
      if (scopes.get(params.sessionId)?.excluded) {
        owners.delete(target?.targetId); sessions.delete(params.sessionId); readiness.delete(params.sessionId);
      }
    }
    else if (method === 'Runtime.bindingCalled' && params.name === BINDING) {
      try {
        const event = JSON.parse(params.payload);
        if (event.kind === 'observer-ready') {
          const scope = scopes.get(message.sessionId);
          if (scope && !scope.detached) scope.ready = true;
          readiness.get(message.sessionId)?.();
        }
        if (ownedUrl(event.href)) {
          const target = sessions.get(message.sessionId);
          if (target) target.url = event.href;
          evidence.events.push({ ...event, at: Date.now(), sessionId: message.sessionId, phase: evidence.phase });
          persist();
        }
      } catch (error) { failed(error); }
    } else if (method === 'Network.webSocketCreated') {
      const target = sessions.get(message.sessionId);
      if (ownedUrl(target?.url)) evidence.events.push({
        kind: 'native-websocket', url: params.url, targetId: target.targetId, phase: evidence.phase,
      });
      persist();
    }
  };
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    // why: fence at the ownership boundary; queued microtasks cannot dispatch CDP
    // or resume an unobserved worker after this point. Only teardown uses nativeSend.
    closePromise = (async () => {
      try {
        // why: a native rejection may already be queued through async CDP layers.
        // Let those microtasks settle before cancellation, with dispatch fenced above.
        // This yields one turn; it never waits for an unresolved target command.
        await new Promise(resolve => setTimeout(resolve, 0));
        lifetime.abort(cancelled);
        await diagnostic('observer installation drain', () => Promise.allSettled([...installing]), 5_000);
        await diagnostic('observer stop auto-attach', () => nativeSend('Target.setAutoAttach',
          { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }), 5_000);
        requireResult(evidence.observerErrors.length === 0, `Observer failed: ${evidence.observerErrors.join('\n')}`);
      } finally {
        connection.off(listener); connection.close();
        sessions.clear(); owners.clear(); readiness.clear(); scopes.clear(); retirements.clear();
      }
    })();
    return closePromise;
  };
  connection.on(listener);
  try {
    await connection.send('Target.setDiscoverTargets', { discover: true, filter: [{}] });
    await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: ROOT_TARGET_FILTER });
    await activeDiagnostic('observer installations', async () => {
          while (installing.size) await Promise.all([...installing]);
        }, 120_000);
    requireResult(await waitFor(() => evidence.events.some(event => event.kind === 'observer-ready'
      && event.href.includes('/home/home.html')), { budgetMs: 10_000, pollMs: 25 }), 'Home observer never armed');
    return {
      async barrier() {
        const barrierLifetime = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, barrierLifetime.signal]);
        const checkActive = () => signal.throwIfAborted();
        try { await activeDiagnostic('observer stable barrier', async () => {
          // why: a retired realm cannot answer a drain command. Only browser
          // destruction evidence discharges that obligation; detach alone never does.
          for (let pass = 0; pass < 8; pass++) {
            checkActive();
            const startRevision = revision;
            await activeDiagnostic('barrier installations', async () => {
              while (installing.size) { checkActive(); await Promise.all([...installing]); }
              checkActive();
            }, 30_000, signal);
            checkActive();
            requireResult(evidence.observerErrors.length === 0, `Observer failed: ${evidence.observerErrors.join('\n')}`);
            for (const [sessionId, scope] of [...retirements]) {
              requireResult(scope.ready, `Unobserved target retired: ${scope.target.targetId}`);
              await activeDiagnostic(`target destruction target=${scope.target.targetId}`, () => scope.destroyedWait, 3_000, signal);
              checkActive();
              lifecycle({ method: 'observer.retirementConfirmed', sessionId, targetId: scope.target.targetId });
              retirements.delete(sessionId); scopes.delete(sessionId);
            }
            let changed = false;
            for (const [sessionId, target] of [...sessions]) {
              if (!ownedUrl(target.url)) continue;
              try { await connection.send('Runtime.evaluate', { expression: '0' }, sessionId, signal); }
              catch (error) {
                if (!(error instanceof ObserverDetachedError)) throw error;
                changed = true; break;
              }
            }
            // Explicit all-target inventory is coverage evidence, never a substitute
            // for the correlated destruction event required above.
            checkActive();
            const inventory = await connection.send('Target.getTargets', { filter: [{}] }, undefined, signal);
            checkActive();
            requireResult(Array.isArray(inventory.targetInfos), 'Observer target inventory missing');
            if (changed || revision !== startRevision || installing.size || retirements.size) continue;
            for (const target of inventory.targetInfos) {
              if (!ownedUrl(target.url) || !['page', 'iframe', 'other', 'worker', 'shared_worker', 'service_worker'].includes(target.type)) continue;
              const sessionId = owners.get(target.targetId);
              requireResult(sessionId && scopes.get(sessionId)?.ready && !scopes.get(sessionId)?.detached,
                `Live target lacks observer: ${target.targetId}`);
            }
            requireResult(evidence.observerErrors.length === 0, `Observer failed: ${evidence.observerErrors.join('\n')}`);
            return;
          }
          throw new Error('Consent observer target churn exceeded barrier budget');
        }, 30_000, signal); }
        finally { barrierLifetime.abort(new Error('Consent observer barrier settled')); }
      },
      async releaseWorker(targetId) {
        for (const [sessionId, target] of sessions) {
          if (target.targetId === targetId) {
            await connection.send('Target.detachFromTarget', { sessionId });
            // The reply may precede detachedFromTarget; keep the destruction obligation.
            retire(sessionId);
          }
        }
      },
      async nativeRtcCanary() {
        const match = [...sessions].find(([, target]) => ownedUrl(target.url) && target.url.includes('/offscreen/offscreen.html'));
        requireResult(match, 'No observed real offscreen realm for native RTC canary');
        evidence.rtcCanary = { sessionId: match[0], targetId: match[1].targetId, at: Date.now() };
        persist();
        const eventStart = evidence.events.length;
        const result = await connection.send('Runtime.evaluate', {
          expression: RTC_CANARY_SOURCE, returnByValue: true,
        }, match[0]);
        requireResult(!result.exceptionDetails && result.result?.value === true, 'Native RTC canary failed');
        return { sessionId: match[0], eventStart };
      },
      close,
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { evidence.cleanupError = String(cleanupError); persist(); }
    throw error;
  }
}

const click = async (page, selector) => {
  const ready = await waitFor(() => evalIn(page, `(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    return !!button && !button.disabled;
  })()`), { budgetMs: 20_000, pollMs: 50 });
  requireResult(ready, `Missing enabled button ${selector}`);
  await evalIn(page, `document.querySelector(${JSON.stringify(selector)}).click()`);
};

export async function runColdConsent({ reportPath = REPORT, launch = launchPeerd, runBudgetMs = 360_000 } = {}) {
  const evidence = { schema: 1, ok: false, phase: 'fresh-locked', checks: [], events: [], observerErrors: [], restart: 'physical-mv3-worker' };
  const persist = () => {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
  };
  const diagnostic = createConsentDiagnostics(evidence, persist);
  let ctx, observer;
  let terminated = false;
  const check = (name, condition, details) => {
    evidence.checks.push({ name, pass: !!condition, ...(details === undefined ? {} : { details }) });
    persist();
    requireResult(condition, name);
  };
  try {
    await diagnostic('consent scenario', async () => {
      ctx = await launch({ panelPath: 'home/home.html', interceptModel: false, enforceWebSecurity: true });
      if (terminated) { await ctx.close(); throw new Error('Consent scenario already terminated'); }
      const nativeSend = ctx.page.send.bind(ctx.page);
      ctx.page.send = (method, params, sessionId) => diagnostic(`page ${method}`, () => {
        if (terminated) throw new Error('Consent scenario already terminated');
        return nativeSend(method, params, sessionId);
      }, 150_000);
      const fresh = await rpc(ctx.page, { type: 'state/get' });
      check('real fresh profile has no vault', fresh?.state?.vault?.initialized === false);
      const hosts = await evalIn(ctx.page, 'chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})', true);
      check('no preexisting offscreen transport realm before observer installation', Array.isArray(hosts) && hosts.length === 0, hosts);
      observer = await observeHosts(ctx, evidence, diagnostic, persist);
      evidence.phase = 'before-choice'; persist();
      const initialized = await rpc(ctx.page, { type: 'vault/initialize', passphrase: PASSPHRASE }, { timeoutMs: 120_000 });
      check('vault created and unlocked without completing onboarding', initialized?.ok === true);
      await click(ctx.page, '.onboarding-skip'); // Provider skip: no network choice yet.
      const prompt = await waitFor(() => evalIn(ctx.page, '!!document.querySelector("[data-network-choice=skip]")'), { budgetMs: 20_000, pollMs: 50 });
      check('fresh onboarding presents explicit network choice', !!prompt);
      const undecided = await rpc(ctx.page, { type: 'state/get' });
      check('no inherited network or agent consent', undecided?.state?.settings?.dwebChoiceMade === false
        && undecided.state.settings.dwebEnabled === false && undecided.state.settings.dwebAgentEnabled === false);
      await observer.barrier(); assertNoTransport(evidence.events, 'unlocked before choice');
      check('zero native WebSocket or RTC construction before choice', true);

      await click(ctx.page, '[data-network-choice=skip]');
      const skipped = await waitFor(async () => {
        const state = (await rpc(ctx.page, { type: 'state/get' }))?.state;
        return state?.settings?.dwebChoiceMade === true && state.settings.dwebEnabled === false ? state : null;
      }, { budgetMs: 20_000, pollMs: 50 });
      check('Not now is an explicit persisted off decision', !!skipped);
      // Finish the remaining real personal-setup screens without route shortcuts.
      for (const field of ['.peer-name-input', '#onb-call', '#onb-notes']) {
        check(`personal setup screen ${field} appears`, !!await waitFor(() => evalIn(ctx.page,
          `!!document.querySelector(${JSON.stringify(field)})`), { budgetMs: 20_000, pollMs: 50 }));
        await click(ctx.page, '.onboarding-skip');
      }
      check('personal setup completes', !!await waitFor(async () =>
        (await rpc(ctx.page, { type: 'state/get' }))?.state?.profile?.onboardingComplete === true,
      { budgetMs: 20_000, pollMs: 50 }));
      await observer.barrier(); assertNoTransport(evidence.events, 'Not now');
      evidence.phase = 'reload-off'; persist();
      await ctx.page.send('Page.reload', { ignoreCache: true });
      check('Home reload finishes without repeating network onboarding', !!await waitFor(() => evalIn(ctx.page,
        '!!document.querySelector(".home-rail") && !document.querySelector("[data-network-choice=skip]")'),
      { budgetMs: 20_000, pollMs: 50 }));
      const reloaded = await rpc(ctx.page, { type: 'state/get' });
      check('explicit off survives real Home reload', reloaded?.state?.settings?.dwebChoiceMade === true
        && reloaded.state.settings.dwebEnabled === false);
      await observer.barrier(); assertNoTransport(evidence.events, 'Home reload after Not now');
      evidence.phase = 'restart-off'; persist();
      check('vault locks before physical restart', (await rpc(ctx.page, { type: 'vault/lock' }))?.ok === true);
      await observer.releaseWorker(ctx.sw.targetId);
      const stopped = await ctx.stopServiceWorker();
      const next = await ctx.restartServiceWorker(stopped);
      check('physical worker identity changes', next.targetId !== stopped.targetId, { before: stopped.targetId, after: next.targetId });
      check('vault unlock after restart', (await rpc(ctx.page, { type: 'vault/unlock', passphrase: PASSPHRASE }, { timeoutMs: 120_000 }))?.ok === true);
      const restarted = await rpc(ctx.page, { type: 'state/get' });
      check('explicit off and separate agent setting survive worker restart', restarted?.state?.settings?.dwebChoiceMade === true
        && restarted.state.settings.dwebEnabled === false && restarted.state.settings.dwebAgentEnabled === false);
      await observer.barrier(); assertNoTransport(evidence.events, 'restart after Not now');
      check('zero native transports through Not now and physical restart', true);

      // Positive control on the same observers: actual user opt-in must produce
      // native signaling construction in the real host. Network reachability is
      // not required; WebSocket creation itself is the observable side effect.
      evidence.phase = 'explicit-enable'; persist();
      await evalIn(ctx.page, 'location.hash = "discover"');
      await click(ctx.page, '[data-network-choice=enable]');
      const started = await waitFor(() => evidence.events.find(event => event.kind === 'WebSocket'
        && event.href.includes('/offscreen/offscreen.html') && event.phase === 'explicit-enable'), { budgetMs: 60_000, pollMs: 100 });
      check('explicit Discover enable constructs native host signaling', !!started, started);
      await observer.barrier();
      check('native CDP confirms signaling positive control', evidence.events.some(event => event.kind === 'native-websocket'
        && event.phase === 'explicit-enable'));
      const captureLease = async stage => {
        const entry = { stage, at: Date.now() };
        evidence.featureLeaseSnapshots ??= [];
        evidence.featureLeaseSnapshots.push(entry);
        try {
          // bootstrap/ready reads runtime.snapshot(); it does not acquire a host.
          const reply = await diagnostic(`passive feature lease snapshot ${stage}`, () =>
            rpc(ctx.page, { type: 'bootstrap/ready' }, { timeoutMs: 5_000 }), 6_000);
          Object.assign(entry, { ok: reply?.ok === true, snapshot: leaseDiagnostic(reply?.featureLeases) });
        } catch { Object.assign(entry, { unavailable: true }); }
        persist();
      };
      await captureLease('before-rtc');
      let canary;
      try { canary = await observer.nativeRtcCanary(); }
      finally { await captureLease('after-rtc'); }
      await observer.barrier();
      check('real host RTC observer positive control', rtcCanaryComplete(evidence.events.slice(canary.eventStart), canary.sessionId));
      // Stop via the ordinary preference route; no host API shim or forced close.
      check('final network disable acknowledged', (await rpc(ctx.page, { type: 'settings/update', patch: { dwebEnabled: false } }, { timeoutMs: 30_000 }))?.ok === true);
      requireResult(!terminated, 'Consent scenario already terminated');
      evidence.ok = true;
    }, runBudgetMs);
  } catch (error) {
    terminated = true;
    evidence.ok = false;
    evidence.error = String(error?.stack ?? error);
  } finally {
    persist();
    try { if (observer) await diagnostic('observer teardown', () => observer.close(), 20_000); }
    catch (error) { evidence.ok = false; evidence.cleanupError = String(error); }
    try { if (ctx) await diagnostic('browser teardown', () => ctx.close(), 10_000); }
    catch (error) { evidence.ok = false; evidence.cleanupError = String(error); }
    persist();
  }
  if (!evidence.ok) throw new Error(`Cold consent failed; see ${reportPath}: ${evidence.error}`);
  return evidence;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  runColdConsent().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(error); process.exit(1); // launchPeerd exit cleanup reaps Chrome even if launch never returned.
  });
}
