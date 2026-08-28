import { beforeEach, describe, expect, test } from 'bun:test';
import { createKernelTransferLive } from '../../extension/background/kernel-executable-transfer-live.js';
import { semanticHooksFor } from '../../extension/peerd-runtime/tools/local-tool-dispatcher.js';
import {
  _clearAllHooks,
  listHooks,
  loadUserHooks,
  saveUserHook,
} from '../../extension/peerd-runtime/tools/hooks/registry.js';
import { runPreToolUse } from '../../extension/peerd-runtime/tools/hooks/runner.js';

const makeKv = () => {
  const records = new Map<string, any>();
  return {
    get: async (key: string) => structuredClone(records.get(key)),
    set: async (key: string, value: any) => { records.set(key, structuredClone(value)); },
  };
};

const makeLive = async (kv: ReturnType<typeof makeKv>) => createKernelTransferLive({
  kv,
  idb: { get: async () => null },
  canWrite: () => {},
  auditLog: { append: async () => {} },
  getDwebTransfer: async () => null,
});

beforeEach(() => _clearAllHooks());

describe('transfer hook durable source', () => {
  test('save, export, and reload share the durable records across runtime realms', async () => {
    const kv = makeKv();
    const live = await makeLive(kv);
    const current = {
      id: 'block-secret', event: 'pre-tool-use', enabled: true,
      kind: 'declarative', rule: { matchArg: 'text', contains: 'secret' },
    };
    await live.saveUserHook({ kv }, current);
    expect(await live.exportHooks()).toEqual([{ ...current, enabled: false }]);

    await loadUserHooks({ kv, warn: () => {} });
    expect(listHooks()).toHaveLength(1);
    expect(listHooks()[0]).toMatchObject({ id: 'block-secret', enabled: false });

    // A management toggle updates the durable record. A fresh semantic turn
    // reads that same key, so the policy applies without a host restart.
    await saveUserHook({ kv }, { ...current, enabled: true } as any);
    const records = await kv.get('hooks.user.v1');
    const semanticHooks = semanticHooksFor(records);
    const decision = await runPreToolUse({
      hooks: [...semanticHooks], toolName: 'type', args: { text: 'a secret' }, ctx: {} as any,
    });
    expect(decision).toMatchObject({ allowed: false, reason: expect.stringContaining('block-secret') });
  });

  test('legacy and reserved records import disabled, remain visible, and round-trip', async () => {
    const kv = makeKv();
    const live = await makeLive(kv);
    const records = [{
      id: 'legacy-js', event: 'pre-tool-use', enabled: true,
      kind: 'js', body: 'return { action: "allow" };', trusted: true,
    }, {
      id: 'legacy-regex', event: 'post-tool-use', enabled: true,
      kind: 'declarative', rule: { matchArg: 'url', pattern: '(a+)+$' },
    }, {
      id: 'egress-allowlist', event: 'pre-tool-use', enabled: true,
      kind: 'declarative', rule: { matchArg: 'url', contains: 'x' },
    }];
    for (const record of records) await live.saveUserHook({ kv }, record);
    expect(await live.exportHooks()).toEqual(records.map((record) => ({
      ...record, enabled: false,
    })));

    await loadUserHooks({ kv, warn: () => {} });
    expect(listHooks()).toHaveLength(3);
    for (const hook of listHooks() as any[]) {
      expect(hook).toMatchObject({ enabled: false, unsupported: true });
    }
  });
});
