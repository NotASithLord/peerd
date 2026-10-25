import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

describe('Notebook output layout', () => {
  test('the actual console append path leaves layout to the size observer', async () => {
    const source = await Bun.file('./extension/engine-tabs/notebook-tab/notebook-tab.js').text();
    const observerStart = source.indexOf('// why: defer output mutations');
    const start = observerStart < 0 ? source.indexOf('/** @param {string} cls @param {string} text */') : observerStart;
    const body = source.slice(start, source.indexOf('const showApp =', start));
    let reads = 0, writes = 0;
    const lines: Array<{ className: string, textContent: string }> = [];
    const callbacks: Array<() => void> = [];
    const frames: Array<() => void> = [];
    const output = {
      appendChild: (line: typeof lines[number]) => lines.push(line),
      get childElementCount() { return lines.length; },
      get lastElementChild() { return lines.at(-1) ?? null; },
      get firstElementChild() { return { remove: () => lines.shift() }; },
    };
    const outputPane = {
      get scrollHeight() { reads += 1; return lines.length * 18; },
      set scrollTop(_value: number) { writes += 1; },
    };
    const appendLine = runInNewContext(`${body}; appendLine`, {
      els: { output, outputPane },
      document: { createElement: () => ({ className: '', textContent: '' }) },
      requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; },
      ResizeObserver: class {
        constructor(callback: () => void) { callbacks.push(callback); }
        observe(target: unknown) { expect(target).toBe(output); }
      },
    });
    for (let index = 0; index < 20_000; index += 1) appendLine('log-info', `line ${index}`);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(lines).toHaveLength(20_000);
    expect(lines.at(-1)).toEqual({ className: 'log-line log-info', textContent: 'line 19999\n' });
    expect(callbacks).toHaveLength(1);
    callbacks[0]();
    expect(frames).toHaveLength(1);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(lines).toHaveLength(20_000);
    frames.shift()!();
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    expect(lines).toHaveLength(5_000);
    callbacks[0]();
    expect(reads).toBe(1);
    frames.shift()!();
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    appendLine('log-info', 'next'); callbacks[0]();
    expect(lines).toHaveLength(5_001);
    expect(reads).toBe(1);
    frames.shift()!();
    expect(lines).toHaveLength(5_000);
    expect(lines.at(-1)?.textContent).toBe('next\n');
    expect(reads).toBe(2);
  });
});
