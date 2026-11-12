import { describe, test, expect } from 'bun:test';
import {
  APP_FILE_MISSING_EVENT, APP_FILES_HANDOFF, APP_MODULE_FAILED_EVENT, composeApp, stripMetaRefresh,
} from '../../extension/peerd-engine/app-compose.js';

const FILE_SERVER_RE = /^<script data-peerd-file-server>[\s\S]*?<\/script>/;
// The App markup after the file server that composeApp always puts first.
const appMarkup = (html: string) => html.replace(FILE_SERVER_RE, '');

describe('composeApp', () => {
  test('returns entry unchanged if no relative refs', () => {
    const files = { 'index.html': '<p>hello</p>' };
    expect(appMarkup(composeApp(files))).toBe('<p>hello</p>');
  });

  test('inlines <link rel="stylesheet" href="./style.css">', () => {
    const files = {
      'index.html': `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body></body></html>`,
      'style.css': 'body { color: red; }',
    };
    const out = composeApp(files);
    expect(out).not.toContain('href="./style.css"');
    expect(out).toContain('<style');
    expect(out).toContain('body { color: red; }');
  });

  test('inlines <script src="./script.js"></script> preserving type=module', () => {
    const files = {
      'index.html': `<script type="module" src="./app.js"></script>`,
      'app.js': 'console.log("hi");',
    };
    const out = composeApp(files);
    expect(out).not.toContain('src="./app.js"');
    expect(out).toContain('type="module"');
    expect(out).toContain('console.log("hi")');
  });

  // Regression: a BARE relative href/src (no './') must inline just like a
  // dot-relative one. Demanding './' was a footgun — the agent naturally
  // writes href="style.css", and the bare <link> was silently dropped,
  // leaving an unresolvable href in the opaque-origin sandbox.
  test('inlines a BARE <link rel="stylesheet" href="style.css">', () => {
    const files = {
      'index.html': `<head><link rel="stylesheet" href="style.css"></head>`,
      'style.css': 'body { color: red; }',
    };
    const out = composeApp(files);
    expect(out).not.toContain('href="style.css"');
    expect(out).toContain('<style');
    expect(out).toContain('body { color: red; }');
  });

  test('inlines an unquoted <script src=game.js async></script>', () => {
    const files = {
      'index.html': '<body><script src=game.js async></script><script src=https://cdn.example/x.js></script></body>',
      'game.js': 'globalThis.game = 1;',
    };
    const out = composeApp(files);
    expect(out).toContain('<script async data-from="game.js">globalThis.game = 1;</script>');
    expect(out).not.toContain('src=game.js');
    expect(out).toContain('<script src=https://cdn.example/x.js></script>');
  });

  // GameMaker and other exports add a cache-busting query to a file they ship.
  test('inlines a script and a style named with a ?query or a #hash', () => {
    const files = {
      'index.html': '<link rel="stylesheet" href="css/game.css?v=7"><script src="html5game/game.js?cachebust=1995823255"></script>'
        + '<script src="./boot.js#top"></script><script src="missing.js?v=1"></script>',
      'css/game.css': 'canvas { width: 100%; }',
      'html5game/game.js': 'globalThis.game = 1;',
      'boot.js': 'globalThis.boot = 1;',
    };
    expect(appMarkup(composeApp(files))).toBe('<style data-from="css/game.css">canvas { width: 100%; }</style>'
      + '<script data-from="html5game/game.js">globalThis.game = 1;</script>'
      + '<script data-from="boot.js">globalThis.boot = 1;</script><script src="missing.js?v=1"></script>');
    expect(() => composeApp({ 'index.html': '<script src="data/save.json?v=1"></script>', 'data/save.json': '1' }))
      .toThrow('app runtime data cannot be a composed source: data/save.json');
  });

  // An App file can have ? or # in its own name. The exact name comes first.
  test('inlines a file with ? or # in its name, and cuts a query with a line break or in an unquoted src', () => {
    const files = {
      'index.html': '<script src="lib/c#.js"></script><script src="what?.js"></script><script src="game.js?a\nb"></script>'
        + '<script src=game.js?v=1&x=2 defer></script><link rel="stylesheet" href="a#b.css"><script src="game.js?x/../what?.js"></script>',
      'lib/c#.js': 'globalThis.sharp = 1;',
      'what?.js': 'globalThis.what = 1;',
      'game.js': 'globalThis.game = 1;',
      'a#b.css': 'b { color: red; }',
    };
    expect(appMarkup(composeApp(files))).toBe('<script data-from="lib/c#.js">globalThis.sharp = 1;</script>'
      + '<script data-from="what?.js">globalThis.what = 1;</script>'
      + '<script data-from="game.js">globalThis.game = 1;</script>'
      + '<script defer data-from="game.js">globalThis.game = 1;</script><style data-from="a#b.css">b { color: red; }</style><script data-from="game.js">globalThis.game = 1;</script>');
  });

  test('inlines a BARE <script src="script.js"></script>', () => {
    const files = {
      'index.html': `<body><script src="script.js"></script></body>`,
      'script.js': 'console.log("bare");',
    };
    const out = composeApp(files);
    expect(out).not.toContain('src="script.js"');
    expect(out).toContain('console.log("bare")');
  });

  test('inlines bare nested paths (styles/main.css)', () => {
    const files = {
      'index.html': '<link rel="stylesheet" href="styles/main.css">',
      'styles/main.css': '/* nested */',
    };
    const out = composeApp(files);
    expect(out).toContain('/* nested */');
    expect(out).not.toContain('href="styles/main.css"');
  });

  test('inlines siblings of a nested entry file', () => {
    const files = {
      'pages/about.html': '<link rel="stylesheet" href="about.css">',
      'pages/about.css': '.about{}',
    };
    const out = composeApp(files, 'pages/about.html');
    expect(out).toContain('.about{}');
    expect(out).not.toContain('href="about.css"');
  });

  test('leaves protocol-relative, data:, and fragment refs alone', () => {
    const files = {
      'index.html': [
        '<link rel="stylesheet" href="//cdn.example/x.css">',
        '<link rel="stylesheet" href="data:text/css,body{}">',
        '<a href="#section">jump</a>',
      ].join('\n'),
    };
    const out = composeApp(files);
    expect(out).toContain('//cdn.example/x.css');
    expect(out).toContain('data:text/css,body{}');
    expect(out).toContain('href="#section"');
    expect(out).not.toContain('<style');
  });

  test('skips refs that point at files not in the bundle', () => {
    const files = {
      'index.html': '<link rel="stylesheet" href="./missing.css">',
    };
    const out = composeApp(files);
    expect(appMarkup(out)).toBe('<link rel="stylesheet" href="./missing.css">');
  });

  test('leaves absolute / CDN URLs alone', () => {
    const files = {
      'index.html': '<link rel="stylesheet" href="https://cdn.example/x.css">',
    };
    expect(composeApp(files)).toContain('https://cdn.example/x.css');
  });

  test('throws on missing entry file', () => {
    expect(() => composeApp({})).toThrow('app entry not found');
  });

  test('handles multiple inlines in order', () => {
    const files = {
      'index.html': `
        <link rel="stylesheet" href="./a.css">
        <link rel="stylesheet" href="./b.css">
        <script src="./c.js"></script>
      `,
      'a.css': '.a{}',
      'b.css': '.b{}',
      'c.js':  'const c=1;',
    };
    const out = composeApp(files);
    expect(out).toContain('.a{}');
    expect(out).toContain('.b{}');
    expect(out).toContain('const c=1;');
    expect(out).not.toContain('./a.css');
    expect(out).not.toContain('./b.css');
    expect(out).not.toContain('./c.js');
  });

  test('handles nested paths', () => {
    const files = {
      'index.html': '<link rel="stylesheet" href="./styles/main.css">',
      'styles/main.css': '/* main */',
    };
    const out = composeApp(files);
    expect(out).toContain('/* main */');
    expect(out).not.toContain('./styles/main.css');
  });

  // why: the file server starts workers from blob: URLs at runtime, so no
  // worker source needs to enter the document as markup.
  test('leaves worker sources out of the composed document', () => {
    const files = {
      'index.html': '<head></head><body><script>new Worker("w.js")</script></body>',
      'w.js': 'const s = "</script><script>steal()</script>";',
    };
    const out = composeApp(files);
    expect(out).not.toContain('steal()');
    expect(out).not.toContain('data-peerd-worker-shim');
  });

  test('runtime data cannot become an entry, script, or style source', () => {
    const payload = JSON.stringify('</script><script>globalThis.pwned=1</script>');
    for (const html of [
      '<script src="data/state.json"></script>',
      '<link rel="stylesheet" href="data/state.json">',
    ]) {
      expect(() => composeApp({ 'index.html': html, 'data/state.json': payload }))
        .toThrow('app runtime data cannot be a composed source');
    }
    expect(() => composeApp({ 'data/state.json': payload }, 'data/state.json'))
      .toThrow('app runtime data cannot be a composed source');
  });

  test('runtime-data source refusal uses the resolved case-insensitive path', () => {
    for (const html of [
      '<script src="../DATA/State.JSON"></script>',
      '<link rel="stylesheet" href="../DATA/State.JSON">',
    ]) {
      expect(() => composeApp({
        'pages/index.html': html, 'DATA/State.JSON': '{}',
      }, 'pages/index.html')).toThrow('app runtime data cannot be a composed source');
    }
  });

  test('unreferenced runtime data does not prevent composing ordinary App code', () => {
    const html = '<h1>App</h1><script src="main.js"></script>';
    const files = { 'index.html': html, 'main.js': 'globalThis.ready=true;' };
    expect(composeApp({ ...files, 'data/state.json': '{"count":1}' }))
      .toBe(composeApp(files));
  });
});

// A stand-in for the browser XMLHttpRequest. Bun has none. It records the
// calls that reach it and runs on<type> handlers the way the browser does.
class NativeRequest extends EventTarget {
  calls: unknown[][] = [];
  onreadystatechange: ((event: Event) => void) | null = null;
  onloadstart: ((event: Event) => void) | null = null;
  onprogress: ((event: Event) => void) | null = null;
  onload: ((event: Event) => void) | null = null;
  onloadend: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  responseType: XMLHttpRequestResponseType = '';
  get readyState() { return -1; }
  get status() { return -1; }
  get statusText() { return 'native'; }
  get response(): unknown { return 'native'; }
  get responseText() { return 'native'; }
  get responseURL() { return 'native'; }
  get responseXML() { return null; }
  open(...args: unknown[]) { this.calls.push(['open', ...args]); }
  send(...args: unknown[]) { this.calls.push(['send', ...args]); }
  abort() { this.calls.push(['abort']); }
  setRequestHeader(...args: unknown[]) { this.calls.push(['setRequestHeader', ...args]); }
  getResponseHeader(name: string): string | null { return `native:${name}`; }
  getAllResponseHeaders() { return 'native'; }
  override dispatchEvent(event: Event) {
    const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`];
    const result = super.dispatchEvent(event);
    if (typeof handler === 'function') handler.call(this, event);
    return result;
  }
}

class ProgressStandIn extends Event {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
  constructor(type: string, init: ProgressEventInit = {}) {
    super(type);
    this.lengthComputable = init.lengthComputable ?? false;
    this.loaded = init.loaded ?? 0;
    this.total = init.total ?? 0;
  }
}

const RUNNER_URL = 'chrome-extension://peerdtest/engine-tabs/app-tab/runner.html#4';
const bytesOf = (value: string | number[]) => (
  typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)).buffer;

// Run the exact script that composeApp writes into the App document against a
// stand-in Window, the same way the runner's document.write runs it. The DOM
// classes are made per call, because the file server patches their prototypes.
const installFileServer = (files: Record<string, string | number[]>, entry = 'index.html') => {
  const html = composeApp({ [entry]: '<!doctype html><title>Game</title>' }, entry);
  const script = /<script data-peerd-file-server>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const nativeCalls: unknown[][] = [];
  const nativeFetch = (...args: unknown[]) => {
    nativeCalls.push(args);
    return Promise.reject(new TypeError('Failed to fetch'));
  };
  const events: string[] = [];
  const blobs = new Map<string, Blob>();
  const revoked = new Set<string>();
  class URLStandIn extends URL {
    static override createObjectURL(blob: Blob) {
      const url = `blob:chrome-extension://peerdtest/${blobs.size}`;
      blobs.set(url, blob);
      return url;
    }
    static override revokeObjectURL(url: string) { revoked.add(url); }
  }
  class ElementStandIn {
    attributes: Record<string, unknown> = {};
    setAttribute(name: string, value: unknown) { this.attributes[name] = value; }
  }
  class ScriptStandIn extends ElementStandIn {
    #src: unknown = '';
    get src() { return this.#src; }
    set src(value: unknown) { this.#src = value; }
  }
  class WorkerStandIn extends EventTarget {
    constructor(readonly url: unknown, readonly options?: unknown) { super(); }
  }
  class WorkletStandIn {
    calls: unknown[][] = [];
    addModule(...args: unknown[]) {
      this.calls.push(args);
      return Promise.resolve();
    }
  }
  class AudioWorkletStandIn extends WorkletStandIn {}
  class StorageStandIn {}
  const nativeIndexedDb = { open: () => { throw new DOMException('denied', 'SecurityError'); } };
  const realStorageReads: string[] = [];
  const scope: Record<string, unknown> = {
    Storage: StorageStandIn,
    indexedDB: nativeIndexedDb,
    location: { href: RUNNER_URL },
    fetch: nativeFetch,
    XMLHttpRequest: NativeRequest,
    ProgressEvent: ProgressStandIn,
    Blob, DOMException, Event, Request, Response, TextDecoder, URL: URLStandIn,
    dispatchEvent: (event: Event) => events.push(event.type) > 0,
    Element: ElementStandIn,
    HTMLScriptElement: ScriptStandIn,
    Worker: WorkerStandIn,
    AudioWorklet: AudioWorkletStandIn,
    [APP_FILES_HANDOFF]: Object.fromEntries(Object.entries(files).map(([path, value]) => [path, bytesOf(value)])),
  };
  // In the opaque App frame, a read of each of these properties throws.
  for (const name of ['localStorage', 'sessionStorage', 'caches']) {
    Object.defineProperty(scope, name, {
      configurable: true,
      enumerable: true,
      get() {
        realStorageReads.push(name);
        throw new DOMException('The document is sandboxed.', 'SecurityError');
      },
    });
  }
  // eslint-disable-next-line no-new-func
  new Function('self', script)(scope);
  const fetch = scope.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  const XHR = scope.XMLHttpRequest as typeof NativeRequest;
  const Script = scope.HTMLScriptElement as typeof ScriptStandIn;
  const AppWorker = scope.Worker as typeof WorkerStandIn;
  return {
    html, script, scope, fetch, XHR, nativeFetch, nativeCalls, events, blobs, revoked,
    Script, AppWorker, NativeWorker: WorkerStandIn, AudioWorklet: AudioWorkletStandIn, Worklet: WorkletStandIn,
    Storage: StorageStandIn, nativeIndexedDb, realStorageReads,
  };
};

const settle = (request: EventTarget) => new Promise((resolve) => {
  request.addEventListener('loadend', resolve, { once: true });
});

describe('App file server', () => {
  test('runs before any App script and keeps a compact doctype in standards mode', () => {
    const html = composeApp({
      'index.html': '<!doctypehtml><html lang=en><head><script>globalThis.first = 1;</script></head></html>',
    });
    expect(html.startsWith('<!doctypehtml><script data-peerd-file-server>')).toBe(true);
    expect(html.indexOf('data-peerd-file-server')).toBeLessThan(html.indexOf('globalThis.first'));
    const headless = composeApp({ 'index.html': '<!-- a --><!DOCTYPE html><title>T</title>' });
    expect(headless.startsWith('<!-- a --><!DOCTYPE html><script data-peerd-file-server>')).toBe(true);
  });

  test('the injected script cannot end early and never talks to the parent', () => {
    const { script } = installFileServer({}, 'pages/<\/script>.html');
    expect(script).not.toContain('</');
    expect(script).not.toContain('postMessage');
    expect(script).toContain('"pages/\\u003c/script>.html"');
  });

  test('takes the runner handoff and removes it before App code can see it', async () => {
    const { scope } = installFileServer({ 'x.wasm': [0, 97, 115, 109] });
    expect(APP_FILES_HANDOFF in scope).toBe(false);
    const runner = await Bun.file('./extension/engine-tabs/app-tab/runner.html').text();
    expect(runner).toContain(`Object.defineProperty(window, '${APP_FILES_HANDOFF}'`);
    expect(runner).toContain(`delete window.${APP_FILES_HANDOFF};`);
    expect(runner).toContain(`window.addEventListener('${APP_FILE_MISSING_EVENT}'`);
    expect(runner).toContain(`window.addEventListener('${APP_MODULE_FAILED_EVENT}'`);
  });

  test('fetch serves App files by relative, absolute, Request, and query URLs', async () => {
    const wasm = [0, 97, 115, 109, 1, 0, 0, 0];
    const original = [0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62];
    const { fetch, nativeCalls } = installFileServer({ 'x.wasm': wasm, 'assets/level.json': '{"level":1}', 'game.js': original });
    for (const input of [
      'x.wasm', './x.wasm', '/x.wasm', 'x.wasm?v=3#top',
      'chrome-extension://peerdtest/engine-tabs/app-tab/x.wasm',
      new URL('chrome-extension://peerdtest/engine-tabs/app-tab/x.wasm'),
      new Request('chrome-extension://peerdtest/engine-tabs/app-tab/x.wasm'),
    ]) {
      const response = await fetch(input);
      expect(response.status).toBe(200);
      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toBe('application/wasm');
      expect(response.headers.get('content-length')).toBe(String(wasm.length));
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(wasm);
    }
    const json = await fetch('assets/level.json');
    expect(json.headers.get('content-type')).toBe('application/json');
    expect(await json.json()).toEqual({ level: 1 });
    const script = await fetch('game.js');
    expect(script.headers.get('content-type')).toBe('text/javascript');
    expect([...new Uint8Array(await script.arrayBuffer())]).toEqual(original);
    expect(nativeCalls).toEqual([]);
  });

  test('a path at the extension origin that is not an App file gets a 404, never the native fetch', async () => {
    const { fetch, nativeCalls } = installFileServer({ 'x.wasm': [0] });
    for (const input of [
      '/manifest.json', '../../background/vault-kernel.js', 'runner.html', 'missing.data',
      'chrome-extension://peerdtest/background/vault-kernel.js', '%E0%A4%A.wasm',
    ]) {
      const response = await fetch(input);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
    expect(nativeCalls).toEqual([]);
  });

  test('every other URL reaches the native fetch with the same arguments', async () => {
    const { fetch, nativeCalls } = installFileServer({ 'x.wasm': [0] });
    const init = { method: 'POST', body: 'probe' };
    for (const input of [
      'https://evil.example/x.wasm', 'blob:chrome-extension://peerdtest/1', 'data:text/plain,x',
      'chrome-extension://another/x.wasm',
    ]) {
      await expect(fetch(input, init)).rejects.toThrow('Failed to fetch');
    }
    expect(nativeCalls).toEqual([
      ['https://evil.example/x.wasm', init], ['blob:chrome-extension://peerdtest/1', init],
      ['data:text/plain,x', init], ['chrome-extension://another/x.wasm', init],
    ]);
  });

  test('a nested entry resolves sibling files first, then App-root files', async () => {
    const { fetch } = installFileServer({ 'game/x.data': 'nested', 'x.data': 'root', 'shared.data': 'shared' }, 'game/index.html');
    expect(await (await fetch('x.data')).text()).toBe('nested');
    expect(await (await fetch('shared.data')).text()).toBe('shared');
    expect(await (await fetch('/x.data')).text()).toBe('root');
  });

  test('XMLHttpRequest arraybuffer follows the event order Emscripten loaders read', async () => {
    const data = [1, 2, 3, 4, 5];
    const { XHR, nativeCalls } = installFileServer({ 'x.data': data });
    const request = new XHR();
    const events: string[] = [];
    request.onreadystatechange = () => events.push(`state:${request.readyState}`);
    request.onloadstart = () => events.push('loadstart');
    request.onprogress = (event) => {
      const progress = event as ProgressEvent;
      events.push(`progress:${progress.loaded}/${progress.total}:${progress.lengthComputable}`);
    };
    request.onload = () => events.push(`load:${request.status}`);
    request.onloadend = () => events.push('loadend');
    request.open('GET', 'x.data', true);
    request.responseType = 'arraybuffer';
    request.send(null);
    expect(request.readyState).toBe(1);
    await settle(request);
    expect(events).toEqual([
      'state:1', 'loadstart', 'state:2', 'state:3', 'progress:5/5:true', 'state:4', 'load:200', 'loadend',
    ]);
    expect(request.status).toBe(200);
    expect(request.statusText).toBe('OK');
    expect(request.responseURL).toBe('chrome-extension://peerdtest/engine-tabs/app-tab/x.data');
    expect(request.getResponseHeader('Content-Length')).toBe('5');
    expect(request.getResponseHeader('content-type')).toBe('application/octet-stream');
    expect(request.getAllResponseHeaders()).toBe('content-length: 5\r\ncontent-type: application/octet-stream\r\n');
    const response = request.response as ArrayBuffer;
    expect([...new Uint8Array(response)]).toEqual(data);
    expect(request.response).toBe(response);
    new Uint8Array(response)[0] = 9;
    const again = new XHR();
    again.open('GET', 'x.data');
    again.responseType = 'arraybuffer';
    again.send();
    await settle(again);
    expect([...new Uint8Array(again.response as ArrayBuffer)]).toEqual(data);
    expect(nativeCalls).toEqual([]);
  });

  test('XMLHttpRequest supports text, json, and blob, and answers a missing file with 404', async () => {
    const { XHR } = installFileServer({ 'level.json': '{"level":2}' });
    const read = async (type: XMLHttpRequestResponseType, path = 'level.json') => {
      const request = new XHR();
      request.open('GET', path);
      request.responseType = type;
      request.send();
      await settle(request);
      return request;
    };
    expect((await read('')).responseText).toBe('{"level":2}');
    expect((await read('text')).response).toBe('{"level":2}');
    expect((await read('json')).response).toEqual({ level: 2 });
    const blob = (await read('blob')).response as Blob;
    expect(blob.type).toStartWith('application/json');
    expect(await blob.text()).toBe('{"level":2}');
    const binary = await read('arraybuffer');
    expect(() => binary.responseText).toThrow('invalid state');
    const missing = await read('arraybuffer', '/manifest.json');
    expect(missing.status).toBe(404);
    expect(missing.response).toBe(null);
    expect(missing.getResponseHeader('content-type')).toBe(null);
  });

  test('XMLHttpRequest for any other URL stays the native request', () => {
    const { XHR } = installFileServer({ 'x.data': [1] });
    const request = new XHR();
    request.open('POST', 'https://evil.example/x');
    request.setRequestHeader('X-Probe', '1');
    request.send('probe');
    expect(request.calls).toEqual([
      ['open', 'POST', 'https://evil.example/x'], ['setRequestHeader', 'X-Probe', '1'], ['send', 'probe'],
    ]);
    expect(request.readyState).toBe(-1);
    expect(request.response).toBe('native');
    expect(request instanceof NativeRequest).toBe(true);
  });

  test('abort or a new open stops a pending App file read', async () => {
    const { XHR } = installFileServer({ 'x.data': [1, 2], 'y.data': 'y' });
    for (const point of [2, 3, 4, 'pending', 'loadstart', 'progress']) for (const reopen of [false, true]) {
      const request = new XHR();
      const events: string[] = [];
      const interrupt = () => {
        request.onreadystatechange = null;
        if (reopen) {
          request.open('GET', 'y.data');
          request.send();
        } else request.abort();
      };
      for (const type of ['abort', 'load', 'loadend']) request.addEventListener(type, () => events.push(`${type}:${request.responseText}`));
      request.open('GET', 'x.data');
      if (typeof point === 'number') request.onreadystatechange = () => { if (request.readyState === point) interrupt(); };
      else if (point !== 'pending') request.addEventListener(point, interrupt, { once: true });
      request.send();
      if (point === 'pending') interrupt();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const aborted = point === 4 ? [] : ['abort:', 'loadend:'];
      expect(events).toEqual(reopen ? ['load:y', 'loadend:y'] : aborted);
      expect([request.readyState, request.status]).toEqual(reopen ? [4, 200] : [0, 0]);
    }
  });

  test('a script src set by property or setAttribute loads the App file from a blob: URL', async () => {
    const { Script, blobs, events } = installFileServer({ 'game.js': 'globalThis.game = 1;' });
    const byProperty = new Script();
    byProperty.src = 'game.js';
    const url = String(byProperty.src);
    expect(url).toStartWith('blob:');
    expect(await blobs.get(url)?.text()).toBe('globalThis.game = 1;');
    expect(blobs.get(url)?.type).toStartWith('text/javascript');
    const byAttribute = new Script();
    byAttribute.setAttribute('SRC', './game.js');
    byAttribute.setAttribute('type', 'game.js');
    expect(byAttribute.attributes).toEqual({ SRC: url, type: 'game.js' });
    const remote = new Script();
    remote.src = 'https://cdn.example/game.js';
    expect(remote.src).toBe('https://cdn.example/game.js');
    remote.setAttribute('src', url);
    expect(remote.attributes.src).toBe(url);
    expect(blobs.size).toBe(1);
    expect(events).toEqual([]);
  });

  test('a Worker named by a variable or a URL starts from the App file', async () => {
    const { AppWorker, NativeWorker, blobs } = installFileServer({ 'worker.js': 'onmessage = () => postMessage(42);', 'jobs/calc.js': 'calc' });
    const name = ['work', 'er.js'].join('');
    const fromString = new AppWorker(name, { type: 'module' });
    expect(fromString).toBeInstanceOf(NativeWorker);
    expect(String(fromString.url)).toStartWith('blob:');
    expect(await blobs.get(String(fromString.url))?.text()).toBe('onmessage = () => postMessage(42);');
    expect(fromString.options).toEqual({ type: 'module' });
    const fromUrl = new AppWorker(new URL('jobs/calc.js', RUNNER_URL));
    expect(await blobs.get(String(fromUrl.url))?.text()).toBe('calc');
    const inline = 'blob:chrome-extension://peerdtest/made-by-the-app';
    expect(new AppWorker(inline).url).toBe(inline);
  });

  test('a module Worker that does not start fires the module event; other Worker errors do not', () => {
    const { AppWorker, events } = installFileServer({ 'worker.js': 'postMessage(1);' });
    const failed = (worker: EventTarget, message?: string) => worker.dispatchEvent(
      Object.assign(new Event('error'), message === undefined ? {} : { message }));
    failed(new AppWorker('worker.js'));
    failed(new AppWorker('worker.js', { type: 'classic' }));
    failed(new AppWorker('worker.js', { type: 'module' }), 'Uncaught Error: thrown by the worker');
    expect(events).toEqual([]);
    failed(new AppWorker('worker.js', { type: 'module' }));
    failed(new AppWorker('blob:chrome-extension://peerdtest/made-by-the-app', { type: 'module' }));
    expect(events).toEqual([APP_MODULE_FAILED_EVENT, APP_MODULE_FAILED_EVENT]);
  });

  test('AudioWorklet addModule loads the App file; other worklets keep the native call', async () => {
    const { AudioWorklet, Worklet, blobs } = installFileServer({ 'audio/processor.js': 'registerProcessor("p", class {});' });
    const audio = new AudioWorklet();
    await audio.addModule('audio/processor.js', { credentials: 'omit' });
    const [url, options] = audio.calls[0] ?? [];
    expect(await blobs.get(String(url))?.text()).toBe('registerProcessor("p", class {});');
    expect(options).toEqual({ credentials: 'omit' });
    const paint = new Worklet();
    await paint.addModule('audio/processor.js');
    expect(paint.calls).toEqual([['audio/processor.js']]);
  });

  test('a missing App file gets a revoked blob: URL, never a packaged extension path', () => {
    const { Script, AppWorker, AudioWorklet, revoked, events } = installFileServer({ 'game.js': 'x' });
    const script = new Script();
    script.src = '/background/vault-kernel.js';
    const missingUrl = String(script.src);
    expect(missingUrl).toStartWith('blob:');
    expect(revoked.has(missingUrl)).toBe(true);
    expect(new AppWorker('data/state.json').url).toBe(missingUrl);
    const audio = new AudioWorklet();
    audio.addModule('../../manifest.json');
    expect(audio.calls[0]?.[0]).toBe(missingUrl);
    expect(events).toEqual(Array(3).fill(APP_FILE_MISSING_EVENT));
  });

  test('fetch and XHR read an App data path, and it never loads as a script, Worker, or worklet', async () => {
    const { fetch, XHR, Script, AppWorker, AudioWorklet, blobs, revoked, events } = installFileServer({
      'data/Actors.json': '[null,{"id":1}]', 'data/plugins.js': 'globalThis.plugins = 1;',
    });
    const response = await fetch('data/Actors.json');
    expect([response.status, response.headers.get('content-type')]).toEqual([200, 'application/json']);
    expect(await response.json()).toEqual([null, { id: 1 }]);
    const request = new XHR();
    request.open('GET', './data/Actors.json');
    request.send();
    await settle(request);
    expect([request.status, request.responseText]).toEqual([200, '[null,{"id":1}]']);
    expect(events).toEqual([]);
    const script = new Script();
    script.src = 'data/Actors.json';
    const missingUrl = String(script.src);
    expect(revoked.has(missingUrl)).toBe(true);
    expect(new AppWorker(new URL('data/Actors.json', RUNNER_URL)).url).toBe(missingUrl);
    const audio = new AudioWorklet();
    audio.addModule('./data/Actors.json');
    expect(audio.calls[0]?.[0]).toBe(missingUrl);
    expect(events).toEqual(Array(3).fill(APP_FILE_MISSING_EVENT));
    // Only data/<key>.json is App data. Other files under data/ stay code.
    const plugins = new Script();
    plugins.src = 'data/plugins.js';
    expect(await blobs.get(String(plugins.src))?.text()).toBe('globalThis.plugins = 1;');
  });

  test('a fetch or XHR 404 fires the missing-file event; App files and other URLs do not', async () => {
    const { fetch, XHR, events } = installFileServer({ 'x.wasm': [0] });
    await fetch('x.wasm');
    await fetch('https://evil.example/x.wasm').catch(() => {});
    expect(events).toEqual([]);
    await fetch('missing.data');
    const request = new XHR();
    request.open('GET', 'missing.pck');
    request.send();
    await settle(request);
    expect(events).toEqual([APP_FILE_MISSING_EVENT, APP_FILE_MISSING_EVENT]);
  });
});

// Engines read these properties with no try/catch: Twine, Unity 6, PixiJS
// and RPG Maker stop on the SecurityError that the opaque frame throws.
describe('App storage', () => {
  type KeyedStorage = Storage & Record<string, unknown>;

  test('localStorage and sessionStorage hold strings in page memory and never read the real objects', () => {
    const { scope, Storage, realStorageReads } = installFileServer({});
    const local = scope.localStorage as KeyedStorage;
    const session = scope.sessionStorage as KeyedStorage;
    expect(local).toBeInstanceOf(Storage);
    expect(scope.localStorage).toBe(local);
    expect(session).not.toBe(local);
    expect([local.length, local.getItem('best'), local.key(0)]).toEqual([0, null, null]);
    local.setItem('best', 7 as unknown as string);
    local.setItem('name', 'Ada');
    expect([local.length, local.getItem('best'), local.key(0), local.key(1), local.key(2)])
      .toEqual([2, '7', 'best', 'name', null]);
    expect(session.length).toBe(0);
    local.removeItem('best');
    expect([local.length, local.getItem('best')]).toEqual([1, null]);
    local.clear();
    expect(local.length).toBe(0);
    expect(realStorageReads).toEqual([]);
  });

  test('a key reads and writes as a property, the way Kaboom and GameMaker use it', () => {
    const local = installFileServer({}).scope.localStorage as KeyedStorage;
    local.level = 3;
    local['hp'] = '12';
    expect([local.getItem('level'), local.hp, local.missing, 'level' in local, 'missing' in local])
      .toEqual(['3', '12', undefined, true, false]);
    expect(Object.keys(local)).toEqual(['level', 'hp']);
    expect(JSON.stringify(local)).toBe('{"level":"3","hp":"12"}');
    expect(Object.hasOwn(local, 'hp')).toBe(true);
    expect(delete local.level).toBe(true);
    expect(local.length).toBe(1);
    // A stored key never hides a method or length.
    local.setItem('getItem', 'x');
    (local as Record<string, unknown>).length = 9;
    expect([typeof local.getItem, local.getItem('getItem'), local.getItem('length'), local.length])
      .toEqual(['function', 'x', '9', 3]);
  });

  test('the Storage prototype holds the methods, so a library can call or patch them there', () => {
    const { scope, Storage } = installFileServer({});
    const local = scope.localStorage as KeyedStorage;
    const proto = Storage.prototype as unknown as globalThis.Storage;
    proto.setItem.call(local, 'k', 'v');
    expect([proto.getItem.call(local, 'k'), Object.getOwnPropertyDescriptor(proto, 'length')?.get?.call(local)])
      .toEqual(['v', 1]);
    proto.removeItem.call(local, 'k');
    expect(local.length).toBe(0);
    expect(() => proto.getItem.call({}, 'k')).toThrow(TypeError);
    const seen: string[] = [];
    const { setItem } = proto;
    proto.setItem = function patched(key: string, value: string) { seen.push(key); setItem.call(this, key, value); };
    local.setItem('patched', '1');
    expect([seen, local.getItem('patched')]).toEqual([['patched'], '1']);
  });

  test('a write over the quota throws QuotaExceededError and keeps the old values', () => {
    const { scope } = installFileServer({});
    const local = scope.localStorage as KeyedStorage;
    local.setItem('small', 'kept');
    const quotaError = (write: () => void) => {
      try { write(); return 'stored'; } catch (error) { return (error as DOMException).name; }
    };
    // The key counts as the value does.
    expect(quotaError(() => local.setItem('k'.repeat(5 * 1024 * 1024), 'v'))).toBe('QuotaExceededError');
    expect(quotaError(() => local.setItem('big', 'x'.repeat(6 * 1024 * 1024)))).toBe('QuotaExceededError');
    expect(quotaError(() => { local.big = 'x'.repeat(6 * 1024 * 1024); })).toBe('QuotaExceededError');
    expect(quotaError(() => local.setItem('fits', 'x'.repeat(4 * 1024 * 1024)))).toBe('stored');
    expect(quotaError(() => local.setItem('more', 'x'.repeat(2 * 1024 * 1024)))).toBe('QuotaExceededError');
    expect(quotaError(() => local.setItem('fits', 'x'.repeat(5 * 1024 * 1024 - 13)))).toBe('stored');
    expect([local.length, local.getItem('small'), local.getItem('big'), local.getItem('more')])
      .toEqual([2, 'kept', null, null]);
    // The other storage has its own quota.
    expect(quotaError(() => (scope.sessionStorage as Storage).setItem('fits', 'x'.repeat(4 * 1024 * 1024)))).toBe('stored');
  });

  test('key() takes its index as the real Storage does, and defineProperty stores a key', () => {
    const local = installFileServer({}).scope.localStorage as KeyedStorage;
    local.setItem('a', '1');
    local.setItem('b', '2');
    expect([NaN, undefined, 1.7, 4294967296, -1, 2].map((index) => local.key(index as number)))
      .toEqual(['a', 'a', 'b', 'a', null, null]);
    Object.defineProperty(local, 'c', { value: 3 });
    expect([local.c, local.getItem('c'), local.length]).toEqual(['3', '3', 3]);
  });

  test('a Symbol key is a plain property and not an item', () => {
    const local = installFileServer({}).scope.localStorage as KeyedStorage;
    const bySymbol = local as unknown as Record<symbol, unknown>;
    const tag = Symbol('tag');
    const fixed = Symbol('fixed');
    bySymbol[tag] = 1;
    Object.defineProperty(local, fixed, { value: 2 });
    expect([bySymbol[tag], bySymbol[fixed], tag in local, local.length, Object.keys(local)])
      .toEqual([1, 2, true, 0, []]);
    expect(Object.getOwnPropertySymbols(local)).toEqual([tag, fixed]);
    expect(Object.getOwnPropertyDescriptor(local, fixed)?.configurable).toBe(false);
    expect([delete bySymbol[tag], tag in local]).toEqual([true, false]);
  });

  test('defineProperty stores only a data descriptor', () => {
    const local = installFileServer({}).scope.localStorage as KeyedStorage;
    expect(() => Object.defineProperty(local, 'score', { get: () => 'x' })).toThrow(TypeError);
    expect(() => Object.defineProperty(local, 'score', { set: () => {} })).toThrow(TypeError);
    expect(() => Object.defineProperty(local, 'score', { enumerable: true })).toThrow(TypeError);
    expect([local.getItem('score'), local.length]).toEqual([null, 0]);
    Object.defineProperty(local, 'score', { value: 5, writable: true, enumerable: true, configurable: true });
    expect([local.getItem('score'), local.length]).toEqual(['5', 1]);
  });

  test('nothing is kept: each App document starts with empty storage', () => {
    const first = installFileServer({}).scope.localStorage as Storage;
    first.setItem('save', 'slot 1');
    const second = installFileServer({}).scope;
    expect((second.localStorage as Storage).getItem('save')).toBe(null);
    expect((second.sessionStorage as Storage).length).toBe(0);
  });

  test('caches is absent, and indexedDB stays the native object that refuses open()', () => {
    const { scope, nativeIndexedDb, realStorageReads } = installFileServer({});
    expect('caches' in scope).toBe(false);
    expect(scope.caches).toBe(undefined);
    expect(scope.indexedDB).toBe(nativeIndexedDb);
    expect(() => (scope.indexedDB as IDBFactory).open('save')).toThrow('denied');
    expect(realStorageReads).toEqual([]);
  });
});

describe('stripMetaRefresh', () => {
  test('removes a meta-refresh that would reload the sandbox frame', () => {
    const out = stripMetaRefresh('<head><meta http-equiv="refresh" content="3;url=/x"></head>');
    expect(out).toBe('<head></head>');
  });

  test('matches regardless of attribute order, quoting, and self-closing', () => {
    expect(stripMetaRefresh('<meta content="0" http-equiv=refresh>')).toBe('');
    expect(stripMetaRefresh("<meta http-equiv='refresh' content='5' />")).toBe('');
  });

  test('leaves other meta tags untouched', () => {
    const html = '<meta charset="utf-8"><meta name="viewport" content="width=device-width">';
    expect(stripMetaRefresh(html)).toBe(html);
  });
});
