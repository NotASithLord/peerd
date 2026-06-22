import { describe, test, expect } from 'bun:test';
import { composeApp, withNewTabLinks, stripMetaRefresh } from '../../extension/peerd-engine/app-compose.js';

describe('composeApp', () => {
  test('returns entry unchanged if no relative refs', () => {
    const files = { 'index.html': '<p>hello</p>' };
    expect(composeApp(files)).toBe('<p>hello</p>');
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
    expect(out).toBe('<link rel="stylesheet" href="./missing.css">');
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

describe('withNewTabLinks', () => {
  test('injects <base target="_blank"> right after <head>', () => {
    const out = withNewTabLinks('<!doctype html><html><head><title>x</title></head><body><a href="https://huggingface.co">hf</a></body></html>');
    expect(out).toContain('<head><base target="_blank"><title>x</title>');
  });

  test('headless documents get the base tag prepended', () => {
    const out = withNewTabLinks('<p><a href="https://example.com">go</a></p>');
    expect(out.startsWith('<base target="_blank">')).toBe(true);
  });

  test('an app shipping its OWN <base> is respected', () => {
    const html = '<head><base href="/x/" target="_self"></head><a href="y">y</a>';
    expect(withNewTabLinks(html)).toBe(html);
  });

  test('attributes on <head> survive', () => {
    const out = withNewTabLinks('<head data-x="1"><meta charset="utf-8"></head>');
    expect(out).toContain('<head data-x="1"><base target="_blank"><meta');
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
