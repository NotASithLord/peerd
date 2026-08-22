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
import { makeSemanticControllerClient } from '../../extension/background/offscreen-controller-client.js';
import { makeControllerOfferHandler } from '../../extension/offscreen/controller-shell.js';
import { createController } from '../../extension/offscreen/controller-runtime.js';
import {
  renderSystemPromptFromAssets,
} from '../../extension/peerd-runtime/loop/system-prompt.js';
import { CONTROLLER_BUILD_DIGEST } from '../../extension/shared/structured-clone-size.js';

const TEMPLATE = readFileSync(join(EXTENSION_DIR, 'peerd-provider/system-prompt.txt'), 'utf8');
const DWEB_TEXT = readFileSync(
  join(EXTENSION_DIR, 'peerd-provider/system-prompt-dweb.txt'), 'utf8',
).trim();
const DWEB_BLOCK = DWEB_TEXT ? `\n${DWEB_TEXT}\n` : '';

describe('production semantic controller slice', () => {
  test('the live Firefox assembly never enters a Chrome offscreen lease', () => {
    const serviceWorker = readFileSync(
      join(EXTENSION_DIR, 'background', 'service-worker.js'), 'utf8',
    );
    expect(serviceWorker).toContain('firefoxDirect: !offscreenAvailable');
    expect(serviceWorker).toContain('withDirectLifetime: (operation, options)');
    expect(serviceWorker).toContain('firefoxBackgroundLifetime.run(operation, options)');
    expect(serviceWorker).toMatch(
      /\.\.\.\(offscreenAvailable\s*\?\s*\{[\s\S]*?withControllerLease:[\s\S]*?\}\s*:\s*\{[\s\S]*?withDirectLifetime:/,
    );
  });

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
    ];
    for (const entry of governed) expect(CONTROLLER_BUILD_ENTRIES).toContain(entry as any);

    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-identity-'));
    try {
      cpSync(EXTENSION_DIR, root, { recursive: true });
      const before = await controllerBuildDigest(root);
      const repositoryHost = join(root, 'offscreen', 'repository-host.js');
      writeFileSync(repositoryHost, `${readFileSync(repositoryHost, 'utf8')}\n// identity mutation\n`);
      expect(await controllerBuildDigest(root)).not.toBe(before);
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

  test('prompt.render is byte-identical through the Chrome private channel', async () => {
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
      offscreenUrl: 'offscreen/offscreen.html',
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
        customSystemPrompt: 'keep responses terse',
        appRole: {
          source: 'local', publisher: 'alice', manifestDigest: 'a'.repeat(64),
          name: 'Example', instructions: 'Maintain the package.',
        },
      },
      { actorType: 'web', backing: 'tab', actorSurface: 'code', schemaReply: true },
    ];
    for (const ctx of contexts) {
      const expected = renderSystemPromptFromAssets(ctx as any, {
        template: TEMPLATE, dwebBlock: DWEB_BLOCK,
      });
      await expect(semantic.renderSystemPrompt(ctx)).resolves.toBe(expected);
    }
    expect(ensures).toBe(1);
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
      origin: null, target: 'semantic:toolbox/read:first-party', replayClass: 'A',
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
        return { ok: true, value: 'export default 1' };
      },
      fetchFn: (async () => new Response(TEMPLATE, { status: 200 })) as unknown as typeof fetch,
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (data: unknown, transfer: Transferable[]) => offerHandler({
          isTrusted: true, source: { scriptURL: workerUrl }, data, ports: transfer,
        } as unknown as MessageEvent),
      }],
    });
    await expect(semantic.callSemantic({
      protocol: 1, route: 'toolbox/read', message: { type: 'toolbox/read', name: 'known' },
    })).resolves.toEqual({ ok: true, body: 'export default 1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: 'semantic.toolbox.get-body', payload: { name: 'known' },
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
        try { return await operation(); }
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

  test('a failed lazy controller realm is retired before the visible startup failure returns', async () => {
    const retirements: string[] = [];
    const semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
      ensureOffscreen: async () => {},
      offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: false,
      dwebEnabled: false,
      withControllerLease: (operation) => operation(),
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
      .rejects.toThrow('semantic prompt renderer unavailable');
    expect(retirements).toEqual([
      'controller-host-startup-failed',
      'controller-host-startup-failed',
    ]);
  });
});
