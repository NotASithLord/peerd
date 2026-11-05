import { describe, test, expect } from 'bun:test';
import { APP_FILES_HANDOFF, composeApp, stripMetaRefresh } from '../../extension/peerd-engine/app-compose.js';

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

  // Workers: an opaque-origin sandbox can only load a Worker from a same-origin
  // blob: URL, so composeApp embeds the referenced worker source + a shim that
  // turns `new Worker('worker.js')` into a blob: worker at runtime.
  test('inlines a bare new Worker(\'worker.js\') reference + shim', () => {
    const files = {
      'index.html': '<head></head><body><script>const w = new Worker("worker.js");</script></body>',
      'worker.js': 'self.onmessage = () => self.postMessage(42);',
    };
    const out = composeApp(files);
    expect(out).toContain('data-peerd-worker-shim');
    expect(out).toContain('self.postMessage(42)');     // worker source embedded
    expect(out).toContain('self.Worker=W');            // Worker is overridden
    // shim is injected at <head> start, before the app script runs it
    expect(out.indexOf('data-peerd-worker-shim')).toBeLessThan(out.indexOf('new Worker'));
  });

  test('resolves ./-relative and nested worker specs', () => {
    const files = {
      'index.html': '<head></head><script>new Worker("./jobs/calc.js")</script>',
      'jobs/calc.js': 'JOB_SRC',
    };
    const out = composeApp(files);
    expect(out).toContain('data-peerd-worker-shim');
    expect(out).toContain('JOB_SRC');
  });

  test('no worker ref → no shim (zero cost)', () => {
    const files = { 'index.html': '<head></head><script>const x = 1;</script>' };
    expect(composeApp(files)).not.toContain('data-peerd-worker-shim');
  });

  test('new Worker pointing at a non-bundled path is left alone (no shim)', () => {
    const files = { 'index.html': '<head></head><script>new Worker("missing.js")</script>' };
    expect(composeApp(files)).not.toContain('data-peerd-worker-shim');
  });

  test('escapes </script> in worker source so it cannot break out', () => {
    const files = {
      'index.html': '<head></head><script>new Worker("w.js")</script>',
      'w.js': 'const s = "</script>";',
    };
    const out = composeApp(files);
    // the raw closing tag must NOT appear inside the embedded source
    expect(out).not.toContain('"</script>"');
    expect(out).toContain('\\u003c/script>');
  });

  test('runtime data cannot become an entry, script, style, or worker source', () => {
    const payload = JSON.stringify('</script><script>globalThis.pwned=1</script>');
    for (const html of [
      '<script src="data/state.json"></script>',
      '<link rel="stylesheet" href="data/state.json">',
      '<script>new Worker("data/state.json")</script>',
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
      '<script>new Worker("../DATA/State.JSON")</script>',
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

  // Execute the injected shim against mocked Worker/Blob/URL to prove the
  // runtime rewrite — a known spec becomes a blob: worker, anything else passes
  // straight through. Guards against a regression in the shim source string.
  test('the injected shim rewrites a known spec to a blob: worker at runtime', () => {
    const out = composeApp({
      'index.html': '<head></head><script>new Worker("worker.js")</script>',
      'worker.js': 'WORKER_BODY',
    });
    const shim = /data-peerd-worker-shim>([\s\S]*?)<\/script>/.exec(out)?.[1];
    expect(shim).toBeTruthy();

    const blobs: any[] = [];
    const calls: any[] = [];
    const mockSelf: any = { Worker: function (u: string, o: any) { calls.push({ u, o }); } };
    const MockBlob: any = function (this: any, parts: any[], opts: any) {
      this.parts = parts; this.opts = opts; blobs.push(this);
    };
    const mockURL: any = { createObjectURL: (b: any) => `blob:mock/${blobs.indexOf(b)}` };

    // eslint-disable-next-line no-new-func
    new Function('self', 'URL', 'Blob', shim as string)(mockSelf, mockURL, MockBlob);

    new mockSelf.Worker('worker.js');
    expect(calls).toHaveLength(1);
    expect(calls[0].u).toBe('blob:mock/0');            // rewritten to a blob URL
    expect(blobs[0].parts[0]).toBe('WORKER_BODY');     // blob carries the source
    expect(blobs[0].opts.type).toBe('application/javascript');

    new mockSelf.Worker('https://cdn/other.js');       // unknown spec
    expect(calls[1].u).toBe('https://cdn/other.js');   // passes straight through
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
// stand-in Window, the same way the runner's document.write runs it.
const installFileServer = (files: Record<string, string | number[]>, entry = 'index.html') => {
  const html = composeApp({ [entry]: '<!doctype html><title>Game</title>' }, entry);
  const script = /<script data-peerd-file-server>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const nativeCalls: unknown[][] = [];
  const nativeFetch = (...args: unknown[]) => {
    nativeCalls.push(args);
    return Promise.reject(new TypeError('Failed to fetch'));
  };
  const scope: Record<string, unknown> = {
    location: { href: RUNNER_URL },
    fetch: nativeFetch,
    XMLHttpRequest: NativeRequest,
    ProgressEvent: ProgressStandIn,
    Blob, DOMException, Event, Request, Response, TextDecoder, URL,
    [APP_FILES_HANDOFF]: Object.fromEntries(Object.entries(files).map(([path, value]) => [path, bytesOf(value)])),
  };
  // eslint-disable-next-line no-new-func
  new Function('self', script)(scope);
  const fetch = scope.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  const XHR = scope.XMLHttpRequest as typeof NativeRequest;
  return { html, script, scope, fetch, XHR, nativeFetch, nativeCalls };
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

  test('abort stops a pending App file read', async () => {
    const { XHR } = installFileServer({ 'x.data': [1, 2] });
    const request = new XHR();
    const events: string[] = [];
    request.onabort = () => events.push('abort');
    request.onload = () => events.push('load');
    request.open('GET', 'x.data');
    request.send();
    request.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(['abort']);
    expect(request.readyState).toBe(0);
    expect(request.status).toBe(0);
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
