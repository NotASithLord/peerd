// Transfer (settings export/import) — pure-logic coverage: payload
// shaping, the §10 import pre-flight (including the store-build
// dweb-drop notice), passphrase crypto round-trip, and applyImport
// against stub IO. Values in, values out — Bun territory.

import { describe, test, expect } from 'bun:test';
import {
  EXPORT_FORMAT, EXPORT_VERSION,
  buildExport, inspectImport, applyImport,
  encryptWithPassphrase, decryptWithPassphrase,
  ExportPassphraseError,
} from '/peerd-runtime/transfer/transfer.js';

const KNOWN_KEYS = ['devMode', 'reasoningEnabled', 'providerName', 'spendLimitUsd'];

const makePayload = (over: Record<string, unknown> = {}) => ({
  format: EXPORT_FORMAT,
  version: EXPORT_VERSION,
  exportedAt: '2026-06-11T00:00:00.000Z',
  channel: 'preview',
  settings: { devMode: true, dwebMaxPeers: 8 },
  providerEndpoints: null,
  secrets: null,
  memory: { version: 1, docs: [{ id: 'user', body: 'x', updatedAt: 5 }] },
  hooks: [{ id: 'h1', event: 'pre-tool-use' }],
  skills: [{ id: 's1', name: 'review' }],
  ...over,
});

describe('passphrase crypto', () => {
  test('round-trips JSON values', async () => {
    const box = await encryptWithPassphrase('correct horse', { anthropic: 'sk-ant-xyz' });
    expect(box.cipher).toBe('AES-GCM');
    expect(box.kdf).toBe('PBKDF2-SHA256');
    const back = await decryptWithPassphrase('correct horse', box);
    expect(back).toEqual({ anthropic: 'sk-ant-xyz' });
  });

  test('wrong passphrase throws ExportPassphraseError', async () => {
    const box = await encryptWithPassphrase('right', { k: 'v' });
    expect(decryptWithPassphrase('wrong', box)).rejects.toBeInstanceOf(ExportPassphraseError);
  });
});

describe('buildExport', () => {
  test('shapes the payload and encrypts secrets', async () => {
    const payload = await buildExport({
      channel: 'preview',
      storedSettings: { devMode: false },
      providerEndpoints: { endpoints: [{ url: 'https://x.test' }] },
      secrets: { anthropic: 'sk-1' },
      passphrase: 'a long passphrase',
      memory: { version: 1, docs: [] },
      hooks: [],
      skills: [],
    });
    expect(payload.format).toBe(EXPORT_FORMAT);
    expect(payload.channel).toBe('preview');
    expect(payload.settings).toEqual({ devMode: false });
    expect(payload.secrets?.data).toBeString();
    expect(JSON.stringify(payload)).not.toContain('sk-1'); // never plaintext
  });

  test('refuses secrets without a passphrase', async () => {
    expect(buildExport({
      channel: 'store', storedSettings: {}, providerEndpoints: null,
      secrets: { anthropic: 'sk-1' }, passphrase: '', memory: null, hooks: [], skills: [],
    })).rejects.toBeInstanceOf(ExportPassphraseError);
  });

  test('no dweb field in Phase 0 exports', async () => {
    const payload = await buildExport({
      channel: 'preview', storedSettings: {}, providerEndpoints: null,
      secrets: {}, passphrase: '', memory: null, hooks: [], skills: [],
    });
    expect('dweb' in payload).toBe(false);
  });
});

describe('inspectImport', () => {
  test('rejects non-exports and unknown versions', () => {
    expect(inspectImport({ payload: { hi: 1 }, channel: 'store', knownSettingKeys: KNOWN_KEYS }).ok).toBe(false);
    expect(inspectImport({
      payload: makePayload({ version: 99 }), channel: 'store', knownSettingKeys: KNOWN_KEYS,
    }).error).toBe('unsupported-export-version-99');
  });

  test('drops unknown settings keys with a notice (dweb* on store)', () => {
    const res = inspectImport({ payload: makePayload(), channel: 'store', knownSettingKeys: KNOWN_KEYS });
    expect(res.ok).toBe(true);
    if (!res.summary) throw new Error('expected ok result'); // narrow inspectImport union for TS — expect() does not
    expect(res.summary.settingsKeys).toEqual(['devMode']);
    expect(res.summary.settingsDropped).toEqual(['dwebMaxPeers']);
    expect(res.summary.notices.some((n: string) => n.includes('dwebMaxPeers'))).toBe(true);
  });

  test('store package surfaces the §10 dweb-dropped notice', () => {
    const res = inspectImport({
      payload: makePayload({ dweb: { identity: 'did:key:z...' } }),
      channel: 'store',
      knownSettingKeys: KNOWN_KEYS,
    });
    if (!res.summary) throw new Error('expected ok result'); // narrow inspectImport union for TS
    expect(res.summary.dwebDropped).toBe(true);
    expect(res.summary.notices[0]).toBe(
      'Dweb state in this export is not supported in the store package and was skipped.',
    );
  });

  test('preview package keeps dweb state (no drop notice)', () => {
    const res = inspectImport({
      payload: makePayload({ dweb: { identity: 'did:key:z...' } }),
      channel: 'preview',
      knownSettingKeys: KNOWN_KEYS,
    });
    if (!res.summary) throw new Error('expected ok result'); // narrow inspectImport union for TS
    expect(res.summary.dwebPresent).toBe(true);
    expect(res.summary.dwebDropped).toBe(false);
  });
});

describe('applyImport', () => {
  const stubIo = () => {
    const calls: Record<string, any[]> = {
      applySettings: [], setProviderEndpoints: [], setSecret: [], importMemory: [], saveHook: [],
    };
    return {
      calls,
      io: {
        applySettings: async (p: any) => { calls.applySettings.push(p); },
        setProviderEndpoints: async (v: any) => { calls.setProviderEndpoints.push(v); },
        setSecret: async (n: string, v: string) => { calls.setSecret.push([n, v]); },
        importMemory: async (p: any) => { calls.importMemory.push(p); return { written: p.docs.length, skipped: 0 }; },
        saveHook: async (r: any) => { calls.saveHook.push(r); },
      },
    };
  };

  test('applies only known settings; preserves explicit values verbatim', async () => {
    const { calls, io } = stubIo();
    const res = await applyImport({
      payload: makePayload(), channel: 'store', knownSettingKeys: KNOWN_KEYS, io,
    });
    expect(res.ok).toBe(true);
    if (!('imported' in res)) throw new Error('expected applied result'); // narrow applyImport union for TS
    // devMode: true travels even though the store default is false — the
    // user's explicit choice wins (§11 cross-channel nuances).
    expect(calls.applySettings).toEqual([{ devMode: true }]);
    expect(res.imported).toEqual({ settings: 1, secrets: 0, memoryWritten: 1, hooks: 1 });
  });

  test('secrets import is all-or-nothing on a bad passphrase', async () => {
    const { calls, io } = stubIo();
    const secrets = await encryptWithPassphrase('right', { anthropic: 'sk-2' });
    await expect(applyImport({
      payload: makePayload({ secrets }), passphrase: 'wrong',
      channel: 'preview', knownSettingKeys: KNOWN_KEYS, io,
    })).rejects.toBeInstanceOf(ExportPassphraseError);
    expect(calls.setSecret).toEqual([]);

    const res = await applyImport({
      payload: makePayload({ secrets }), passphrase: 'right',
      channel: 'preview', knownSettingKeys: KNOWN_KEYS, io,
    });
    expect(res.ok).toBe(true);
    expect(calls.setSecret).toEqual([['anthropic', 'sk-2']]);
  });
});

// R6 — transfer import is an untrusted-deserialization surface. The three
// authority-bearing sections get gates: endpoints validated to https/local
// loopback, hooks quarantined (disabled + untrusted), memory named loudly.
describe('R6 import gates', () => {
  const stubIo = () => {
    const calls: Record<string, any[]> = {
      applySettings: [], setProviderEndpoints: [], setSecret: [], importMemory: [], saveHook: [],
    };
    return {
      calls,
      io: {
        applySettings: async (p: any) => { calls.applySettings.push(p); },
        setProviderEndpoints: async (v: any) => { calls.setProviderEndpoints.push(v); },
        setSecret: async (n: string, v: string) => { calls.setSecret.push([n, v]); },
        importMemory: async (p: any) => { calls.importMemory.push(p); return { written: p.docs.length, skipped: 0 }; },
        saveHook: async (r: any) => { calls.saveHook.push(r); },
      },
    };
  };

  test('non-https endpoints are dropped and named; https + local loopback pass', async () => {
    const { calls, io } = stubIo();
    const res = await applyImport({
      payload: makePayload({
        providerEndpoints: { endpoints: [
          { url: 'https://api.good.example/v1' },
          { url: 'http://localhost:11434' },
          { url: 'http://evil.example/steal' },
          { url: 'ftp://weird.example' },
          { url: 'not a url' },
        ] },
      }),
      channel: 'preview', knownSettingKeys: KNOWN_KEYS, io,
    });
    expect(res.ok).toBe(true);
    expect(calls.setProviderEndpoints.length).toBe(1);
    const applied = calls.setProviderEndpoints[0].endpoints.map((e: any) => e.url);
    expect(applied).toEqual(['https://api.good.example/v1', 'http://localhost:11434']);
    if (!('notices' in res)) throw new Error('expected notices');
    expect((res.notices as string[]).some((n) => n.includes('Dropped 3'))).toBe(true);
  });

  test('imported hooks land DISABLED and UNTRUSTED regardless of the file\'s flags', async () => {
    const { calls, io } = stubIo();
    await applyImport({
      payload: makePayload({ hooks: [{ id: 'h1', event: 'pre-tool-use', kind: 'js', enabled: true, trusted: true, body: 'return {}' }] }),
      channel: 'preview', knownSettingKeys: KNOWN_KEYS, io,
    });
    expect(calls.saveHook.length).toBe(1);
    expect(calls.saveHook[0].enabled).toBe(false);
    expect(calls.saveHook[0].trusted).toBe(false);
    expect(calls.saveHook[0].body).toBe('return {}'); // the record itself is preserved for review
  });

  test('the inspect summary names endpoint urls and hook quarantine BEFORE apply', () => {
    const res = inspectImport({
      payload: makePayload({
        providerEndpoints: { endpoints: [{ url: 'https://api.custom.example/v1' }] },
        hooks: [{ id: 'h1', event: 'pre-tool-use' }, { id: 'h2', event: 'post-tool-use' }],
      }),
      channel: 'preview', knownSettingKeys: KNOWN_KEYS,
    });
    if (!res.ok || !res.summary) throw new Error('expected ok summary');
    expect((res.summary as any).endpointUrls).toEqual(['https://api.custom.example/v1']);
    expect((res.summary as any).hookIds).toEqual(['h1', 'h2']);
    const joined = res.summary.notices.join(' ');
    expect(joined).toContain('api.custom.example');
    expect(joined).toContain('DISABLED');
  });

  test('a memory import states its consequence in the notices', async () => {
    const { io } = stubIo();
    const res = await applyImport({
      payload: makePayload(), channel: 'preview', knownSettingKeys: KNOWN_KEYS, io,
    });
    if (!res.ok || !('notices' in res)) throw new Error('expected notices');
    expect((res.notices as string[]).some((n) => n.includes('memory doc'))).toBe(true);
  });
});
