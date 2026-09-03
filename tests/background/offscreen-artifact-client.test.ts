import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import {
  ARTIFACT_CHANNEL_OFFER,
  ARTIFACT_CHANNEL_PROTOCOL,
  makeArtifactEngineClient,
} from '../../extension/background/offscreen-artifact-client.js';
import {
  createArtifactOfferAcceptor,
} from '../../extension/offscreen/artifact-host.js';
import { createServiceWorkerChannels } from '../../extension/offscreen/supervisor-channels.js';
import { backgroundScriptUrl } from '../../extension/offscreen/sender-checks.js';
import {
  ARTIFACT_CHANNEL_CANCEL,
  admitArtifactChannelOffer,
  artifactChannelRequestAllowed,
} from '../../extension/shared/artifact-channel.js';
import * as artifactCodec from '../../extension/peerd-engine/export.js';

const offscreenSource = readFileSync(join(EXTENSION_DIR, 'offscreen/offscreen.js'), 'utf8');
const supervisorSource = readFileSync(
  join(EXTENSION_DIR, 'offscreen/supervisor-channels.js'), 'utf8',
);
const runCodec = (operation: string, args: any[]) => {
  const fn = (artifactCodec as Record<string, any>)[operation];
  if (typeof fn !== 'function') throw new Error('artifact operation denied');
  return fn(...args);
};
const createRunFrom = (run: (operation: string, args: any[]) => unknown) =>
  (offer: { operation: string, args: any[] }) => ({
    promise: Promise.resolve().then(() => run(offer.operation, offer.args)),
    cancel: () => {},
  });
const acceptArtifactOffer = createArtifactOfferAcceptor({
  createRun: createRunFrom(runCodec),
});

const offscreenUrl = 'chrome-extension://test/offscreen/offscreen.html';
const target = {
  url: offscreenUrl,
  postMessage: (data: unknown, transfer: Transferable[]) => {
    acceptArtifactOffer({ data, ports: transfer } as unknown as MessageEvent);
  },
};
const ids = (prefix: string) => {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
};

describe('demand-only artifact codec channel', () => {
  test('preserves multi-MiB binary App bytes through the exact private channel', async () => {
    let leaseDepth = 0;
    const client: any = makeArtifactEngineClient({
      offscreen: true,
      offscreenUrl,
      withHost: async (operation) => {
        leaseDepth += 1;
        try { return await operation(); } finally { leaseDepth -= 1; }
      },
      listWindowClients: async () => [target],
      newId: ids('artifact-channel-binary'),
    });
    const bytes = new Uint8Array((3 * 1024 * 1024) + 31);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (Math.imul(index, 31) + (index >>> 8) + 17) & 0xff;
    }
    const envelope = await client.buildAppExport({
      record: { name: 'Binary', entryFile: 'index.html', fileKinds: { 'asset.bin': 'binary' } },
      files: { 'index.html': new TextEncoder().encode('<h1>x</h1>'), 'asset.bin': bytes },
    });
    expect(leaseDepth).toBe(0);
    const opened = await client.openEnvelope(envelope);
    expect(opened.files['asset.bin']).toEqual(bytes);
    expect(await client.exportFilename('Binary', 'app')).toContain('.peerd');
  });

  test('reconstructs stable codec errors and refuses ambiguous hosts', async () => {
    const client: any = makeArtifactEngineClient({
      offscreen: true,
      offscreenUrl,
      withHost: (operation) => operation(),
      listWindowClients: async () => [target],
      newId: ids('artifact-channel-error'),
    });
    await expect(client.openEnvelope({})).rejects.toMatchObject({
      name: 'EnvelopeFormatError',
    });
    const ambiguous: any = makeArtifactEngineClient({
      offscreen: true,
      offscreenUrl,
      withHost: (operation) => operation(),
      listWindowClients: async () => [target, target],
    });
    await expect(ambiguous.inspectEnvelope({})).rejects.toThrow('unavailable or ambiguous');
  });

  test('retires a realm whose lazy artifact host import was poisoned', async () => {
    const retirements: string[] = [];
    const client: any = makeArtifactEngineClient({
      offscreen: true,
      offscreenUrl,
      withHost: (operation) => operation(),
      retireHost: async (reason) => { retirements.push(reason); },
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (data: any, ports: MessagePort[]) => {
          ports[0].postMessage({
            protocol: ARTIFACT_CHANNEL_PROTOCOL,
            channelId: data.channelId,
            ok: false,
            error: { name: 'ArtifactHostLoadError', message: 'module graph rejected' },
          });
        },
      }],
      newId: () => 'artifact-load-failure',
    });
    await expect(client.inspectEnvelope({})).rejects.toMatchObject({
      name: 'ArtifactHostLoadError',
    });
    expect(retirements).toEqual(['artifact-host-module-load-failed']);
  });

  test('the host refuses a forged operation and Firefox imports the same codec locally', async () => {
    const { port1, port2 } = new MessageChannel();
    const reply = new Promise<any>((resolve) => {
      port1.onmessage = (event) => resolve(event.data);
      port1.start();
    });
    expect(acceptArtifactOffer({
      data: {
        type: ARTIFACT_CHANNEL_OFFER,
        protocol: ARTIFACT_CHANNEL_PROTOCOL,
        channelId: 'forged-channel',
        operation: 'fetch',
        args: [],
      },
      ports: [port2],
    } as unknown as MessageEvent)).toBe(true);
    await expect(reply).resolves.toMatchObject({
      ok: false, error: { name: 'ArtifactOperationDeniedError' },
    });
    const lifetimeOptions: any[] = [];
    const local: any = makeArtifactEngineClient({
      offscreen: false,
      offscreenUrl,
      withHost: async () => { throw new Error('must not lease'); },
      listWindowClients: async () => { throw new Error('must not enumerate offscreen'); },
      createChannel: () => { throw new Error('must not create a channel'); },
      importLocal: () => import('../../extension/peerd-engine/export.js'),
      withLocalLifetime: async (operation, options) => {
        lifetimeOptions.push(options);
        return operation();
      },
    });
    await expect(local.exportFilename('Local', 'app')).resolves.toContain('.peerd');
    expect(lifetimeOptions).toEqual([{
      outcomeKnownOnLoss: true,
      code: 'artifact-firefox-background-lost',
    }]);
  });

  test('a frozen Firefox codec import releases its lifetime with a startup refusal', async () => {
    let starts = 0;
    let stops = 0;
    const local: any = makeArtifactEngineClient({
      offscreen: false,
      offscreenUrl,
      withHost: async () => { throw new Error('must not lease'); },
      importLocal: async () => new Promise<any>(() => {}),
      localLoadTimeoutMs: 5,
      withLocalLifetime: async (operation) => {
        starts += 1;
        try { return await operation(); } finally { stops += 1; }
      },
    });
    await expect(local.inspectEnvelope({})).rejects.toMatchObject({
      code: 'artifact-local-load-timeout', outcomeKnown: true, phase: 'startup',
    });
    expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });
  });

  test('admits only the exact trusted service worker and an active dom-host lease', () => {
    const expectedWorkerUrl = 'chrome-extension://test/background/service-worker.js';
    const offer = {
      type: ARTIFACT_CHANNEL_OFFER,
      protocol: ARTIFACT_CHANNEL_PROTOCOL,
      channelId: 'artifact-admission-one',
      operation: 'inspectEnvelope',
      args: [{}],
    };
    const event = (overrides: Record<string, any> = {}) => ({
      isTrusted: true,
      source: { scriptURL: expectedWorkerUrl },
      data: offer,
      ports: [{}],
      ...overrides,
    });
    expect(admitArtifactChannelOffer(event(), expectedWorkerUrl, true))
      .toMatchObject({ matched: true, ok: true, offer });
    for (const forged of [
      event({ isTrusted: false }),
      event({ source: { scriptURL: `${expectedWorkerUrl}.forged` } }),
      event({ source: null }),
    ]) expect(admitArtifactChannelOffer(forged, expectedWorkerUrl, true))
      .toMatchObject({ matched: true, ok: false, reason: 'sender-invalid' });
    expect(admitArtifactChannelOffer(event(), expectedWorkerUrl, false))
      .toMatchObject({ ok: false, reason: 'lease-inactive' });
    expect(admitArtifactChannelOffer(event({ ports: [{}, {}] }), expectedWorkerUrl, true))
      .toMatchObject({ ok: false, reason: 'port-invalid' });
    expect(admitArtifactChannelOffer(event({
      data: { ...offer, protocol: 99 },
    }), expectedWorkerUrl, true)).toMatchObject({ ok: false, reason: 'offer-invalid' });
    expect(admitArtifactChannelOffer(event({
      data: { ...offer, operation: 'fetch' },
    }), expectedWorkerUrl, true)).toMatchObject({ ok: false, reason: 'operation-denied' });
    expect(supervisorSource).toContain("ownsLease?.('dom-host', lease) === true");
    expect(supervisorSource).toContain("'dom-host', artifactAdmission.offer?.lease");
  });

  test('forged and unleased offers never load the artifact host', async () => {
    let loads = 0;
    let accepts = 0;
    let active = true;
    const lease = { scope: 'dom-host', leaseId: 'artifact-exact-lease' };
    let releaseLoad!: (module: any) => void;
    const deferredLoad = new Promise<any>((resolve) => { releaseLoad = resolve; });
    const channels = createServiceWorkerChannels({
      getFeatureLeaseHost: () => ({
        isActive: () => active,
        ownsLease: (scope: string, candidate: unknown) =>
          active && scope === 'dom-host' && candidate === lease,
      }),
      loadControllerBootstrap: async () => ({}),
      loadArtifactHost: async () => {
        loads += 1;
        return deferredLoad;
      },
    });
    const port = { close() {}, postMessage() {} };
    const offer = {
      type: ARTIFACT_CHANNEL_OFFER,
      protocol: ARTIFACT_CHANNEL_PROTOCOL,
      channelId: 'artifact-loader-gate',
      operation: 'inspectEnvelope',
      args: [{}],
      lease,
    };
    const event = (scriptURL: string) => ({
      isTrusted: true, source: { scriptURL }, data: offer, ports: [port],
    } as unknown as MessageEvent);

    channels.onMessage(event(`${backgroundScriptUrl}.forged`));
    channels.onMessage({
      ...event(backgroundScriptUrl), data: { ...offer, lease: undefined },
    } as unknown as MessageEvent);
    await Promise.resolve();
    expect({ loads, accepts }).toEqual({ loads: 0, accepts: 0 });

    channels.onMessage(event(backgroundScriptUrl));
    for (let attempt = 0; attempt < 5 && loads === 0; attempt += 1) await Promise.resolve();
    expect(loads).toBe(1);
    active = false;
    releaseLoad({ acceptArtifactOffer: () => { accepts += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(accepts).toBe(0);

    active = true;
    channels.onMessage(event(backgroundScriptUrl));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ loads, accepts }).toEqual({ loads: 1, accepts: 1 });
  });

  test('the artifact branch closes before actor-channel admission', () => {
    const listenerStart = supervisorSource.indexOf('const onMessage =');
    const listenerEnd = supervisorSource.indexOf(
      'return Object.freeze({ actorPorts, vaultAuthorityWorkers })', listenerStart,
    );
    const listener = supervisorSource.slice(listenerStart, listenerEnd);
    expect(listener.match(/if \(artifactAdmission\.matched\)/g)).toHaveLength(1);
    const artifactStart = listener.indexOf('if (artifactAdmission.matched)');
    const sourceAdmission = listener.indexOf(
      'const source = /** @type {{ scriptURL?: string } | null} */ (event.source);',
    );
    const actorAdmission = listener.indexOf('event.data?.type !== ACTOR_CHANNEL_OFFER');
    const actorBind = listener.indexOf('loadActor()');
    expect(artifactStart).toBeGreaterThanOrEqual(0);
    expect(sourceAdmission).toBeGreaterThan(artifactStart);
    expect(listener.slice(artifactStart, sourceAdmission)).toMatch(/return;\s*\n\s*}/);
    expect(actorAdmission).toBeGreaterThan(sourceAdmission);
    expect(actorBind).toBeGreaterThan(actorAdmission);
  });

  test('rejects duplicate channel IDs and ambiguous transferred ports', async () => {
    const accept = createArtifactOfferAcceptor({ createRun: createRunFrom(runCodec) });
    const offer = {
      type: ARTIFACT_CHANNEL_OFFER,
      protocol: ARTIFACT_CHANNEL_PROTOCOL,
      channelId: 'artifact-replay-channel',
      operation: 'exportFilename',
      args: ['Replay', 'app'],
    };
    const dispatch = () => {
      const { port1, port2 } = new MessageChannel();
      const reply = new Promise<any>((resolve) => {
        port1.onmessage = (event) => resolve(event.data);
        port1.start();
      });
      expect(accept({ data: offer, ports: [port2] } as unknown as MessageEvent)).toBe(true);
      return reply;
    };
    const first = dispatch();
    const duplicate = dispatch();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(duplicate).resolves.toMatchObject({
      ok: false, error: { name: 'ArtifactChannelReplayError' },
    });

    let closes = 0;
    const fakePort = { close: () => { closes += 1; } };
    expect(accept({
      data: { ...offer, channelId: 'artifact-ambiguous-ports' },
      ports: [fakePort, fakePort],
    } as unknown as MessageEvent)).toBe(false);
    expect(closes).toBe(2);
  });

  test('enforces operation byte rails before host startup without a low node-count cliff', async () => {
    let hostStarts = 0;
    const client: any = makeArtifactEngineClient({
      offscreen: true,
      offscreenUrl,
      withHost: async (operation) => { hostStarts += 1; return operation(); },
      listWindowClients: async () => [target],
    });
    await expect(client.exportFilename('x'.repeat(20 * 1024), 'app')).rejects.toMatchObject({
      name: 'ArtifactPayloadTooLargeError',
      code: 'artifact-request-too-large',
      outcomeKnown: true,
      retryable: false,
    });
    expect(hostStarts).toBe(0);
    const structurallyRich = Array.from({ length: 12_000 }, (_, id) => ({ id, value: 'x' }));
    expect(artifactChannelRequestAllowed('openEnvelope', [{ rows: structurallyRich }])).toBe(true);
  });

  test('bounds codec concurrency and refuses oversized results as known-safe', async () => {
    let releaseFirst!: (value: string) => void;
    const accept = createArtifactOfferAcceptor({
      maxConcurrent: 1,
      createRun: createRunFrom((operation) => operation === 'exportFilename'
        ? new Promise((resolve) => { releaseFirst = resolve; })
        : null),
    });
    const dispatch = (channelId: string) => {
      const { port1, port2 } = new MessageChannel();
      const reply = new Promise<any>((resolve) => {
        port1.onmessage = (event) => resolve(event.data);
        port1.start();
      });
      accept({
        data: {
          type: ARTIFACT_CHANNEL_OFFER, protocol: ARTIFACT_CHANNEL_PROTOCOL,
          channelId, operation: 'exportFilename', args: ['App', 'app'],
        },
        ports: [port2],
      } as unknown as MessageEvent);
      return reply;
    };
    const first = dispatch('artifact-capacity-one');
    await Promise.resolve();
    await expect(dispatch('artifact-capacity-two')).resolves.toMatchObject({
      ok: false,
      error: { name: 'ArtifactHostBusyError', outcomeKnown: true, retryable: true },
    });
    releaseFirst('app.peerd');
    await expect(first).resolves.toMatchObject({ ok: true, value: 'app.peerd' });

    const oversize = createArtifactOfferAcceptor({
      createRun: createRunFrom(() => 'x'.repeat(20 * 1024)),
    });
    const { port1, port2 } = new MessageChannel();
    const reply = new Promise<any>((resolve) => {
      port1.onmessage = (event) => resolve(event.data);
      port1.start();
    });
    oversize({
      data: {
        type: ARTIFACT_CHANNEL_OFFER, protocol: ARTIFACT_CHANNEL_PROTOCOL,
        channelId: 'artifact-oversize-result', operation: 'exportFilename', args: ['App', 'app'],
      },
      ports: [port2],
    } as unknown as MessageEvent);
    await expect(reply).resolves.toMatchObject({
      ok: false,
      error: { name: 'ArtifactPayloadTooLargeError', code: 'artifact-result-too-large' },
    });
  });

  test('timeout sends exact cancellation and terminates only the codec run', async () => {
    let cancelled = 0;
    let hostPort: MessagePort | null = null;
    const accept = createArtifactOfferAcceptor({
      createRun: () => ({
        promise: new Promise(() => {}),
        cancel: () => { cancelled += 1; },
      }),
    });
    const client: any = makeArtifactEngineClient({
      offscreen: true,
      offscreenUrl,
      withHost: (operation) => operation(),
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (data: unknown, ports: MessagePort[]) => {
          hostPort = ports[0];
          accept({ data, ports } as unknown as MessageEvent);
        },
      }],
      newId: () => 'artifact-cancel-channel',
      timeoutMs: 5,
    });
    await expect(client.inspectEnvelope({})).rejects.toMatchObject({
      name: 'ArtifactHostTimeoutError',
      code: 'artifact-host-timeout',
      outcomeKnown: true,
      retryable: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hostPort).not.toBeNull();
    expect(cancelled).toBe(1);
    expect(ARTIFACT_CHANNEL_CANCEL).toBe('peerd/artifact-cancel');
  });

  test('timeout and channel loss both release the bounded host lease', async () => {
    let depth = 0;
    const withHost = async <T>(operation: () => Promise<T>) => {
      depth += 1;
      try { return await operation(); } finally { depth -= 1; }
    };
    const blackhole: any = makeArtifactEngineClient({
      offscreen: true,
      offscreenUrl,
      withHost,
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (_data: unknown, transfer: MessagePort[]) => transfer[0].close(),
      }],
      newId: ids('artifact-timeout'),
      timeoutMs: 5,
    });
    await expect(blackhole.inspectEnvelope({})).rejects.toMatchObject({
      name: 'ArtifactHostTransportError',
      message: 'artifact host channel closed',
    });
    expect(depth).toBe(0);

    class FakePort extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      start() {}
      close() {}
      postMessage() {}
    }
    const clientPort = new FakePort();
    const hostPort = new FakePort();
    const lost: any = makeArtifactEngineClient({
      offscreen: true,
      offscreenUrl,
      withHost,
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: () => clientPort.dispatchEvent(new Event('close')),
      }],
      createChannel: () => ({ port1: clientPort, port2: hostPort } as unknown as MessageChannel),
      newId: ids('artifact-host-loss'),
    });
    await expect(lost.inspectEnvelope({})).rejects.toMatchObject({
      name: 'ArtifactHostTransportError',
    });
    expect(depth).toBe(0);
  });

  test('refuses reused or malformed client channel identities before dispatch', async () => {
    let sends = 0;
    const client: any = makeArtifactEngineClient({
      offscreen: true,
      offscreenUrl,
      withHost: (operation) => operation(),
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (data: unknown, transfer: Transferable[]) => {
          sends += 1;
          acceptArtifactOffer({ data, ports: transfer } as unknown as MessageEvent);
        },
      }],
      newId: () => 'artifact-reused-identity',
    });
    await expect(client.exportFilename('First', 'app')).resolves.toContain('.peerd');
    await expect(client.exportFilename('Second', 'app'))
      .rejects.toThrow('identity invalid or reused');
    expect(sends).toBe(1);

    const malformed: any = makeArtifactEngineClient({
      offscreen: true,
      offscreenUrl,
      withHost: (operation) => operation(),
      listWindowClients: async () => [target],
      newId: () => 'short',
    });
    await expect(malformed.inspectEnvelope({})).rejects.toThrow('identity invalid or reused');
  });
});
