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

const bytesToB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const makeLegacySecretsBox = async (passphrase: string, value: unknown) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)),
  ));
  const data = new Uint8Array(iv.length + ciphertext.length);
  data.set(iv);
  data.set(ciphertext, iv.length);
  return {
    kdf: 'PBKDF2-SHA256', iterations: 600_000, salt: bytesToB64(salt),
    cipher: 'AES-GCM', data: bytesToB64(data),
  };
};

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
    expect(box).toMatchObject({
      kdf: 'Argon2id', memKiB: 64 * 1024, iters: 3, parallelism: 1,
    });
    const back = await decryptWithPassphrase('correct horse', box);
    expect(back).toEqual({ anthropic: 'sk-ant-xyz' });
  });

  test('wrong passphrase throws ExportPassphraseError', async () => {
    const box = await encryptWithPassphrase('right', { k: 'v' });
    await expect(decryptWithPassphrase('wrong', box)).rejects.toBeInstanceOf(ExportPassphraseError);
  });

  test('rejects attacker-controlled KDF parameters before doing crypto', async () => {
    const box = await encryptWithPassphrase('right', { k: 'v' });
    await expect(decryptWithPassphrase('right', { ...box, memKiB: Number.MAX_SAFE_INTEGER }))
      .rejects.toBeInstanceOf(ExportPassphraseError);
    await expect(decryptWithPassphrase('right', { ...box, iterations: 600_000 }))
      .rejects.toBeInstanceOf(ExportPassphraseError);
  });

  test('imports legacy PBKDF2 backups without emitting new PBKDF2 boxes', async () => {
    const legacy = await makeLegacySecretsBox('old backup passphrase', { anthropic: 'sk-old' });
    await expect(decryptWithPassphrase('old backup passphrase', legacy))
      .resolves.toEqual({ anthropic: 'sk-old' });
    const current = await encryptWithPassphrase('new backup passphrase', { anthropic: 'sk-new' });
    expect(JSON.stringify(current)).not.toContain('PBKDF2');
    expect(current.kdf).toBe('Argon2id');
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
    expect(payload.secrets?.kdf).toBe('Argon2id');
    expect(JSON.stringify(payload.secrets)).not.toContain('PBKDF2');
    expect(JSON.stringify(payload)).not.toContain('sk-1'); // never plaintext
  });

  test('refuses secrets without a passphrase', async () => {
    await expect(buildExport({
      channel: 'store', storedSettings: {}, providerEndpoints: null,
      secrets: { anthropic: 'sk-1' }, passphrase: '', memory: null, hooks: [], skills: [],
    })).rejects.toBeInstanceOf(ExportPassphraseError);
  });

  test('no dweb field in identity-less exports', async () => {
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
      payload: makePayload({ version: 1 }), channel: 'store', knownSettingKeys: KNOWN_KEYS,
    }).ok).toBe(true);
    expect(inspectImport({
      payload: makePayload({ version: 99 }), channel: 'store', knownSettingKeys: KNOWN_KEYS,
    }).error).toBe('unsupported-export-version-99');
  });

  test('rejects malformed write-bearing sections during pre-flight', () => {
    for (const malformed of [
      { hooks: { id: 'not-an-array' } },
      { providerEndpoints: { endpoints: {} } },
      { memory: { docs: [null] } },
      { dweb: [] },
      { secrets: { kdf: 'Argon2id', memKiB: Number.MAX_SAFE_INTEGER } },
    ]) {
      expect(inspectImport({
        payload: makePayload(malformed), channel: 'preview', knownSettingKeys: KNOWN_KEYS,
      })).toEqual({ ok: false, error: 'invalid-export-sections' });
    }
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
    expect(res.imported).toEqual({
      settings: 1, secrets: 0, providerEndpoints: 0,
      memoryWritten: 1, hooks: 1, dwebIdentity: 0,
    });
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

  test('the inspect summary calls out an imported Ollama egress destination', () => {
    const res = inspectImport({
      payload: makePayload({ settings: { ollamaHost: 'https://ollama.example.test/path' } }),
      channel: 'preview',
      knownSettingKeys: [...KNOWN_KEYS, 'ollamaHost'],
    });
    if (!res.ok || !res.summary) throw new Error('expected ok summary');
    expect(res.summary.endpointUrls).toContain('https://ollama.example.test');
    expect(res.summary.notices.join(' ')).toContain('ollama.example.test');
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

// The portable-identity section (docs/design/portable-identity/ 02): the
// did travels ONLY as the capsule record in payload.dweb — never as a raw
// seed in the secrets box — and the import side routes the dweb-side
// adoption decision into user-visible notices.
describe('dweb identity section', () => {
  const record = { format: 'peerd-identity-record', version: 1, did: 'did:key:zTest', capsule: 'AAAA', wrappers: [{ kind: 'passphrase', wrappedKey: 'BBBB' }], updatedAt: 1 };

  test('buildExport carries the record and structurally excludes custody secrets', async () => {
    const payload = await buildExport({
      channel: 'preview',
      storedSettings: {},
      providerEndpoints: null,
      secrets: {
        anthropic: 'sk-1',
        'distributed/identity/v1': '{"v":1}',
        'distributed/identity/record/v1': '{}',
        'distributed/device-key/v1': '{"v":1}',
      },
      passphrase: 'pw123456',
      memory: null, hooks: [], skills: [],
      dweb: { identityRecord: record },
    });
    expect(payload.dweb).toEqual({ identityRecord: record });
    const secrets = await decryptWithPassphrase('pw123456', payload.secrets as any);
    expect(Object.keys(secrets)).toEqual(['anthropic']); // seed/device key filtered by mechanism
  });

  test('inspectImport: store drops with the §10 notice; preview names the identity restore', () => {
    const store = inspectImport({ payload: makePayload({ dweb: { identityRecord: record } }), channel: 'store', knownSettingKeys: KNOWN_KEYS });
    if (!store.ok || !store.summary) throw new Error('expected summary');
    expect(store.summary.dwebDropped).toBe(true);
    expect(store.summary.notices[0]).toBe(
      'The peer identity in this preview backup cannot be restored by the store build and will be skipped.',
    );
    const preview = inspectImport({ payload: makePayload({ dweb: { identityRecord: record } }), channel: 'preview', knownSettingKeys: KNOWN_KEYS });
    if (!preview.ok || !preview.summary) throw new Error('expected summary');
    expect(preview.summary.dwebDropped).toBe(false);
    expect(preview.summary.hasIdentityRecord).toBe(true);
    expect(preview.summary.requiresPassphrase).toBe(true);
    expect(preview.summary.identityDid).toBe(record.did);
    expect(preview.summary.notices.join(' ')).toContain('identity record');
  });

  test('applyImport adopts on preview via injected IO, passing the file passphrase through', async () => {
    const adoptions: any[] = [];
    const io = {
      applySettings: async () => {}, setProviderEndpoints: async () => {},
      setSecret: async () => {}, importMemory: async () => ({ written: 0, skipped: 0 }),
      saveHook: async () => {},
      adoptDwebIdentity: async (r: any, pass: string, options: any) => { adoptions.push([r, pass, options]); return { adopted: true, did: r.did, reason: 'recovered' }; },
    };
    const res = await applyImport({
      payload: makePayload({ memory: null, hooks: [], dweb: { identityRecord: record } }),
      passphrase: 'pw123456', channel: 'preview', knownSettingKeys: KNOWN_KEYS, io,
    });
    if (!res.ok || !('imported' in res)) throw new Error('expected applied result');
    expect(adoptions).toEqual([
      [record, 'pw123456', { replaceExisting: false, prepareOnly: true }],
      [record, 'pw123456', {
        replaceExisting: false,
        expectedExistingDid: null,
        expectedIncomingDid: record.did,
      }],
    ]);
    expect((res.imported as any).dwebIdentity).toBe(1);
    expect((res.notices as string[]).join(' ')).toContain('restored');
  });

  test('store never calls the adopter; preview conflicts stop before any other writes', async () => {
    const adoptions: any[] = [];
    const baseIo = {
      applySettings: async () => {}, setProviderEndpoints: async () => {},
      setSecret: async () => {}, importMemory: async () => ({ written: 0, skipped: 0 }),
      saveHook: async () => {},
    };
    const storeRes = await applyImport({
      payload: makePayload({ memory: null, hooks: [], dweb: { identityRecord: record } }),
      channel: 'store', knownSettingKeys: KNOWN_KEYS,
      io: { ...baseIo, adoptDwebIdentity: async (r: any) => { adoptions.push(r); return { adopted: true, reason: 'recovered' }; } },
    });
    expect(storeRes.ok).toBe(true);
    expect(adoptions).toEqual([]);

    const conflict = await applyImport({
      payload: makePayload({ memory: null, hooks: [], dweb: { identityRecord: record } }),
      channel: 'preview', knownSettingKeys: KNOWN_KEYS,
      io: { ...baseIo, adoptDwebIdentity: async () => ({
        adopted: false,
        reason: 'did-conflict',
        existingDid: 'did:key:zOther',
        incomingDid: record.did,
      }) },
    });
    expect(conflict).toEqual({
      ok: false,
      error: 'dweb-identity-conflict',
      conflict: { existingDid: 'did:key:zOther', incomingDid: record.did },
    });

    await expect(applyImport({
      payload: makePayload({ memory: null, hooks: [], dweb: { identityRecord: record } }),
      channel: 'preview', knownSettingKeys: KNOWN_KEYS,
      io: { ...baseIo, adoptDwebIdentity: async () => ({ adopted: false, reason: 'no-openable-wrapper' }) },
    })).rejects.toBeInstanceOf(ExportPassphraseError);
  });

  test('explicit keep and replace choices are passed through', async () => {
    const adopted: any[] = [];
    const baseIo = {
      applySettings: async () => {}, setProviderEndpoints: async () => {},
      setSecret: async () => {}, importMemory: async () => ({ written: 0, skipped: 0 }),
      saveHook: async () => {},
      adoptDwebIdentity: async (_record: any, _pass: string, options: any) => {
        adopted.push(options);
        return {
          adopted: true, reason: 'replaced', did: record.did,
          existingDid: 'did:key:zOld', incomingDid: record.did,
        };
      },
    };
    const skipped = await applyImport({
      payload: makePayload({ memory: null, hooks: [], dweb: { identityRecord: record } }),
      channel: 'preview', knownSettingKeys: KNOWN_KEYS, io: baseIo,
      skipDwebIdentity: true,
    });
    expect(skipped.ok).toBe(true);
    expect(adopted).toEqual([]);

    const replaced = await applyImport({
      payload: makePayload({ memory: null, hooks: [], dweb: { identityRecord: record } }),
      passphrase: 'pw123456', channel: 'preview', knownSettingKeys: KNOWN_KEYS,
      io: baseIo, replaceDwebIdentity: true,
      approvedExistingDwebDid: 'did:key:zOld', approvedIncomingDwebDid: record.did,
    });
    expect(replaced.ok).toBe(true);
    expect(adopted).toEqual([
      { replaceExisting: true, prepareOnly: true },
      { replaceExisting: true, expectedExistingDid: 'did:key:zOld', expectedIncomingDid: record.did },
    ]);
  });

  test('replacement approval is bound to the exact did pair the user reviewed', async () => {
    let writes = 0;
    const result = await applyImport({
      payload: makePayload({
        settings: { devMode: true }, memory: null, hooks: [],
        providerEndpoints: { endpoints: [{ url: 'https://api.example.test/v1' }] },
        dweb: { identityRecord: record },
      }),
      passphrase: 'pw123456', channel: 'preview', knownSettingKeys: KNOWN_KEYS,
      replaceDwebIdentity: true,
      approvedExistingDwebDid: 'did:key:zApprovedOld', approvedIncomingDwebDid: record.did,
      io: {
        applySettings: async () => { writes++; }, setProviderEndpoints: async () => {},
        setSecret: async () => {}, importMemory: async () => ({ written: 0, skipped: 0 }),
        saveHook: async () => {},
        adoptDwebIdentity: async () => ({
          adopted: true, reason: 'replaced', did: record.did,
          existingDid: 'did:key:zChangedWhileDialogOpen', incomingDid: record.did,
        }),
      },
    });
    expect(result).toEqual({
      ok: false, error: 'dweb-identity-conflict',
      conflict: { existingDid: 'did:key:zChangedWhileDialogOpen', incomingDid: record.did },
    });
    expect(writes).toBe(0);
  });

  test('an unreadable local identity becomes a bound destructive conflict', async () => {
    const calls: any[] = [];
    const baseIo = {
      applySettings: async () => {}, setProviderEndpoints: async () => {},
      setSecret: async () => {}, importMemory: async () => ({ written: 0, skipped: 0 }),
      saveHook: async () => {},
      adoptDwebIdentity: async (_record: any, _pass: string, options: any) => {
        calls.push(options);
        return options.replaceExisting
          ? {
              adopted: true, reason: 'replaced-invalid-local', did: record.did,
              existingDid: null, incomingDid: record.did,
              existingUnreadable: true, existingRevision: 'revision-a',
            }
          : {
              adopted: false, reason: 'invalid-local-identity', existingDid: null,
              incomingDid: record.did, existingUnreadable: true, existingRevision: 'revision-a',
            };
      },
    };
    const first = await applyImport({
      payload: makePayload({ memory: null, hooks: [], dweb: { identityRecord: record } }),
      passphrase: 'pw123456', channel: 'preview', knownSettingKeys: KNOWN_KEYS, io: baseIo,
    });
    expect(first).toEqual({
      ok: false, error: 'dweb-identity-conflict',
      conflict: {
        existingDid: null, incomingDid: record.did,
        existingUnreadable: true, existingRevision: 'revision-a',
      },
    });

    const repaired = await applyImport({
      payload: makePayload({ memory: null, hooks: [], dweb: { identityRecord: record } }),
      passphrase: 'pw123456', channel: 'preview', knownSettingKeys: KNOWN_KEYS, io: baseIo,
      replaceDwebIdentity: true,
      approvedExistingDwebRevision: 'revision-a', approvedIncomingDwebDid: record.did,
    });
    expect(repaired).toMatchObject({ ok: true, identityOutcome: 'replaced' });
    expect(calls.at(-1)).toEqual({
      replaceExisting: true,
      expectedExistingDid: null,
      expectedExistingRevision: 'revision-a',
      expectedIncomingDid: record.did,
    });
  });

  test('identity is authenticated first but committed only after all ordinary writes succeed', async () => {
    const events: string[] = [];
    const io = {
      applySettings: async () => { events.push('settings'); throw new Error('disk full'); },
      setProviderEndpoints: async () => {}, setSecret: async () => {},
      importMemory: async () => ({ written: 0, skipped: 0 }), saveHook: async () => {},
      adoptDwebIdentity: async (_record: any, _pass: string, options: any) => {
        events.push(options.prepareOnly ? 'identity-authenticated' : 'identity-committed');
        return {
          adopted: true, reason: 'replaced', did: record.did,
          existingDid: 'did:key:zOld', incomingDid: record.did,
        };
      },
    };
    const result = await applyImport({
      payload: makePayload({
        settings: { devMode: true }, memory: null, hooks: [],
        providerEndpoints: { endpoints: [{ url: 'https://api.example.test/v1' }] },
        dweb: { identityRecord: record },
      }),
      passphrase: 'pw123456', channel: 'preview', knownSettingKeys: KNOWN_KEYS,
      io, replaceDwebIdentity: true,
      approvedExistingDwebDid: 'did:key:zOld', approvedIncomingDwebDid: record.did,
    });
    expect(result).toMatchObject({
      ok: false, error: 'import-partial', failure: 'write-failed',
      partial: { settings: 0, dwebIdentity: 0 }, identityOutcome: 'not-changed',
    });
    expect(events).toEqual(['identity-authenticated', 'settings']);
  });

  test('final identity failure reports every ordinary section already committed', async () => {
    let identityCalls = 0;
    const io = {
      applySettings: async () => {}, setProviderEndpoints: async () => {},
      setSecret: async () => {}, importMemory: async () => ({ written: 0, skipped: 0 }),
      saveHook: async () => {},
      adoptDwebIdentity: async () => {
        identityCalls++;
        if (identityCalls === 1) {
          return { adopted: true, reason: 'replaced', did: record.did, existingDid: 'did:key:zOld', incomingDid: record.did };
        }
        throw Object.assign(new Error('host stopped'), { name: 'IdentityTransferError', code: 'stop-failed' });
      },
    };
    const result = await applyImport({
      payload: makePayload({
        settings: { devMode: true }, memory: null, hooks: [],
        providerEndpoints: { endpoints: [{ url: 'https://api.example.test/v1' }] },
        dweb: { identityRecord: record },
      }),
      passphrase: 'pw123456', channel: 'preview', knownSettingKeys: KNOWN_KEYS,
      io, replaceDwebIdentity: true,
      approvedExistingDwebDid: 'did:key:zOld', approvedIncomingDwebDid: record.did,
    });
    expect(result).toMatchObject({
      ok: false, error: 'import-partial', failure: 'dweb-identity-stop-failed',
      partial: { settings: 1, providerEndpoints: 1, dwebIdentity: 0 }, identityOutcome: 'not-changed',
    });
  });

  test('a committed identity with runtime recovery pending returns success and a notice', async () => {
    let identityCalls = 0;
    const result = await applyImport({
      payload: makePayload({ memory: null, hooks: [], dweb: { identityRecord: record } }),
      passphrase: 'pw123456', channel: 'preview', knownSettingKeys: KNOWN_KEYS,
      io: {
        applySettings: async () => {}, setProviderEndpoints: async () => {},
        setSecret: async () => {}, importMemory: async () => ({ written: 0, skipped: 0 }),
        saveHook: async () => {},
        adoptDwebIdentity: async () => {
          identityCalls++;
          return identityCalls === 1
            ? { adopted: true, reason: 'recovered', did: record.did, existingDid: null, incomingDid: record.did }
            : {
                adopted: true, reason: 'recovered', did: record.did,
                existingDid: null, incomingDid: record.did, runtimeRecoveryPending: true,
              };
        },
      },
    });
    expect(result).toMatchObject({
      ok: true, identityOutcome: 'restored', runtimeRecoveryPending: true,
    });
    if (!result.ok || !('notices' in result)) throw new Error('expected notices');
    expect((result.notices ?? []).join(' ')).toContain('peer network is still recovering');
  });

  test('crafted generic secrets cannot overwrite identity custody records', async () => {
    const writes: any[] = [];
    const secrets = await encryptWithPassphrase('right', {
      anthropic: 'sk-safe',
      'distributed/identity/v1': 'forged-root',
      'distributed/identity/v2': 'future-forged-root',
      'distributed/device-key/v99': 'forged-device',
    });
    const res = await applyImport({
      payload: makePayload({ memory: null, hooks: [], secrets }),
      passphrase: 'right', channel: 'preview', knownSettingKeys: KNOWN_KEYS,
      io: {
        applySettings: async () => {}, setProviderEndpoints: async () => {},
        setSecret: async (name: string, value: string) => { writes.push([name, value]); },
        importMemory: async () => ({ written: 0, skipped: 0 }), saveHook: async () => {},
      },
    });
    expect(res.ok).toBe(true);
    expect(writes).toEqual([['anthropic', 'sk-safe']]);
    if (!res.ok || !('notices' in res)) throw new Error('expected notices');
    expect((res.notices as string[]).join(' ')).toContain('protected identity/device');
  });
});
