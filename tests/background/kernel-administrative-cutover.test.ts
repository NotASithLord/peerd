import { describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createKernelAdministrativeControl } from '../../extension/background/kernel-administrative-control.js';
import { createKernelSkillPersistence } from '../../extension/background/kernel-skill-persistence.js';
import { createKernelFeatureControl } from '../../extension/background/kernel-feature-control.js';
import { makeSemanticControllerClient } from '../../extension/background/offscreen-controller-client.js';
import { makeKernelSkillInstallRoutes } from '../../extension/background/kernel-administrative-routes.js';
import { parseSkillMd } from '../../extension/peerd-runtime/skills/parse.js';
import { parseHookMarkdown } from '../../extension/peerd-runtime/tools/hooks/compile.js';
import { scopeId } from '../../extension/peerd-runtime/memory/memory.js';
import { makeConfirmCoordinator } from '../../extension/peerd-egress/confirm/protocol.js';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { createController } from '../../extension/offscreen/controller-runtime.js';
import { createKernelFeatureHost } from '../../extension/offscreen/kernel-feature-host.js';
import {
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
  kernelFeatureAuthorityFor,
} from '../../extension/shared/kernel-feature-policy.js';
import { useFakeIndexedDB } from '../setup.ts';
import { TEST_CONTROLLER_KERNEL_IDENTITY } from './controller-test-identity.ts';

await useFakeIndexedDB();

const hookMarkdown = (id: string) => [
  '---', `id: ${id}`, 'event: pre-tool-use', 'rule:', '  matchArg: url',
  '  pattern: blocked', '  onMatch: block', '---', 'Block one URL pattern.',
].join('\n');

const makeHarness = (overrides: Record<string, any> = {}) => {
  const stored = new Map<string, any>();
  const memory = new Map<string, any>();
  const audits: any[] = [];
  const notes: string[] = [];
  const effects: string[] = [];
  const featureHost = createKernelFeatureHost({
    loaders: { administrative: overrides.adminLoader
      ?? (() => import('../../extension/offscreen/kernel-administrative-host.js')) },
  });
  const featureAbort = overrides.featureAbort ?? new AbortController();
  let control: ReturnType<typeof createKernelAdministrativeControl>;
  const deps = {
    callFeature: async (payload: any, options: any = {}) => {
      const authority = control.authorize(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload);
      const signal = options.signal ?? featureAbort.signal;
      const deadlineAt = Date.now() + (options.timeoutMs ?? 60_000);
      return featureHost.dispatch(payload, {
        signal, authority, deadlineAt,
        kernelCall: (operation: string, value: unknown) => {
          effects.push(operation);
          return control.handleKernelCall(operation, value, {
            capability: KERNEL_FEATURE_DISPATCH_CAPABILITY,
            authority, signal, deadlineAt,
          });
        },
      });
    },
    kv: {
      get: async (key: string) => structuredClone(stored.get(key)),
      set: async (key: string, value: any) => { stored.set(key, structuredClone(value)); },
    },
    auditLog: { append: async (entry: any) => { audits.push(entry); } },
    canWrite: () => {},
    commitSkill: async (text: string, options: any) => {
      const parsed = parseSkillMd(text);
      return {
      id: parsed.name, name: parsed.name, description: parsed.description,
      version: parsed.version, license: parsed.license, allowedTools: parsed.allowedTools,
      source: 'local', origin: options.origin, sizeBytes: parsed.body.length,
      enabled: true, installedAt: 1,
      };
    },
    probeMemoryTab: async () => ({ tab: null }),
    listApps: async () => [],
    idb: {
      get: async (_store: string, id: string) => structuredClone(memory.get(id)),
      transact: async (_stores: string[], operation: Function) => {
        const staged = new Map([...memory].map(([id, value]) => [id, structuredClone(value)]));
        let pending = 0;
        let aborted = false;
        const store = {
          get: (id: string) => {
            const request: any = {};
            pending += 1;
            queueMicrotask(() => {
              request.result = structuredClone(staged.get(id));
              request.onsuccess?.();
              pending -= 1;
            });
            return request;
          },
          put: (doc: any) => {
            overrides.failMemoryPut?.(doc);
            staged.set(doc.id, structuredClone(doc));
          },
          delete: (id: string) => { staged.delete(id); },
        };
        const result = operation({ agents_memory: store }, { abort: () => { aborted = true; } });
        do { await Promise.resolve(); } while (pending > 0);
        if (aborted) throw new Error('transaction aborted');
        memory.clear();
        for (const [id, value] of staged) memory.set(id, value);
        return typeof result === 'function' ? result() : result;
      },
    },
    confirm: async () => 'yes_once',
    currentSessionId: async () => 'session:1',
    assertMemoryInitAllowed: async () => {},
    postChatNote: (text: string) => { notes.push(text); },
    ...overrides,
  };
  control = createKernelAdministrativeControl(deps);
  return { control, stored, memory, audits, notes, effects, featureAbort };
};

describe('sealed administrative root cutover', () => {
  test('matches the existing hook and skill route results through granular effects', async () => {
    const { control, audits, effects } = makeHarness();
    const id = `cutover-${crypto.randomUUID()}`;
    expect(await control.routes['hooks/list']()).toMatchObject({ ok: true });
    expect(await control.routes['hooks/save']({ markdown: hookMarkdown(id) }))
      .toEqual({ ok: true, id });
    expect(await control.routes['hooks/toggle']({ id, enabled: false })).toEqual({ ok: true });
    expect(await control.routes['hooks/remove']({ id })).toEqual({ ok: true });
    expect(audits.map((entry) => entry.type)).toEqual([
      'hook_added', 'hook_disabled', 'hook_removed',
    ]);
    expect(new Set(effects)).toEqual(new Set([
      'administrative.hooks.read',
      'administrative.hooks.save',
      'administrative.hooks.toggle',
      'administrative.hooks.remove',
    ]));

    class SkillExistsError extends Error {}
    class SkillParseError extends Error {}
    class SkillInstallError extends Error {}
    const legacy = makeKernelSkillInstallRoutes({
      skillRegistry: { install: async (text: string) => ({ name: parseSkillMd(text).name }) },
      canWrite: () => {}, pushState: () => {}, REMOTE_SKILL_INSTALL: false,
      installFromLocal: ({ registry }: any, { text }: any) => registry.install(text),
      installFromGit: async () => {}, installFromManifest: async () => {},
      SkillExistsError, SkillParseError, SkillInstallError,
    });
    expect(await control.routes['skills/installGit']({ url: 'https://example.test' }))
      .toEqual(await legacy['skills/installGit']({ url: 'https://example.test' }));
    const skill = [
      '---', 'name: skill-one', 'description: One skill', '---', '', '# One', 'Body.',
    ].join('\n');
    expect(await control.routes['skills/installLocal']({ text: skill }))
      .toMatchObject(await legacy['skills/installLocal']({ text: skill }));
  });

  test('keeps write refusals known and storage loss after dispatch unknown', async () => {
    const refused = makeHarness({ canWrite: () => { throw new Error('read-only'); } });
    const refusedId = `refused-${crypto.randomUUID()}`;
    expect(await refused.control.routes['hooks/save']({ markdown: hookMarkdown(refusedId) }))
      .toMatchObject({ ok: false, outcomeKnown: true, code: 'administrative-write-refused' });

    const lost = makeHarness({
      kv: { get: async () => [], set: async () => { throw new Error('storage lost'); } },
    });
    const lostId = `lost-${crypto.randomUUID()}`;
    expect(await lost.control.routes['hooks/save']({ markdown: hookMarkdown(lostId) }))
      .toMatchObject({ ok: false, outcomeKnown: false,
        code: 'administrative-hooks-write-unknown' });
  });

  test('preserves accepted-then-note memory init while the sealed lease finishes', async () => {
    const { control, memory, notes } = makeHarness();
    expect(control.routes['memory/init']()).toEqual({ ok: true });
    for (let attempt = 0; attempt < 50 && !notes.some((note) => note.includes('saved AGENTS.md'));
      attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(notes[0]).toContain('/init scanned workspace');
    expect(notes.at(-1)).toContain('/init saved AGENTS.md');
    expect(memory.size).toBe(2);
  });

  test('rejects sibling, full-set, source, and same-route effect substitution', async () => {
    const original = hookMarkdown('original-hook');
    for (const operation of [
      'administrative.hooks.remove',
      'administrative.hooks.write',
      'administrative.hooks.save',
    ]) {
      const harness = makeHarness({
        adminLoader: async () => ({ routes: {
          'hooks/save': async (_message: any, context: any) => context.effects.call(
            operation,
            operation === 'administrative.hooks.remove' ? { id: 'sibling-hook' }
              : operation === 'administrative.hooks.write' ? { records: [] }
                : { record: parseHookMarkdown(hookMarkdown('substituted-hook')) },
          ),
        } }),
      });
      expect(await harness.control.routes['hooks/save']({ markdown: original }))
        .toMatchObject({ ok: false, outcomeKnown: true });
      expect(harness.stored.size).toBe(0);
    }

    let commits = 0;
    const skillHarness = makeHarness({
      commitSkill: async () => { commits += 1; return {}; },
      adminLoader: async () => ({ routes: {
        'skills/installLocal': async (_message: any, context: any) => context.effects.call(
          'administrative.skills.commit', {
            text: 'substituted source',
            parsed: {
              name: 'forged', description: 'forged', version: null, license: null,
              allowedTools: [], body: 'forged',
            },
            origin: 'local', replace: false,
          },
        ),
      } }),
    });
    const skill = [
      '---', 'name: original', 'description: Original', '---', '', 'Original body.',
    ].join('\n');
    expect(await skillHarness.control.routes['skills/installLocal']({ text: skill }))
      .toMatchObject({ ok: false, outcomeKnown: true });
    expect(commits).toBe(0);

    const projectionHarness = makeHarness({
      commitSkill: async () => { commits += 1; return {}; },
      adminLoader: async () => ({ routes: {
        'skills/installLocal': async (message: any, context: any) => context.effects.call(
          'administrative.skills.commit', {
            text: message.text,
            parsed: {
              name: 'forged', description: 'forged', version: null, license: null,
              allowedTools: [], body: 'forged',
            },
            origin: 'local', replace: false,
          },
        ),
      } }),
    });
    expect(await projectionHarness.control.routes['skills/installLocal']({ text: skill }))
      .toMatchObject({ ok: false, outcomeKnown: true });
    expect(commits).toBe(0);
  });

  test('commits exact SKILL.md bytes through the real kernel authority', async () => {
    const databaseName = `administrative-skill-${crypto.randomUUID()}`;
    const factory: IDBFactory = new Proxy(indexedDB, {
      get(target, property) {
        if (property === 'open') {
          return (_name: string, version?: number) => target.open(databaseName, version);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const persistence = createKernelSkillPersistence({ idbFactory: factory, now: () => 7 });
    const harness = makeHarness({ commitSkill: persistence.commit });
    const text = [
      '---', 'name: Exact Skill', 'description: Exact projection', '---', '',
      '# Exact', 'Original body.',
    ].join('\n');
    expect(await harness.control.routes['skills/installLocal']({ text }))
      .toMatchObject({ ok: true, skill: { name: 'exact-skill', description: 'Exact projection' } });
    expect(await persistence.list()).toEqual([expect.objectContaining({
      id: 'exact-skill', sizeBytes: new TextEncoder().encode('# Exact\nOriginal body.').length,
    })]);
    const storedText = await new Promise<string>((resolve, reject) => {
      const open = factory.open(databaseName, 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const request = open.result.transaction('bodies').objectStore('bodies').get('exact-skill');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result.text);
      };
    });
    expect(storedText).toBe(text);
  });

  test('binds confirmation to the current session and rejects a concurrent memory write', async () => {
    let prompt: any;
    let answer!: (value: string) => void;
    const confirmation = new Promise<string>((resolve) => { answer = resolve; });
    const harness = makeHarness({
      confirm: async (value: any) => { prompt = value; return confirmation; },
    });
    harness.control.routes['memory/init']();
    for (let attempt = 0; attempt < 50 && !prompt; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(prompt).toMatchObject({
      toolName: 'init', sideEffect: 'write',
      sessionId: 'session:1', ownerSessionId: 'session:1', dispatchId: null,
      proposal: { id: scopeId({ kind: 'project', workspace: 'workspace' }) },
    });
    const projectId = scopeId({ kind: 'project', workspace: 'workspace' });
    harness.memory.set(projectId, {
      id: projectId, kind: 'project', workspace: 'workspace',
      body: 'concurrent user bytes', createdAt: 2, updatedAt: 2,
    });
    answer('yes_once');
    for (let attempt = 0; attempt < 50
      && !harness.notes.some((entry) => entry.includes('memory-write-conflict'));
      attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.memory.get(projectId)?.body).toBe('concurrent user bytes');
    expect(harness.memory.size).toBe(1);
  });

  test('uses the real confirmation claim and Stop retires the card without a late write', async () => {
    const acceptedPrompts: any[] = [];
    const acceptedCoordinator = makeConfirmCoordinator({
      notifySidePanel: (prompt) => { acceptedPrompts.push(prompt); },
      isChannelOpen: () => true,
    });
    const accepted = makeHarness({ confirm: acceptedCoordinator.confirm });
    accepted.control.routes['memory/init']();
    for (let attempt = 0; attempt < 50 && acceptedPrompts.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const acceptedPrompt = acceptedPrompts[0];
    expect(acceptedCoordinator.resolve({
      id: acceptedPrompt.id,
      ownerSessionId: acceptedPrompt.ownerSessionId,
      sessionId: acceptedPrompt.sessionId,
      dispatchId: acceptedPrompt.dispatchId,
    }, 'yes_once', 'sidepanel')).toBe(true);
    for (let attempt = 0; attempt < 50 && accepted.memory.size < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(accepted.memory.size).toBe(2);

    const prompts: any[] = [];
    const settlements: any[] = [];
    const coordinator = makeConfirmCoordinator({
      notifySidePanel: (prompt) => { prompts.push(prompt); },
      isChannelOpen: () => true,
      onSettled: (id, prompt, outcome) => { settlements.push({ id, prompt, outcome }); },
    });
    const harness = makeHarness({ confirm: coordinator.confirm });
    harness.control.routes['memory/init']();
    for (let attempt = 0; attempt < 50 && prompts.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const prompt = prompts[0];
    expect(coordinator.resolve({
      id: prompt.id, ownerSessionId: 'wrong',
      sessionId: prompt.sessionId, dispatchId: prompt.dispatchId,
    }, 'yes_once')).toBe(false);
    harness.featureAbort.abort();
    for (let attempt = 0; attempt < 50 && settlements.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(settlements[0]?.outcome).toMatchObject({ answer: 'no', cause: 'abort' });
    expect(harness.memory.size).toBe(0);
    expect(coordinator.resolve({
      id: prompt.id,
      ownerSessionId: prompt.ownerSessionId,
      sessionId: prompt.sessionId,
      dispatchId: prompt.dispatchId,
    }, 'yes_once')).toBe(false);
  });

  test('omits hung probes independently and ignores their late values', async () => {
    let resolveTab!: (value: any) => void;
    const lateTab = new Promise((resolve) => { resolveTab = resolve; });
    const tabHung = makeHarness({
      probeMemoryTab: () => lateTab,
      listApps: async () => [{ id: 'app:1', name: 'App One' }],
      probeTimeoutMs: 5,
    });
    tabHung.control.routes['memory/init']();
    for (let attempt = 0; attempt < 100
      && !tabHung.notes.some((entry) => entry.includes('saved AGENTS.md'));
      attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    const projectId = scopeId({ kind: 'project', workspace: 'workspace' });
    const saved = tabHung.memory.get(projectId)?.body;
    expect(saved).toContain('App One');
    expect(tabHung.notes.some((entry) => entry.includes('probe did not finish'))).toBe(true);
    resolveTab({ tab: { url: 'https://late.invalid', title: 'late mutation' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tabHung.memory.get(projectId)?.body).toBe(saved);

    const appsHung = makeHarness({
      probeMemoryTab: async () => ({ tab: null }),
      listApps: () => new Promise(() => {}),
      probeTimeoutMs: 5,
    });
    appsHung.control.routes['memory/init']();
    for (let attempt = 0; attempt < 100
      && !appsHung.notes.some((entry) => entry.includes('saved AGENTS.md'));
      attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(appsHung.memory.size).toBe(2);
  });

  test('rolls back both memory rows when the initializer write fails', async () => {
    const harness = makeHarness({
      failMemoryPut: (doc: any) => {
        if (doc.subpath === '.peerd/initializer') throw new Error('initializer failed');
      },
    });
    harness.control.routes['memory/init']();
    for (let attempt = 0; attempt < 50
      && !harness.notes.some((entry) => entry.includes('/init failed'));
      attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.memory.size).toBe(0);
  });

  test('keeps parsers and browser policy out of the kernel and hook demand graphs', async () => {
    const root = join(process.cwd(), 'extension');
    const hostGraph = await collectStaticModuleGraph(
      root, join(root, 'offscreen/kernel-administrative-host.js'),
    );
    const kernelGraph = await collectStaticModuleGraph(
      root, join(root, 'background/kernel-skills-authority.js'),
    );
    const controlGraph = await collectStaticModuleGraph(
      root, join(root, 'background/kernel-administrative-control.js'),
    );
    const probeGraph = await collectStaticModuleGraph(
      root, join(root, 'background/kernel-memory-init-probe.js'),
    );
    const graphBytes = async (graph: Set<string>) => {
      let bytes = 0;
      for (const path of graph) bytes += (await stat(path)).size;
      return bytes;
    };
    expect([...hostGraph].some((path) => path.endsWith('/peerd-runtime/administrative.js')))
      .toBe(false);
    expect([...hostGraph].some((path) => path.endsWith('/memory/store.js'))).toBe(false);
    expect([...hostGraph].some((path) => path.endsWith('/memory/init-orchestrator.js')))
      .toBe(false);
    expect([...hostGraph].some((path) => path.includes('/tools/hooks/defaults/'))).toBe(false);
    expect([...kernelGraph].some((path) => path.endsWith('/skills/parse.js'))).toBe(false);
    expect([...kernelGraph].some((path) => path.includes('browser-automation-policy'))).toBe(false);
    expect([...controlGraph].some((path) => path.endsWith('/tools/hooks/compile.js'))).toBe(false);
    expect([...probeGraph].some((path) => path.includes('/peerd-runtime/'))).toBe(false);
    expect(await graphBytes(hostGraph)).toBeLessThan(100_000);
    expect(await graphBytes(probeGraph)).toBeLessThan(10_000);
    expect(await graphBytes(kernelGraph)).toBeLessThan(20_000);
  });

  test('bounds administrative module hangs and keeps cancelled reads replayable', async () => {
    const payload = Object.freeze({
      cluster: 'administrative', route: 'hooks/list',
      dispatchId: 'dispatch-admin-1', message: Object.freeze({}),
    });
    const authority = kernelFeatureAuthorityFor(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload);
    const hung = createKernelFeatureHost({
      loaders: { administrative: () => new Promise(() => {}) }, loadTimeoutMs: 5,
    });
    expect(await hung.dispatch(payload, {
      signal: new AbortController().signal, authority, deadlineAt: Date.now() + 1_000,
    })).toMatchObject({
      ok: false, code: 'feature-administrative-load-timeout', outcomeKnown: true,
      phase: 'startup', retryable: true,
    });

    const abort = new AbortController();
    let markStarted = () => {};
    const effectStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const started = createKernelFeatureHost({ loaders: {
      administrative: async () => ({ routes: {
        'hooks/list': async (_message: unknown, context: any) => {
          const result = await context.effects.call('administrative.hooks.read', {});
          if (result.ok !== true) throw Object.assign(new Error(result.code), {
            outcomeKnown: result.outcomeKnown,
          });
          return { ok: true };
        },
      } }),
    } });
    const call = started.dispatch(payload, {
      signal: abort.signal, authority, deadlineAt: Date.now() + 1_000,
      kernelCall: () => new Promise((resolve) => {
        markStarted();
        abort.signal.addEventListener(
          'abort', () => resolve({ ok: false, code: 'cancelled', outcomeKnown: false }),
          { once: true },
        );
      }),
    });
    await effectStarted;
    abort.abort();
    expect(await call).toMatchObject({
      ok: false, code: 'feature-host-generation-expired', outcomeKnown: true, phase: 'run',
      retryable: true,
    });
  });

  test('default controller physically loads the fixed administrative host', async () => {
    const payload = Object.freeze({
      cluster: 'administrative', route: 'hooks/list',
      dispatchId: 'dispatch-admin-2', message: Object.freeze({}),
    });
    const controller = await createController();
    expect(await controller.call(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload, {
      signal: new AbortController().signal,
      authority: kernelFeatureAuthorityFor(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload),
      deadlineAt: Date.now() + 5_000,
      kernelCall: async () => ({ ok: true, outcomeKnown: true, value: [] }),
    })).toMatchObject({ ok: true, value: { ok: true, hooks: expect.any(Array) } });
  });

  test('Firefox direct transport offers and authorizes the identical feature contract', async () => {
    let semantic: ReturnType<typeof makeSemanticControllerClient>;
    const offered: string[][] = [];
    const feature = createKernelFeatureControl({
      call: (_capability, payload, options) => semantic.callFeature(payload, options),
      handleEffect: async () => ({ ok: true, outcomeKnown: true, value: [] }),
    });
    semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false,
      kernelIdentity: TEST_CONTROLLER_KERNEL_IDENTITY,
      authorizeFeatureCall: feature.authorize,
      handleFeatureKernelCall: feature.handleKernelCall,
      withDirectLifetime: (operation: () => Promise<any>) => operation(),
      connectDirectController: (async (deps: any) => {
        offered.push(deps.capabilities);
        return {
          call: async (capability: string, payload: unknown) => {
            const authority = deps.authorizeCall(capability, payload);
            const effect = await deps.handleKernelCall(
              'administrative.hooks.read', {}, {
                capability, authority, signal: new AbortController().signal,
                deadlineAt: Date.now() + 1_000,
              },
            );
            return { ok: true, outcomeKnown: true, value: effect.value };
          },
          close: () => {},
        };
      }) as any,
      fetchFn: (async () => new Response('')) as unknown as typeof fetch,
    });
    expect(await feature.dispatch('administrative', 'hooks/list', {}))
      .toEqual({ ok: true, outcomeKnown: true, value: [] });
    expect(offered).toEqual([[
      'prompt.render', 'turn.tools.project', KERNEL_FEATURE_DISPATCH_CAPABILITY,
    ]]);
    semantic.close();
  });
});
