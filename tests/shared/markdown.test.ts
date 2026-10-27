import { describe, test, expect } from 'bun:test';
import { renderMarkdown } from '../../extension/shared/markdown.js';

describe('renderMarkdown — security', () => {
  test('escapes raw HTML so it can never reach the DOM', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  test('escapes script tags', () => {
    const out = renderMarkdown('hello <script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  test('drops javascript: link hrefs (renders as text)', () => {
    const out = renderMarkdown('[click](javascript:alert(1))');
    expect(out).not.toContain('href="javascript');
    expect(out).not.toContain('<a ');
  });

  test('keeps http/https/mailto links', () => {
    const out = renderMarkdown('[site](https://example.com)');
    expect(out).toContain('<a href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});

describe('renderMarkdown — formatting', () => {
  test('bold and italic', () => {
    expect(renderMarkdown('**b** and *i*')).toContain('<strong>b</strong>');
    expect(renderMarkdown('**b** and *i*')).toContain('<em>i</em>');
  });

  test('inline code is not further formatted', () => {
    const out = renderMarkdown('use `**not bold**` here');
    expect(out).toContain('<code>**not bold**</code>');
    expect(out).not.toContain('<strong>');
  });

  test('fenced code block escapes its body', () => {
    const out = renderMarkdown('```\n<b>x</b>\n```');
    expect(out).toContain('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  });

  test('headings', () => {
    expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>');
    expect(renderMarkdown('### Sub')).toContain('<h3>Sub</h3>');
  });

  test('unordered and ordered lists', () => {
    expect(renderMarkdown('- a\n- b')).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. a\n2. b')).toContain('<ol><li>a</li><li>b</li></ol>');
  });

  test('empty input returns empty string', () => {
    expect(renderMarkdown('')).toBe('');
    // @ts-expect-error — defensive against non-string input
    expect(renderMarkdown(null)).toBe('');
  });
});

describe('renderMarkdown - underscores in links and identifiers', () => {
  test('a Wikipedia link keeps its href and target="_blank"', () => {
    const out = renderMarkdown('[Albert Einstein](https://en.wikipedia.org/wiki/Albert_Einstein)');
    expect(out).toContain('<a href="https://en.wikipedia.org/wiki/Albert_Einstein" target="_blank" rel="noopener noreferrer">Albert Einstein</a>');
    expect(out).not.toContain('<em>');
  });

  test('a URL with a utm_ query keeps its underscores', () => {
    const out = renderMarkdown('[news](https://example.com/a?utm_source=news&utm_medium=email)');
    expect(out).toContain('href="https://example.com/a?utm_source=news&amp;utm_medium=email"');
    expect(out).not.toContain('<em>');
  });

  test('two links on one line both stay intact', () => {
    const out = renderMarkdown('[A](https://x.org/a_b) and [C](https://x.org/c_d)');
    expect(out).toContain('<a href="https://x.org/a_b" target="_blank" rel="noopener noreferrer">A</a>');
    expect(out).toContain('<a href="https://x.org/c_d" target="_blank" rel="noopener noreferrer">C</a>');
    expect(out).not.toContain('<em>');
  });

  test('snake_case file names and constants are not italicized', () => {
    expect(renderMarkdown('my_config_file.py')).toBe('<p>my_config_file.py</p>');
    expect(renderMarkdown('MAX_RETRY_COUNT')).toBe('<p>MAX_RETRY_COUNT</p>');
    expect(renderMarkdown('my__var__name')).toBe('<p>my__var__name</p>');
  });

  test('an identifier before a link leaves no stray <em>', () => {
    const out = renderMarkdown('my_var and [Physics](https://en.wikipedia.org/wiki/Physics)');
    expect(out).not.toContain('<em>');
    expect(out).toContain('my_var and <a href="https://en.wikipedia.org/wiki/Physics"');
  });

  test('bold inside link text keeps its <strong>', () => {
    const out = renderMarkdown('[**Bold** link](https://example.com)');
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer"><strong>Bold</strong> link</a>');
  });

  test('__init__.py renders bold, as CommonMark does', () => {
    expect(renderMarkdown('__init__.py')).toBe('<p><strong>init</strong>.py</p>');
  });

  test('word-boundary underscores still emphasize', () => {
    expect(renderMarkdown('an _italic_ word')).toContain('<em>italic</em>');
    expect(renderMarkdown('a __bold__ word')).toContain('<strong>bold</strong>');
  });

  test('a fake placeholder in the input never renders "undefined"', () => {
    const nul = String.fromCharCode(0);
    const out = renderMarkdown(`x ${nul}${nul}7${nul} y ${nul}9${nul} z`);
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('<code>');
  });
});

describe('renderMarkdown - lists as written', () => {
  test('a loose numbered list stays one <ol> numbered 1, 2, 3', () => {
    const out = renderMarkdown('1. **Install**\n\n2. **Configure**\n\n3. **Run**');
    expect(out).toBe('<ol><li><strong>Install</strong></li><li><strong>Configure</strong></li><li><strong>Run</strong></li></ol>');
  });

  test('a list starting at 3 gets start="3"', () => {
    expect(renderMarkdown('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  test('nested bullets become a nested <ul>', () => {
    expect(renderMarkdown('- a\n  - nested\n- b')).toBe('<ul><li>a<ul><li>nested</li></ul></li><li>b</li></ul>');
  });

  test('a sub-bullet under a step keeps the next step numbered', () => {
    expect(renderMarkdown('1. Step one\n   - detail a\n2. Step two'))
      .toBe('<ol><li>Step one<ul><li>detail a</li></ul></li><li>Step two</li></ol>');
  });

  test('an indented fence inside an item becomes <pre> inside the <li>', () => {
    const out = renderMarkdown('1. Install:\n   ```bash\n   npm i\n\n   npm test\n   ```\n2. Done');
    expect(out).toBe('<ol><li>Install:<pre><code>npm i\n\nnpm test</code></pre></li><li>Done</li></ol>');
  });

  test('a fence body inside a nested item keeps its indentation', () => {
    const out = renderMarkdown('- a\n  - b\n    ```\n    if (x) {\n      <y>\n    }\n    ```');
    expect(out).toBe('<ul><li>a<ul><li>b<pre><code>if (x) {\n  &lt;y&gt;\n}</code></pre></li></ul></li></ul>');
  });

  test('escaped HTML inside an item stays escaped', () => {
    const out = renderMarkdown('1. x\n   - <img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('a javascript: link inside an item is neutralised', () => {
    const out = renderMarkdown('- a\n  - [click](javascript:alert(1))');
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('href="javascript');
  });

  test('the start number is digits only', () => {
    expect(renderMarkdown('007. x')).toBe('<ol start="7"><li>x</li></ol>');
  });

  test('nesting stops at the depth cap', () => {
    const src = Array.from({ length: 9 }, (_v, depth) => `${'  '.repeat(depth)}- l${depth}`).join('\n');
    const out = renderMarkdown(src);
    expect(out.split('<ul>').length - 1).toBe(8);
    expect(out).toContain('l7<br>- l8');
  });

  test('a paragraph after a blank line ends the list', () => {
    expect(renderMarkdown('- a\n\npara')).toBe('<ul><li>a</li></ul>\n<p>para</p>');
  });
});
