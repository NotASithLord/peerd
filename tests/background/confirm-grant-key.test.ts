// R5 — origin-BOUND session grants. A "yes for this session" must mean
// "this tool on this origin": the key folds in the prompt's computed
// origin whenever one exists, and only originless tools keep the bare
// tool key.

import { describe, test, expect } from 'bun:test';
import { confirmGrantKey } from '../../extension/background/confirm-grant-key.js';

describe('confirmGrantKey', () => {
  test('a DOM tool with a tab origin is scoped to that origin', () => {
    expect(confirmGrantKey({ tool: 'click', origins: ['https://a.example'] }))
      .toBe('click|https://a.example');
    // the crux of R5: the same tool on another origin is a DIFFERENT grant
    expect(confirmGrantKey({ tool: 'click', origins: ['https://b.example'] }))
      .not.toBe(confirmGrantKey({ tool: 'click', origins: ['https://a.example'] }));
  });

  test('the web-write key keeps its host scoping (same shape as before)', () => {
    expect(confirmGrantKey({ tool: 'web:write', origins: ['https://api.example'] }))
      .toBe('web:write|https://api.example');
  });

  test('an originless tool keys by name alone', () => {
    expect(confirmGrantKey({ tool: 'write_memory' })).toBe('write_memory');
    expect(confirmGrantKey({ tool: 'write_memory', origins: [] })).toBe('write_memory');
  });

  test('degenerate origins never produce a scoped key by accident', () => {
    expect(confirmGrantKey({ tool: 'click', origins: ['', ''] })).toBe('click');
    expect(confirmGrantKey({ tool: 'click', origins: undefined })).toBe('click');
  });
});
