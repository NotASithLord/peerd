import { describe, test, expect } from 'bun:test';
import { APP_FILE_MISSING_EVENT, APP_FILES_HANDOFF, composeApp, stripMetaRefresh } from '../../extension/peerd-engine/app-compose.js';

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
  #responseType: XMLHttpRequestResponseType = '';
  get responseType() { return this.#responseType; }
  set responseType(value: XMLHttpRequestResponseType) { this.#responseType = value; }
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
  class WorkerStandIn {
    constructor(readonly url: unknown, readonly options?: unknown) {}
  }
  class WorkletStandIn {
    calls: unknown[][] = [];
    addModule(...args: unknown[]) {
      this.calls.push(args);
      return Promise.resolve();
    }
  }
  class AudioWorkletStandIn extends WorkletStandIn {}
  const scope: Record<string, unknown> = {
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
  // eslint-disable-next-line no-new-func
  new Function('self', script)(scope);
  const fetch = scope.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  const XHR = scope.XMLHttpRequest as typeof NativeRequest;
  const Script = scope.HTMLScriptElement as typeof ScriptStandIn;
  const AppWorker = scope.Worker as typeof WorkerStandIn;
  return {
    html, script, scope, fetch, XHR, nativeFetch, nativeCalls, events, blobs, revoked,
    Script, AppWorker, NativeWorker: WorkerStandIn, AudioWorklet: AudioWorkletStandIn, Worklet: WorkletStandIn,
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
  });

  test('fetch serves App files by relative, absolute, Request, and query URLs', async () => {
    const wasm = [0, 97, 115, 109, 1, 0, 0, 0];
    const { fetch, nativeCalls } = installFileServer({ 'x.wasm': wasm, 'assets/level.json': '{"level":1}' });
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

  test('serves the original bytes of text files, including a BOM and invalid UTF-8', async () => {
    const original = [0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62];
    const { fetch } = installFileServer({ 'game.js': original });
    const response = await fetch('game.js');
    expect(response.headers.get('content-type')).toBe('text/javascript');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(original);
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
    const request = new XHR();
    const events: string[] = [];
    request.onabort = () => events.push('abort');
    request.onload = () => events.push(`load:${request.responseText}`);
    request.open('GET', 'x.data');
    request.send();
    request.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(['abort']);
    expect(request.readyState).toBe(0);
    expect(request.status).toBe(0);
    request.open('GET', 'x.data');
    request.send();
    request.open('GET', 'y.data');
    request.send();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(['abort', 'load:y']);
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
