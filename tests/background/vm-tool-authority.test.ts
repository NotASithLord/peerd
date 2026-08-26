import { describe, expect, test } from 'bun:test';
import { createVmToolAuthority } from '../../extension/background/vm-tool-authority.js';
import { executeControllerVmTool } from '../../extension/peerd-runtime/controller-vm-tools.js';

const context = (overrides: Record<string, any> = {}) => ({
  session: { sessionId: 'session-1' },
  vm: {
    run: async () => ({ stdout: 'ok\n', exitCode: 0, durationMs: 2 }),
    writeFile: async () => undefined,
  },
  vmRegistry: {
    get: async (id: string) => ({ id, name: 'work', pinned: false, diskOverlayKey: 'disk-1' }),
    list: async () => [{ id: 'vm-1', name: 'work' }],
    setDefaultForSession: async () => undefined,
    delete: async () => undefined,
  },
  vmTabTracker: { closeTab: async () => undefined },
  webFetch: async () => new Response('payload', {
    status: 200, headers: { 'content-type': 'application/octet-stream' },
  }),
  ...overrides,
});

describe('exact WebVM authority', () => {
  test('runs admitted command semantics without exposing the VM client', async () => {
    const call = { name: 'vm_boot', args: { cmd: 'echo ok', vm: 'work', timeoutMs: 2000 } };
    const authority = createVmToolAuthority({ call, ctx: context() });
    const result = await executeControllerVmTool('vm_boot', call.args, authority);
    expect(result).toMatchObject({ ok: true });
    expect(result.content).toContain('$ echo ok');
  });

  test('refuses a changed command after admission', async () => {
    const authority = createVmToolAuthority({
      call: { name: 'vm_boot', args: { cmd: 'echo safe' } }, ctx: context(),
    });
    let failure: any;
    try { await authority.runVm('echo changed', 60_000, undefined); }
    catch (cause) { failure = cause; }
    expect(failure).toMatchObject({ message: 'VM authority mismatch', outcomeKnown: true });
  });

  test('keeps fetched bytes inside authority and returns bounded metadata', async () => {
    let written: Uint8Array | undefined;
    const call = {
      name: 'vm_import',
      args: { url: 'https://example.com/a.bin', path: '/tmp/a.bin' },
    };
    const authority = createVmToolAuthority({
      call,
      ctx: context({
        vm: { writeFile: async (_path: string, bytes: Uint8Array) => { written = bytes; } },
      }),
    });
    const result = await executeControllerVmTool('vm_import', call.args, authority);
    expect(result).toMatchObject({ ok: true });
    expect(written).toBeInstanceOf(Uint8Array);
    expect(result.content).toContain('"bytes": 7');
  });

  test('rechecks pin state immediately before destructive deletion', async () => {
    let reads = 0;
    let deleted = false;
    const authority = createVmToolAuthority({
      call: { name: 'vm_delete', args: { vmId: 'vm-1' } },
      ctx: context({
        vmRegistry: {
          get: async () => ({
            id: 'vm-1', name: 'work', pinned: reads++ > 0, diskOverlayKey: 'disk-1',
          }),
          delete: async () => { deleted = true; },
        },
      }),
    });
    const result = await executeControllerVmTool(
      'vm_delete', { vmId: 'vm-1' }, authority,
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { error?: string }).error).toContain('VM authority mismatch');
    expect(deleted).toBe(false);
  });
});
