import { describe, test, expect } from 'bun:test';
import { createRefRegistry } from '../../../extension/peerd-runtime/dom/ref-registry.js';

describe('createRefRegistry', () => {
  test('stores a snapshot and resolves its refs', () => {
    const reg = createRefRegistry();
    const n = reg.setSnapshot(7, [
      { ref: '@e1', backendDOMNodeId: 44, role: 'textbox', name: 'Subject' },
      { ref: '@e2', backendDOMNodeId: 66, role: 'button', name: 'Send' },
    ]);
    expect(n).toBe(2);
    expect(reg.resolve(7, '@e2')).toMatchObject({ backendDOMNodeId: 66, role: 'button' });
    expect(reg.resolve(7, '@e9')).toBeNull();   // unknown ref
    expect(reg.resolve(999, '@e1')).toBeNull(); // unknown tab
  });

  test('a new snapshot REPLACES the prior refs and bumps the generation', () => {
    const reg = createRefRegistry();
    reg.setSnapshot(7, [{ ref: '@e1', backendDOMNodeId: 1 }]);
    expect(reg.generation(7)).toBe(1);
    reg.setSnapshot(7, [{ ref: '@e1', backendDOMNodeId: 2 }]);
    expect(reg.generation(7)).toBe(2);
    // same ref string now points at the NEW node — old mapping is gone
    expect(reg.resolve(7, '@e1')).toMatchObject({ backendDOMNodeId: 2 });
  });

  test('clear drops a tab; tabs are isolated from each other', () => {
    const reg = createRefRegistry();
    reg.setSnapshot(1, [{ ref: '@e1', backendDOMNodeId: 10 }]);
    reg.setSnapshot(2, [{ ref: '@e1', backendDOMNodeId: 20 }]);
    expect(reg.resolve(1, '@e1')).toMatchObject({ backendDOMNodeId: 10 });
    expect(reg.resolve(2, '@e1')).toMatchObject({ backendDOMNodeId: 20 });
    reg.clear(1);
    expect(reg.resolve(1, '@e1')).toBeNull();
    expect(reg.resolve(2, '@e1')).toMatchObject({ backendDOMNodeId: 20 });
  });
});
