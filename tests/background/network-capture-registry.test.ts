import { describe, expect, test } from 'bun:test';
import {
  createNetworkCaptureRegistry,
  networkCaptureRequestPolicy,
} from '../../extension/background/network-capture-registry.js';

describe('network capture registry', () => {
  test('private subresources are ignored without acquiring response bytes', () => {
    expect(networkCaptureRequestPolicy('http://127.0.0.1/private.json', 'XHR')).toBe('ignore');
    expect(networkCaptureRequestPolicy('http://169.254.169.254/latest/meta-data', 'Fetch')).toBe('ignore');
    expect(networkCaptureRequestPolicy('https://example.com/api', 'XHR')).toBe('record');
  });

  test('a private main-document request revokes the whole capture', () => {
    expect(networkCaptureRequestPolicy('http://192.168.1.1/admin', 'Document')).toBe('discard');
  });

  test('keeps at most one capture per tab', () => {
    const registry = createNetworkCaptureRegistry();
    const oldCapture = registry.begin(7);
    oldCapture.set('old', { url: 'https://example.com/old' });
    const replacement = registry.begin(7);
    replacement.set('new', { url: 'https://example.com/new' });

    expect(registry.isCurrent(7, oldCapture)).toBe(false);
    expect(registry.isCurrent(7, replacement)).toBe(true);
  });

  test('a settling old stop cannot expose or delete its replacement', () => {
    const registry = createNetworkCaptureRegistry();
    const oldCapture = registry.begin(7);
    oldCapture.set('old', { value: 1 });
    const replacement = registry.begin(7);

    expect(registry.finish(7, oldCapture)).toEqual([]);
    expect(registry.isCurrent(7, replacement)).toBe(true);
  });

  test('a settling stop cannot recover bytes after policy cancellation', () => {
    const registry = createNetworkCaptureRegistry();
    const cancelled = registry.begin(7);
    cancelled.set('private', { value: 'must-not-escape' });

    registry.discard(7);

    expect(registry.finish(7, cancelled)).toEqual([]);
  });

  test('bounds distinct requests while allowing an existing request to update', () => {
    const registry = createNetworkCaptureRegistry();
    registry.begin(7);

    expect(registry.record(7, 'one', { value: 1 }, 2)).toBe(true);
    expect(registry.record(7, 'two', { value: 2 }, 2)).toBe(true);
    expect(registry.record(7, 'three', { value: 3 }, 2)).toBe(false);
    expect(registry.record(7, 'two', { value: 22 }, 2)).toBe(true);
    expect(registry.finish(7, registry.get(7))).toEqual([
      { value: 1 },
      { value: 22 },
    ]);
  });

  test('detach or tab removal discards the capture', () => {
    const registry = createNetworkCaptureRegistry();
    registry.begin(7);
    expect(registry.discard(7)).toBe(true);
    expect(registry.has(7)).toBe(false);
  });
});
