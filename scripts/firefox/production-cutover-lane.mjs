#!/usr/bin/env bun
// Installed Store-Firefox production cutover lane: real first-install UI,
// passphrase commit, semantic controller, App/isomorphic-git, and event-page
// discard/recovery. Firefox Store intentionally prunes dweb until it has a
// durable mesh host; this lane proves that posture instead of claiming mesh
// continuity that the artifact cannot provide.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { packageArtifact } from '../../packaging/package.ts';
import { ARTIFACTS_DIR, REPO_ROOT } from '../../packaging/lib.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import {
  digestTree, sha256File,
} from '../cdp/passkey-signup-lane.mjs';
import {
  assertLiveKernelAssembly,
} from '../acceptance/live-kernel-assembly.mjs';
import {
  ACCEPTANCE_REPLY, browserVerifyAcceptanceAppPayload,
  kernelIdentityFromReply,
  REMOTE_GIT_PROOF_PATH, REMOTE_GIT_PROOF_TEXT,
  startOllamaAcceptanceFixture,
} from '../cdp/product-acceptance-probes.mjs';
import { sseText, sseToolCall } from '../cdp/e2e-harness.mjs';
import {
  assertExactGitFixtureRequests, assertGitFixtureBinding, assertGitFixtureSnapshot,
  assertSecretlessGitReport,
  GIT_FIXTURE_HOST, GIT_FIXTURE_REMOTE,
  redactGitFixtureCredential,
  startGitSmartHttpFixture,
} from '../acceptance/git-smart-http-fixture.mjs';
import { startGeckodriver, waitFor } from './webdriver.mjs';
import {
  APP_EGRESS_REGEX, APP_EGRESS_RULE_ID,
} from '../../extension/peerd-egress/denylist/dnr-rules.js';

const ENTRY = import.meta.path;
const FIREFOX_BACKGROUND_ENTRY = 'background/vault-kernel-firefox.js';
const ADDON_ID = 'peerd@peerd.ai';
const FIREFOX_UUID = '7d12f198-31fc-4e95-9184-e954123981b6';
const HOME_URL = `moz-extension://${FIREFOX_UUID}/home/home.html#production-cutover`;
const OPTIONS_URL = `moz-extension://${FIREFOX_UUID}/options/options.html#!/production-cutover`;
const FIREFOX_ORIGIN = `moz-extension://${FIREFOX_UUID}`;
const FIREFOX_SIDEBAR_ID = 'peerd_peerd_ai-sidebar-action';
const appUrl = (appId) => `moz-extension://${FIREFOX_UUID}/engine-tabs/app-tab/index.html#${encodeURIComponent(appId)}`;
const CONTROLLER_IDLE_CONTINUITY_MS = 30_000;
const EVENT_PAGE_IDLE_MS = 45_000;
const PASSPHRASE = 'firefox-production-cutover-passphrase';
export const FIREFOX_CUTOVER_HANG_CEILINGS = Object.freeze({
  ctaMs: 180_000,
  vaultCommitAfterSubmitMs: 120_000,
  panelAfterVaultMs: 60_000,
  controllerMs: 30_000,
  repositoryMs: 30_000,
  recycleAfterIdleMs: 150_000,
});
const exactBudgetProfile = (actual, expected) => actual != null
  && typeof actual === 'object'
  && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => actual[key] === value);
const HEX_256 = /^[a-f0-9]{64}$/;
const hostNowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const sha256Text = (value) => createHash('sha256').update(value).digest('hex');

const toolCallIdFromSse = (body) => {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const id = JSON.parse(line.slice(6))?.choices?.[0]?.delta?.tool_calls?.[0]?.id;
      if (typeof id === 'string' && id) return id;
    } catch {}
  }
  return null;
};

const validNowResult = (content) => {
  let value;
  try { value = JSON.parse(content); } catch { return false; }
  const unixMs = Number(value?.unixMs);
  return Number.isFinite(unixMs)
    && value?.iso === new Date(unixMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
    && typeof value?.timezone === 'string' && value.timezone.length > 0
    && typeof value?.dayOfWeek === 'string' && value.dayOfWeek.length > 0;
};

export const createNowCompletionResponder = () => {
  let expectedToolCallId = null;
  return ({ completionCall, requestBody }) => {
    if (completionCall % 2 === 1) {
      const body = sseToolCall('now', {});
      expectedToolCallId = toolCallIdFromSse(body);
      if (!expectedToolCallId) throw new Error('now fixture tool_call_id missing');
      return {
        body,
        proof: {
          completionCall, toolCallIssued: true,
          toolCallIdDigest: sha256Text(expectedToolCallId),
        },
      };
    }
    const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
    const result = messages.at(-1);
    const assistant = messages.at(-2);
    const toolCall = assistant?.tool_calls?.find((entry) => entry?.function?.name === 'now');
    const toolCallIdMatched = typeof expectedToolCallId === 'string'
      && toolCall?.id === expectedToolCallId && result?.tool_call_id === expectedToolCallId;
    const nowResultValid = result?.role === 'tool'
      && typeof result.content === 'string' && validNowResult(result.content);
    const inputValid = (() => {
      try { return Object.keys(JSON.parse(toolCall?.function?.arguments ?? '')).length === 0; }
      catch { return false; }
    })();
    const toolResultAccepted = toolCallIdMatched && nowResultValid && inputValid;
    const proof = {
      completionCall, toolResultAccepted, toolCallIdMatched, nowResultValid,
      toolCallIdDigest: sha256Text(expectedToolCallId ?? ''),
      resultDigest: sha256Text(typeof result?.content === 'string' ? result.content : ''),
    };
    if (!toolResultAccepted) {
      return {
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'now-tool-result-rejected' }),
        proof,
      };
    }
    expectedToolCallId = null;
    return { body: sseText(ACCEPTANCE_REPLY), proof };
  };
};

const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((directory) => join(directory, name))
  .find((path) => { try { return statSync(path).isFile(); } catch { return false; } });
const firefoxBinary = () => process.env.FIREFOX_PATH || process.env.FIREFOX_BIN
  || '/private/tmp/Firefox153-installed-copy.app/Contents/MacOS/firefox';
const geckodriverBinary = () => process.env.GECKODRIVER_PATH || onPath('geckodriver');

const call = async (driver, message) => JSON.parse(await driver.executeAsync(`
  const message = arguments[0];
  const done = arguments[arguments.length - 1];
  browser.runtime.sendMessage(message).then(
    (reply) => done(JSON.stringify(reply)),
    (error) => done(JSON.stringify({
      ok: false, transportError: error?.message || String(error),
    })),
  );
`, [message]));

const executeInBrowsingContext = async (driver, browsingContextId, script, args, async) => {
  await driver.setContext('chrome');
  await driver.switchToFrame(null);
  const payload = JSON.parse(await driver.executeAsync(`
    const id = arguments[0];
    const script = arguments[1];
    const args = arguments[2];
    const async = arguments[3];
    const done = arguments[arguments.length - 1];
    const context = BrowsingContext.get(id);
    const actor = context?.currentWindowGlobal?.getActor('MarionetteCommands');
    if (!actor) {
      done(JSON.stringify({ ok: false, error: 'Firefox sidebar browsing context unavailable' }));
      return;
    }
    actor.executeScript(script, args, {
      timeout: 30_000,
      sandboxName: null,
      newSandbox: false,
      file: '',
      line: 0,
      async,
    }).then(
      (value) => done(JSON.stringify({ ok: true, value })),
      (cause) => done(JSON.stringify({
        ok: false,
        error: cause?.message || String(cause),
      })),
    );
  `, [browsingContextId, script, args, async]));
  if (!payload.ok) throw new Error(payload.error);
  return payload.value;
};

const openFirefoxSidebar = async (driver) => {
  const opened = await waitFor(async () => {
    await driver.setContext('chrome');
    await driver.switchToFrame(null);
    return driver.executeAsync(`
      const id = arguments[0];
      const done = arguments[arguments.length - 1];
      Promise.resolve(SidebarController.promiseInitialized).then(async () => {
        if (SidebarController.currentID !== id || SidebarController._box?.hidden) {
          await SidebarController.show(id);
        }
        const ready = SidebarController.currentID === id
          && SidebarController._box?.hidden !== true
          && SidebarController.browser?.currentURI?.spec
            === 'chrome://browser/content/webext-panels.xhtml';
        done(ready);
      }, () => done(false));
    `, [FIREFOX_SIDEBAR_ID]).catch(() => false);
  }, { budgetMs: 15_000, pollMs: 100 });
  if (!opened) throw new Error('Firefox extension sidebar did not open');

  await driver.setContext('chrome');
  await driver.switchToFrame(null);
  const outer = await driver.execute('return SidebarController.browser');
  await driver.switchToFrame(outer);
  await driver.setContext('content');
  const browsingContextId = await waitFor(async () => driver.execute(`
    const panel = document.getElementById('webext-panels-browser');
    const url = panel?.currentURI?.spec ?? '';
    let path = '';
    try { path = new URL(url).pathname; } catch {}
    return url.startsWith('moz-extension://') && path === '/sidepanel/sidepanel.html'
      ? panel.browsingContext?.id ?? null : null;
  `), { budgetMs: 15_000, pollMs: 100 });
  if (!Number.isInteger(browsingContextId)) {
    const evidence = await driver.execute(`
      const panel = document.getElementById('webext-panels-browser');
      return JSON.stringify({
        href: location.href,
        readyState: document.readyState,
        panel: !!panel,
        url: panel?.currentURI?.spec ?? null,
        browsingContextId: panel?.browsingContext?.id ?? null,
      });
    `).catch(() => null);
    throw new Error(`Firefox extension sidebar browsing context unavailable: ${evidence}`);
  }
  await driver.setContext('chrome');
  await driver.switchToFrame(null);
  return Object.freeze({
    browsingContextId,
    execute: (script, args = []) =>
      executeInBrowsingContext(driver, browsingContextId, script, args, false),
    executeAsync: (script, args = []) =>
      executeInBrowsingContext(driver, browsingContextId, script, args, true),
  });
};

const closeFirefoxSidebar = async (driver) => {
  await driver.setContext('chrome');
  await driver.switchToFrame(null);
  await driver.executeAsync(`
    const done = arguments[arguments.length - 1];
    Promise.resolve(SidebarController.hide()).then(() => done(true), () => done(false));
  `);
};

const executeJson = async (driver, source, args = []) =>
  JSON.parse(await driver.execute(`return JSON.stringify((${source}));`, args));

const surfaceCheckpoint = (driver, kind, appId = null) => executeJson(driver, `(() => {
  const kind = arguments[0];
  const appId = arguments[1];
  const visible = (node) => {
    const rect = node?.getBoundingClientRect();
    const style = node ? getComputedStyle(node) : null;
    return !!node && !!rect && rect.width > 0 && rect.height > 0
      && style?.display !== 'none' && style?.visibility !== 'hidden';
  };
  const root = kind === 'app' ? document.querySelector('#app-frame')
    : document.querySelector('#app');
  let shell = false;
  let target = null;
  if (kind === 'home') shell = !!document.querySelector('.home-shell');
  else if (kind === 'options') shell = !!document.querySelector('.options-shell .options-page');
  else if (kind === 'sidebar') shell = !!document.querySelector('.app-shell');
  else if (kind === 'app') {
    const boot = document.querySelector('#boot');
    const frame = document.querySelector('#app-frame');
    target = decodeURIComponent(location.hash.slice(1).split('?')[0]);
    shell = boot?.classList.contains('is-hidden') === true
      && boot?.classList.contains('is-failed') !== true
      && frame?.getAttribute('src')?.startsWith('/engine-tabs/app-tab/runner.html#') === true;
  }
  const url = location.href.split('#')[0].split('?')[0];
  const stageReady = kind === 'home' || kind === 'sidebar'
    ? document.documentElement.dataset.peerdBootStage === 'app-ready' : true;
  const ready = document.readyState === 'complete' && browser.runtime.id === arguments[2]
    && url === arguments[3] + arguments[4] && location.pathname === arguments[4]
    && visible(root) && shell && stageReady && (kind !== 'app' || target === appId);
  return {
    kind, url, pathname: location.pathname,
    runtimeId: browser.runtime.id, readyState: document.readyState,
    ready, rootVisible: visible(root), shell, target,
    ...(!ready && kind === 'app' ? { diagnostic: {
      title: document.title,
      boot: document.querySelector('#boot-msg')?.textContent ?? '',
      bootClass: document.querySelector('#boot')?.className ?? '',
      retryVisible: document.querySelector('#actor-retry')?.hidden === false,
      frameSrc: document.querySelector('#app-frame')?.getAttribute('src') ?? '',
    } } : {}),
  };
})()`, [kind, appId, ADDON_ID, FIREFOX_ORIGIN, {
  home: '/home/home.html',
  options: '/options/options.html',
  sidebar: '/sidepanel/sidepanel.html',
  app: '/engine-tabs/app-tab/index.html',
}[kind]]);

const waitSurface = async (driver, kind, appId = null, budgetMs = 60_000) => {
  let observed = null;
  const checkpoint = await waitFor(async () => {
    observed = await surfaceCheckpoint(driver, kind, appId);
    return observed?.ready === true ? observed : null;
  }, { budgetMs, pollMs: 100 });
  if (!checkpoint) {
    throw new Error(`Firefox ${kind} surface did not become ready: ${JSON.stringify(observed)}`);
  }
  return checkpoint;
};

const uiSnapshot = (driver) => executeJson(driver, `(() => {
  const root = document.querySelector('#app');
  const rect = root?.getBoundingClientRect();
  const style = root ? getComputedStyle(root) : null;
  const body = document.body?.innerText || '';
  return {
    url: location.href,
    readyState: document.readyState,
    stage: document.documentElement.dataset.peerdBootStage || '',
    bootError: document.documentElement.dataset.peerdBootError || '',
    bootModule: document.documentElement.dataset.peerdBootModule || '',
    staticShellPainted: document.documentElement.dataset.peerdStaticShellPainted === 'true',
    rootVisible: !!root && !!rect && rect.width > 0 && rect.height > 0
      && style?.visibility !== 'hidden' && style?.display !== 'none',
    rootTextLength: body.trim().length,
    body: body.slice(0, 2000),
    homeShell: !!document.querySelector('.home-shell'),
    appShell: !!document.querySelector('.app-shell'),
    gate: !!document.querySelector('.gate-card'),
    failure: document.documentElement.dataset.peerdBootStage === 'failed'
      || !!document.querySelector('[role="alert"]'),
  };
})()`);

const ensurePassphraseForm = async (driver) => waitFor(async () => executeJson(driver, `(() => {
  if (document.documentElement.dataset.peerdBootStage !== 'vault-ready') return null;
  const root = document.querySelector('#app');
  const rootRect = root?.getBoundingClientRect();
  const rootStyle = root ? getComputedStyle(root) : null;
  if (!root || !rootRect || rootRect.width <= 0 || rootRect.height <= 0
      || rootStyle?.display === 'none' || rootStyle?.visibility === 'hidden') return null;
  const fallback = [...document.querySelectorAll('button')]
    .find((node) => /use a passphrase instead/i.test(node.textContent || ''));
  if (fallback) {
    const rect = fallback.getBoundingClientRect();
    if (fallback.disabled || rect.width <= 0 || rect.height <= 0) return null;
    fallback.click();
    return null;
  }
  const pass = document.querySelector('#pass');
  const confirm = document.querySelector('#pass2');
  const submit = [...document.querySelectorAll('button')]
    .find((node) => /create vault/i.test(node.textContent || '') && !node.disabled);
  const passRect = pass?.getBoundingClientRect();
  const confirmRect = confirm?.getBoundingClientRect();
  const submitRect = submit?.getBoundingClientRect();
  return pass && confirm && submit
    && passRect?.width > 0 && passRect?.height > 0
    && confirmRect?.width > 0 && confirmRect?.height > 0
    && submitRect?.width > 0 && submitRect?.height > 0
    ? { rootVisible: true, formVisible: true, submitEnabled: true } : null;
})()`), { budgetMs: FIREFOX_CUTOVER_HANG_CEILINGS.ctaMs, pollMs: 100 });

const submitPassphrase = (driver) => driver.execute(`
  const value = arguments[0];
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const id of ['pass', 'pass2']) {
    const input = document.getElementById(id);
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const submit = [...document.querySelectorAll('button')]
    .find((node) => /create vault/i.test(node.textContent || '') && !node.disabled);
  submit.click();
  return true;
`, [PASSPHRASE]);

const skipProviderSetup = (driver) => waitFor(() => executeJson(driver, `(() => {
  const skip = [...document.querySelectorAll('button')]
    .find((node) => /do this later/i.test(node.textContent || '') && !node.disabled);
  if (!skip) return null;
  skip.click();
  return true;
})()`), { budgetMs: 30_000, pollMs: 100 });

const waitForControllerReply = async (driver, text, fixture, expectedCalls) => waitFor(async () => {
  if (fixture.completionCalls() !== expectedCalls) return null;
  return executeJson(driver, `(() => {
    const user = [...document.querySelectorAll('.message-user')]
      .some((node) => (node.textContent || '').includes(arguments[0]));
    const assistant = [...document.querySelectorAll('.message-assistant .bubble')]
      .some((node) => (node.textContent || '').trim() === arguments[1]);
    const busy = !!document.querySelector('.message-assistant.streaming, form.input-bar button.stop');
    return user && assistant && !busy ? { user, assistant, busy } : null;
  })()`, [text, ACCEPTANCE_REPLY]);
}, { budgetMs: 30_000, pollMs: 50 });

export const controllerNowReceiptFromState = (reply, text, completionCalls) => {
  const messages = reply?.state?.session?.messages;
  if (!Array.isArray(messages)) return null;
  const userIndex = messages.findLastIndex((message) =>
    message?.role === 'user' && message.content === text);
  if (userIndex < 0) return null;
  const tail = messages.slice(userIndex + 1);
  const toolMessageIndex = tail.findIndex((message) => message?.role === 'assistant'
    && Array.isArray(message.toolUses)
    && message.toolUses.some((toolUse) => toolUse?.name === 'now'));
  if (toolMessageIndex < 0) return null;
  const toolUses = tail[toolMessageIndex].toolUses.filter((toolUse) => toolUse?.name === 'now');
  if (toolUses.length !== 1 || Object.keys(toolUses[0].input ?? {}).length !== 0) return null;
  const result = tail.slice(toolMessageIndex + 1)
    .flatMap((message) => Array.isArray(message?.toolResults) ? message.toolResults : [])
    .find((entry) => entry?.tool_use_id === toolUses[0].id);
  const final = tail.slice(toolMessageIndex + 1)
    .some((message) => message?.role === 'assistant' && message.content === ACCEPTANCE_REPLY);
  if (!result || result.is_error !== false || result.outcomeKnown === false
      || result.meta?.toolName !== 'now' || result.meta?.primitive !== 'time' || !final) return null;
  let value;
  try { value = JSON.parse(result.content); } catch { return null; }
  const unixMs = Number(value?.unixMs);
  const expectedIso = Number.isFinite(unixMs)
    ? new Date(unixMs).toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
  if (value?.iso !== expectedIso || typeof value?.timezone !== 'string' || !value.timezone
      || typeof value?.dayOfWeek !== 'string' || !value.dayOfWeek) return null;
  return {
    ok: true, tool: 'now', primitive: 'time', inputKeys: 0,
    outcomeKnown: true, iso: value.iso, unixMs,
    timezone: value.timezone, dayOfWeek: value.dayOfWeek, completionCalls,
    resultDigest: sha256Text(result.content),
  };
};

const runNowControllerTurn = async (driver, fixture, text, expectedCalls) => {
  const sent = await call(driver, { type: 'agent/send', text });
  if (sent?.ok !== true || !(await waitForControllerReply(driver, text, fixture, expectedCalls))) {
    throw new Error(`Firefox now controller turn failed: ${JSON.stringify({ sent, expectedCalls })}`);
  }
  const receipt = await waitFor(async () => controllerNowReceiptFromState(
    await call(driver, { type: 'state/get' }), text, fixture.completionCalls(),
  ), { budgetMs: 5_000, pollMs: 50 });
  if (!receipt) throw new Error('Firefox now controller receipt was incomplete');
  return receipt;
};

const selectMainContent = async (driver, handle) => {
  await driver.switchToWindow(handle);
  await driver.setContext('content');
  await driver.switchToFrame(null);
};

const navigateMain = async (driver, handle, url, kind, appId = null) => {
  await selectMainContent(driver, handle);
  await driver.navigate(url);
  const ready = await waitFor(async () => {
    const reply = await call(driver, { type: 'bootstrap/ready' });
    return reply?.ok === true ? true : null;
  }, { budgetMs: 15_000, pollMs: 100 });
  if (!ready) throw new Error(`Firefox extension document did not bind its kernel: ${url}`);
  return waitSurface(driver, kind, appId);
};

const openAppMain = async (driver, sender, handle, appId) => {
  await selectMainContent(driver, handle);
  const opened = await call(sender, { type: 'apps/open', appId });
  if (opened?.ok !== true) {
    throw new Error(`Firefox App open failed: ${JSON.stringify(opened)}`);
  }
  const appHandle = await waitFor(async () => {
    for (const candidate of await driver.windowHandles()) {
      await selectMainContent(driver, candidate);
      const href = await driver.execute('return location.href;').catch(() => '');
      if (href.startsWith(appUrl(appId))) return candidate;
    }
    return null;
  }, { budgetMs: 15_000, pollMs: 100 });
  if (!appHandle) throw new Error('Firefox App tab did not open');
  await selectMainContent(driver, appHandle);
  const surface = await waitSurface(driver, 'app', appId);
  if (appHandle !== handle) {
    await driver.switchToWindow(handle);
    await driver.closeWindow();
    await selectMainContent(driver, appHandle);
  }
  return { handle: appHandle, surface };
};

const importAcceptanceApp = async (driver) => JSON.parse(await driver.executeAsync(`
  const done = arguments[arguments.length - 1];
  import('/peerd-engine/index.js').then(async ({ buildAppExport }) => {
    const envelope = await buildAppExport({
      record: {
        name: 'Production Cutover App Git Probe',
        entryFile: 'index.html',
        tags: ['acceptance'],
      },
      files: {
        'index.html': '<!doctype html><title>Cutover App</title><main>ready</main>',
        'src/main.js': 'document.querySelector("main").dataset.ready = "true";',
        'assets/raw.bin': new Uint8Array([0, 1, 2, 127, 128, 255]),
      },
    });
    return browser.runtime.sendMessage({ type: 'import/apply', envelope });
  }).then(
    (reply) => done(JSON.stringify(reply)),
    (error) => done(JSON.stringify({ ok: false, phase: 'exception', detail: String(error) })),
  );
`));

const verifyPayload = async (driver, appId) => JSON.parse(await driver.executeAsync(`
  const done = arguments[arguments.length - 1];
  const appId = arguments[0];
  const verifyPayload = ${browserVerifyAcceptanceAppPayload.toString()};
  verifyPayload(appId).then(
    (reply) => done(JSON.stringify(reply)),
    (error) => done(JSON.stringify({ ok: false, phase: 'exception', detail: String(error) })),
  );
`, [appId]));

const verifyAppIsolation = async (driver) => {
  await driver.switchToFrame(null);
  const frame = await driver.execute('return document.querySelector("#app-frame")');
  if (!frame) return { ok: false };
  await driver.switchToFrame(frame);
  const realm = JSON.parse(await driver.executeAsync(`
    const done = arguments[arguments.length - 1];
    const key = '__peerdFirefoxAppIsolation';
    const script = document.createElement('script');
    script.textContent = ${JSON.stringify(`(() => {
      const opaqueOrigin = (() => {
        if (window.parent === window) return false;
        try { void window.parent.document; return false; }
        catch (error) { return error?.name === 'SecurityError'; }
      })();
      const proof = {
        inlineExecuted: true,
        opaqueOrigin,
        browserAbsent: typeof globalThis.browser === 'undefined',
        chromeAbsent: typeof globalThis.chrome === 'undefined',
        rtcSealed: typeof globalThis.RTCPeerConnection === 'undefined'
          && typeof globalThis.webkitRTCPeerConnection === 'undefined',
        fetchBlocked: false,
        webSocketBlocked: false,
        complete: false,
      };
      globalThis.__peerdFirefoxAppIsolation = proof;
      const fetchProbe = fetch('https://app-egress.invalid/probe', { cache: 'no-store' })
        .then(() => false, () => true);
      const socketProbe = new Promise((resolve) => {
        let socket;
        let settled = false;
        const finish = (blocked) => {
          if (settled) return;
          settled = true;
          try { socket?.close(); } catch {}
          resolve(blocked);
        };
        try {
          socket = new WebSocket('wss://app-egress.invalid/probe');
          socket.addEventListener('open', () => finish(false), { once: true });
          socket.addEventListener('error', () => finish(true), { once: true });
          setTimeout(() => finish(false), 2_000);
        } catch { finish(true); }
      });
      Promise.all([fetchProbe, socketProbe]).then(([fetchBlocked, webSocketBlocked]) => {
        proof.fetchBlocked = fetchBlocked;
        proof.webSocketBlocked = webSocketBlocked;
        proof.complete = true;
      });
    })();`)};
    document.body.append(script);
    const started = Date.now();
    const poll = () => {
      const proof = globalThis[key];
      if (proof?.complete === true || Date.now() - started > 5_000) {
        done(JSON.stringify(proof ?? {
          inlineExecuted: false,
          opaqueOrigin: false,
          browserAbsent: typeof globalThis.browser === 'undefined',
          chromeAbsent: typeof globalThis.chrome === 'undefined',
          rtcSealed: typeof globalThis.RTCPeerConnection === 'undefined'
            && typeof globalThis.webkitRTCPeerConnection === 'undefined',
          fetchBlocked: false, webSocketBlocked: false, complete: false,
        }));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  `));
  await driver.switchToFrame(null);
  const dnr = await waitFor(async () => {
    const proof = JSON.parse(await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      Promise.all([
        browser.tabs.getCurrent(),
        browser.declarativeNetRequest.getSessionRules(),
      ]).then(([tab, rules]) => {
        const rule = rules.find((candidate) => candidate.id === arguments[0]);
        done(JSON.stringify({
          ruleInstalled: rule?.action?.type === 'block'
            && rule?.condition?.regexFilter === arguments[1],
          tabScoped: Number.isInteger(tab?.id)
            && rule?.condition?.tabIds?.includes(tab.id) === true,
        }));
      }, () => done(JSON.stringify({ ruleInstalled: false, tabScoped: false })));
    `, [APP_EGRESS_RULE_ID, APP_EGRESS_REGEX]));
    return proof.ruleInstalled && proof.tabScoped ? proof : null;
  }, { budgetMs: 5_000, pollMs: 50 }) ?? { ruleInstalled: false, tabScoped: false };
  const proof = {
    opaqueOrigin: realm?.opaqueOrigin === true,
    browserAbsent: realm?.browserAbsent === true,
    chromeAbsent: realm?.chromeAbsent === true,
    inlineExecuted: realm?.inlineExecuted === true,
    fetchBlocked: realm?.fetchBlocked === true,
    webSocketBlocked: realm?.webSocketBlocked === true,
    rtcSealed: realm?.rtcSealed === true,
    dnrRuleInstalled: dnr.ruleInstalled === true,
    dnrTabScoped: dnr.tabScoped === true,
  };
  return { ok: Object.values(proof).every(Boolean), ...proof };
};

const runAppGit = async (driver, sender, handle) => {
  const options = await navigateMain(driver, handle, OPTIONS_URL, 'options');
  const imported = await importAcceptanceApp(driver);
  if (imported?.ok !== true || imported.kind !== 'app' || typeof imported.id !== 'string') {
    return { ok: false, phase: 'import', imported };
  }
  const appId = imported.id;
  const opened = await openAppMain(driver, sender, handle, appId);
  handle = opened.handle;
  const app = opened.surface;
  const isolation = await verifyAppIsolation(driver);
  const home = await navigateMain(driver, handle, HOME_URL, 'home');
  const beforePayload = await call(driver, { type: 'bootstrap/ready' });
  const payload = await verifyPayload(driver, appId);
  const afterPayload = await call(driver, { type: 'bootstrap/ready' });
  const status = await call(driver, { type: 'apps/repository/status', appId });
  const branch = await call(driver, {
    type: 'apps/repository/branch', appId, name: 'acceptance/cutover', checkout: true,
  });
  const history = await call(driver, { type: 'apps/repository/history', appId, depth: 5 });
  const ok = isolation.ok === true && payload?.ok === true
    && status?.ok === true && typeof status.status?.oid === 'string'
    && status.status.oid.length > 0 && branch?.ok === true
    && history?.ok === true && history.commits?.length >= 1;
  return {
    ok, phase: ok ? 'complete' : 'repository', appId, isolation, handle,
    payload, status, branch, history,
    surfaces: { options, app, home },
    ...(ok ? {} : {
      payloadKernel: {
        before: kernelIdentityFromReply(beforePayload),
        after: kernelIdentityFromReply(afterPayload),
      },
    }),
  };
};

const runRemoteAppGit = async (driver, sender, handle, appId, config) => {
  await navigateMain(driver, handle, OPTIONS_URL, 'options');
  const credential = await call(driver, {
    type: 'git-cred/set', host: config.host, token: config.token,
  });
  const credentialList = await call(driver, { type: 'git-cred/list' });
  if (credential?.ok !== true || credential.host !== config.host
      || credentialList?.hosts?.filter((host) => host === config.host).length !== 1) {
    return { ok: false, phase: 'credential', credentialStored: credential?.ok === true };
  }

  await navigateMain(driver, handle, HOME_URL, 'home');
  const linked = await call(driver, {
    type: 'apps/repository/link', appId, url: config.remote,
  });
  if (linked?.ok !== true || linked.remote?.host !== config.host
      || linked.remote?.url !== config.remote) {
    return {
      ok: false, phase: 'link', credentialStored: true,
      linked: {
        ok: linked?.ok === true,
        code: typeof linked?.code === 'string' ? linked.code : null,
        error: typeof linked?.error === 'string' ? linked.error : null,
        host: linked?.remote?.host ?? null,
        remoteMatched: linked?.remote?.url === config.remote,
      },
    };
  }

  handle = (await openAppMain(driver, sender, handle, appId)).handle;
  const wrote = await call(driver, {
    type: 'app/editor/write', appId, path: config.proofPath, content: config.proofText,
  });
  await navigateMain(driver, handle, HOME_URL, 'home');
  const committed = await call(driver, {
    type: 'apps/repository/commit', appId, message: 'installed Smart HTTP acceptance proof',
  });
  const pushed = await call(driver, {
    type: 'apps/repository/push', appId, branch: config.branch,
  });
  const fetched = await call(driver, { type: 'apps/repository/fetch', appId });
  if (wrote?.ok !== true || committed?.ok !== true
      || typeof committed.result?.oid !== 'string' || committed.result.oid.length < 7
      || pushed?.ok !== true || pushed.result?.ok !== true
      || pushed.result?.branch !== config.branch
      || fetched?.ok !== true || fetched.result?.remote?.host !== config.host) {
    return {
      ok: false, phase: 'push-fetch', credentialStored: true,
      linked: linked?.ok === true, wrote: wrote?.ok === true,
      committed: committed?.ok === true, pushed: pushed?.ok === true,
      fetched: {
        ok: fetched?.ok === true,
        code: typeof fetched?.code === 'string' ? fetched.code : null,
        error: typeof fetched?.error === 'string' ? fetched.error : null,
        outcomeKnown: fetched?.outcomeKnown ?? null,
        host: fetched?.result?.remote?.host ?? null,
      },
    };
  }

  const cloned = await call(driver, {
    type: 'apps/import-git', url: config.remote, ref: config.branch,
    depth: 20, name: 'Installed Smart HTTP Clone',
  });
  const cloneId = cloned?.record?.id;
  if (cloned?.ok !== true || typeof cloneId !== 'string') {
    return {
      ok: false, phase: 'clone', credentialStored: true,
      clone: {
        ok: cloned?.ok === true,
        code: typeof cloned?.code === 'string' ? cloned.code : null,
        error: typeof cloned?.error === 'string' ? cloned.error : null,
        outcomeKnown: cloned?.outcomeKnown ?? null,
      },
    };
  }
  const payload = await verifyPayload(driver, cloneId);
  handle = (await openAppMain(driver, sender, handle, cloneId)).handle;
  const proof = await call(driver, {
    type: 'app/editor/read', appId: cloneId, path: config.proofPath,
  });
  await navigateMain(driver, handle, HOME_URL, 'home');
  const cloneStatus = await call(driver, {
    type: 'apps/repository/status', appId: cloneId,
  });
  const cloneHistory = await call(driver, {
    type: 'apps/repository/history', appId: cloneId, depth: 10,
  });
  await call(driver, { type: 'apps/delete', appId: cloneId });
  const proofOk = proof?.ok === true && proof.content === config.proofText;
  const ok = payload?.ok === true && proofOk
    && cloneStatus?.ok === true && cloneStatus.remote?.host === config.host
    && cloneStatus.status?.oid === committed.result.oid
    && cloneHistory?.commits?.some((entry) => entry?.oid === committed.result.oid) === true;
  return {
    ok, phase: ok ? 'complete' : 'clone-verify', credentialStored: true, handle,
    host: config.host, remoteLinked: true, branch: config.branch,
    committedOid: committed.result.oid, pushed: true, fetched: true,
    cleanClone: {
      ok,
      payload: {
        ok: payload?.ok === true, textOk: payload?.textOk === true,
        binaryOk: payload?.binaryOk === true, fileCount: payload?.fileCount ?? 0,
      },
      proofOk,
      oid: cloneStatus?.status?.oid ?? null,
      historyContainsCommit: cloneHistory?.commits?.some(
        (entry) => entry?.oid === committed.result.oid,
      ) === true,
    },
  };
};

const verifyRemoteAppGit = async (driver, handle, appId, config) => {
  await navigateMain(driver, handle, HOME_URL, 'home');
  const fetched = await call(driver, { type: 'apps/repository/fetch', appId });
  const status = await call(driver, { type: 'apps/repository/status', appId });
  const history = await call(driver, {
    type: 'apps/repository/history', appId, depth: 10,
  });
  await navigateMain(driver, handle, OPTIONS_URL, 'options');
  const credentialList = await call(driver, { type: 'git-cred/list' });
  const continuityOk = fetched?.ok === true && fetched.result?.remote?.host === config.host
    && status?.ok === true && status.remote?.host === config.host
    && status.status?.oid === config.committedOid
    && history?.commits?.some((entry) => entry?.oid === config.committedOid) === true
    && credentialList?.hosts?.filter((host) => host === config.host).length === 1;
  await navigateMain(driver, handle, HOME_URL, 'home');
  const appRemoved = await call(driver, { type: 'apps/delete', appId });
  await navigateMain(driver, handle, OPTIONS_URL, 'options');
  const credentialRemoved = await call(driver, { type: 'git-cred/delete', host: config.host });
  const afterList = await call(driver, { type: 'git-cred/list' });
  const cleanupOk = appRemoved?.ok === true && credentialRemoved?.ok === true
    && afterList?.ok === true && !afterList.hosts?.includes(config.host);
  return {
    ok: continuityOk && cleanupOk,
    phase: continuityOk && cleanupOk ? 'complete' : 'recycle-verify',
    host: config.host, fetched: fetched?.ok === true,
    oid: status?.status?.oid ?? null,
    historyContainsCommit: history?.commits?.some(
      (entry) => entry?.oid === config.committedOid,
    ) === true,
    credentialRetained: credentialList?.hosts?.includes(config.host) === true,
    cleanup: {
      appRemoved: appRemoved?.ok === true,
      credentialRemoved: credentialRemoved?.ok === true,
      credentialAbsent: afterList?.ok === true && !afterList.hosts?.includes(config.host),
    },
  };
};

const verifyAppGit = async (driver, appId, { cleanup = true } = {}) => {
  const payload = await verifyPayload(driver, appId);
  const status = await call(driver, { type: 'apps/repository/status', appId });
  const history = await call(driver, { type: 'apps/repository/history', appId, depth: 5 });
  const removed = cleanup ? await call(driver, { type: 'apps/delete', appId }) : { ok: true };
  return {
    ok: payload?.ok === true
      && status?.ok === true && typeof status.status?.oid === 'string'
      && status.status.oid.length > 0 && history?.ok === true
      && history.commits?.length >= 1 && removed?.ok === true,
    payload, status, history, removed,
  };
};

const digestHarness = async () => {
  const graph = [...await collectStaticModuleGraph(REPO_ROOT, ENTRY)];
  const inputs = [...new Set([
    ...graph,
    resolve(import.meta.dir, 'firefox-version.txt'),
    resolve(import.meta.dir, 'geckodriver-version.txt'),
  ])].sort();
  const hash = createHash('sha256');
  for (const path of inputs) {
    const data = readFileSync(path);
    hash.update(`input\0${relative(REPO_ROOT, path)}\0${data.byteLength}\0`);
    hash.update(data);
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), files: inputs.length };
};

const assert = (condition, message) => {
  if (!condition) throw new Error(`Firefox production acceptance invalid: ${message}`);
};
const exactKeys = (value, keys) => value != null && typeof value === 'object'
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const reportContainsCredentialMaterial = (value) => {
  if (typeof value === 'string') return /^(?:Basic|Bearer)\s/i.test(value);
  if (Array.isArray(value)) return value.some(reportContainsCredentialMaterial);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) =>
    ['token', 'authorization', 'headers', 'credentialValue', 'secret',
      'password', 'apiKey', 'bearer'].includes(key)
      || reportContainsCredentialMaterial(entry));
};
export const sanitizeFirefoxFailureEvidence = (evidence, credential) => {
  const sanitized = JSON.parse(redactGitFixtureCredential(JSON.stringify(evidence), credential));
  assertSecretlessGitReport(sanitized, credential);
  return sanitized;
};
const assertSurfaceCheckpoint = (surface, kind, pathname, target = null) => {
  assert(exactKeys(surface, [
    'kind', 'url', 'pathname', 'runtimeId', 'readyState',
    'ready', 'rootVisible', 'shell', 'target',
  ]) && surface.kind === kind && surface.url === `${FIREFOX_ORIGIN}${pathname}`
    && surface.pathname === pathname && surface.runtimeId === ADDON_ID
    && surface.readyState === 'complete' && surface.ready === true
    && surface.rootVisible === true && surface.shell === true
    && surface.target === target, `${kind} surface provenance`);
};

export const assertFirefoxProductionReport = (report) => {
  assert(report?.schema === 2 && report?.ok === true, 'schema/ok');
  assert(!reportContainsCredentialMaterial(report), 'credential material');
  assert(exactBudgetProfile(report?.budgets, FIREFOX_CUTOVER_HANG_CEILINGS),
    'budget profile');
  assert(report?.bindings?.channel === 'store' && report?.bindings?.browser === 'firefox',
    'target');
  for (const value of [
    report?.bindings?.artifact?.sha256,
    report?.bindings?.tree?.sha256,
    report?.bindings?.manifest?.sha256,
    report?.bindings?.harness?.sha256,
    report?.bindings?.runtimeIdentity?.binaries?.firefox?.sha256,
    report?.bindings?.runtimeIdentity?.binaries?.geckodriver?.sha256,
    report?.bindings?.gitFixture?.sha256,
    report?.bindings?.gitFixture?.certificateSha256,
    report?.bindings?.gitFixture?.protocolSha256,
  ]) assert(HEX_256.test(String(value ?? '')), 'digest binding');
  assert(report.bindings.gitFixture?.host === GIT_FIXTURE_HOST
    && report.bindings.gitFixture?.remote === GIT_FIXTURE_REMOTE, 'Git fixture identity');
  assertGitFixtureBinding(report.bindings.gitFixture);
  assert(report.bindings.manifest.backgroundEntry === FIREFOX_BACKGROUND_ENTRY,
    'production background entry');
  assert(report.bindings.manifest.appSandbox === true
    && report.bindings.manifest.firefoxMinVersion === '154.0', 'packaged App sandbox');
  assert(report.bindings.runtimeIdentity?.pinned === true
    && report.bindings.runtimeIdentity.expected.firefox
      === report.bindings.runtimeIdentity.actual.firefox
    && report.bindings.runtimeIdentity.expected.geckodriver
      === report.bindings.runtimeIdentity.actual.geckodriver, 'pinned runtime identity');
  assert(report.postRun.artifact.sha256 === report.bindings.artifact.sha256
    && report.postRun.artifact.bytes === report.bindings.artifact.bytes
    && report.postRun.tree.sha256 === report.bindings.tree.sha256
    && report.postRun.tree.bytes === report.bindings.tree.bytes
    && report.postRun.tree.files === report.bindings.tree.files, 'artifact mutation');
  assert(report.timings?.clock === 'host-monotonic-ms', 'clock');
  const ordered = [
    'ctaMs', 'submitMs', 'vaultCommitMs', 'panelReadyMs', 'controllerFirstMessageMs',
    'controllerWarmMessageMs', 'appGitReadyMs', 'remoteGitReadyMs',
    'controllerIdleStartedMs', 'controllerContinuityWakeStartedMs',
    'controllerAfterIdleMs', 'eventPageIdleStartedMs', 'recycleWakeStartedMs',
    'controllerAfterEventPageIdleMs', 'recycleReadyMs',
  ];
  let prior = -Infinity;
  for (const name of ordered) {
    const value = Number(report.timings?.[name]);
    assert(Number.isFinite(value) && value >= prior, `milestone order at ${name}`);
    prior = value;
  }
  assert(report.timings.ctaMs <= report.budgets.ctaMs, 'CTA hang ceiling');
  assert(report.timings.vaultCommitMs - report.timings.submitMs
    <= report.budgets.vaultCommitAfterSubmitMs, 'vault commit hang ceiling');
  assert(report.timings.panelReadyMs - report.timings.vaultCommitMs
    <= report.budgets.panelAfterVaultMs, 'panel hang ceiling');
  assert(report.timings.controllerFirstMessageMs - report.timings.panelReadyMs
    <= report.budgets.controllerMs, 'controller hang ceiling');
  assert(report.timings.controllerWarmMessageMs - report.timings.controllerFirstMessageMs
    <= report.budgets.controllerMs, 'warm controller hang ceiling');
  assert(report.timings.remoteGitReadyMs - report.timings.controllerWarmMessageMs
    <= report.budgets.repositoryMs, 'repository hang ceiling');
  assert(report.timings.controllerContinuityWakeStartedMs
    - report.timings.controllerIdleStartedMs >= CONTROLLER_IDLE_CONTINUITY_MS,
  'controller idle continuity boundary');
  assert(report.timings.controllerAfterIdleMs
    - report.timings.controllerContinuityWakeStartedMs <= report.budgets.controllerMs,
  'post-idle controller hang ceiling');
  assert(report.timings.recycleWakeStartedMs - report.timings.eventPageIdleStartedMs
    >= EVENT_PAGE_IDLE_MS, 'event-page idle boundary');
  assert(report.timings.controllerAfterEventPageIdleMs - report.timings.recycleWakeStartedMs
    <= report.budgets.controllerMs, 'post-recycle controller hang ceiling');
  assert(report.timings.recycleReadyMs - report.timings.recycleWakeStartedMs
    <= report.budgets.recycleAfterIdleMs, 'recycle hang ceiling');
  assertLiveKernelAssembly(report.observations.cutover, 'store-firefox');
  assert(report.observations.cta.actionable === true
    && report.observations.cta.rootVisible === true
    && report.observations.cta.formVisible === true
    && report.observations.cta.submitEnabled === true
    && report.observations.vault.initialized === true
    && report.observations.vault.locked === false, 'passphrase commit');
  assert(exactKeys(report.observations.surfaces, [
    'home', 'options', 'app', 'sidebar', 'sidebarRecovered',
  ]), 'surface report shape');
  assertSurfaceCheckpoint(report.observations.surfaces.home,
    'home', '/home/home.html');
  assertSurfaceCheckpoint(report.observations.surfaces.options,
    'options', '/options/options.html');
  assertSurfaceCheckpoint(report.observations.surfaces.app,
    'app', '/engine-tabs/app-tab/index.html', report.observations.appGit?.appId);
  assertSurfaceCheckpoint(report.observations.surfaces.sidebar,
    'sidebar', '/sidepanel/sidepanel.html');
  assertSurfaceCheckpoint(report.observations.surfaces.sidebarRecovered,
    'sidebar', '/sidepanel/sidepanel.html');
  assert(report.observations.finalUi.stage === 'app-ready'
    && report.observations.finalUi.rootVisible === true
    && report.observations.finalUi.rootTextLength > 0
    && report.observations.finalUi.failure === false, 'nonblank app terminal');
  const controllerTools = report.observations.controllerTools;
  const expectedToolCalls = [
    ['initial', 2], ['warm', 4], ['afterIdleContinuity', 6], ['afterEventPageIdle', 8],
  ];
  for (const [name, completionCalls] of expectedToolCalls) {
    const receipt = controllerTools?.[name];
    assert(exactKeys(receipt, [
      'ok', 'tool', 'primitive', 'inputKeys', 'outcomeKnown', 'iso', 'unixMs',
      'timezone', 'dayOfWeek', 'completionCalls', 'resultDigest',
    ]) && receipt.ok === true && receipt.tool === 'now' && receipt.primitive === 'time'
      && receipt.inputKeys === 0 && receipt.outcomeKnown === true
      && receipt.completionCalls === completionCalls
      && Number.isFinite(receipt.unixMs)
      && new Date(receipt.unixMs).toISOString().replace(/\.\d{3}Z$/, 'Z') === receipt.iso
      && typeof receipt.timezone === 'string' && receipt.timezone.length > 0
      && typeof receipt.dayOfWeek === 'string' && receipt.dayOfWeek.length > 0
      && HEX_256.test(receipt.resultDigest),
    `${name} now controller receipt`);
  }
  const modelWire = report.observations.modelWire;
  assert(Array.isArray(modelWire) && modelWire.length === 8, 'model wire proof count');
  for (const [index, [name, completionCalls]] of expectedToolCalls.entries()) {
    const issued = modelWire[index * 2];
    const returned = modelWire[index * 2 + 1];
    assert(exactKeys(issued, [
      'completionCall', 'toolCallIssued', 'toolCallIdDigest',
    ]) && issued.completionCall === completionCalls - 1 && issued.toolCallIssued === true
      && HEX_256.test(issued.toolCallIdDigest), `${name} model tool-call proof`);
    assert(exactKeys(returned, [
      'completionCall', 'toolResultAccepted', 'toolCallIdMatched', 'nowResultValid',
      'toolCallIdDigest', 'resultDigest',
    ]) && returned.completionCall === completionCalls
      && returned.toolResultAccepted === true && returned.toolCallIdMatched === true
      && returned.nowResultValid === true
      && returned.toolCallIdDigest === issued.toolCallIdDigest
      && returned.resultDigest === controllerTools[name].resultDigest,
    `${name} model tool-result proof`);
  }
  assert(report.observations.appGit?.ok === true
    && report.observations.appGit?.payload?.ok === true
    && exactKeys(report.observations.appGit?.isolation, [
      'ok', 'opaqueOrigin', 'browserAbsent', 'chromeAbsent', 'inlineExecuted',
      'fetchBlocked', 'webSocketBlocked', 'rtcSealed', 'dnrRuleInstalled', 'dnrTabScoped',
    ])
    && Object.values(report.observations.appGit.isolation).every((value) => value === true),
  'semantic/App Git');
  assert(report.observations.remoteGit?.ok === true
    && report.observations.remoteGit?.phase === 'complete'
    && report.observations.remoteGit?.credentialStored === true
    && report.observations.remoteGit?.remoteLinked === true
    && report.observations.remoteGit?.pushed === true
    && report.observations.remoteGit?.fetched === true
    && report.observations.remoteGit?.cleanClone?.ok === true
    && report.observations.remoteGit?.cleanClone?.payload?.textOk === true
    && report.observations.remoteGit?.cleanClone?.payload?.binaryOk === true
    && report.observations.remoteGit?.cleanClone?.proofOk === true,
  'remote App/isomorphic-git');
  assert(exactKeys(report.observations.remoteGit, [
    'ok', 'phase', 'credentialStored', 'host', 'remoteLinked', 'branch',
    'committedOid', 'pushed', 'fetched', 'cleanClone', 'remoteBranch',
  ]) && exactKeys(report.observations.remoteGit.cleanClone, [
    'ok', 'payload', 'proofOk', 'oid', 'historyContainsCommit',
  ]) && exactKeys(report.observations.remoteGit.cleanClone.payload, [
    'ok', 'textOk', 'binaryOk', 'fileCount',
  ]) && exactKeys(report.observations.remoteGit.remoteBranch, ['branch', 'oid', 'files'])
    && exactKeys(report.observations.remoteGit.remoteBranch.files, [
      'index.html', 'src/main.js', 'assets/raw.bin', REMOTE_GIT_PROOF_PATH,
    ]), 'remote Git report shape');
  assert(report.observations.remoteGitFixture?.bindingSha256
    === report.bindings.gitFixture.sha256, 'Git fixture binding');
  assert(Object.keys(report.observations.remoteGitFixture).sort().join(',')
    === ['bindingSha256', 'requests', 'schema', 'summary'].sort().join(','),
  'Git fixture report shape');
  assertGitFixtureSnapshot({
    schema: report.observations.remoteGitFixture.schema,
    requests: report.observations.remoteGitFixture.requests,
    summary: report.observations.remoteGitFixture.summary,
  });
  assert(report.observations.recycle?.newGeneration === true
    && report.observations.recycle?.controllerRecovered === true
    && report.observations.recycle?.controllerCompletionCalls === 8
    && report.observations.recycle?.appGitPersisted === true
    && report.observations.recycle?.appGitPersistence?.payload?.ok === true
    && report.observations.recycle?.remoteGitPersisted === true
    && report.observations.recycle?.remoteGitPersistence?.fetched === true
    && report.observations.recycle?.remoteGitPersistence?.credentialRetained === true
    && report.observations.recycle?.remoteGitPersistence?.cleanup?.appRemoved === true
    && report.observations.recycle?.remoteGitPersistence?.cleanup?.credentialRemoved === true
    && report.observations.recycle?.remoteGitPersistence?.cleanup?.credentialAbsent === true,
  'event-page continuity');
  assert(exactKeys(report.observations.recycle.remoteGitPersistence, [
    'ok', 'phase', 'host', 'fetched', 'oid', 'historyContainsCommit',
    'credentialRetained', 'cleanup',
  ]) && exactKeys(report.observations.recycle.remoteGitPersistence.cleanup, [
    'appRemoved', 'credentialRemoved', 'credentialAbsent',
  ]), 'remote Git recycle report shape');
  assert(report.observations.dweb?.error === 'dweb-disabled',
    `Firefox dweb posture: ${JSON.stringify(report.observations.dweb)}`);
  assert(typeof report.observations.screenshot?.path === 'string'
    && report.observations.screenshot.path.endsWith('.png')
    && HEX_256.test(String(report.observations.screenshot?.sha256 ?? '')),
  'screenshot binding');
  return report;
};

export async function runFirefoxProductionCutover({
  sourceRoot = REPO_ROOT,
  artifactRoot = ARTIFACTS_DIR,
  reportPath = join(artifactRoot, 'e2e', 'firefox-production-cutover.json'),
} = {}) {
  sourceRoot = resolve(sourceRoot);
  artifactRoot = resolve(artifactRoot);
  const firefox = firefoxBinary();
  const geckodriver = geckodriverBinary();
  if (!firefox || !existsSync(firefox) || !geckodriver || !existsSync(geckodriver)) {
    throw new Error('pinned Firefox/geckodriver unavailable; set FIREFOX_PATH and GECKODRIVER_PATH');
  }
  const version = String(JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')).version);
  const artifactPath = await packageArtifact({
    channel: 'store', browser: 'firefox', version, sign: false, verify: true,
    sourceRoot, artifactRoot,
  });
  const treePath = join(artifactRoot, 'staging', 'store-firefox');
  const manifestPath = join(treePath, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const backgroundEntry = manifest?.background?.scripts?.[0] ?? '';
  const harness = await digestHarness();
  const gitFixture = await startGitSmartHttpFixture();
  const bindings = {
    channel: 'store', browser: 'firefox', version,
    artifact: { sha256: await sha256File(artifactPath), bytes: statSync(artifactPath).size },
    tree: await digestTree(treePath),
    manifest: {
      sha256: await sha256File(manifestPath), backgroundEntry,
      appSandbox: manifest?.sandbox?.pages?.includes('engine-tabs/app-tab/runner.html') === true
        && typeof manifest?.content_security_policy?.sandbox === 'string',
      firefoxMinVersion: manifest?.browser_specific_settings?.gecko?.strict_min_version ?? null,
    },
    harness,
    gitFixture: gitFixture.binding(),
    runtimeIdentity: null,
  };
  let driver;
  let panel;
  let mainHandle;
  let fixture;
  try {
    if (backgroundEntry !== FIREFOX_BACKGROUND_ENTRY) {
      throw new Error(
        `production worker cutover mismatch: expected ${FIREFOX_BACKGROUND_ENTRY}, `
        + `packaged ${backgroundEntry || '(missing)'}`,
      );
    }
    if (bindings.manifest.appSandbox !== true
        || bindings.manifest.firefoxMinVersion !== '154.0') {
      throw new Error('Firefox packaged App sandbox posture is unavailable');
    }
    fixture = await startOllamaAcceptanceFixture({
      completionResponse: createNowCompletionResponder(),
    });
    const proxyUrl = new URL(gitFixture.proxyServer.url);
    const startedAt = hostNowMs();
    driver = await startGeckodriver({
      binary: geckodriver,
      firefoxBinary: firefox,
      acceptInsecureCerts: true,
      proxy: {
        proxyType: 'manual',
        sslProxy: `127.0.0.1:${proxyUrl.port}`,
        noProxy: ['127.0.0.1', 'localhost'],
      },
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: FIREFOX_UUID }),
        'app.update.auto': false,
        'app.update.enabled': false,
      },
    });
    bindings.runtimeIdentity = driver.runtimeIdentity;
    const installed = await driver.installAddon(artifactPath);
    if (installed !== ADDON_ID) throw new Error(`unexpected Firefox add-on id: ${installed}`);
    await driver.navigate(HOME_URL);
    mainHandle = await driver.windowHandle();
    const bootstrap = await call(driver, { type: 'bootstrap/ready' });
    const cutover = bootstrap?.assembly;
    if (bootstrap?.ok !== true) {
      throw new Error(`Firefox packaged kernel assembly is incomplete: ${JSON.stringify(bootstrap)}`);
    }
    assertLiveKernelAssembly(cutover, 'store-firefox');
    const actionable = await ensurePassphraseForm(driver);
    if (!actionable) throw new Error('Firefox passphrase CTA never became actionable');
    const ctaMs = hostNowMs() - startedAt;
    const submitMs = hostNowMs() - startedAt;
    await submitPassphrase(driver);
    if (!await skipProviderSetup(driver)) {
      throw new Error('Firefox provider setup did not become skippable');
    }
    const onboarding = await call(driver, {
      type: 'onboarding/complete', peerName: 'peerd', facts: null,
    });
    const settings = await call(driver, {
      type: 'settings/update',
      patch: { providerName: 'ollama', providerModel: 'qwen3:8b', ollamaHost: fixture.origin },
    });
    if (onboarding?.ok !== true || settings?.ok !== true) {
      throw new Error(`Firefox semantic setup failed: ${JSON.stringify({ onboarding, settings })}`);
    }
    const homeReady = await waitSurface(driver, 'home', null, 120_000);
    const state = await call(driver, { type: 'state/get' });
    if (state?.state?.vault?.initialized !== true || state.state.vault.locked !== false) {
      throw new Error(`Firefox vault did not commit: ${JSON.stringify(state)}`);
    }
    const vaultCommitMs = hostNowMs() - startedAt;
    panel = await openFirefoxSidebar(driver);
    const panelReady = await waitSurface(panel, 'sidebar');
    const panelReadyMs = hostNowMs() - startedAt;
    const initialNow = await runNowControllerTurn(
      panel, fixture, 'Firefox production controller now initial', 2,
    );
    const controllerFirstMessageMs = hostNowMs() - startedAt;
    const warmNow = await runNowControllerTurn(
      panel, fixture, 'Firefox production controller now warm', 4,
    );
    const controllerWarmMessageMs = hostNowMs() - startedAt;
    const appGitResult = await runAppGit(driver, panel, mainHandle);
    if (appGitResult?.ok !== true) {
      throw new Error(`Firefox App/Git failed: ${JSON.stringify(appGitResult)}`);
    }
    mainHandle = appGitResult.handle;
    const { surfaces: appSurfaces, handle: _appHandle, ...appGit } = appGitResult;
    const appGitReadyMs = hostNowMs() - startedAt;
    const gitCredential = gitFixture.credential();
    const remoteConfig = {
      host: GIT_FIXTURE_HOST,
      remote: GIT_FIXTURE_REMOTE,
      token: gitCredential.token,
      branch: 'acceptance/cutover',
      proofPath: REMOTE_GIT_PROOF_PATH,
      proofText: REMOTE_GIT_PROOF_TEXT,
    };
    const remoteGit = await runRemoteAppGit(
      driver, panel, mainHandle, appGit.appId, remoteConfig,
    );
    if (remoteGit?.ok !== true) {
      throw new Error(`Firefox remote App/Git failed: ${JSON.stringify(remoteGit)}`);
    }
    mainHandle = remoteGit.handle;
    delete remoteGit.handle;
    const remoteBranch = await gitFixture.verifyBranch(remoteConfig.branch, {
      'index.html': '<!doctype html><title>Cutover App</title><main>ready</main>',
      'src/main.js': 'document.querySelector("main").dataset.ready = "true";',
      'assets/raw.bin': Buffer.from([0, 1, 2, 127, 128, 255]),
      [REMOTE_GIT_PROOF_PATH]: REMOTE_GIT_PROOF_TEXT,
    });
    if (remoteBranch.oid !== remoteGit.committedOid) {
      throw new Error(`Firefox fixture branch OID mismatch: ${remoteBranch.oid} != ${remoteGit.committedOid}`);
    }
    const remoteGitReadyMs = hostNowMs() - startedAt;
    const controllerIdleStartedMs = hostNowMs() - startedAt;
    await sleep(CONTROLLER_IDLE_CONTINUITY_MS + 1_000);
    const controllerContinuityWakeStartedMs = hostNowMs() - startedAt;
    const afterIdleContinuityNow = await runNowControllerTurn(
      panel, fixture, 'Firefox production controller now after idle continuity', 6,
    );
    const controllerAfterIdleMs = hostNowMs() - startedAt;
    const before = kernelIdentityFromReply(await call(panel, { type: 'state/get' }));
    if (!before) throw new Error('Firefox kernel generation missing before discard');

    await closeFirefoxSidebar(driver);
    panel = null;
    await selectMainContent(driver, mainHandle);
    const extensionHandle = await driver.windowHandle();
    const survivor = await driver.newWindow('tab');
    await driver.switchToWindow(survivor.handle);
    await driver.navigate('about:blank');
    await driver.switchToWindow(extensionHandle);
    await driver.closeWindow();
    await driver.switchToWindow(survivor.handle);
    mainHandle = survivor.handle;
    const eventPageIdleStartedMs = hostNowMs() - startedAt;
    await sleep(EVENT_PAGE_IDLE_MS + 1_000);
    const recycleWakeStartedMs = hostNowMs() - startedAt;
    panel = await openFirefoxSidebar(driver);
    const afterReply = await waitFor(async () => {
      const reply = await call(panel, { type: 'state/get' });
      const identity = kernelIdentityFromReply(reply);
      return identity && identity.bootId !== before.bootId
        && identity.kernelEpoch !== before.kernelEpoch ? { reply, identity } : null;
    }, { budgetMs: 90_000, pollMs: 200 });
    if (!afterReply) throw new Error('Firefox event page did not claim a fresh generation');
    const sidebarRecovered = await waitSurface(panel, 'sidebar');
    const finalUi = await uiSnapshot(panel);
    const afterEventPageIdleNow = await runNowControllerTurn(
      panel, fixture, 'Firefox production controller now after event-page discard', 8,
    );
    const controllerAfterEventPageIdleMs = hostNowMs() - startedAt;
    const controllerRecovered = true;
    await navigateMain(driver, mainHandle, HOME_URL, 'home');
    const appGitPersisted = await verifyAppGit(driver, appGit.appId, { cleanup: false });
    const remoteGitPersisted = await verifyRemoteAppGit(driver, mainHandle, appGit.appId, {
      host: GIT_FIXTURE_HOST,
      committedOid: remoteGit.committedOid,
    });
    if (remoteGitPersisted?.ok !== true) {
      throw new Error(`Firefox remote App/Git did not survive recycle: ${JSON.stringify(remoteGitPersisted)}`);
    }
    const remoteGitFixture = gitFixture.snapshot();
    assertExactGitFixtureRequests(remoteGitFixture.summary);
    await navigateMain(driver, mainHandle, HOME_URL, 'home');
    const dweb = await call(driver, { type: 'dweb/base/status' });
    const recycleReadyMs = hostNowMs() - startedAt;
    const screenshotPath = join(dirname(reportPath), 'firefox-production-cutover.png');
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(screenshotPath, Buffer.from(await driver.screenshot(), 'base64'));
    const postRun = {
      artifact: { sha256: await sha256File(artifactPath), bytes: statSync(artifactPath).size },
      tree: await digestTree(treePath),
    };
    const report = {
      schema: 2, ok: true, bindings, postRun,
      budgets: FIREFOX_CUTOVER_HANG_CEILINGS,
      timings: {
        clock: 'host-monotonic-ms', ctaMs, submitMs, vaultCommitMs, panelReadyMs,
        controllerFirstMessageMs, controllerWarmMessageMs, appGitReadyMs, remoteGitReadyMs,
        controllerIdleStartedMs, controllerContinuityWakeStartedMs,
        controllerAfterIdleMs, eventPageIdleStartedMs,
        recycleWakeStartedMs, controllerAfterEventPageIdleMs, recycleReadyMs,
        completeMs: hostNowMs() - startedAt,
        controllerIdleContinuityMs: CONTROLLER_IDLE_CONTINUITY_MS,
        eventPageIdleMs: EVENT_PAGE_IDLE_MS,
      },
      observations: {
        cutover,
        cta: { actionable: true, kind: 'passphrase', ...actionable },
        vault: state.state.vault,
        surfaces: {
          home: homeReady, options: appSurfaces.options, app: appSurfaces.app,
          sidebar: panelReady, sidebarRecovered,
        },
        modelWire: fixture.completionProofs(),
        controllerTools: {
          initial: initialNow,
          warm: warmNow,
          afterIdleContinuity: afterIdleContinuityNow,
          afterEventPageIdle: afterEventPageIdleNow,
        },
        appGit,
        remoteGit: { ...remoteGit, remoteBranch },
        remoteGitFixture: {
          bindingSha256: bindings.gitFixture.sha256,
          ...remoteGitFixture,
        },
        recycle: {
          before, after: afterReply.identity, newGeneration: true,
          controllerRecovered, appGitPersisted: appGitPersisted.ok === true,
          controllerCompletionCalls: fixture.completionCalls(),
          appGitPersistence: appGitPersisted,
          remoteGitPersisted: remoteGitPersisted.ok === true,
          remoteGitPersistence: remoteGitPersisted,
        },
        dweb,
        finalUi,
        screenshot: { path: relative(sourceRoot, screenshotPath), sha256: await sha256File(screenshotPath) },
      },
    };
    assertSecretlessGitReport(report, gitCredential);
    assertFirefoxProductionReport(report);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    const terminal = panel ? await uiSnapshot(panel).catch(() => null) : null;
    const gitState = {
      snapshot: gitFixture.snapshot(),
      branch: await gitFixture.verifyBranch('acceptance/cutover', {
        [REMOTE_GIT_PROOF_PATH]: REMOTE_GIT_PROOF_TEXT,
      }).catch(() => null),
    };
    const consoleMessages = driver ? await (async () => {
      await driver.setContext('chrome');
      await driver.switchToFrame(null);
      return JSON.parse(await driver.execute(`
        const origin = arguments[0];
        const messages = Services.console.getMessageArray().flatMap((entry) => {
          const message = String(entry.message ?? entry.errorMessage ?? entry);
          const sourceName = typeof entry.sourceName === 'string' ? entry.sourceName : '';
          if (!sourceName.startsWith(origin)) return [];
          return [{
            message: message.slice(0, 2000),
            sourceName: sourceName.slice(0, 500) || null,
            lineNumber: Number.isInteger(entry.lineNumber) ? entry.lineNumber : null,
            category: typeof entry.category === 'string' ? entry.category.slice(0, 100) : null,
          }];
        });
        return JSON.stringify(messages.slice(-100));
      `, [FIREFOX_ORIGIN]));
    })().catch(() => null) : null;
    const postRun = await Promise.all([
      sha256File(artifactPath), digestTree(treePath),
    ]).then(([sha256, tree]) => ({ artifact: { sha256 }, tree })).catch(() => null);
    if (error && typeof error === 'object') {
      const failure = /** @type {Error & {firefoxProductionEvidence?:unknown}} */ (error);
      const credential = gitFixture.credential();
      if (typeof failure.message === 'string') {
        failure.message = redactGitFixtureCredential(failure.message, credential);
      }
      if (typeof failure.stack === 'string') {
        failure.stack = redactGitFixtureCredential(failure.stack, credential);
      }
      failure.firefoxProductionEvidence = sanitizeFirefoxFailureEvidence(
        { bindings, postRun, terminal, consoleMessages, gitState }, credential,
      );
    }
    throw error;
  } finally {
    await driver?.close();
    await fixture?.close().catch(() => {});
    await gitFixture.close().catch(() => {});
  }
}

if (import.meta.main) {
  const artifactRoot = process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT
    ? resolve(process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT) : ARTIFACTS_DIR;
  const reportPath = process.env.PEERD_ACCEPTANCE_REPORT_PATH
    ? resolve(process.env.PEERD_ACCEPTANCE_REPORT_PATH)
    : join(artifactRoot, 'e2e', 'firefox-production-cutover.json');
  try {
    console.log(JSON.stringify(await runFirefoxProductionCutover({
      sourceRoot: process.env.PEERD_ACCEPTANCE_SOURCE_ROOT
        ? resolve(process.env.PEERD_ACCEPTANCE_SOURCE_ROOT) : REPO_ROOT,
      artifactRoot,
      reportPath,
    }), null, 2));
  } catch (error) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(join(dirname(reportPath), 'firefox-production-cutover-failure.json'),
      `${JSON.stringify({
        schema: 2, ok: false, error: error?.stack || String(error),
        evidence: error?.firefoxProductionEvidence ?? null,
      }, null, 2)}\n`);
    throw error;
  }
}
