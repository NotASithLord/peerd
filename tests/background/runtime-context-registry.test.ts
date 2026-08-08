import { describe, expect, test } from 'bun:test';
import { createRuntimeContextRegistry } from '../../extension/background/runtime-context-registry.js';

const created = (id: number, origin: string, frameId: string, isDefault = true) => ({
  context: { id, origin, auxData: { frameId, isDefault } },
});

describe('runtime context registry', () => {
  test('selects only the default context for the checked main frame and origin', () => {
    const registry = createRuntimeContextRegistry();
    registry.observe(7, 'Runtime.executionContextCreated', created(11, 'https://example.com', 'main'));
    registry.observe(7, 'Runtime.executionContextCreated', created(12, 'https://private.test', 'child'));
    registry.observe(7, 'Runtime.executionContextCreated', created(13, 'https://example.com', 'main', false));

    expect(registry.selectMain(7, 'main', 'https://example.com')).toBe(11);
    expect(registry.selectMain(7, 'child', 'https://example.com')).toBe(null);
  });

  test('a replaced or cleared document cannot reuse the prior context', () => {
    const registry = createRuntimeContextRegistry();
    registry.observe(7, 'Runtime.executionContextCreated', created(11, 'https://example.com', 'main'));
    registry.observe(7, 'Runtime.executionContextDestroyed', { executionContextId: 11 });
    expect(registry.selectMain(7, 'main', 'https://example.com')).toBe(null);

    registry.observe(7, 'Runtime.executionContextCreated', created(14, 'http://127.0.0.1', 'main'));
    registry.observe(7, 'Runtime.executionContextsCleared', {});
    expect(registry.selectMain(7, 'main', 'http://127.0.0.1')).toBe(null);
  });

  test('tab release drops every context for that tab', () => {
    const registry = createRuntimeContextRegistry();
    registry.observe(7, 'Runtime.executionContextCreated', created(11, 'https://example.com', 'main'));
    registry.release(7);
    expect(registry.selectMain(7, 'main', 'https://example.com')).toBe(null);
  });
});
