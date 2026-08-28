import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { controllerOuterPayloadCap } from '../../extension/shared/controller-kernel-quota.js';
import { controllerPayloadBytes } from '../../extension/shared/structured-clone-size.js';
import {
  assertUserHookRecordsBounded,
  projectSemanticHookManifest,
  SEMANTIC_HOOK_MANIFEST_MAX_BYTES,
  USER_HOOK_RECORDS_MAX_BYTES,
  USER_HOOK_RECORDS_MAX_COUNT,
} from '../../extension/shared/semantic-hook-manifest.js';
import { applyImport, EXPORT_FORMAT, EXPORT_VERSION } from '../../extension/peerd-runtime/transfer/transfer.js';

const hook = (index: number) => ({
  id: `hook-${index}`, event: 'pre-tool-use', enabled: true, order: index,
  match: '*', kind: 'declarative', doc: 'human prose '.repeat(80),
  rule: { matchArg: 'text', contains: `literal-${index}`, onMatch: 'block', reason: 'blocked' },
});

describe('semantic hook manifest', () => {
  test('maximum-count legal policy stays bounded for main and actor turns', () => {
    const durable = Array.from({ length: USER_HOOK_RECORDS_MAX_COUNT }, (_, index) => hook(index));
    expect(assertUserHookRecordsBounded(durable)).toBeLessThan(USER_HOOK_RECORDS_MAX_BYTES);
    const manifest = projectSemanticHookManifest(durable);
    expect(manifest).toHaveLength(USER_HOOK_RECORDS_MAX_COUNT);
    expect(JSON.stringify(manifest)).not.toContain('human prose');
    expect(manifest.every((record: any) => !Object.hasOwn(record, 'doc')
      && !Object.hasOwn(record, 'body'))).toBe(true);
    const bytes = controllerPayloadBytes(manifest);
    expect(bytes).toBeLessThanOrEqual(SEMANTIC_HOOK_MANIFEST_MAX_BYTES);
    expect(bytes).toBeLessThan(controllerOuterPayloadCap('turn.run'));

    const mainSource = readFileSync(join(import.meta.dir,
      '../../extension/peerd-runtime/loop/turn-authority-driver.js'), 'utf8');
    const actorSource = readFileSync(join(import.meta.dir,
      '../../extension/background/kernel-turn-authority-adapter.js'), 'utf8');
    expect(mainSource).toContain('.then(projectSemanticHookManifest)');
    expect(actorSource.match(/\.then\(projectSemanticHookManifest\)/g)).toHaveLength(2);
  });

  test('disabled prose and executable bodies never enter the semantic realm', () => {
    const manifest = projectSemanticHookManifest([{
      id: 'disabled', event: 'pre-tool-use', enabled: false,
      kind: 'js', body: 'throw new Error("must not cross")', doc: 'private note',
    }, {
      id: 'legacy-enabled', event: 'pre-tool-use', enabled: true,
      kind: 'js', body: 'return { action: "allow" }', doc: 'retired source',
    }]);
    expect(manifest).toEqual([{
      id: 'legacy-enabled', event: 'pre-tool-use', enabled: true, kind: 'js',
    }]);
  });

  test('count and aggregate storage excess refuse before persistence', () => {
    expect(() => assertUserHookRecordsBounded(
      Array.from({ length: USER_HOOK_RECORDS_MAX_COUNT + 1 }, (_, index) => hook(index)),
    )).toThrow('hook limit exceeded');
    expect(() => assertUserHookRecordsBounded(Array.from({ length: 129 }, (_, index) => ({
      ...hook(index), doc: 'x'.repeat(64 * 1024),
    })))).toThrow('hook data limit exceeded');
  });

  test('oversized imported hooks refuse before any import write', async () => {
    const hooks = Array.from({ length: 129 }, (_, index) => ({
      ...hook(index), doc: 'x'.repeat(64 * 1024),
    }));
    let writes = 0;
    const result = await applyImport({
      payload: {
        format: EXPORT_FORMAT, version: EXPORT_VERSION, settings: {},
        providerEndpoints: null, secrets: null, memory: null, hooks, skills: [],
      },
      channel: 'store', knownSettingKeys: [],
      io: {
        applySettings: async () => { writes += 1; },
        setProviderEndpoints: async () => { writes += 1; },
        setSecret: async () => { writes += 1; },
        importMemory: async () => { writes += 1; return { written: 0, skipped: 0 }; },
        saveHook: async () => { writes += 1; },
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'hook-records-limit' });
    expect(writes).toBe(0);
  });
});
