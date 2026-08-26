import { describe, expect, test } from 'bun:test';
import { handleSandboxCreateEffect } from '../../../extension/peerd-runtime/tools/sandbox-create-effects.js';

const payload = (value: unknown) => ({ json: JSON.stringify(value) });
const decode = (result: any) => JSON.parse(result.value.json);
const binding = () => ({
  sessionId: 'session-1', signal: new AbortController().signal,
});

describe('sandbox_create kernel effects', () => {
  test('binds tab and default mutations to the record created by this execution', async () => {
    const calls: any[] = [];
    const custody = {
      call: { id: 'call-1' },
      ctx: {
        vmRegistry: {
          create: async (options: any) => {
            calls.push(['create', options]);
            return { id: 'vm-1', name: options.name };
          },
          delete: async (id: string) => calls.push(['delete', id]),
          setDefaultForSession: async (sessionId: string, id: string) =>
            calls.push(['default', sessionId, id]),
        },
        vmTabTracker: {
          ensureTab: async (id: string, options: any) => calls.push(['tab', id, options]),
          getTabId: () => 42,
        },
      },
    };
    const created = await handleSandboxCreateEffect({
      custody, operation: 'sandbox.record.mutate', binding: binding(),
      payload: payload({
        kind: 'webvm', action: 'create',
        options: { name: ' builder ', ownerSessionId: 'forged-session' },
      }),
    });
    expect(decode(created)).toEqual({ id: 'vm-1', name: 'builder' });
    expect(calls[0]).toEqual(['create', { name: 'builder', ownerSessionId: 'session-1' }]);

    const mismatch = await handleSandboxCreateEffect({
      custody, operation: 'sandbox.tab.ensure', binding: binding(),
      payload: payload({ kind: 'webvm', id: 'vm-foreign' }),
    });
    expect(mismatch).toMatchObject({ ok: false, code: 'sandbox-tab-request-invalid' });

    await handleSandboxCreateEffect({
      custody, operation: 'sandbox.tab.ensure', binding: binding(),
      payload: payload({ kind: 'webvm', id: 'vm-1' }),
    });
    await handleSandboxCreateEffect({
      custody, operation: 'sandbox.record.mutate', binding: binding(),
      payload: payload({ kind: 'webvm', action: 'default', id: 'vm-1' }),
    });
    expect(calls.slice(1)).toEqual([
      ['tab', 'vm-1', { active: false, groupTitle: 'peerd' }],
      ['default', 'session-1', 'vm-1'],
    ]);
  });

  test('reconstructs Git consent and binds clone to the approved remote', async () => {
    const confirms: any[] = [];
    const clones: any[] = [];
    const custody = {
      call: { id: 'call-2' },
      ctx: {
        jsRegistry: {
          create: async () => ({ id: 'notebook-1', name: 'repo' }),
          delete: async () => {}, setDefaultForSession: async () => {},
        },
        confirm: async (prompt: any) => { confirms.push(prompt); return 'yes_once'; },
        repositories: {
          clone: async (ref: any, options: any) => {
            clones.push([ref, options]);
            return { branch: 'main' };
          },
          destroy: async () => {},
        },
      },
    };
    await handleSandboxCreateEffect({
      custody, operation: 'sandbox.record.mutate', binding: binding(),
      payload: payload({ kind: 'notebook', action: 'create', options: {} }),
    });
    await handleSandboxCreateEffect({
      custody, operation: 'sandbox.git.confirm', binding: binding(),
      payload: payload({ kind: 'notebook', url: 'https://github.com/example/repo.git' }),
    });
    const cloned = await handleSandboxCreateEffect({
      custody, operation: 'sandbox.repository.mutate', binding: binding(),
      payload: payload({
        action: 'clone', ref: { kind: 'notebook', id: 'notebook-1' },
        options: { url: 'https://github.com/example/repo.git', depth: 20 },
      }),
    });
    expect(decode(cloned)).toEqual({ branch: 'main' });
    expect(confirms[0]).toMatchObject({
      tool: 'sandbox_create', kind: 'git_clone',
      origins: ['https://github.com'], sessionId: 'session-1', dispatchId: 'call-2',
    });
    expect(clones[0][0]).toEqual({ kind: 'notebook', id: 'notebook-1' });
    expect(clones[0][1]).toMatchObject({
      url: 'https://github.com/example/repo.git', depth: 20,
    });
  });

  test('reports a local privileged failure as known instead of transport loss', async () => {
    const custody = {
      call: { id: 'call-3' },
      ctx: {
        appClient: {
          create: async () => ({ id: 'app-1', name: 'Demo', entryFile: 'index.html' }),
          open: async () => { throw new Error('tab refused'); },
        },
      },
    };
    await handleSandboxCreateEffect({
      custody, operation: 'sandbox.app.persist', binding: binding(),
      payload: payload({ mode: 'create', options: { name: 'Demo', files: {} } }),
    });
    const result = await handleSandboxCreateEffect({
      custody, operation: 'sandbox.app.open', binding: binding(),
      payload: payload({ appId: 'app-1', sessionId: 'forged', focus: true }),
    });
    expect(result).toEqual({
      ok: false, code: 'sandbox-effect-failed', error: 'tab refused', outcomeKnown: true,
    });
  });
});
