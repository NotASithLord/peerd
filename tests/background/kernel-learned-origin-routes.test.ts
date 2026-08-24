import { describe, expect, test } from 'bun:test';
import {
  makeKernelLearnedOriginRoutes,
  normalizeKernelLearnedHost,
} from '../../extension/background/settings-store.js';
import { makeLearnedOriginRoutes } from '../../extension/background/routes/learned-origins.js';
import { makeLearnedOrigins } from '../../extension/peerd-runtime/actor/learned-origins.js';
import { normalizeApiOrigin } from '../../extension/peerd-runtime/actor/web-actor.js';

const hostFromLegacy = (value: unknown) => {
  const origin = normalizeApiOrigin(value);
  return origin ? new URL(origin).hostname : null;
};

const setup = (seed: Record<string, string>) => {
  let stored: any = structuredClone(seed);
  const audits: any[] = [];
  const errors: any[] = [];
  const kv = {
    get: async () => structuredClone(stored),
    set: async (_key: string, value: any) => { stored = structuredClone(value); },
  };
  const routes = makeKernelLearnedOriginRoutes({
    kv,
    auditLog: { append: async (entry: any) => { audits.push(structuredClone(entry)); } },
    onError: (...args) => { errors.push(args); },
  });
  return { routes, audits, errors, stored: () => stored };
};

describe('native kernel learned-origin settings authority', () => {
  test('the small host normalizer remains exact with the rich Web actor', () => {
    for (const value of [
      'GitHub.COM', 'https://login.example.com:443/path',
      'http://api.example.dev:8080/a', '', 'localhost', '127.0.0.1',
      'https://user@example.com.evil.test', 'ftp://example.com', 'web',
    ]) expect(normalizeKernelLearnedHost(value)).toBe(hostFromLegacy(value));
  });

  test('list, forget, clear, persistence, and audit match the legacy settings routes', async () => {
    const seed = {
      'https://Beta.example.com:443': 'password-field',
      'alpha.example.com': 'confirmed-write',
      'invalid': 'confirmed-write',
      'gamma.example.com': 'unknown-reason',
    };
    const native = setup(seed);
    let legacyStored: any = structuredClone(seed);
    const legacyAudits: any[] = [];
    const learned = makeLearnedOrigins({
      load: async () => structuredClone(legacyStored),
      save: async (value) => { legacyStored = structuredClone(value); },
      onForget: (hosts) => hosts.forEach((host) => legacyAudits.push({
        type: 'origin_unlearned_sensitive', details: { host },
      })),
    });
    const legacy = makeLearnedOriginRoutes({ learnedOrigins: learned, normalizeApiOrigin });

    expect(await native.routes['learned/list']()).toEqual(await legacy['learned/list']());
    expect(await native.routes['learned/forget']({ host: 'BETA.example.com' }))
      .toEqual(await legacy['learned/forget']({ host: 'BETA.example.com' }));
    expect(native.stored()).toEqual(legacyStored);
    expect(native.audits).toEqual(legacyAudits);
    expect(await native.routes['learned/forget']({ host: 'missing.example.com' }))
      .toEqual(await legacy['learned/forget']({ host: 'missing.example.com' }));
    expect(await native.routes['learned/clear']()).toEqual(await legacy['learned/clear']());
    expect(native.stored()).toEqual(legacyStored);
    expect(native.audits).toEqual(legacyAudits);
    expect(native.errors).toEqual([]);
  });

  test('load fails open for reads but a failed mutation is outcome-unknown', async () => {
    const errors: any[] = [];
    const routes = makeKernelLearnedOriginRoutes({
      kv: {
        get: async () => { throw new Error('read failed'); },
        set: async () => { throw new Error('write failed'); },
      },
      auditLog: { append: async () => {} },
      onError: (...args) => { errors.push(args); },
    });
    await expect(routes['learned/list']()).resolves.toEqual({ ok: true, origins: [] });
    await expect(routes['learned/clear']()).rejects.toMatchObject({
      code: 'learned-origins-save-failed', outcomeKnown: false,
      message: 'The learned-origin change could not be confirmed.',
    });
    expect(errors.length).toBe(3);
  });
});
