import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDeferredRepositoryClient,
  createOffscreenRepositoryClient,
  decodeRepositoryRpcValue,
  encodeRepositoryRpcValue,
  makeRepositoryKernelFetch,
} from '../../extension/background/repository-client.js';
import { createLazyLocalRepositoryClient } from '../../extension/background/repository-local-client.js';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import {
  REPOSITORY_CHANNEL_CANCEL,
  REPOSITORY_CHANNEL_RESULT,
  REPOSITORY_KERNEL_FETCH,
  REPOSITORY_KERNEL_FETCH_RESULT,
} from '../../extension/shared/repository-channel.js';
import {
  REPOSITORY_CHANNEL_PROTOCOL,
  parseRepositoryChannelOffer,
  repositoryMethodIsMutating,
} from '../../extension/shared/feature-lease-protocol.js';
import { admitRepositoryChannelOffer } from '../../extension/offscreen/supervisor-channels.js';
import { acceptRepositoryOffer } from '../../extension/offscreen/repository-host.js';
import { createRepositoryAppFileService } from '../../extension/offscreen/repository-app-files.js';

const ref = { kind: 'app', id: 'app-one' };
const testLease = {
  scope: 'controller', leaseId: 'repository-test-lease', generation: 1,
  buildId: `0.7.0:${'0'.repeat(64)}`, kernelEpoch: 'repository-test-kernel',
  hostEpoch: 'repository-test-host',
};
const makePrivateClient = (
  handle: (message: any) => any,
  options: Record<string, unknown> = {},
) => {
  const offscreenUrl = 'chrome-extension://id/offscreen/offscreen.html';
  return createOffscreenRepositoryClient({
    withHost: (operation: any) => operation(testLease),
    offscreenUrl,
    kernelFetch: async () => ({ ok: true, status: 200, headers: {}, bodyB64: '' }),
    listWindowClients: async () => [{
      url: offscreenUrl,
      postMessage(offer: any, ports: MessagePort[]) {
        const port = ports[0];
        port.onmessage = (event) => {
          if (event.data?.type === REPOSITORY_CHANNEL_CANCEL) {
            void handle({ type: 'repository/host-cancel', callId: offer.channelId });
          }
        };
        port.start();
        Promise.resolve().then(() => handle({
          type: 'repository/host-call', callId: offer.channelId, method: offer.method,
          args: decodeRepositoryRpcValue(offer.args),
        })).then((reply) => {
          if (reply === undefined) return;
          port.postMessage({
            type: REPOSITORY_CHANNEL_RESULT,
            protocol: REPOSITORY_CHANNEL_PROTOCOL,
            channelId: offer.channelId,
            ...reply,
            result: encodeRepositoryRpcValue(reply.result),
          });
        }, (cause) => port.postMessage({
          type: REPOSITORY_CHANNEL_RESULT,
          protocol: REPOSITORY_CHANNEL_PROTOCOL,
          channelId: offer.channelId,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
          code: 'repository-host-transport-lost',
          outcomeKnown: !repositoryMethodIsMutating(offer.method),
        }));
      },
    }],
    ...options,
  });
};

class MemoryDirectory {
  entries = new Map<string, any>();
  async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    const entry = this.entries.get(name);
    if (entry instanceof MemoryDirectory) return entry;
    if (!options.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    const directory = new MemoryDirectory();
    this.entries.set(name, directory);
    return directory;
  }
  async getFileHandle(name: string, options: { create?: boolean } = {}) {
    let entry = this.entries.get(name);
    if (!entry && options.create) {
      entry = { kind: 'file', name, bytes: new Uint8Array() };
      this.entries.set(name, entry);
    }
    if (!entry || entry instanceof MemoryDirectory) {
      throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    }
    return {
      getFile: async () => ({
        size: entry.bytes.byteLength,
        text: async () => new TextDecoder().decode(entry.bytes),
        arrayBuffer: async () => entry.bytes.slice().buffer,
      }),
      createWritable: async () => {
        let next = entry.bytes;
        return {
          write: async (value: Uint8Array) => { next = Uint8Array.from(value); },
          close: async () => { entry.bytes = next; },
          abort: async () => {},
        };
      },
    };
  }
  async removeEntry(name: string) {
    if (!this.entries.delete(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
  }
  async *values(): AsyncGenerator<any> {
    for (const [name, entry] of this.entries) {
      yield entry instanceof MemoryDirectory
        ? { kind: 'directory', name, values: () => entry.values() }
        : { ...entry, getFile: async () => ({ size: entry.bytes.byteLength }) };
    }
  }
}

describe('operation-lazy offscreen repository split', () => {
  test('preserves binary trees across the private-channel codec', () => {
    const largeBytes = Uint8Array.from(
      { length: 70_000 }, (_, index) => (index * 17 + 11) & 0xff,
    );
    const source = {
      text: 'readable',
      files: {
        'assets/texture.bin': new Uint8Array([0, 1, 2, 255]),
        nested: { bytes: largeBytes, buffer: largeBytes.slice().buffer },
      },
    };
    const decoded = decodeRepositoryRpcValue(encodeRepositoryRpcValue(source)) as typeof source;
    expect(decoded.text).toBe(source.text);
    expect([...decoded.files['assets/texture.bin']]).toEqual([0, 1, 2, 255]);
    expect(decoded.files.nested.bytes).toEqual(largeBytes);
    expect(new Uint8Array(decoded.files.nested.buffer)).toEqual(largeBytes);
  });

  test('keeps the transaction lane separate from the operation lane', async () => {
    const calls: any[] = [];
    const client = makePrivateClient(async (message: any) => {
      calls.push(message);
      return { ok: true, result: { oid: 'abc123', created: true } };
    }, {
      newId: () => `repository-call-${calls.length + 1}`,
    });
    const result = await client.coordinate(ref, () => client.commit(ref, { message: 'checkpoint' }));
    expect(result).toEqual({ oid: 'abc123', created: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: 'repository/host-call', method: 'commit',
      args: [ref, { message: 'checkpoint' }],
    });
  });

  test('binds Git and reverse credentialed fetch to one exact lease-owned private port', async () => {
    const offers: any[] = [];
    const fetches: any[] = [];
    const lease = {
      scope: 'controller', leaseId: 'lease-controller-private', generation: 1,
      buildId: `0.7.0:${'a'.repeat(64)}`, kernelEpoch: 'kernel-private-epoch',
      hostEpoch: 'host-private-epoch',
    };
    const offscreenUrl = 'chrome-extension://id/offscreen/offscreen.html';
    const client = createOffscreenRepositoryClient({
      ensureHost: async () => {},
      withHost: (operation: any) => operation(lease),
      offscreenUrl,
      kernelFetch: async (request: any) => {
        fetches.push(request);
        return { ok: true, status: 200, headers: {}, bodyB64: '' };
      },
      newId: () => 'repository-private-call',
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage(offer: any, ports: MessagePort[]) {
          offers.push(offer);
          const admitted = parseRepositoryChannelOffer(offer);
          expect(admitted?.lease).toEqual(lease);
          const port = ports[0];
          port.onmessage = (event) => {
            const reply = event.data;
            if (reply.type !== REPOSITORY_KERNEL_FETCH_RESULT) return;
            expect(reply.ok).toBe(true);
            port.postMessage({
              type: REPOSITORY_CHANNEL_RESULT,
              protocol: REPOSITORY_CHANNEL_PROTOCOL,
              channelId: offer.channelId,
              ok: true,
              result: encodeRepositoryRpcValue({ dirty: false }),
              outcomeKnown: true,
            });
          };
          port.start();
          port.postMessage({
            type: REPOSITORY_KERNEL_FETCH,
            protocol: REPOSITORY_CHANNEL_PROTOCOL,
            channelId: offer.channelId,
            fetchId: `${offer.channelId}:fetch:1`,
            request: {
              remote: 'https://example.com/owner/a.git',
              url: 'https://example.com/owner/a.git/info/refs',
            },
          });
        },
      }],
    });
    await expect(client.fetch(ref)).resolves.toEqual({ dirty: false });
    expect(offers).toHaveLength(1);
    expect(fetches).toHaveLength(1);
  });

  test('the admitted host executes once on the private port and refuses channel replay', async () => {
    const channelId = 'repository-host-integration';
    const lease = {
      scope: 'controller', leaseId: 'lease-host-integration', generation: 2,
      buildId: `0.7.0:${'b'.repeat(64)}`, kernelEpoch: 'kernel-host-integration',
      hostEpoch: 'renderer-host-integration',
    };
    const offer = {
      type: 'peerd/repository-channel', protocol: REPOSITORY_CHANNEL_PROTOCOL,
      channelId, method: 'status', args: [ref], lease,
    };
    const first = new MessageChannel();
    const calls: any[] = [];
    expect(acceptRepositoryOffer({ data: offer, ports: [first.port2] } as any, {
      ownsLease: () => true,
      createService: () => ({
        status: async (...args: any[]) => { calls.push(args); return { dirty: false }; },
      }),
    })).toBe(true);
    const result = await new Promise<any>((resolve) => {
      first.port1.onmessage = (event) => resolve(event.data);
      first.port1.start();
    });
    expect(result).toMatchObject({
      type: REPOSITORY_CHANNEL_RESULT, channelId, ok: true, outcomeKnown: true,
    });
    expect(decodeRepositoryRpcValue(result.result)).toEqual({ dirty: false });
    expect(calls).toEqual([[ref]]);

    const replay = new MessageChannel();
    expect(acceptRepositoryOffer({ data: offer, ports: [replay.port2] } as any, {
      ownsLease: () => true,
      createService: () => { throw new Error('replay must not load the host'); },
    })).toBe(false);
  });

  test('rechecks the exact lease after lazy host import before any operation dispatch', async () => {
    const lease = {
      scope: 'controller', leaseId: 'lease-revoked-during-load', generation: 4,
      buildId: `0.7.0:${'d'.repeat(64)}`, kernelEpoch: 'kernel-revoked-during-load',
      hostEpoch: 'host-revoked-during-load',
    };
    const offer = {
      type: 'peerd/repository-channel', protocol: REPOSITORY_CHANNEL_PROTOCOL,
      channelId: 'repository-revoked-during-load', method: 'commit', args: [ref], lease,
    };
    const channel = new MessageChannel();
    let dispatches = 0;
    expect(acceptRepositoryOffer({ data: offer, ports: [channel.port2] } as any, {
      ownsLease: () => false,
      createService: () => { dispatches += 1; return {}; },
    })).toBe(false);
    const result = await new Promise<any>((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data);
      channel.port1.start();
    });
    expect(result).toMatchObject({
      type: REPOSITORY_CHANNEL_RESULT,
      code: 'repository-channel-lease-stale',
      ok: false,
      outcomeKnown: true,
    });
    expect(dispatches).toBe(0);
  });

  test('a read-only private port cannot redeem the kernel Git credential capability', async () => {
    let fetches = 0;
    const lease = {
      scope: 'controller', leaseId: 'lease-read-no-fetch', generation: 1,
      buildId: `0.7.0:${'e'.repeat(64)}`, kernelEpoch: 'kernel-read-no-fetch',
      hostEpoch: 'host-read-no-fetch',
    };
    const offscreenUrl = 'chrome-extension://id/offscreen/offscreen.html';
    const client = createOffscreenRepositoryClient({
      ensureHost: async () => {},
      withHost: (operation: any) => operation(lease),
      offscreenUrl,
      kernelFetch: async () => { fetches += 1; return { ok: true }; },
      newId: () => 'repository-read-no-fetch',
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage(offer: any, ports: MessagePort[]) {
          const port = ports[0];
          port.start();
          port.postMessage({
            type: REPOSITORY_KERNEL_FETCH,
            protocol: REPOSITORY_CHANNEL_PROTOCOL,
            channelId: offer.channelId,
            fetchId: `${offer.channelId}:fetch:1`,
            request: {
              remote: 'https://example.com/owner/a.git',
              url: 'https://example.com/owner/a.git/info/refs',
            },
          });
        },
      }],
    });
    await expect(client.status(ref)).rejects.toMatchObject({
      code: 'repository-reverse-fetch-invalid', outcomeKnown: true,
    });
    expect(fetches).toBe(0);
  });

  test('moves bounded App file bytes over the private port without Git credential authority', async () => {
    const calls: any[] = [];
    let credentialFetches = 0;
    let nextId = 0;
    const lease = {
      scope: 'controller', leaseId: 'lease-app-files-private', generation: 5,
      buildId: `0.7.0:${'f'.repeat(64)}`, kernelEpoch: 'kernel-app-files-private',
      hostEpoch: 'host-app-files-private',
    };
    const offscreenUrl = 'chrome-extension://id/offscreen/offscreen.html';
    const client: any = createOffscreenRepositoryClient({
      ensureHost: async () => {},
      withHost: (operation: any) => operation(lease),
      offscreenUrl,
      kernelFetch: async () => { credentialFetches += 1; return { ok: true }; },
      newId: () => `repository-app-file-${++nextId}`,
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage(offer: any, ports: MessagePort[]) {
          expect(acceptRepositoryOffer({ data: offer, ports } as any, {
            ownsLease: () => true,
            createService: () => ({
              appWrite: async (...args: any[]) => {
                calls.push(['write', ...args]); return { written: true, size: 5 };
              },
              appRead: async (...args: any[]) => {
                calls.push(['read', ...args]); return 'hello';
              },
              appList: async (...args: any[]) => {
                calls.push(['list', ...args]); return [{ path: '/index.html', size: 5 }];
              },
              appDelete: async (...args: any[]) => {
                calls.push(['delete', ...args]); return { deleted: true };
              },
            }),
          })).toBe(true);
        },
      }],
    });
    await expect(client.appFiles.writeText('app-one', 'index.html', 'hello'))
      .resolves.toMatchObject({ written: true, size: 5 });
    await expect(client.appFiles.readText('app-one', 'index.html')).resolves.toBe('hello');
    await expect(client.appFiles.listAppInfo('app-one'))
      .resolves.toEqual([{ path: '/index.html', size: 5 }]);
    await expect(client.appFiles.deleteFile('app-one', 'index.html'))
      .resolves.toMatchObject({ deleted: true });
    expect(calls.map(([method]) => method)).toEqual(['write', 'read', 'list', 'delete']);
    expect(calls[0][1]).toEqual(ref);
    expect(calls[0][2]).toMatchObject({ path: 'index.html', value: 'hello', signal: expect.any(AbortSignal) });
    expect(credentialFetches).toBe(0);
  });

  test('the lazy App-file host preserves bytes and refuses cross-App/path traversal', async () => {
    const root = new MemoryDirectory();
    const files = createRepositoryAppFileService({ getRootDirectory: async () => root as any });
    await expect(files.appWrite(ref, { path: 'assets/pixel.bin', value: new Uint8Array([0, 1, 255]) }))
      .resolves.toMatchObject({ written: true, size: 3 });
    await expect(files.appRead(ref, { path: 'assets/pixel.bin', encoding: 'bytes' }))
      .resolves.toEqual(new Uint8Array([0, 1, 255]));
    await expect(files.appList(ref, { sizes: true }))
      .resolves.toEqual([{ path: '/assets/pixel.bin', size: 3 }]);
    await expect(files.appRead({ kind: 'app', id: 'other' }, {
      path: 'assets/pixel.bin', encoding: 'bytes',
    })).rejects.toThrow('invalid App file reference');
    await expect(files.appWrite(ref, { path: '../escape', value: 'nope' }))
      .rejects.toThrow('unsafe App path');
    await expect(files.appDelete(ref, { path: 'assets/pixel.bin' }))
      .resolves.toMatchObject({ deleted: true });
    await expect(files.appList(ref, { sizes: false })).resolves.toEqual([]);
  });

  test('the lazy App-file host inspects a complete manifest without crossing catalog authority', async () => {
    const root = new MemoryDirectory();
    const files = createRepositoryAppFileService({ getRootDirectory: async () => root as any });
    const manifest = JSON.stringify({
      schema: 1, kind: 'app', entry: 'src/main.html',
      agent: { kind: 'bound-app', profile: 'developer', surface: 'code' },
      capabilities: [],
    });
    await files.appWrite(ref, { path: 'peerd.json', value: manifest });
    await files.appWrite(ref, { path: 'src/main.html', value: '<main>ok</main>' });
    await files.appWrite(ref, {
      path: 'assets/pixel.png', value: new TextEncoder().encode('valid text, binary suffix'),
    });
    await expect(files.appInspect(ref)).resolves.toEqual({
      fileKinds: {
        'peerd.json': 'text', 'src/main.html': 'text', 'assets/pixel.png': 'binary',
      },
      contract: {
        schema: 1, kind: 'app', entry: 'src/main.html',
        agent: { kind: 'bound-app', profile: 'developer', surface: 'code' },
        capabilities: [],
      },
    });
  });

  test('bounds App file UX waits, retries only reads, and retires unknown writes', async () => {
    const lease = {
      scope: 'controller', leaseId: 'lease-app-files-timeout', generation: 6,
      buildId: `0.7.0:${'1'.repeat(64)}`, kernelEpoch: 'kernel-app-files-timeout',
      hostEpoch: 'host-app-files-timeout',
    };
    const offscreenUrl = 'chrome-extension://id/offscreen/offscreen.html';
    const offers: string[] = [];
    const retirements: string[] = [];
    let nextId = 0;
    const client: any = createOffscreenRepositoryClient({
      ensureHost: async () => {},
      withHost: (operation: any) => operation(lease),
      offscreenUrl,
      kernelFetch: async () => ({ ok: true }),
      appReadTimeoutMs: 100,
      appEffectTimeoutMs: 150,
      retireHost: async (reason: string) => { retirements.push(reason); },
      newId: () => `repository-app-timeout-${++nextId}`,
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage(offer: any, ports: MessagePort[]) {
          offers.push(offer.method);
          ports[0].start();
        },
      }],
    });
    await expect(client.appFiles.readText('app-one', 'index.html')).rejects.toMatchObject({
      code: 'repository-host-timeout', outcomeKnown: true,
    });
    const readOffers = offers.filter((method) => method === 'appRead').length;
    expect(readOffers).toBeGreaterThanOrEqual(1);
    expect(readOffers).toBeLessThanOrEqual(2);
    await expect(client.appFiles.writeText('app-one', 'index.html', 'dirty'))
      .rejects.toMatchObject({ code: 'repository-host-timeout', outcomeKnown: false });
    expect(offers.at(-1)).toBe('appWrite');
    expect(retirements.slice(0, -1)).toEqual(
      Array.from({ length: readOffers }, () => 'repository-read-host-unavailable'),
    );
    expect(retirements.at(-1)).toBe('repository-mutation-outcome-unknown');
  });

  test('sender, port, and exact active lease are proven before the lazy repository host loads', () => {
    const lease = {
      scope: 'controller', leaseId: 'lease-admission-proof', generation: 3,
      buildId: `0.7.0:${'c'.repeat(64)}`, kernelEpoch: 'kernel-admission-proof',
      hostEpoch: 'host-admission-proof',
    };
    const offer = {
      type: 'peerd/repository-channel', protocol: REPOSITORY_CHANNEL_PROTOCOL,
      channelId: 'repository-admission-proof', method: 'status', args: [ref], lease,
    };
    const port = new MessageChannel().port1;
    const workerUrl = 'chrome-extension://id/background/vault-kernel.js';
    const event = {
      data: offer, ports: [port], isTrusted: true, source: { scriptURL: workerUrl },
    };
    expect(admitRepositoryChannelOffer(event, workerUrl, (candidate) => candidate === lease))
      .toMatchObject({ matched: true, ok: false, reason: 'lease-invalid' });
    expect(admitRepositoryChannelOffer(event, workerUrl,
      (candidate) => candidate.leaseId === lease.leaseId))
      .toMatchObject({ matched: true, ok: true, reason: null });
    expect(admitRepositoryChannelOffer({ ...event, isTrusted: false }, workerUrl, () => true))
      .toMatchObject({ matched: true, ok: false, reason: 'sender-invalid' });
    expect(admitRepositoryChannelOffer({
      ...event, source: { scriptURL: `${workerUrl}.attacker` },
    }, workerUrl, () => true)).toMatchObject({
      matched: true, ok: false, reason: 'sender-invalid',
    });
    expect(admitRepositoryChannelOffer({ ...event, ports: [] }, workerUrl, () => true))
      .toMatchObject({ matched: true, ok: false, reason: 'port-invalid' });
    expect(admitRepositoryChannelOffer({ ...event, ports: [port, port] }, workerUrl, () => true))
      .toMatchObject({ matched: true, ok: false, reason: 'port-invalid' });
    expect(admitRepositoryChannelOffer({
      ...event, data: { ...offer, unexpected: true },
    }, workerUrl, () => true)).toMatchObject({
      matched: true, ok: false, reason: 'offer-invalid', offer: null,
    });
  });

  test('Firefox loads one local repository controller only on first use', async () => {
    let loads = 0;
    const calls: string[] = [];
    const lifetimeOptions: any[] = [];
    const local = createLazyLocalRepositoryClient({
      loadService: async () => {
        loads += 1;
        return {
          coordinate: async (_ref: unknown, operation: () => Promise<unknown>) => operation(),
          status: async () => { calls.push('status'); return { dirty: false }; },
          commit: async () => { calls.push('commit'); return { oid: 'abc' }; },
        } as any;
      },
      withLifetime: async (operation, options) => {
        lifetimeOptions.push(options);
        return operation();
      },
    });
    expect(loads).toBe(0);
    const [status, commit] = await Promise.all([
      local.status(ref),
      local.coordinate(ref, () => local.commit(ref, { message: 'checkpoint' })),
    ]);
    expect(loads).toBe(1);
    expect(status).toEqual({ dirty: false });
    expect(commit).toEqual({ oid: 'abc' });
    expect(calls.sort()).toEqual(['commit', 'status']);
    expect(lifetimeOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outcomeKnownOnLoss: true, code: 'repository-firefox-read-lifetime-lost',
        onLost: expect.any(Function),
      }),
      expect.objectContaining({
        outcomeKnownOnLoss: false, code: 'repository-firefox-effect-lifetime-lost',
        onLost: expect.any(Function),
      }),
    ]));
  });

  test('native Firefox defers one local module load and Chrome construction performs none', async () => {
    let loads = 0;
    const client = createDeferredRepositoryClient(async () => {
      loads += 1;
      return {
        coordinate: async (_ref: unknown, operation: () => Promise<unknown>) => operation(),
        status: async () => ({ clean: true }),
        history: async () => [{ oid: 'one' }],
      } as any;
    });
    expect(loads).toBe(0);
    expect(await Promise.all([client.status(ref), client.history(ref)]))
      .toEqual([{ clean: true }, [{ oid: 'one' }]]);
    expect(loads).toBe(1);
  });

  test('a Firefox local-module load refusal is known-safe, uncached, and pre-dispatch', async () => {
    let loads = 0;
    let dispatches = 0;
    const client = createDeferredRepositoryClient(async () => {
      loads += 1;
      if (loads === 1) throw new Error('module unavailable');
      return {
        coordinate: async (_ref: unknown, operation: () => Promise<unknown>) => operation(),
        commit: async () => { dispatches += 1; return { oid: 'fresh' }; },
      } as any;
    });
    await expect(client.commit(ref, { message: 'first' })).rejects.toMatchObject({
      code: 'repository-local-load-failed', outcomeKnown: true,
    });
    expect(dispatches).toBe(0);
    await expect(client.commit(ref, { message: 'retry' })).resolves.toEqual({ oid: 'fresh' });
    expect({ loads, dispatches }).toEqual({ loads: 2, dispatches: 1 });
  });

  test('a frozen Firefox repository module load is bounded before dispatch', async () => {
    let loads = 0;
    const client = createDeferredRepositoryClient(async () => {
      loads += 1;
      return new Promise<any>(() => {});
    }, { loadTimeoutMs: 5 });
    await expect(client.commit(ref, { message: 'never' })).rejects.toMatchObject({
      code: 'repository-local-load-failed', outcomeKnown: true,
    });
    expect(loads).toBe(1);
  });

  test('a frozen repository service import releases the Firefox lifetime', async () => {
    let starts = 0;
    let stops = 0;
    const local = createLazyLocalRepositoryClient({
      loadService: async () => new Promise<any>(() => {}),
      loadTimeoutMs: 5,
      withLifetime: async (operation) => {
        starts += 1;
        try { return await operation(); } finally { stops += 1; }
      },
    });
    await expect(local.status(ref)).rejects.toMatchObject({
      code: 'repository-service-load-timeout', outcomeKnown: true, phase: 'startup',
    });
    expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });
  });

  test('Firefox discard drains a dispatched mutation before a fresh generation can retry', async () => {
    let loads = 0;
    let mutationCalls = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstResult = new Promise<{ oid: string }>((resolve) => {
      releaseFirst = () => resolve({ oid: 'landed-old-generation' });
    });
    let lifetimes = 0;
    const local = createLazyLocalRepositoryClient({
      loadService: async () => {
        loads += 1;
        const generation = loads;
        return {
          coordinate: async (_ref: unknown, operation: () => Promise<unknown>) => operation(),
          commit: async () => {
            mutationCalls += 1;
            if (generation === 1) { firstStarted(); return firstResult; }
            return { oid: 'fresh-generation' };
          },
        } as any;
      },
      withLifetime: async (operation, options) => {
        lifetimes += 1;
        if (lifetimes !== 1) return operation();
        const oldWork = Promise.resolve().then(operation);
        await started;
        options?.onLost?.(new Error('event page discarded'));
        void oldWork.catch(() => {});
        const error = Object.assign(new Error('Firefox background lifetime was lost'), {
          code: 'repository-firefox-effect-lifetime-lost', outcomeKnown: false,
        });
        throw error;
      },
    });
    await expect(local.commit(ref, { message: 'first' })).rejects.toMatchObject({
      code: 'repository-firefox-effect-lifetime-lost', outcomeKnown: false,
    });
    const retry = local.commit(ref, { message: 'retry' });
    await expect(retry).rejects.toMatchObject({
      code: 'repository-firefox-generation-draining', outcomeKnown: true,
    });
    expect({ loads, mutationCalls }).toEqual({ loads: 1, mutationCalls: 1 });
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await expect(local.commit(ref, { message: 'after reconcile' }))
      .resolves.toEqual({ oid: 'fresh-generation' });
    expect({ loads, mutationCalls }).toEqual({ loads: 2, mutationCalls: 2 });
  });

  test('Firefox App-file deadline poisons a dispatched write until the old generation drains', async () => {
    let appLoads = 0;
    let writes = 0;
    let releaseFirst!: () => void;
    const first = new Promise((resolve) => {
      releaseFirst = () => resolve({ written: true, size: 3 });
    });
    const local: any = createLazyLocalRepositoryClient({
      loadService: async () => { throw new Error('Git must stay lazy'); },
      loadAppService: async () => {
        appLoads += 1;
        const generation = appLoads;
        return {
          appWrite: async () => {
            writes += 1;
            return generation === 1 ? first : { written: true, size: 5 };
          },
        };
      },
      appEffectTimeoutMs: 4,
    });
    await expect(local.appFiles.writeText('app-one', 'index.html', 'old'))
      .rejects.toMatchObject({ code: 'repository-app-file-timeout', outcomeKnown: false });
    const retry = local.appFiles.writeText('app-one', 'index.html', 'fresh');
    await expect(retry).rejects.toMatchObject({
      code: 'repository-firefox-generation-draining', outcomeKnown: true,
    });
    expect({ appLoads, writes }).toEqual({ appLoads: 1, writes: 1 });
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await expect(local.appFiles.writeText('app-one', 'index.html', 'after reconcile'))
      .resolves.toMatchObject({ written: true, size: 5 });
    expect({ appLoads, writes }).toEqual({ appLoads: 2, writes: 2 });
  });

  test('Firefox App-file timeout before dispatch stays known-safe and cannot land late', async () => {
    let dispatches = 0;
    let releaseLifetime!: () => void;
    const lifetimeReady = new Promise<void>((resolve) => { releaseLifetime = resolve; });
    const local: any = createLazyLocalRepositoryClient({
      loadService: async () => { throw new Error('Git must stay lazy'); },
      loadAppService: async () => ({
        appWrite: async () => { dispatches += 1; return { written: true }; },
      }),
      withLifetime: async (operation) => { await lifetimeReady; return operation(); },
      appEffectTimeoutMs: 4,
    });
    await expect(local.appFiles.writeText('app-one', 'index.html', 'never'))
      .rejects.toMatchObject({ code: 'repository-app-file-timeout', outcomeKnown: true });
    releaseLifetime();
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(dispatches).toBe(0);
  });

  test('serializes repository reads and mutations against one OPFS lane', async () => {
    let releaseStatus!: () => void;
    const status = new Promise((resolve) => { releaseStatus = () => resolve({ ok: true, result: {} }); });
    const calls: string[] = [];
    const client = makePrivateClient(async (message: any) => {
      if (message.type !== 'repository/host-call') return { ok: true };
      calls.push(message.method);
      if (message.method === 'status') return status;
      return { ok: true, result: { oid: 'commit' } };
    });
    const read = client.status(ref);
    const mutation = client.commit(ref, { message: 'after read' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(calls).toEqual(['status']);
    releaseStatus();
    await expect(read).resolves.toEqual({});
    await expect(mutation).resolves.toEqual({ oid: 'commit' });
    expect(calls).toEqual(['status', 'commit']);
  });

  test('marks lost mutation custody unknown but read loss known-safe', async () => {
    const client = makePrivateClient(async () => { throw new Error('offscreen disappeared'); });
    await expect(client.commit(ref, { message: 'x' })).rejects.toMatchObject({
      code: 'repository-host-transport-lost', outcomeKnown: false,
    });
    await expect(client.status(ref)).rejects.toMatchObject({
      code: 'repository-host-transport-lost', outcomeKnown: true,
    });
  });

  test('classifies a synchronous private-port dispatch refusal as known-safe', async () => {
    const lease = {
      scope: 'controller', leaseId: 'lease-predispatch-safe', generation: 1,
      buildId: `0.7.0:${'2'.repeat(64)}`, kernelEpoch: 'kernel-predispatch-safe',
      hostEpoch: 'host-predispatch-safe',
    };
    const offscreenUrl = 'chrome-extension://id/offscreen/offscreen.html';
    const client = createOffscreenRepositoryClient({
      ensureHost: async () => {},
      withHost: (operation: any) => operation(lease),
      offscreenUrl,
      kernelFetch: async () => ({ ok: true }),
      newId: () => 'repository-predispatch-safe',
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage() { throw new Error('transfer refused before dispatch'); },
      }],
    });
    await expect(client.commit(ref, { message: 'never dispatched' })).rejects.toMatchObject({
      code: 'repository-host-dispatch-failed',
      outcomeKnown: true,
      repositoryHostDispatched: false,
    });
  });

  test('retires a cached lazy-import failure before retrying a repository read', async () => {
    let calls = 0;
    const retirements: string[] = [];
    const client = makePrivateClient(async (message: any) => {
      if (message.type === 'repository/host-cancel') return { ok: true };
      calls += 1;
      if (calls === 1) return {
        ok: false,
        code: 'repository-host-load-failed',
        error: 'module graph rejected',
        outcomeKnown: true,
      };
      return { ok: true, result: { dirty: false } };
    }, {
      retireHost: async (reason: string) => { retirements.push(reason); },
    });
    await expect(client.status(ref)).resolves.toEqual({ dirty: false });
    expect(retirements).toEqual(['repository-host-module-load-failed']);
    expect(calls).toBe(2);
  });

  test('bounds a frozen host, retries reads once, and releases the keyed lane', async () => {
    const messages: any[] = [];
    const client = makePrivateClient(async (message: any) => {
      messages.push(message);
      if (message.type === 'repository/host-cancel') return { ok: true };
      return new Promise(() => {});
    }, {
      readTimeoutMs: 5,
      effectTimeoutMs: 5,
      newId: (() => { let id = 0; return () => `call-timeout-${++id}`; })(),
    });
    await expect(client.status(ref)).rejects.toMatchObject({
      code: 'repository-host-timeout', outcomeKnown: true,
    });
    await expect(client.history(ref, { depth: 2 })).rejects.toMatchObject({
      code: 'repository-host-timeout', outcomeKnown: true,
    });
    const calls = messages.filter((entry) => entry.type === 'repository/host-call').length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(4);
  });

  test('expires abandoned sibling reads before dispatch so a later mutation is not starved', async () => {
    const messages: any[] = [];
    const client = makePrivateClient(async (message: any) => {
      messages.push(message);
      if (message.type === 'repository/host-cancel') return { ok: true };
      if (message.method === 'commit') return { ok: true, result: { oid: 'after-reads' } };
      return new Promise(() => {});
    }, {
      readTimeoutMs: 5,
      effectTimeoutMs: 50,
      newId: (() => { let id = 0; return () => `call-queue-deadline-${++id}`; })(),
    });
    const reads = Promise.allSettled([
      client.status(ref),
      client.history(ref, { depth: 20 }),
      client.branches(ref),
      client.getRemote(ref),
    ]);
    const mutation = client.commit(ref, { message: 'after abandoned overview' });
    const [readResults, commit] = await Promise.all([reads, mutation]);
    expect(commit).toEqual({ oid: 'after-reads' });
    expect(readResults.every((entry) => entry.status === 'rejected')).toBe(true);
    const calls = messages.filter((entry) => entry.type === 'repository/host-call');
    const readCalls = calls.filter((entry) => entry.method !== 'commit');
    expect(readCalls.length).toBeGreaterThanOrEqual(1);
    expect(readCalls.length).toBeLessThanOrEqual(2);
    expect(calls.filter((entry) => entry.method === 'commit')).toHaveLength(1);
  });

  test('never replays a timed-out mutation and reports unknown custody', async () => {
    const messages: any[] = [];
    const client = makePrivateClient(async (message: any) => {
      messages.push(message);
      if (message.type === 'repository/host-cancel') return { ok: true };
      return new Promise(() => {});
    }, {
      readTimeoutMs: 5,
      effectTimeoutMs: 5,
    });
    await expect(client.commit(ref, { message: 'checkpoint' })).rejects.toMatchObject({
      code: 'repository-host-timeout', outcomeKnown: false,
    });
    expect(messages.filter((entry) => entry.type === 'repository/host-call'))
      .toHaveLength(1);
  });

  test('a timed-out mutation physically retires its host before the keyed lane reopens', async () => {
    const first = new Promise(() => {});
    let calls = 0;
    let retired = false;
    let releaseRetirement!: () => void;
    const retirement = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    const client = makePrivateClient(async (message: any) => {
      if (message.type === 'repository/host-cancel') return { ok: true };
      calls += 1;
      if (calls === 1) return first;
      return { ok: true, result: { oid: 'replacement' } };
    }, {
      effectTimeoutMs: 5,
      retireHost: async () => { await retirement; retired = true; },
    });
    const timedOut = client.commit(ref, { message: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 12));
    const successor = client.commit(ref, { message: 'second' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(calls).toBe(1);
    expect(retired).toBe(false);
    releaseRetirement();
    await expect(timedOut).rejects.toMatchObject({
      code: 'repository-host-timeout', outcomeKnown: false,
    });
    expect(await successor).toEqual({ oid: 'replacement' });
    expect(retired).toBe(true);
    expect(calls).toBe(2);
  });

  test('kernel revalidates the Git remote, strips forged credentials, and injects its token', async () => {
    let request: { url: string; init?: RequestInit } | null = null;
    const route = makeRepositoryKernelFetch({
      getSecret: async (name) => name === 'git:github.com' ? 'vault-token' : null,
      webFetch: async (url, init) => {
        request = { url, init };
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-result' },
        });
      },
    });
    const result = await route({
      remote: 'https://github.com/owner/repo',
      url: 'https://github.com/owner/repo.git/git-upload-pack',
      method: 'POST',
      headers: { Authorization: 'Bearer attacker', Cookie: 'x=y', Accept: 'application/x-git' },
      bodyB64: 'AQI=',
    });
    expect(result).toMatchObject({ ok: true, status: 200, bodyB64: 'AQID' });
    const captured = request as { url: string; init?: RequestInit } | null;
    expect(captured?.url).toBe('https://github.com/owner/repo.git/git-upload-pack');
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toStartWith('Basic ');
    expect(headers.get('authorization')).not.toContain('attacker');
    await expect(route({
      remote: 'https://github.com/owner/repo',
      url: 'https://github.com/other/repo.git/git-upload-pack',
      method: 'POST',
    })).rejects.toThrow('escaped its bound repository');
  });

  test('bounds credentialed Git response headers before returning them to the host', async () => {
    const route = makeRepositoryKernelFetch({
      getSecret: async () => null,
      webFetch: async () => new Response(null, {
        status: 200,
        headers: { 'x-oversized': 'a'.repeat(64 * 1024) },
      }),
    });
    await expect(route({
      remote: 'https://example.com/owner/repo',
      url: 'https://example.com/owner/repo.git/info/refs',
      method: 'GET',
    })).rejects.toThrow('response headers exceed the transfer ceiling');
  });

  test('isomorphic-git is absent from the service-worker static graph', async () => {
    const root = join(process.cwd(), 'extension');
    const entry = join(root, 'background/service-worker.js');
    const graph = await collectStaticModuleGraph(root, entry);
    expect([...graph].some((file) => file.includes('/vendor/isomorphic-git/'))).toBe(false);
    expect([...graph].some((file) => file.endsWith('/repository/repository-service.js'))).toBe(false);
    expect([...graph].some((file) => file.endsWith('/offscreen/repository-app-files.js'))).toBe(false);
    expect([...graph].some((file) => readFileSync(file, 'utf8')
      .includes('admitRepositoryChannelOffer'))).toBe(false);
    const sw = readFileSync(entry, 'utf8');
    const offscreen = readFileSync(join(root, 'offscreen/offscreen.js'), 'utf8');
    const supervisor = readFileSync(join(root, 'offscreen/supervisor-channels.js'), 'utf8');
    expect(sw).not.toContain("import browserGit from '/vendor/isomorphic-git/index.js'");
    expect(offscreen).toContain("import('./repository-host.js')");
    expect(supervisor).toContain('export const admitRepositoryChannelOffer');
  });

  test('has one private repository transport and no broadcast compatibility path', () => {
    const root = join(process.cwd(), 'extension');
    const client = readFileSync(join(root, 'background/repository-client.js'), 'utf8');
    const host = readFileSync(join(root, 'offscreen/repository-host.js'), 'utf8');
    expect(client).not.toContain("'repository/host-call'");
    expect(client).not.toContain("'repository/host-cancel'");
    expect(host).not.toContain('browser.runtime.sendMessage');
    expect(host).not.toContain('/background/repository-client.js');
  });
});
