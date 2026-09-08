import { beforeEach, describe, expect, test } from 'bun:test';
import { createKernelTransferLive } from '../../extension/background/kernel-executable-transfer-live.js';
import { createKernelAdministrativeControl } from '../../extension/background/kernel-administrative-control.js';
import { createKernelFeatureHost } from '../../extension/offscreen/kernel-feature-host.js';
import { semanticHooksFor } from '../../extension/peerd-runtime/tools/local-tool-dispatcher.js';
import {
  _clearAllHooks,
  listHooks,
  loadUserHooks,
} from '../../extension/peerd-runtime/tools/hooks/registry.js';
import { runPreToolUse } from '../../extension/peerd-runtime/tools/hooks/runner.js';
import { projectSemanticHookManifest } from '../../extension/shared/semantic-hook-manifest.js';
import { KERNEL_FEATURE_DISPATCH_CAPABILITY } from '../../extension/shared/kernel-feature-policy.js';

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

const hookMarkdown = (id: string, contains: string) => [
  '---', `id: ${id}`, 'event: pre-tool-use', 'rule:', '  matchArg: text',
  `  contains: ${contains}`, '  onMatch: block', '---', `Block ${contains}.`,
].join('\n');

const makeAdministrative = (kv: ReturnType<typeof makeKv>) => {
  const host = createKernelFeatureHost({
    loaders: { administrative: () => import('../../extension/offscreen/kernel-administrative-host.js') },
  });
  let control: ReturnType<typeof createKernelAdministrativeControl>;
  control = createKernelAdministrativeControl({
    callFeature: (payload: any, options: any = {}) => {
      const authority = control.authorize(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload);
      const signal = options.signal ?? new AbortController().signal;
      const deadlineAt = Date.now() + 60_000;
      return host.dispatch(payload, {
        signal, authority, deadlineAt,
        kernelCall: (operation: string, value: unknown) => control.handleKernelCall(
          operation, value, {
            capability: KERNEL_FEATURE_DISPATCH_CAPABILITY,
            authority, signal, deadlineAt,
          },
        ),
      });
    },
    kv,
    auditLog: { append: async () => {} },
    canWrite: () => {},
    commitSkill: async () => ({}),
    probeMemoryTab: async () => ({ tab: null }),
    listApps: async () => [],
    idb: { get: async () => null, transact: async () => null },
    confirm: async () => 'yes_once',
    currentSessionId: async () => 'session:test',
    assertMemoryInitAllowed: async () => {},
    postChatNote: () => {},
  } as any);
  return control.routes;
};

beforeEach(() => _clearAllHooks());

describe('transfer hook durable source', () => {
  test('administrative and transfer realms share one durable hook lifecycle', async () => {
    const kv = makeKv();
    const live = await makeLive(kv);
    const administrative = makeAdministrative(kv);

    expect(await administrative['hooks/save']({
      markdown: hookMarkdown('block-secret', 'secret'),
    })).toEqual({ ok: true, id: 'block-secret' });
    expect(await live.exportHooks()).toEqual([expect.objectContaining({
      id: 'block-secret', enabled: true, doc: 'Block secret.',
    })]);

    const imported = {
      id: 'block-token', event: 'pre-tool-use', enabled: true,
      kind: 'declarative', rule: { matchArg: 'text', contains: 'token' },
    };
    await live.prepareHookImport([imported]);
    await live.saveUserHook({ kv }, imported);
    expect(await administrative['hooks/list']()).toMatchObject({
      ok: true,
      hooks: expect.arrayContaining([
        expect.objectContaining({ id: 'block-secret', enabled: true }),
        expect.objectContaining({ id: 'block-token', enabled: false }),
      ]),
    });

    expect(await administrative['hooks/toggle']({ id: 'block-token', enabled: true }))
      .toEqual({ ok: true });
    const records = await kv.get('hooks.user.v1');
    const semanticHooks = semanticHooksFor(projectSemanticHookManifest(records));
    const decision = await runPreToolUse({
      hooks: [...semanticHooks], toolName: 'type', args: { text: 'a token' }, ctx: {} as any,
    });
    expect(decision).toMatchObject({
      allowed: false, reason: expect.stringContaining('block-token'),
    });
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
