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
