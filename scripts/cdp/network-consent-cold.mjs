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

export const assertNoTransport = (events, label) => {
  const traffic = events.filter(event => ['WebSocket', 'RTCPeerConnection', 'native-websocket'].includes(event.kind));
  if (traffic.length) throw new Error(`${label}: transport before consent: ${JSON.stringify(traffic)}`);
};

const requireResult = (condition, message) => { if (!condition) throw new Error(message); };

// Host deadlines remain effective when a renderer is paused or its socket disappears.
export const createConsentDiagnostics = (evidence, persist, timeoutMs = 15_000) => {
  let sequence = 0;
  evidence.commands = [];
  return async (label, operation, budgetMs = timeoutMs) => {
    const entry = { id: ++sequence, label, phase: evidence.phase, started: Date.now(), status: 'pending' };
    evidence.commands.push(entry);
    if (evidence.commands.length > 256) evidence.commands.shift();
    persist();
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Consent deadline: ${label}`)), budgetMs); }),
      ]);
      entry.status = 'complete';
      return result;
    } catch (error) {
      entry.status = 'failed';
      entry.error = String(error?.stack ?? error);
      throw error;
    } finally { clearTimeout(timer); entry.finished = Date.now(); persist(); }
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

// Startup-paused workers and offscreen targets need a first-script trap;
// inject on that script's call frame before releasing application code.
export async function instrumentPausedTarget(connection, sessionId, diagnostic) {
  const send = (method, params = {}) => connection.send(method, params, sessionId);
  let pause;
  let ready;
  const paused = new Promise(resolve => { pause = resolve; });
  const observed = new Promise(resolve => { ready = resolve; });
  const listener = (method, params, message) => {
    if (message.sessionId !== sessionId) return;
    if (method === 'Debugger.paused') pause(params);
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
    const result = await send('Debugger.evaluateOnCallFrame', {
      callFrameId: event.callFrames[0].callFrameId,
      expression: `${OBSERVER_SOURCE}; globalThis.__peerdConsentObserverInstalled === true`, returnByValue: true,
    });
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
  connection.send = (method, params = {}, sessionId) => diagnostic(
    `${method} session=${sessionId ?? 'browser'}`, () => nativeSend(method, params, sessionId));
  const sessions = new Map();
  const owners = new Map();
  const readiness = new Map();
  const installing = new Set();
  let closing = false;
  const origin = `chrome-extension://${ctx.sw.id}/`;
  const ownedUrl = url => String(url ?? '').startsWith(origin) || String(url ?? '').startsWith(`blob:${origin}`);
  const failed = error => { if (!closing) { evidence.observerErrors.push(String(error?.stack ?? error)); persist(); } };
  const install = async ({ sessionId, targetInfo, waitingForDebugger }) => {
    if (owners.has(targetInfo.targetId)) {
      await connection.send('Target.detachFromTarget', { sessionId });
      return;
    }
    owners.set(targetInfo.targetId, sessionId);
    sessions.set(sessionId, targetInfo);
    let markReady;
    const ready = new Promise(resolve => { markReady = resolve; });
    readiness.set(sessionId, markReady);
    evidence.targets ??= [];
    evidence.targets.push({ sessionId, targetId: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url, waitingForDebugger });
    persist();
    const send = (method, params = {}) => connection.send(method, params, sessionId);
    try {
      // Blank offscreen/worker URLs can become extension-owned on first script.
      // Root owns service workers; descendants only discover frames and workers.
      if (targetInfo.url && targetInfo.url !== 'about:blank' && !ownedUrl(targetInfo.url)) {
        if (waitingForDebugger) { await send('Runtime.runIfWaitingForDebugger'); waitingForDebugger = false; }
        await connection.send('Target.detachFromTarget', { sessionId });
        sessions.delete(sessionId);
        owners.delete(targetInfo.targetId);
        readiness.delete(sessionId);
        return;
      }
      await send('Runtime.enable');
      await send('Runtime.addBinding', { name: BINDING });
      await send('Network.enable');
      // Pages need reinstrumentation on navigation; workers have no Page domain.
      if (['page', 'iframe', 'other'].includes(targetInfo.type)) {
        await send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SOURCE });
      }
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true,
        flatten: true, filter: CHILD_TARGET_FILTER });
      if (waitingForDebugger && ['worker', 'shared_worker', 'service_worker', 'other'].includes(targetInfo.type)) {
        waitingForDebugger = false; // The pre-execution trap exclusively owns release.
        await instrumentPausedTarget(connection, sessionId, diagnostic);
      } else if (waitingForDebugger) {
        // Page preload is registered before release; evaluating in its startup wait can hang.
        await send('Runtime.runIfWaitingForDebugger');
        waitingForDebugger = false;
        await diagnostic(`page observer ready session=${sessionId}`, () => ready);
      } else {
        const result = await send('Runtime.evaluate', { expression: OBSERVER_SOURCE, returnByValue: true });
        if (result.exceptionDetails) throw new Error(`observer injection failed: ${JSON.stringify(result.exceptionDetails)}`);
      }
    } catch (error) { failed(error); }
    finally { readiness.delete(sessionId); }
  };
  const listener = (method, params, message) => {
    if (method === 'Target.attachedToTarget') {
      const pending = install(params);
      installing.add(pending);
      pending.then(() => installing.delete(pending), error => { installing.delete(pending); failed(error); });
    } else if (method === 'Target.detachedFromTarget') {
      const target = sessions.get(params.sessionId);
      if (target && owners.get(target.targetId) === params.sessionId) owners.delete(target.targetId);
      sessions.delete(params.sessionId);
      readiness.delete(params.sessionId);
    }
    else if (method === 'Runtime.bindingCalled' && params.name === BINDING) {
      try {
        const event = JSON.parse(params.payload);
        if (event.kind === 'observer-ready') readiness.get(message.sessionId)?.();
        if (ownedUrl(event.href)) {
          const target = sessions.get(message.sessionId);
          if (target) target.url = event.href;
          evidence.events.push({ ...event, sessionId: message.sessionId, phase: evidence.phase });
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
  connection.on(listener);
  try {
    await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: ROOT_TARGET_FILTER });
    await diagnostic('observer installations', async () => {
          while (installing.size) await Promise.all([...installing]);
        }, 120_000);
    requireResult(await waitFor(() => evidence.events.some(event => event.kind === 'observer-ready'
      && event.href.includes('/home/home.html')), { budgetMs: 10_000, pollMs: 25 }), 'Home observer never armed');
    return {
      async barrier() {
        await diagnostic('observer installations', async () => {
          while (installing.size) await Promise.all([...installing]);
        }, 120_000);
        // Drain CDP events already emitted by each live extension realm.
        for (const [sessionId, target] of sessions) {
          if (ownedUrl(target.url)) await connection.send('Runtime.evaluate', { expression: '0' }, sessionId);
        }
        requireResult(evidence.observerErrors.length === 0, `Observer failed: ${evidence.observerErrors.join('\n')}`);
      },
      async releaseWorker(targetId) {
        for (const [sessionId, target] of sessions) {
          if (target.targetId === targetId) {
            await connection.send('Target.detachFromTarget', { sessionId });
            sessions.delete(sessionId);
            owners.delete(target.targetId);
            readiness.delete(sessionId);
          }
        }
      },
      async nativeRtcCanary() {
        const match = [...sessions].find(([, target]) => ownedUrl(target.url) && target.url.includes('/offscreen/offscreen.html'));
        requireResult(match, 'No observed real offscreen realm for native RTC canary');
        const result = await connection.send('Runtime.evaluate', {
          expression: '(() => { const pc = new RTCPeerConnection({iceServers: []}); pc.close(); return true; })()', returnByValue: true,
        }, match[0]);
        requireResult(!result.exceptionDetails && result.result?.value === true, 'Native RTC canary failed');
      },
      async close() {
        closing = true;
        try { await connection.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }); }
        finally { connection.off(listener); connection.close(); }
      },
    };
  } catch (error) {
    closing = true;
    connection.off(listener); connection.close();
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
      await observer.nativeRtcCanary();
      await observer.barrier();
      check('real host RTC observer positive control', evidence.events.some(event => event.kind === 'RTCPeerConnection' && event.phase === 'explicit-enable'));
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
