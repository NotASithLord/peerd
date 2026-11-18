// @ts-check
// why: the trusted host binds one catalog entry and signed tree before it opens game code.
import { createAppRegistry, parseAppRequest, validateAppHttpRoutes } from '/peerd-engine/index.js';
import { idb } from '/peerd-egress/index.js';
import { loadDweb } from '/shared/dweb-loader.js';
import { gameCsp, gameStartScript, passesToNetwork } from './game-network.js';

const title = /** @type {HTMLElement} */ (document.getElementById('title'));
const status = /** @type {HTMLElement} */ (document.getElementById('status'));
const closeButton = /** @type {HTMLButtonElement} */ (document.getElementById('close'));
const binding = location.hash;
const match = /^#(app-[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?)\/([a-f0-9]{64})$/.exec(binding);
const abort = new AbortController();
/** @type {number | null} */ let gameTabId = null;
let attached = false, closed = false;
let requests = Promise.resolve();

const registry = createAppRegistry({ storage: {
  get: async key => (await idb.get('apps', key))?.value,
  set: async () => { throw new Error('Game host catalog is read-only'); },
} });

/** @param {string} message */
const closeGame = async (message = 'Game closed.') => {
  if (closed) return;
  closed = true;
  abort.abort();
  title.textContent = 'Game closed';
  status.textContent = message;
  closeButton.disabled = true;
  const tabId = gameTabId;
  gameTabId = null;
  // why: remove the game before detach so no request can fall through to the network.
  if (tabId !== null) {
    try { await chrome.tabs.remove(tabId); } catch {}
    if (attached) try { await chrome.debugger.detach({ tabId }); } catch {}
  }
  chrome.debugger?.onEvent.removeListener(onEvent);
  chrome.debugger?.onDetach.removeListener(onDetach);
  chrome.tabs.onRemoved.removeListener(onRemoved);
};

/** @param {chrome.debugger.Debuggee} source @param {string} reason */
const onDetach = (source, reason) => {
  if (source.tabId === gameTabId) void closeGame(`Game connection closed: ${reason}`);
};
/** @param {number} tabId */
const onRemoved = tabId => { if (tabId === gameTabId) void closeGame(); };

/** @typedef {{requestId:string,resourceType:string,request:{url:string,method:string,headers:Record<string,string>}}} PausedRequest */
/** @type {((source:chrome.debugger.Debuggee,request:PausedRequest)=>Promise<void>) | null} */
let serve = null;
/** @type {((request:PausedRequest)=>boolean) | null} */
let passes = null;
/** @param {chrome.debugger.Debuggee} source @param {string} method @param {object | undefined} parameters */
const onEvent = (source, method, parameters) => {
  if (source.tabId !== gameTabId || method !== 'Fetch.requestPaused') return;
  const request = /** @type {PausedRequest} */ (parameters);
  // why: a network call must not wait behind file reads, and a call that the page aborted must not close the game.
  if (!closed && serve && location.hash === binding && passes?.(request)) {
    chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: request.requestId }).catch(() => {});
    return;
  }
  // why: serial reads bound retained response bytes when a game starts many workers.
  requests = requests.then(async () => {
    try {
      if (closed || !serve || location.hash !== binding) throw new Error('Game binding closed');
      await serve(source, request);
    } catch (error) {
      try { await chrome.debugger.sendCommand(source, 'Fetch.failRequest', {
        requestId: request.requestId, errorReason: 'BlockedByClient',
      }); } catch {}
      if (!closed) void closeGame(`Game stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
};

closeButton.addEventListener('click', () => { void closeGame(); });
addEventListener('hashchange', () => { void closeGame('Game binding changed.'); });
addEventListener('pagehide', () => { void closeGame(); });

const openGame = async () => {
  if (!match) throw new Error('Game address invalid');
  if (!chrome.debugger) throw new Error('This browser does not support the game host');
  const [, appId, hash] = match;
  const record = await registry.get(appId);
  if (!record || record.id !== appId || record.fileTree?.hash !== hash) throw new Error('Installed game binding not found');
  const client = await loadDweb();
  if (!client.loadFileTreeRecord) throw new Error('File tree support unavailable');
  const tree = await client.loadFileTreeRecord(hash);
  if (tree.hash !== hash || tree.storageKey !== record.fileTree.storageKey) throw new Error('Installed game tree changed');
  const index = { ...tree.index, httpRoutes: validateAppHttpRoutes(undefined) };
  const descriptor = index.files.find((/** @type {{path:string,size:number}} */ file) => file.path === 'peerd-host.json');
  if (descriptor) {
    if (descriptor.size > 32_768) throw new Error('Game host descriptor too large');
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      await tree.read(descriptor.path, 0, descriptor.size, { signal: abort.signal })));
    if (!config || config.v !== 1 || Object.keys(config).some(key => !['v', 'httpRoutes'].includes(key))) throw new Error('Game host descriptor invalid');
    index.httpRoutes = validateAppHttpRoutes(config.httpRoutes);
  }
  const origin = `https://${appId}.localhost`;
  // why: the user sets this in the Library. The signed game files cannot set it.
  const networkAllowed = record.networkAllowed === true;
  const csp = gameCsp(networkAllowed);
  passes = request => passesToNetwork({ url: request.request.url, resourceType: request.resourceType, origin, networkAllowed });
  serve = async (source, request) => {
    const range = Object.entries(request.request.headers).find(([name]) => name.toLowerCase() === 'range')?.[1] ?? null;
    const response = parseAppRequest({ url: request.request.url, origin, index, method: request.request.method, range });
    let body = '';
    if (!response.head && response.path !== null) {
      const bytes = new Uint8Array(response.length);
      for (let offset = 0; offset < bytes.length; offset += 8_388_608) {
        abort.signal.throwIfAborted();
        const length = Math.min(8_388_608, bytes.length - offset);
        const chunk = await tree.read(response.path, response.offset + offset, length, { signal: abort.signal });
        if (chunk.byteLength !== length) throw new Error('Game file read incomplete');
        bytes.set(chunk, offset);
      }
      // why: bounded codec slices avoid the function argument limit for large WASM files.
      for (let offset = 0; offset < bytes.length; offset += 65_536) body += String.fromCharCode(...bytes.subarray(offset, offset + 65_536));
      body = btoa(body);
    }
    abort.signal.throwIfAborted();
    await chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
      requestId: request.requestId, responseCode: response.status, body,
      responseHeaders: [...response.headers, { name: 'Content-Security-Policy', value: csp },
        { name: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=()' }],
    });
  };
  if (closed || location.hash !== binding) throw new Error('Game binding closed');
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  chrome.tabs.onRemoved.addListener(onRemoved);
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (tab.id === undefined) throw new Error('Game tab unavailable');
  gameTabId = tab.id;
  if (closed) { await chrome.tabs.remove(tab.id); return; }
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  attached = true;
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  });
  // why: an App-owned saved service worker must not replace the verified host response.
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable');
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.setBypassServiceWorker', { bypass: true });
  // why: this session does not see the requests of a shared worker, and the page policy does not stop WebRTC.
  // The start script removes SharedWorker, and WebRTC when the switch is off, before game code runs.
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.addScriptToEvaluateOnNewDocument', { source: gameStartScript(networkAllowed) });
  abort.signal.throwIfAborted();
  const entry = index.entry.split('/').map(encodeURIComponent).join('/');
  await chrome.tabs.update(tab.id, { url: `${origin}/${entry}` });
  title.textContent = record.name;
  status.textContent = `The game is open in its own tab. Keep this page open while you play. Internet access: ${networkAllowed ? 'on' : 'off'}.`;
};

void openGame().catch(error => closeGame(`Cannot open game: ${error instanceof Error ? error.message : String(error)}`));
