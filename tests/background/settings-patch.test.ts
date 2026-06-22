import { describe, test, expect } from 'bun:test';
import { normalizeSettingsPatch } from '../../extension/background/settings-patch.js';

// These pin the contract the `settings/update` route used to inline: only
// whitelisted keys survive, every leaf is clamped/coerced, and a bad value can
// never persist. The route had no unit coverage before extraction — this is it.

const deps = {
  knownProviderNames: ['anthropic', 'openrouter', 'ollama'],
  reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  dwebEnabled: true,
  normalizeVariant: (_v: string) => 'base',
  normalizeEngine: (v: string) => (['auto', 'web-speech', 'moonshine'].includes(v) ? v : 'auto'),
};

const norm = (patch: Record<string, unknown>, over: Partial<typeof deps> = {}) =>
  normalizeSettingsPatch(patch, { ...deps, ...over });

describe('normalizeSettingsPatch — whitelist', () => {
  test('drops unknown keys entirely', () => {
    expect(norm({ hackerKey: 1, providerModel: 'x' })).toEqual({ providerModel: 'x' });
  });
  test('a JSON-parsed __proto__ payload cannot pollute Object.prototype', () => {
    // JSON.parse puts __proto__ as a real own key (unlike an object literal),
    // which is the actual attack surface for a settings blob from storage/import.
    const malicious = JSON.parse('{"__proto__":{"polluted":true},"providerModel":"x"}');
    const out = norm(malicious);
    expect(out).toEqual({ providerModel: 'x' });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as any).polluted).toBeUndefined(); // global prototype untouched
  });
  test('empty patch → empty object', () => {
    expect(norm({})).toEqual({});
  });
  test('garbage-typed known keys are dropped, not coerced to junk', () => {
    expect(norm({ voiceEnabled: 'yes', devMode: 1, reasoningEnabled: null })).toEqual({});
  });
});

describe('normalizeSettingsPatch — booleans + enums', () => {
  test('passes real booleans through', () => {
    expect(norm({ voiceEnabled: true, devMode: false, advancedAutomationEnabled: true, autoMemoryEnabled: false }))
      .toEqual({ voiceEnabled: true, devMode: false, advancedAutomationEnabled: true, autoMemoryEnabled: false });
  });
  test('voiceVariant always coerced through normalizeVariant', () => {
    expect(norm({ voiceVariant: 'whatever' })).toEqual({ voiceVariant: 'base' });
  });
  test('voiceEngine coerces unknown to auto, keeps valid', () => {
    expect(norm({ voiceEngine: 'bogus' })).toEqual({ voiceEngine: 'auto' });
    expect(norm({ voiceEngine: 'moonshine' })).toEqual({ voiceEngine: 'moonshine' });
  });
  test('reasoningEffort gated to known levels', () => {
    expect(norm({ reasoningEffort: 'high' })).toEqual({ reasoningEffort: 'high' });
    expect(norm({ reasoningEffort: 'ultra' })).toEqual({});
  });
});

describe('normalizeSettingsPatch — providers + models', () => {
  test('providerName gated to known providers', () => {
    expect(norm({ providerName: 'anthropic' })).toEqual({ providerName: 'anthropic' });
    expect(norm({ providerName: 'evilcorp' })).toEqual({});
  });
  test('providerModel trims + caps at 200; empty string allowed (means default)', () => {
    expect(norm({ providerModel: '  m  ' })).toEqual({ providerModel: 'm' });
    expect(norm({ providerModel: '' })).toEqual({ providerModel: '' });
    expect((norm({ providerModel: 'x'.repeat(500) }).providerModel as string).length).toBe(200);
  });
  test('openrouterModels: strings only, trimmed, de-duped, capped at 200', () => {
    expect(norm({ openrouterModels: ['a', ' a ', 2, '', 'b', null] })).toEqual({ openrouterModels: ['a', 'b'] });
    const big = Array.from({ length: 300 }, (_, i) => `m${i}`);
    expect((norm({ openrouterModels: big }).openrouterModels as string[]).length).toBe(200);
  });
  test('runnerModel trims + caps; "" means inherit', () => {
    expect(norm({ runnerModel: '  fast  ' })).toEqual({ runnerModel: 'fast' });
    expect(norm({ runnerModel: '' })).toEqual({ runnerModel: '' });
  });
});

describe('normalizeSettingsPatch — numeric clamps', () => {
  test('voiceSilenceMs clamped to [250, 30000] and rounded', () => {
    expect(norm({ voiceSilenceMs: 10 })).toEqual({ voiceSilenceMs: 250 });
    expect(norm({ voiceSilenceMs: 999999 })).toEqual({ voiceSilenceMs: 30_000 });
    expect(norm({ voiceSilenceMs: 1000.7 })).toEqual({ voiceSilenceMs: 1001 });
    expect(norm({ voiceSilenceMs: 'x' })).toEqual({});
  });
  test('vaultAutoLockMs: 0/garbage → 0 (never); else clamp [60000, 24h]', () => {
    expect(norm({ vaultAutoLockMs: 0 })).toEqual({ vaultAutoLockMs: 0 });
    expect(norm({ vaultAutoLockMs: 'nope' })).toEqual({ vaultAutoLockMs: 0 });
    expect(norm({ vaultAutoLockMs: 1000 })).toEqual({ vaultAutoLockMs: 60_000 });
    expect(norm({ vaultAutoLockMs: 999_999_999 })).toEqual({ vaultAutoLockMs: 24 * 60 * 60 * 1000 });
    // present-but-undefined is still "not present" — key omitted
    expect(norm({ vaultAutoLockMs: undefined })).toEqual({});
  });
  test('spendLimitUsd: positive clamps to <=100000; 0/garbage/negative → 0', () => {
    expect(norm({ spendLimitUsd: 5 })).toEqual({ spendLimitUsd: 5 });
    expect(norm({ spendLimitUsd: 1e9 })).toEqual({ spendLimitUsd: 100_000 });
    expect(norm({ spendLimitUsd: -3 })).toEqual({ spendLimitUsd: 0 });
    expect(norm({ spendLimitUsd: 'x' })).toEqual({ spendLimitUsd: 0 });
  });
});

describe('normalizeSettingsPatch — pricingOverrides sanitize', () => {
  test('keeps only finite non-negative rate leaves; drops junk keys + NaN', () => {
    expect(norm({
      pricingOverrides: {
        'm1': { input: 1, output: 2, cacheRead: 0, cacheWrite: 3, evil: 9 },
        'm2': { input: -1, output: 'x' },        // all leaves invalid → model dropped
        'm3': 'not-an-object',
      },
    })).toEqual({ pricingOverrides: { m1: { input: 1, output: 2, cacheRead: 0, cacheWrite: 3 } } });
  });
  test('non-object pricingOverrides dropped', () => {
    expect(norm({ pricingOverrides: 'x' })).toEqual({});
  });
});

describe('normalizeSettingsPatch — dweb gate', () => {
  test('dwebEnabled honored only when the build flag is on', () => {
    expect(norm({ dwebEnabled: true })).toEqual({ dwebEnabled: true });
    expect(norm({ dwebEnabled: true }, { dwebEnabled: false })).toEqual({});
  });
  test('non-boolean dwebEnabled dropped even when build flag on', () => {
    expect(norm({ dwebEnabled: 'yes' })).toEqual({});
  });
});
