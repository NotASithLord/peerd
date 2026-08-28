import { describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import {
  CONTROLLER_BUILD_ENTRIES,
  CONTROLLER_BUILD_STAMP_MODULES,
  controllerBuildDigest,
  writeControllerBuildIdentity,
} from '../../packaging/controller-build-identity.ts';
import {
  makeSemanticControllerClient as makeSemanticControllerClientBase,
} from '../../extension/background/offscreen-controller-client.js';
import { connectDirectController } from '../../extension/background/direct-controller-client.js';
import { createKernelSessionAuthority } from '../../extension/background/kernel-session-authority.js';
import { createKernelSupportControl } from '../../extension/background/kernel-support-control.js';
import { makeControllerOfferHandler } from '../../extension/offscreen/controller-shell.js';
import { createController } from '../../extension/offscreen/controller-runtime.js';
import {
  renderSystemPromptFromAssets,
} from '../../extension/peerd-runtime/loop/system-prompt.js';
import { buildTemporalBlock } from '../../extension/peerd-runtime/clock/context.js';
import { CONTROLLER_BUILD_DIGEST } from '../../extension/shared/structured-clone-size.js';

const TEMPLATE = readFileSync(join(EXTENSION_DIR, 'peerd-provider/system-prompt.txt'), 'utf8');
const DWEB_TEXT = readFileSync(
  join(EXTENSION_DIR, 'peerd-provider/system-prompt-dweb.txt'), 'utf8',
).trim();
const DWEB_BLOCK = DWEB_TEXT ? `\n${DWEB_TEXT}\n` : '';
const TEST_KERNEL_IDENTITY = Object.freeze({
  schema: 1,
  buildId: 'test-controller-build',
  bootId: 'test-controller-boot',
  kernelEpoch: 'test-controller-kernel',
});
let testLeaseGeneration = 0;
const nextTestControllerLease = () => {
  testLeaseGeneration += 1;
  return Object.freeze({
    ...TEST_KERNEL_IDENTITY,
    scope: 'controller',
    leaseId: `test-controller-lease-${String(testLeaseGeneration).padStart(8, '0')}`,
    hostEpoch: 'test-controller-host',
    generation: testLeaseGeneration,
  });
};
const makeSemanticControllerClient = (
  deps: Omit<Parameters<typeof makeSemanticControllerClientBase>[0], 'kernelIdentity'> & {
    kernelIdentity?: Parameters<typeof makeSemanticControllerClientBase>[0]['kernelIdentity'],
  },
) => {
  let leaseUsers = 0;
  let sharedLease: ReturnType<typeof nextTestControllerLease> | null = null;
  const withTestControllerLease = async <T>(
    operation: (lease?: unknown) => Promise<T>,
  ): Promise<T> => {
    sharedLease ??= nextTestControllerLease();
    leaseUsers += 1;
    try { return await operation(sharedLease); }
    finally {
      leaseUsers -= 1;
      if (leaseUsers === 0) sharedLease = null;
    }
  };
  return makeSemanticControllerClientBase({
    ...deps,
    kernelIdentity: deps.kernelIdentity ?? TEST_KERNEL_IDENTITY,
    ...(!deps.firefoxDirect && typeof deps.withControllerLease !== 'function' ? {
      withControllerLease: withTestControllerLease,
    } : {}),
  });
};

describe('production semantic controller slice', () => {
  test('checked-in build identity matches the complete authored controller graphs and assets', async () => {
    expect(CONTROLLER_BUILD_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(await controllerBuildDigest(EXTENSION_DIR)).toBe(CONTROLLER_BUILD_DIGEST);
  });

  test('stamps the identity leaves, leaves the structured-clone re-export untouched, and recomputes stably', async () => {
    expect(CONTROLLER_BUILD_STAMP_MODULES).toEqual([
      'controller-build.js', 'build-config.js',
    ]);
    expect(CONTROLLER_BUILD_STAMP_MODULES).not.toContain('structured-clone-size.js' as any);

    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-stamp-'));
    try {
      cpSync(EXTENSION_DIR, root, { recursive: true });
      const structuredClonePath = join(root, 'shared', 'structured-clone-size.js');
      const structuredCloneBefore = readFileSync(structuredClonePath, 'utf8');
      for (const name of CONTROLLER_BUILD_STAMP_MODULES) {
        const path = join(root, 'shared', name);
        writeFileSync(path, readFileSync(path, 'utf8').replace(
          /(CONTROLLER_BUILD_DIGEST\s*=\s*['"])[a-f0-9]{64}(['"])/,
          `$1${'0'.repeat(64)}$2`,
        ));
      }
      const digest = await writeControllerBuildIdentity(root);

      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      for (const name of CONTROLLER_BUILD_STAMP_MODULES) {
        const source = readFileSync(join(root, 'shared', name), 'utf8');
        expect(source.match(/CONTROLLER_BUILD_DIGEST\s*=\s*['"]([a-f0-9]{64})['"]/i)?.[1])
          .toBe(digest);
      }
      expect(readFileSync(structuredClonePath, 'utf8')).toBe(structuredCloneBefore);
      expect(structuredCloneBefore).toContain(
        "export { CONTROLLER_BUILD_DIGEST } from './controller-build.js';",
      );
      expect(await controllerBuildDigest(root)).toBe(digest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('build identity covers the offscreen supervisor and every operation host', async () => {
    const governed = [
      'offscreen/offscreen.js',
      'offscreen/feature-lease-host.js',
      'offscreen/repository-host.js',
      'offscreen/repository-app-files.js',
      'offscreen/artifact-host.js',
      'offscreen/artifact-worker.js',
      'background/offscreen-artifact-client.js',
      'background/repository-client.js',
      'background/controller-turn-bridge.js',
      'background/kernel-semantic-authority.js',
      'background/kernel-semantic-control.js',
      'background/kernel-administrative-control.js',
      'background/kernel-support-control.js',
      'background/kernel-session-authority.js',
      'offscreen/kernel-runtime-host.js',
      'offscreen/kernel-administrative-host.js',
      'offscreen/kernel-support-host.js',
      'offscreen/controller-turn-runtime.js',
    ];
    for (const entry of governed) expect(CONTROLLER_BUILD_ENTRIES).toContain(entry as any);

    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-identity-'));
    try {
      cpSync(EXTENSION_DIR, root, { recursive: true });
      const before = await controllerBuildDigest(root);
      const repositoryHost = join(root, 'offscreen', 'repository-host.js');
      writeFileSync(repositoryHost, `${readFileSync(repositoryHost, 'utf8')}\n// identity mutation\n`);
      const afterRepository = await controllerBuildDigest(root);
      expect(afterRepository).not.toBe(before);

      const runtimeHost = join(root, 'offscreen', 'kernel-runtime-host.js');
      writeFileSync(runtimeHost, `${readFileSync(runtimeHost, 'utf8')}\n// identity mutation\n`);
      expect(await controllerBuildDigest(root)).not.toBe(afterRepository);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('build identity binds the kernel reverse-turn authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-turn-identity-'));
    try {
      cpSync(EXTENSION_DIR, root, { recursive: true });
      const before = await controllerBuildDigest(root);
      const bridge = join(root, 'background', 'controller-turn-bridge.js');
      writeFileSync(bridge, `${readFileSync(bridge, 'utf8')}\n// identity mutation\n`);
      expect(await controllerBuildDigest(root)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('build identity binds semantic reverse authority and admission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-semantic-identity-'));
    try {
      cpSync(EXTENSION_DIR, root, { recursive: true });
      let before = await controllerBuildDigest(root);
      for (const name of ['kernel-semantic-authority.js', 'kernel-semantic-control.js']) {
        const path = join(root, 'background', name);
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n// identity mutation\n`);
        const after = await controllerBuildDigest(root);
        expect(after).not.toBe(before);
        before = after;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('build identity binds support routing and reverse authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-support-identity-'));
    try {
      cpSync(EXTENSION_DIR, root, { recursive: true });
      let before = await controllerBuildDigest(root);
      for (const name of [
        'background/kernel-session-authority.js',
        'background/kernel-support-control.js',
        'offscreen/kernel-support-host.js',
      ]) {
        const path = join(root, name);
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n// identity mutation\n`);
        const after = await controllerBuildDigest(root);
        expect(after).not.toBe(before);
        before = after;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('prompt.render accepts the production absolute Chrome offscreen URL', async () => {
    const workerUrl = 'chrome-extension://test/background/service-worker.js';
    const offscreenUrl = 'chrome-extension://test/offscreen/offscreen.html';
    const offerHandler = makeControllerOfferHandler({
      expectedWorkerUrl: workerUrl,
      expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
      supportedCaps: ['prompt.render'],
      loadController: () => createController(),
    });
    const host = {
      url: offscreenUrl,
      postMessage: (data: unknown, transfer: Transferable[]) => {
        offerHandler({
          isTrusted: true,
          source: { scriptURL: workerUrl },
          data,
          ports: transfer,
        } as unknown as MessageEvent);
      },
    };
    let ensures = 0;
    const fetchFn = (async (url: string | URL | Request) => {
      const text = String(url).endsWith('system-prompt-dweb.txt') ? DWEB_TEXT : TEMPLATE;
      return new Response(text, { status: 200 });
    }) as typeof fetch;
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
      ensureOffscreen: async () => { ensures += 1; },
      // Production passes the already-resolved URL from vault-kernel. A
      // second runtime.getURL() here used to make the real host undiscoverable.
      offscreenUrl,
      firefoxDirect: false,
      dwebEnabled: true,
      fetchFn,
      listWindowClients: async () => [host],
    });
    const contexts = [
      { memoryBlock: '<memory>m</memory>', skillsBlock: '<skills>s</skills>' },
      { taskOverride: 'review the patch', effectiveTools: ['message_actor'] },
      {
        actorType: 'app', actorSurface: 'code', instanceId: 'app-1',
        temporalNowMs: 1_700_000_000_000,
        customSystemPrompt: 'keep responses terse',
        appRole: {
          source: 'local', publisher: 'alice', manifestDigest: 'a'.repeat(64),
          name: 'Example', instructions: 'Maintain the package.',
        },
      },
      { actorType: 'web', backing: 'tab', actorSurface: 'code', schemaReply: true },
    ];
    for (const ctx of contexts) {
      const { temporalNowMs, ...promptContext } = ctx as any;
      const expected = renderSystemPromptFromAssets({
        ...promptContext,
        ...(temporalNowMs === undefined ? {} : {
          temporalBlock: buildTemporalBlock({ lastTurnAt: null, nowMs: temporalNowMs }),
        }),
      }, {
        template: TEMPLATE, dwebBlock: DWEB_BLOCK,
      });
      await expect(semantic.renderSystemPrompt(ctx)).resolves.toBe(expected);
    }
    expect(ensures).toBe(contexts.length);
    semantic.close();
  });

  test('prompt.render refuses malformed payloads without throwing or widening authority', async () => {
    const controller = await createController();
    const result = await controller.call('prompt.render', { ctx: null, template: '', dwebBlock: '' }, {
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ ok: false, code: 'prompt-payload-invalid', outcomeKnown: true });
  });

  test('semantic.dispatch binds route authority and exact kernel operations through the private channel', async () => {
    const workerUrl = 'chrome-extension://test/background/service-worker.js';
    const offscreenUrl = 'chrome-extension://test/offscreen/offscreen.html';
    const authority = {
      ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
      origin: null, target: 'semantic:provider/status:first-party', replayClass: 'A',
    } as const;
    const offerHandler = makeControllerOfferHandler({
      expectedWorkerUrl: workerUrl,
      expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
      supportedCaps: ['semantic.dispatch'],
      loadController: () => createController(),
    });
    const calls: any[] = [];
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: false, dwebEnabled: false,
      authorizeSemanticCall: () => authority,
      handleSemanticKernelCall: async (operation, payload, context) => {
        calls.push({ operation, payload, context });
        return { ok: true, value: {
          anthropic: { hasKey: true, keyPreview: 'sk-ant-…test' },
          openrouter: { hasKey: false, keyPreview: null },
          openai: { hasKey: false, keyPreview: null },
          glm: { hasKey: false, keyPreview: null },
          ollama: { hasKey: true, keyPreview: null },
        } };
      },
      fetchFn: (async () => new Response(TEMPLATE, { status: 200 })) as unknown as typeof fetch,
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (data: unknown, transfer: Transferable[]) => offerHandler({
          isTrusted: true, source: { scriptURL: workerUrl }, data, ports: transfer,
        } as unknown as MessageEvent),
      }],
    });
    const result = await semantic.callSemantic({
      protocol: 1, route: 'provider/status', message: { type: 'provider/status' },
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.providers[0]).toMatchObject({ name: 'anthropic', hasKey: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: 'semantic.providers.key-status', payload: {},
      context: { capability: 'semantic.dispatch', authority },
    });
    semantic.close();
  });

  test('Chrome acquires the bounded controller lease before host discovery and releases after settle', async () => {
    const workerUrl = 'chrome-extension://test/background/service-worker.js';
    const offscreenUrl = 'chrome-extension://test/offscreen/offscreen.html';
    let leaseDepth = 0;
    const ordering: string[] = [];
    const offerHandler = makeControllerOfferHandler({
      expectedWorkerUrl: workerUrl,
      expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
      supportedCaps: ['prompt.render'],
      loadController: async () => {
        expect(leaseDepth).toBe(1);
        ordering.push('controller-call');
        return createController();
      },
    });
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
      ensureOffscreen: async () => {
        expect(leaseDepth).toBe(1);
        ordering.push('ensure-host');
      },
      offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: false,
      dwebEnabled: false,
      withControllerLease: async (operation) => {
        expect(leaseDepth).toBe(0);
        leaseDepth += 1;
        ordering.push('lease-acquired');
        try { return await operation(nextTestControllerLease()); }
        finally {
          ordering.push('lease-released');
          leaseDepth -= 1;
        }
      },
      fetchFn: (async () => new Response(TEMPLATE, { status: 200 })) as unknown as typeof fetch,
      listWindowClients: async () => {
        expect(leaseDepth).toBe(1);
        ordering.push('find-host');
        return [{
          url: offscreenUrl,
          postMessage: (data: unknown, transfer: Transferable[]) => offerHandler({
            isTrusted: true,
            source: { scriptURL: workerUrl },
            data,
            ports: transfer,
          } as unknown as MessageEvent),
        }];
      },
    });
    await expect(semantic.renderSystemPrompt({ actorType: 'orchestrator' }))
      .resolves.toContain('orchestrator');
    expect(leaseDepth).toBe(0);
    expect(ordering).toEqual([
      'lease-acquired', 'ensure-host', 'find-host', 'controller-call', 'lease-released',
    ]);
    semantic.close();
  });

  test('an outer run hold reuses one controller channel until its final release', async () => {
    const workerUrl = 'chrome-extension://test/background/service-worker.js';
    const offscreenUrl = 'chrome-extension://test/offscreen/offscreen.html';
    let offers = 0;
    let loads = 0;
    let closes = 0;
    let loaded: Promise<any> | null = null;
    const loadController = Object.assign(
      () => {
        loaded ??= Promise.resolve(createController({ handlers: {
          'prompt.render': async () => ({ ok: true, prompt: 'held prompt', outcomeKnown: true }),
          'turn.run': async () => ({ ok: true, outcomeKnown: true }),
        } })).then((controller) => {
          loads += 1;
          return controller;
        });
        return loaded;
      },
      { close: () => { closes += 1; loaded = null; } },
    );
    const offerHandler = makeControllerOfferHandler({
      expectedWorkerUrl: workerUrl,
      expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
      supportedCaps: ['prompt.render', 'turn.run'],
      loadController,
    });
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
      ensureOffscreen: async () => {},
      offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: false,
      dwebEnabled: false,
      authorizeTurnCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: 'session-1', instanceId: null,
        origin: null, target: 'orchestrator-turn', replayClass: 'E',
      }),
      handleTurnKernelCall: async () => ({ ok: true }),
      withControllerLease: (operation) => operation(nextTestControllerLease()),
      fetchFn: (async () => new Response(TEMPLATE, { status: 200 })) as unknown as typeof fetch,
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (data: unknown, transfer: Transferable[]) => {
          offers += 1;
          offerHandler({
            isTrusted: true, source: { scriptURL: workerUrl }, data, ports: transfer,
          } as unknown as MessageEvent);
        },
      }],
    });

    const runResult = await semantic.withRun(async () => {
      await expect(semantic.renderSystemPrompt({ actorType: 'orchestrator' }))
        .resolves.toBe('held prompt');
      await expect(semantic.callTurn({ sessionId: 'session-1' }))
        .resolves.toEqual({ ok: true, outcomeKnown: true, phase: 'settled' });
      expect({ offers, loads, closes }).toEqual({ offers: 1, loads: 1, closes: 0 });
      return 'completed';
    });
    expect(runResult).toBe('completed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ offers, loads, closes }).toEqual({ offers: 1, loads: 1, closes: 1 });
  });

  test('a semantic startup retry releases its lease user before the next call', async () => {
    const workerUrl = 'chrome-extension://test/background/service-worker.js';
    const offscreenUrl = 'chrome-extension://test/offscreen/offscreen.html';
    let discoveries = 0;
    let offers = 0;
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
      ensureOffscreen: async () => {},
      offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: false,
      dwebEnabled: false,
      authorizeSemanticCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
        origin: null, target: 'semantic:test:first-party', replayClass: 'A',
      }),
      handleSemanticKernelCall: async () => ({ ok: true }),
      withControllerLease: (operation) => operation(nextTestControllerLease()),
      fetchFn: (async () => new Response(TEMPLATE, { status: 200 })) as unknown as typeof fetch,
      listWindowClients: async () => {
        discoveries += 1;
        if (discoveries <= 2) return [];
        return [{
          url: offscreenUrl,
          postMessage: (data: unknown, transfer: Transferable[]) => {
            offers += 1;
            makeControllerOfferHandler({
              expectedWorkerUrl: workerUrl,
              expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
              supportedCaps: ['semantic.dispatch'],
              loadController: async () => ({
                call: async () => ({
                  ok: true, outcomeKnown: true, semanticResult: { ok: true, offer: offers },
                }),
              }),
            })({
              isTrusted: true, source: { scriptURL: workerUrl }, data, ports: transfer,
            } as unknown as MessageEvent);
          },
        }];
      },
    });

    await expect(semantic.callSemantic({ route: 'first' }))
      .resolves.toEqual({ ok: true, offer: 1 });
    await expect(semantic.callSemantic({ route: 'second' }))
      .resolves.toEqual({ ok: true, offer: 2 });
    expect(offers).toBe(2);
  });

  test('Firefox lifetime loss retires the exact controller generation before retry', async () => {
    const calls: number[] = [];
    const closed: number[] = [];
    let generation = 0;
    let lifetimes = 0;
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false,
      authorizeSemanticCall: () => ({ replayClass: 'A' }),
      handleSemanticKernelCall: async () => ({ ok: true }),
      connectDirectController: async () => {
        const current = ++generation;
        return {
          call: async () => {
            calls.push(current);
            if (current === 1) return new Promise(() => {});
            return { ok: true, semanticResult: { ok: true, generation: current } };
          },
          close: () => { closed.push(current); },
        } as any;
      },
      withDirectLifetime: async (operation, options) => {
        lifetimes += 1;
        const pending = operation();
        if (lifetimes === 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          options?.onLost?.(new Error('heartbeat lost'));
          throw Object.assign(new Error('heartbeat lost'), {
            code: options?.code, outcomeKnown: options?.outcomeKnownOnLoss,
          });
        }
        return pending;
      },
      fetchFn: (async () => new Response(TEMPLATE, { status: 200 })) as unknown as typeof fetch,
    });

    await expect(semantic.callSemantic({ route: 'one' })).resolves.toMatchObject({
      ok: false, code: 'controller-firefox-semantic-lifetime-lost', outcomeKnown: false,
    });
    await expect(semantic.callSemantic({ route: 'two' })).resolves.toEqual({
      ok: true, generation: 2,
    });
    expect(calls).toEqual([1, 2]);
    expect(closed).toEqual([1]);
    semantic.close();
    expect(closed).toEqual([1, 2]);
  });

  test('Firefox feature lifetime distinguishes replayable reads from commits', async () => {
    const options: any[] = [];
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false,
      authorizeFeatureCall: () => ({ replayClass: 'A' }),
      handleFeatureKernelCall: async () => ({ ok: true }),
      connectDirectController: async () => ({
        call: async () => ({ ok: true, outcomeKnown: true, value: { ok: true } }),
        close() {},
      } as any),
      withDirectLifetime: async (operation, offered) => {
        options.push(offered);
        return operation();
      },
      fetchFn: async () => new Response(TEMPLATE, { status: 200 }),
    });
    const message = (route: string, dispatchId: string, value: Record<string, unknown>) => ({
      cluster: 'support', route, dispatchId, message: value,
    });

    await semantic.callFeature(message('session/list', 'feature-read-1', {}));
    await semantic.callFeature(message('session/setModel', 'feature-commit-1', { model: 'new' }));

    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
      outcomeKnownOnLoss: true,
      code: 'controller-firefox-feature-lifetime-lost',
    });
    expect(options[0].lossGraceMs).toBeUndefined();
    expect(options[1]).toMatchObject({
      outcomeKnownOnLoss: false,
      lossGraceMs: 2_000,
      code: 'controller-firefox-feature-lifetime-lost',
    });
    semantic.close();
  });

  test('Chrome retries one replay-safe feature after transient host startup loss', async () => {
    const workerUrl = 'chrome-extension://test/background/service-worker.js';
    const offscreenUrl = 'chrome-extension://test/offscreen/offscreen.html';
    let discoveries = 0;
    let leases = 0;
    let calls = 0;
    const offerHandler = makeControllerOfferHandler({
      expectedWorkerUrl: workerUrl,
      expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
      supportedCaps: ['feature.dispatch'],
      loadController: async () => ({
        call: async () => {
          calls += 1;
          return { ok: true, value: { rows: [] }, outcomeKnown: true };
        },
      }),
    });
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl,
      firefoxDirect: false, dwebEnabled: false,
      authorizeFeatureCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
        origin: null, target: 'feature:session/list', replayClass: 'A',
      }),
      handleFeatureKernelCall: async () => ({ ok: true }),
      withControllerLease: async (operation) => {
        leases += 1;
        return operation(nextTestControllerLease());
      },
      fetchFn: async () => new Response(TEMPLATE, { status: 200 }),
      listWindowClients: async () => {
        discoveries += 1;
        if (discoveries <= 2) return [];
        return [{
          url: offscreenUrl,
          postMessage: (data: unknown, transfer: Transferable[]) => {
            offerHandler({
              isTrusted: true, source: { scriptURL: workerUrl }, data, ports: transfer,
            } as unknown as MessageEvent);
          },
        }];
      },
    });

    await expect(semantic.callFeature({
      cluster: 'support', route: 'session/list', dispatchId: 'feature-read-1', message: {},
    })).resolves.toMatchObject({ ok: true, value: { rows: [] } });
    expect({ discoveries, leases, calls }).toEqual({ discoveries: 3, leases: 2, calls: 1 });
    semantic.close();
    offerHandler.close();
  });

  test('Firefox carries all session support routes through the sealed controller', async () => {
    const row: any = {
      kind: 'chat', sessionId: 'chat-1', title: 'Chat', createdAt: 1,
      messages: [{ when: 2 }], provider: 'anthropic', model: 'old',
    };
    const cache = new Map<string, any>([['currentSessionId', 'chat-1']]);
    const authority = createKernelSessionAuthority({
      ready: Promise.resolve(), vault: { isLocked: () => false },
      sessions: {
        listSummaries: async () => [{
          ...row, lastMessageAt: 2, messageCount: 1,
          hasCustomSystemPrompt: false, toolManifest: null,
        }],
        get: async (id: string) => id === row.sessionId ? row : null,
        updateMetadata: async (id: string, patch: Record<string, unknown>) => {
          if (id !== row.sessionId) return null;
          Object.assign(row, patch);
          return row;
        },
      },
      contextSnapshots: { snapshotsFor: (id: string) => [{ id, capturedAt: 3 }] },
      sessionCache: {
        sessionGet: async (key: string) => cache.get(key),
        sessionSet: async (key: string, value: unknown) => { cache.set(key, value); },
      },
      auditLog: { append: async () => {} },
      resolvePermission: (session: any, mode: unknown, confirmActions: unknown) => ({
        mode: (session?.permissionMode ?? mode) === 'act' ? 'act' : 'plan',
        confirmActions: session?.confirmActions ?? confirmActions !== false,
      }),
      pushState: async () => {}, admitRoute: () => true,
    });
    let semantic!: ReturnType<typeof makeSemanticControllerClient>;
    const control = createKernelSupportControl({
      callFeature: (payload, options) => semantic.callFeature(payload, options),
      admit: authority.admit,
      effectAllowed: authority.effectAllowed,
      effects: authority.effects,
    });
    semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false,
      authorizeFeatureCall: control.authorize,
      handleFeatureKernelCall: control.handleKernelCall,
      withDirectLifetime: (operation: () => Promise<any>) => operation(),
      connectDirectController: (deps: any) => connectDirectController({
        ...deps, loadController: () => createController(),
      }),
      fetchFn: async () => new Response(TEMPLATE, { status: 200 }),
    });

    await expect(control.routes['session/list']()).resolves.toMatchObject({
      ok: true, sessions: [{ sessionId: 'chat-1', messageCount: 1 }],
    });
    await expect(control.routes['session/get']({ sessionId: 'chat-1' }))
      .resolves.toMatchObject({ ok: true, session: { sessionId: 'chat-1' } });
    await expect(control.routes['session/contextSnapshots']({ sessionId: 'chat-1' }))
      .resolves.toEqual({ ok: true, snapshots: [{ id: 'chat-1', capturedAt: 3 }] });
    await expect(control.routes['session/setModel']({ model: 'new' }))
      .resolves.toEqual({ ok: true, model: 'new' });
    await expect(control.routes['permission/set']({ mode: 'act' }))
      .resolves.toEqual({ ok: true, permission: { mode: 'act', confirmActions: true } });
    semantic.close();
  });

  test('Firefox lifetime loss retires a controller still connecting', async () => {
    let resolveFirst!: (client: any) => void;
    const first = new Promise<any>((resolve) => { resolveFirst = resolve; });
    let generations = 0;
    let closes = 0;
    let calls = 0;
    let lifetimes = 0;
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false,
      authorizeTurnCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: 'session-1', instanceId: null,
        origin: null, target: 'orchestrator-turn', replayClass: 'E',
      }),
      handleTurnKernelCall: async () => ({ ok: true }),
      authorizeSemanticCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
        origin: null, target: 'semantic:test:first-party', replayClass: 'A',
      }),
      handleSemanticKernelCall: async () => ({ ok: true }),
      connectDirectController: async () => {
        generations += 1;
        if (generations === 1) return first;
        return {
          call: async () => {
            calls += 1;
            return { ok: true, outcomeKnown: true, semanticResult: { ok: true } };
          },
          close: () => { closes += 1; },
        } as any;
      },
      withDirectLifetime: async (operation, options) => {
        lifetimes += 1;
        const pending = operation();
        if (lifetimes > 1) return pending;
        await Promise.resolve();
        options?.onLost?.(new Error('heartbeat lost'));
        throw Object.assign(new Error('heartbeat lost'), {
          code: options?.code, outcomeKnown: options?.outcomeKnownOnLoss,
        });
      },
      fetchFn: (async () => new Response(TEMPLATE, { status: 200 })) as unknown as typeof fetch,
    });

    await expect(semantic.callSemantic({ route: 'one' })).resolves.toMatchObject({
      code: 'controller-firefox-semantic-lifetime-lost', outcomeKnown: false,
    });
    resolveFirst({ call: async () => { calls += 1; }, close: () => { closes += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ calls, closes }).toEqual({ calls: 0, closes: 1 });
    await expect(semantic.callSemantic({ route: 'two' })).resolves.toEqual({ ok: true });
    expect(generations).toBe(2);
    semantic.close();
    expect(closes).toBe(2);
  });

  test('a missing Firefox controller connector releases its lifetime', async () => {
    let starts = 0;
    let stops = 0;
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false,
      authorizeTurnCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: 'session-1', instanceId: null,
        origin: null, target: 'orchestrator-turn', replayClass: 'E',
      }),
      handleTurnKernelCall: async () => ({ ok: true }),
      authorizeSemanticCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
        origin: null, target: 'semantic:test:first-party', replayClass: 'A',
      }),
      handleSemanticKernelCall: async () => ({ ok: true }),
      withDirectLifetime: async (operation) => {
        starts += 1;
        try { return await operation(); } finally { stops += 1; }
      },
      fetchFn: (async () => new Response(TEMPLATE, { status: 200 })) as unknown as typeof fetch,
    });
    await expect(semantic.callTurn({ sessionId: 'session-1' })).resolves.toMatchObject({
      code: 'controller-turn-startup-failed', outcomeKnown: true,
      error: 'Temporarily unavailable. Try again.',
    });
    expect({ starts, stops }).toEqual({ starts: 2, stops: 2 });
  });

  test('a failed lazy controller realm is retired before the visible startup failure returns', async () => {
    const retirements: string[] = [];
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
      ensureOffscreen: async () => {},
      offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: false,
      dwebEnabled: false,
      withControllerLease: (operation) => operation(nextTestControllerLease()),
      retireHost: async (reason) => { retirements.push(reason); },
      fetchFn: (async () => new Response(TEMPLATE, { status: 200 })) as unknown as typeof fetch,
      listWindowClients: async () => [{
        url: 'chrome-extension://test/offscreen/offscreen.html',
        postMessage: (data: any, transfer: MessagePort[]) => {
          transfer[0].postMessage({
            protocol: data.protocol,
            channelId: data.channelId,
            buildDigest: data.buildDigest,
            kernelEpoch: data.kernelEpoch,
            hostEpoch: null,
            sequence: 1,
            type: 'controller/unavailable',
            code: 'controller-host-load-failed',
          });
          transfer[0].close();
        },
      }],
    });
    await expect(semantic.renderSystemPrompt({ actorType: 'orchestrator' }))
      .rejects.toMatchObject({
        message: 'Temporarily unavailable. Try again.',
        code: 'controller-prompt-startup-failed',
        outcomeKnown: true, phase: 'startup', retryable: true,
      });
    expect(retirements).toEqual([
      'controller-host-startup-failed',
      'controller-host-startup-failed',
    ]);
  });

  test('a module-load timeout retires the Chrome and Firefox controller generation', async () => {
    for (const firefoxDirect of [false, true]) {
      const scheme = firefoxDirect ? 'moz-extension' : 'chrome-extension';
      const workerUrl = `${scheme}://test/background/vault-kernel.js`;
      const offscreenUrl = `${scheme}://test/offscreen/offscreen.html`;
      let attempts = 0;
      let connections = 0;
      const loadController = async () => createController({ handlers: {
        'semantic.dispatch': async () => {
          attempts += 1;
          return attempts === 1
            ? {
              ok: false, code: 'module-load-timeout', outcomeKnown: true,
              retryable: true, phase: 'startup',
            }
            : { ok: true, outcomeKnown: true, semanticResult: { ok: true, ready: true } };
        },
      } });
      const offerHandler = firefoxDirect ? null : makeControllerOfferHandler({
        expectedWorkerUrl: workerUrl,
        expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
        supportedCaps: ['semantic.dispatch'],
        loadController,
      });
      const client = makeSemanticControllerClient({
        browser: { runtime: { getURL: (path: string) => `${scheme}://test/${path}` } },
        ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
        firefoxDirect, dwebEnabled: false,
        authorizeSemanticCall: () => ({
          ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
          origin: null, target: 'semantic:provider/status:first-party', replayClass: 'A',
        }),
        handleSemanticKernelCall: async () => ({ ok: true }),
        ...(firefoxDirect ? {
          withDirectLifetime: (operation: () => Promise<any>) => operation(),
          connectDirectController: (deps: any) => {
            connections += 1;
            return connectDirectController({ ...deps, loadController });
          },
        } : {
          listWindowClients: async () => [{
            url: offscreenUrl,
            postMessage: (data: unknown, transfer: Transferable[]) => {
              connections += 1;
              offerHandler?.({
                isTrusted: true, source: { scriptURL: workerUrl }, data, ports: transfer,
              } as unknown as MessageEvent);
            },
          }],
        }),
        fetchFn: async () => new Response(TEMPLATE, { status: 200 }),
      });
      const payload = {
        protocol: 1, route: 'provider/status', message: { type: 'provider/status' },
      };
      await expect(client.callSemantic(payload)).resolves.toMatchObject({
        ok: false, code: 'module-load-timeout', outcomeKnown: true,
      });
      await expect(client.callSemantic(payload)).resolves.toMatchObject({
        ok: true, ready: true,
      });
      expect({ attempts, connections }).toEqual({ attempts: 2, connections: 2 });
      client.close();
      offerHandler?.close();
    }
  });

  test('a frozen connector times out, rotates, and closes its late generation', async () => {
    let connections = 0;
    let lateClosed = 0;
    let release = (value: any) => {};
    const frozen = new Promise<any>((resolve) => { release = resolve; });
    const client = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false, connectTimeoutMs: 5,
      authorizeSemanticCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
        origin: null, target: 'semantic:provider/status:first-party', replayClass: 'A',
      }),
      handleSemanticKernelCall: async () => ({ ok: true }),
      withDirectLifetime: (operation: () => Promise<any>) => operation(),
      connectDirectController: async () => {
        connections += 1;
        if (connections === 1) return frozen;
        return {
          call: async () => ({ ok: true, semanticResult: { ok: true, generation: 2 } }),
          close() {},
        } as any;
      },
      fetchFn: async () => new Response(TEMPLATE, { status: 200 }),
    });
    const payload = { protocol: 1, route: 'provider/status', message: {} };
    await expect(client.callSemantic(payload)).resolves.toEqual({ ok: true, generation: 2 });
    release({
      call: async () => ({ ok: true }),
      close: () => { lateClosed += 1; },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ connections, lateClosed }).toEqual({ connections: 2, lateClosed: 1 });
    client.close();
  });

  test('an aborted turn stops waiting without cancelling a shared Firefox connection', async () => {
    let release!: (client: any) => void;
    const connecting = new Promise<any>((resolve) => { release = resolve; });
    let calls = 0;
    const client = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false, connectTimeoutMs: 1_000,
      authorizeTurnCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: 'root', instanceId: null,
        origin: null, target: 'turn:root', replayClass: 'C',
      }),
      handleTurnKernelCall: async () => ({ ok: true }),
      withDirectLifetime: (operation: () => Promise<any>) => operation(),
      connectDirectController: async () => connecting,
      fetchFn: async () => new Response(TEMPLATE, { status: 200 }),
    });
    const stopped = new AbortController();
    const first = client.callTurn({ sessionId: 'root' }, { signal: stopped.signal });
    const second = client.callTurn({ sessionId: 'root' });
    stopped.abort();
    await expect(first).resolves.toMatchObject({
      ok: false, code: 'controller-call-aborted', outcomeKnown: true,
    });
    release({
      call: async () => { calls += 1; return { ok: true, generation: 1 }; },
      close() {},
    });
    await expect(second).resolves.toEqual({ ok: true, generation: 1 });
    expect(calls).toBe(1);
    client.close();
  });

  test('compose forwards Stop to the exact controller call and never starts retry two', async () => {
    const abort = new AbortController();
    let calls = 0;
    let observedSignal: AbortSignal | undefined;
    const client = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false,
      authorizeComposeCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: 'root', instanceId: null,
        origin: null, target: 'turn-compose', replayClass: 'A',
      }),
      handleComposeKernelCall: async () => ({ ok: true }),
      withDirectLifetime: (operation: () => Promise<any>) => operation(),
      connectDirectController: async () => ({
        call: async (_capability: string, _payload: any, options: any) => {
          calls += 1;
          observedSignal = options.signal;
          abort.abort();
          return { ok: false, code: 'host-busy', outcomeKnown: true, retryable: true };
        },
        close() {},
      } as any),
      fetchFn: async () => new Response(TEMPLATE, { status: 200 }),
    });
    await expect(client.composeTurn({ text: '@tab' }, { signal: abort.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal).toBe(abort.signal);
    expect(calls).toBe(1);
    client.close();
  });

  test('repeated frozen connectors stop after one safe retry and a later call recovers', async () => {
    let connections = 0;
    const client = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false, connectTimeoutMs: 5,
      authorizeSemanticCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
        origin: null, target: 'semantic:provider/status:first-party', replayClass: 'A',
      }),
      handleSemanticKernelCall: async () => ({ ok: true }),
      withDirectLifetime: (operation: () => Promise<any>) => operation(),
      connectDirectController: async () => {
        connections += 1;
        if (connections < 3) return new Promise<any>(() => {});
        return {
          call: async () => ({ ok: true, semanticResult: { ok: true, generation: 3 } }),
          close() {},
        } as any;
      },
      fetchFn: async () => new Response(TEMPLATE, { status: 200 }),
    });
    const payload = { protocol: 1, route: 'provider/status', message: {} };
    await expect(client.callSemantic(payload)).resolves.toMatchObject({
      ok: false, code: 'semantic-dispatch-startup-failed', outcomeKnown: true,
      error: 'Temporarily unavailable. Try again.', phase: 'startup', retryable: true,
    });
    await expect(client.callSemantic(payload)).resolves.toEqual({ ok: true, generation: 3 });
    expect(connections).toBe(3);
    client.close();
  });

  test('a frozen prompt asset generation is bounded and retryable', async () => {
    let fetches = 0;
    let firstSignal: AbortSignal | undefined;
    const client = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false, promptLoadTimeoutMs: 5,
      withDirectLifetime: (operation: () => Promise<any>) => operation(),
      connectDirectController: async () => ({
        call: async () => ({ ok: true, prompt: 'ready' }), close() {},
      } as any),
      fetchFn: async (_input, init) => {
        fetches += 1;
        if (fetches === 1) {
          firstSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => {});
        }
        return new Response(TEMPLATE, { status: 200 });
      },
    });
    try {
      await client.renderSystemPrompt({});
      throw new Error('expected prompt load failure');
    } catch (cause) {
      expect(cause).toMatchObject({
        code: 'prompt-assets-load-timeout', message: 'Temporarily unavailable. Try again.',
        outcomeKnown: true, phase: 'startup', retryable: true,
      });
    }
    expect(firstSignal?.aborted).toBe(true);
    await expect(client.renderSystemPrompt({})).resolves.toBe('ready');
    expect(fetches).toBe(2);
    client.close();
  });

  test('Chrome waits for exact host retirement before opening a successor generation', async () => {
    const workerUrl = 'chrome-extension://test/background/vault-kernel.js';
    const offscreenUrl = 'chrome-extension://test/offscreen/offscreen.html';
    let connections = 0;
    let retirements = 0;
    let releaseRetirement = () => {};
    let retirementStarted = () => {};
    const retiring = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    const started = new Promise<void>((resolve) => { retirementStarted = resolve; });
    let retired = false;
    const offerHandler = makeControllerOfferHandler({
      expectedWorkerUrl: workerUrl,
      expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
      supportedCaps: ['semantic.dispatch'],
      loadController: async () => createController({ handlers: {
        'semantic.dispatch': async () => ({
          ok: true, semanticResult: { ok: true, generation: 2 },
        }),
      } }),
    });
    const client = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: false, dwebEnabled: false, connectTimeoutMs: 50,
      authorizeSemanticCall: () => ({
        ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
        origin: null, target: 'semantic:provider/status:first-party', replayClass: 'A',
      }),
      handleSemanticKernelCall: async () => ({ ok: true }),
      retireHost: async () => {
        retirements += 1;
        retirementStarted();
        await retiring;
        retired = true;
      },
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (data: unknown, transfer: Transferable[]) => {
          connections += 1;
          if (retired) offerHandler({
            isTrusted: true, source: { scriptURL: workerUrl }, data, ports: transfer,
          } as unknown as MessageEvent);
        },
      }],
      fetchFn: async () => new Response(TEMPLATE, { status: 200 }),
    });
    const payload = { protocol: 1, route: 'provider/status', message: {} };
    const first = client.callSemantic(payload);
    await started;
    const second = client.callSemantic(payload);
    await Promise.resolve();
    expect({ connections, retirements }).toEqual({ connections: 1, retirements: 1 });
    releaseRetirement();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, generation: 2 }, { ok: true, generation: 2 },
    ]);
    // The concurrent caller owns generation 2; the original replay-safe call
    // retries after that bounded lease settles and therefore opens generation 3.
    expect(connections).toBe(3);
    client.close();
    offerHandler.close();
  });
});
