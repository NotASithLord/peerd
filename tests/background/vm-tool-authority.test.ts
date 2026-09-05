import { describe, expect, test } from 'bun:test';
import { createVmToolAuthority } from '../../extension/background/vm-tool-authority.js';
import { executeControllerVmTool } from '../../extension/peerd-runtime/controller-vm-tools.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
};

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
  test('Stop during the fresh destroy probe prevents tab and registry deletion', async () => {
    let releaseProbe!: () => void;
    let probeStarted!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    const controller = new AbortController();
    const shared: any = {};
    let reads = 0;
    let closes = 0;
    let deletes = 0;
    const ctx = context({
      actorType: 'webvm', actorInstanceId: 'vm-1',
      vmRegistry: {
        get: async () => {
          reads += 1;
          if (reads === 2) {
            probeStarted();
            await probeGate;
          }
          return { id: 'vm-1', name: 'work', pinned: false, diskOverlayKey: 'disk-1' };
        },
        delete: async () => { deletes += 1; },
      },
      vmTabTracker: { closeTab: async () => { closes += 1; } },
    });
    const read = createVmToolAuthority({
      binding: { operation: 'turn.vm.read', args: { vmId: 'vm-1' } },
      ctx, signal: controller.signal, shared,
    });
    await read.readVm('vm-1');
    const destroy = createVmToolAuthority({
      binding: { operation: 'turn.vm.destroy', args: { vmId: 'vm-1' } },
      ctx, signal: controller.signal, shared,
    });
    const pending = destroy.destroyVm('vm-1');
    await started;
    controller.abort();
    releaseProbe();
    await expect(pending).rejects.toMatchObject({
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    });
    expect(closes).toBe(0);
    expect(deletes).toBe(0);
  });

  test('runs admitted command semantics without exposing the VM client', async () => {
    const call = { name: 'vm_boot', args: { cmd: 'echo ok', vm: 'work', timeoutMs: 2000 } };
    const authority = {
      readVm: async () => ({ id: 'vm-1', name: 'work', pinned: false }),
      listVms: async () => [{ id: 'vm-1', name: 'work' }],
      setDefaultVm: async () => undefined,
      runVm: async () => ({ stdout: 'ok\n', exitCode: 0, durationMs: 2 }),
    };
    const result = await executeControllerVmTool('vm_boot', call.args, authority);
    expect(result).toMatchObject({ ok: true });
    expect(result.content).toContain('$ echo ok');
  });

  test('refuses a changed command after admission', async () => {
    const authority = createVmToolAuthority({
      binding: {
        operation: 'turn.vm.run',
        args: { command: 'echo safe', timeoutMs: 60_000, vmId: undefined },
      },
      ctx: context(),
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
      binding: {
        operation: 'turn.vm.import-file', args: { url: call.args.url, path: call.args.path },
      },
      ctx: context({
        vm: { writeFile: async (_path: string, bytes: Uint8Array) => { written = bytes; } },
      }),
    });
    const result = await executeControllerVmTool('vm_import', call.args, authority);
    expect(result).toMatchObject({ ok: true });
    expect(written).toBeInstanceOf(Uint8Array);
    expect(result.content).toContain('"bytes": 7');
  });

  test('Stop settles while an observing fetch is waiting for response headers', async () => {
    const stop = new AbortController();
    let transportSignal: AbortSignal | undefined;
    let written = false;
    const authority = createVmToolAuthority({
      binding: {
        operation: 'turn.vm.import-file',
        args: { url: 'https://example.com/pending.bin', path: '/tmp/pending.bin' },
      },
      signal: stop.signal,
      ctx: context({
        webFetch: (_url: string, init?: RequestInit) => {
          transportSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(
              new DOMException('Aborted', 'AbortError'),
            ), { once: true });
          });
        },
        vm: { writeFile: async () => { written = true; } },
      }),
    });
    const pending = authority.importFile(
      'https://example.com/pending.bin', '/tmp/pending.bin', 50 * 1024 * 1024,
    );
    await Promise.resolve();
    expect(transportSignal).toBe(stop.signal);
    stop.abort('stopped');
    await expect(pending).rejects.toMatchObject({
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    });
    expect(written).toBe(false);
  });

  test('Stop settles before an abort-ignoring response and cancels its late body', async () => {
    const stop = new AbortController();
    const response = deferred<Response>();
    const bodyCancelled = deferred<void>();
    let entered!: () => void;
    const fetchEntered = new Promise<void>((resolve) => { entered = resolve; });
    let written = false;
    const authority = createVmToolAuthority({
      binding: {
        operation: 'turn.vm.import-file',
        args: { url: 'https://example.com/late.bin', path: '/tmp/late.bin' },
      },
      signal: stop.signal,
      ctx: context({
        webFetch: async (_url: string, init?: RequestInit) => {
          expect(init?.signal).toBe(stop.signal);
          entered();
          return response.promise;
        },
        vm: { writeFile: async () => { written = true; } },
      }),
    });
    const pending = authority.importFile(
      'https://example.com/late.bin', '/tmp/late.bin', 50 * 1024 * 1024,
    );
    await fetchEntered;
    stop.abort('stopped');
    await expect(pending).rejects.toMatchObject({
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    });
    response.resolve(new Response(new ReadableStream({
      cancel: () => { bodyCancelled.resolve(); },
    })));
    await bodyCancelled.promise;
    expect(written).toBe(false);
  });

  test('rejects an oversized declared import before reading or writing', async () => {
    let cancelled = false;
    let written = false;
    const authority = createVmToolAuthority({
      binding: {
        operation: 'turn.vm.import-file',
        args: { url: 'https://example.com/large.bin', path: '/tmp/large.bin' },
      },
      ctx: context({
        webFetch: async () => ({
          ok: true, status: 200,
          headers: new Headers({
            'content-type': 'application/octet-stream',
            'content-length': String(50 * 1024 * 1024 + 1),
          }),
          body: { cancel: () => { cancelled = true; } },
        }),
        vm: { writeFile: async () => { written = true; } },
      }),
    });
    await expect(authority.importFile(
      'https://example.com/large.bin', '/tmp/large.bin', 50 * 1024 * 1024,
    )).rejects.toThrow(`payload_too_large: ${50 * 1024 * 1024 + 1}B > ${50 * 1024 * 1024}B`);
    expect(cancelled).toBe(true);
    expect(written).toBe(false);
  });

  test('rejects an oversized chunked import and cancels without writing', async () => {
    const limit = 50 * 1024 * 1024;
    let cancelled = false;
    let written = false;
    let sent = false;
    const authority = createVmToolAuthority({
      binding: {
        operation: 'turn.vm.import-file',
        args: { url: 'https://example.com/chunked.bin', path: '/tmp/chunked.bin' },
      },
      ctx: context({
        webFetch: async () => ({
          ok: true, status: 200,
          headers: new Headers({ 'content-type': 'application/octet-stream' }),
          body: { getReader: () => ({
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: new Uint8Array(limit + 1) };
            },
            cancel: () => { cancelled = true; },
            releaseLock: () => {},
          }) },
        }),
        vm: { writeFile: async () => { written = true; } },
      }),
    });
    await expect(authority.importFile(
      'https://example.com/chunked.bin', '/tmp/chunked.bin', limit,
    )).rejects.toThrow(`payload_too_large: ${limit + 1}B > ${limit}B`);
    expect(cancelled).toBe(true);
    expect(written).toBe(false);
  });

  test('rechecks pin state immediately before destructive deletion', async () => {
    let reads = 0;
    let deleted = false;
    const ctx = context({
        vmRegistry: {
          get: async () => ({
            id: 'vm-1', name: 'work', pinned: reads++ > 0, diskOverlayKey: 'disk-1',
          }),
          delete: async () => { deleted = true; },
        },
      });
    const shared: any = {};
    const read = createVmToolAuthority({
      binding: { operation: 'turn.vm.read', args: { vmId: 'vm-1' } }, ctx, shared,
    });
    await read.readVm('vm-1');
    const destroy = createVmToolAuthority({
      binding: { operation: 'turn.vm.destroy', args: { vmId: 'vm-1' } }, ctx, shared,
    });
    await expect(destroy.destroyVm('vm-1')).rejects.toThrow('VM authority mismatch');
    expect(deleted).toBe(false);
  });
});
