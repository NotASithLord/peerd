import { afterEach, describe, expect, test } from 'bun:test';
import {
  drainFetchTapInjected,
  installFetchTapInjected,
} from '../../../extension/peerd-runtime/dom/fetch-tap-injected.js';
import { digestCapture } from '../../../extension/peerd-runtime/site-clients/digest.js';

const saved = {
  window: (globalThis as any).window,
  document: (globalThis as any).document,
  location: (globalThis as any).location,
};

afterEach(() => {
  (globalThis as any).window = saved.window;
  (globalThis as any).document = saved.document;
  (globalThis as any).location = saved.location;
});

describe('injected fetch tap scope', () => {
  test('actual tap output reaches the digest with types and array count intact', async () => {
    const fakeWindow: any = {
      fetch: async () => ({
        status: 200, headers: { get: () => 'application/json' },
        clone: () => ({ text: async () => JSON.stringify({
          total: 42, paid: false, items: [{ id: 3 }],
        }) }),
      }),
      XMLHttpRequest: undefined,
    };
    (globalThis as any).window = fakeWindow;
    (globalThis as any).document = { cookie: '' };
    (globalThis as any).location = { href: 'https://example.com/' };
    expect(installFetchTapInjected(['https://example.com'])).toEqual({ ok: true });
    await fakeWindow.fetch('/items');
    await Promise.resolve();
    await Promise.resolve();
    const captured = drainFetchTapInjected();
    expect(captured.events?.length).toBe(1);
    expect(captured.events?.[0]?.resSample).toBeUndefined();
    const digest = digestCapture(captured.events ?? [], { origins: ['https://example.com'] });
    expect(digest.endpoints[0]?.note).toBe('→ {"total":"number","paid":"boolean","items":[{"id":"number"},"…×1"]}');
  });

  test('never clones or samples a private response from a public page', async () => {
    let clones = 0;
    const fakeWindow: any = {
      fetch: async () => ({
        status: 200,
        headers: { get: () => 'application/json' },
        clone: () => {
          clones++;
          return { text: async () => '{"secret":true}' };
        },
      }),
      XMLHttpRequest: undefined,
    };
    (globalThis as any).window = fakeWindow;
    (globalThis as any).document = { cookie: '' };
    (globalThis as any).location = { href: 'https://example.com/' };

    expect(installFetchTapInjected(['https://example.com'])).toEqual({ ok: true });
    await fakeWindow.fetch('http://127.0.0.1/private.json');
    await Promise.resolve();
    await Promise.resolve();

    expect(clones).toBe(0);
    expect(drainFetchTapInjected()).toEqual({ ok: true, events: [] });
  });
});
