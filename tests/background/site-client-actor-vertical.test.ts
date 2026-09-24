import { describe, expect, test } from 'bun:test';
import { makeOffscreenActorClient } from '../../extension/background/offscreen-actor-client.js';
import { runActor } from '../../extension/offscreen/actor-runner.js';
import { startActorWorker } from '../../extension/offscreen/actor-worker-runtime.js';
import {
  ACTOR_REALM_FACT_KEYS,
  ACTOR_WORKER_PROTOCOL,
} from '../../extension/offscreen/actor-worker-protocol.js';
import { projectControllerToolSurface } from '../../extension/peerd-runtime/controller-tool-projection.js';
import { canonicalCloneDigest } from '../../extension/shared/canonical-clone-digest.js';
import { controllerDomainOperationPayloadCap } from '../../extension/shared/controller-kernel-quota.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

type ToolCall = { id: string; name: string; args: Record<string, unknown> };

const REALM = Object.freeze({
  dedicatedWorker: true,
  ...Object.fromEntries(ACTOR_REALM_FACT_KEYS.map((key) => [key, false])),
});

const modelCallFor = (calls: ToolCall[]) => {
  let round = 0;
  return async function* () {
    const call = calls[round++];
    if (!call) {
      yield { type: 'text-delta', text: 'done' };
      yield { type: 'message-stop', stopReason: 'end_turn' };
      return;
    }
    yield { type: 'tool-use-start', id: call.id, name: call.name };
    yield {
      type: 'tool-use-delta', id: call.id,
      partialJson: JSON.stringify(call.args),
    };
    yield { type: 'tool-use-stop', id: call.id };
    yield { type: 'message-stop', stopReason: 'tool_use' };
  };
};

class InProcessActorWorker {
  hostListeners = new Map<string, Array<(event: any) => void | Promise<void>>>();
  workerListener: ((event: MessageEvent) => void | Promise<void>) | null = null;
  terminated = false;

  readonly scope = {
    addEventListener: (type: string, listener: (event: MessageEvent) => void | Promise<void>) => {
      if (type === 'message') this.workerListener = listener;
    },
    postMessage: (message: any) => {
      queueMicrotask(() => this.emitToHost(message));
    },
  };

  boot() {
    Object.defineProperty(globalThis, 'self', { value: this.scope, configurable: true });
    startActorWorker(null, () => REALM);
  }

  addEventListener(type: string, listener: (event: any) => void | Promise<void>) {
    const listeners = this.hostListeners.get(type) ?? [];
    listeners.push(listener);
    this.hostListeners.set(type, listeners);
  }

  postMessage(message: any) {
    if (this.terminated) return;
    if (message.type === 'probe') {
      // The real bootstrap sealing and realm-sabotage probe have their own tests.
      // This in-process fixture cannot create a second global object, so answer
      // only the host handshake before exercising the complete production turn.
      queueMicrotask(() => this.emitToHost({
        type: 'probe-response', protocol: ACTOR_WORKER_PROTOCOL,
        rid: message.rid, canaryAbsent: true, realm: REALM,
        prototypeFetchBlocked: true, prototypeStorageBlocked: true,
      }));
      return;
    }
    queueMicrotask(() => { void this.workerListener?.({ data: message } as MessageEvent); });
  }

  emitToHost(message: any) {
    if (this.terminated) return;
    for (const listener of this.hostListeners.get('message') ?? []) {
      void listener({ data: message });
    }
  }

  terminate() { this.terminated = true; }
}

const projectionFor = (names: string[]) => {
  const projection: any = projectControllerToolSurface({ surface: 'selection', toolNames: names });
  if (projection.ok === false) throw new Error(projection.code);
  return projection;
};

const storedRecord = (origin: string, body: string, summary = 'fixture client') => ({
  meta: {
    origin, summary, endpoints: [{ method: 'GET', path: '/items' }],
    auth: 'browser-session', deriver: 'capture', sizeBytes: body.length,
    derivedAt: 1, lastVerifiedAt: 0, recentFailures: 0, createdAt: 1, updatedAt: 1,
  },
  body,
});

const lifecycle = (settlements: any[], beginnings: any[] = []) => ({
  requiresIntentConfirmation: async () => false,
  beginTracking: async (input: any) => {
    beginnings.push(input);
    return { handle: {
      operationId: `tracked:${input.callId}`,
      retryClass: input.tool.retryClass,
      toolName: input.tool.name,
    } };
  },
  settleTracking: async (handle: any, result: any) => { settlements.push({ handle, result }); },
});

const runProductionActor = async ({
  actorRecord, calls, buildToolContext, ownedTabFor, tabOrigin,
}: {
  actorRecord: any;
  calls: ToolCall[];
  buildToolContext: (input?: any) => Promise<any>;
  ownedTabFor?: (sessionId: string) => number | undefined;
  tabOrigin?: string;
}) => {
  const projection = projectionFor([...new Set(calls.map((call) => call.name))]);
  const scriptedModel = modelCallFor(calls);
  const providerEgress = makeScriptedProviderAuthority(() => scriptedModel);
  const lateRelay = {
    current: null as ((type: string, payload: any) => Promise<any>) | null,
  };
  let turnGeneration = '';
  let previousSelf: typeof globalThis.self | undefined;
  const client = makeOffscreenActorClient({
    ensureHost: async () => {},
    isRelaySender: () => true,
    sendMessage: async () => ({ ok: false, error: 'unexpected runtime message' }),
    sessions: { get: async () => structuredClone(actorRecord) },
    buildToolContext,
    ownedTabFor,
    providerEgress,
    spendRefusalFor: async () => null,
    appendAudit: async () => {},
    runOnChannel: async (job: any, { relay }: any) => {
      lateRelay.current = (type, payload) => Promise.resolve(relay(type, payload));
      turnGeneration = job.turnGeneration;
      const worker = { current: null as InProcessActorWorker | null };
      previousSelf = globalThis.self;
      try {
        return await runActor(job, {
          workerUrl: '/test/actor-worker.js',
          sendToSW: (type, payload) => Promise.resolve(relay(type, payload)),
          createWorker: () => {
            worker.current = new InProcessActorWorker();
            worker.current.boot();
            return worker.current as unknown as Worker;
          },
          startupMs: 2_000,
          relayDrainMs: 2_000,
        });
      } finally {
        worker.current?.terminate();
        if (previousSelf === undefined) delete (globalThis as any).self;
        else Object.defineProperty(globalThis, 'self', {
          value: previousSelf, configurable: true,
        });
      }
    },
  });
  const result = await client.run({
    actorSessionId: actorRecord.sessionId,
    actorType: actorRecord.actorType,
    backing: actorRecord.backing,
    instanceId: actorRecord.instanceId,
    message: 'exercise site client', systemPrompt: 'PINNED',
    provider: 'anthropic', model: 'claude-sonnet-4-6',
    maxSteps: calls.length + 1, maxOutputTokens: 512,
    tools: projection.tools, allowedOperations: projection.operations,
    actorSurface: 'tools',
    semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
    ...(actorRecord.backing === 'tab' ? { tabOrigin: tabOrigin ?? 'https://example.test' } : {}),
    ...(actorRecord.backing === 'api' ? { origin: actorRecord.instanceId } : {}),
  } as any);
  return { result, lateRelay: lateRelay.current, turnGeneration, projection };
};

describe('production site-client actor vertical', () => {
  test.serial('tab Web actor runs read/write/execute/capture through exact host custody', async () => {
    const origin = 'https://example.test';
    const body = 'return { list: async () => ["host-owned"] };';
    const actorRecord = {
      kind: 'actor', sessionId: 'web-site-client', actorType: 'web',
      backing: 'tab', instanceId: 'web',
    };
    let record: any = null;
    const effects: string[] = [];
    const confirmations: any[] = [];
    const beginnings: any[] = [];
    const settlements: any[] = [];
    const audits: any[] = [];
    const contextInputs: any[] = [];
    const calls: ToolCall[] = [
      { id: 'write-client', name: 'site_client_write', args: {
        origin, summary: 'captured API', endpoints: [{ method: 'GET', path: '/items' }],
        auth: 'browser-session', deriver: 'capture', body,
      } },
      { id: 'foreign-read', name: 'site_client_read', args: {
        origin: 'https://other.example.test',
      } },
      { id: 'read-client', name: 'site_client_read', args: { origin } },
      { id: 'run-client', name: 'site_client_run', args: {
        origin, code: 'return await client.list()', timeoutMs: 5_000,
      } },
      { id: 'capture-start', name: 'site_capture', args: { action: 'start' } },
      { id: 'capture-stop', name: 'site_capture', args: { action: 'stop' } },
    ];
    const { result, lateRelay, turnGeneration } = await runProductionActor({
      actorRecord, calls, ownedTabFor: () => 17,
      buildToolContext: async (input) => {
        contextInputs.push(input);
        return {
          session: { sessionId: actorRecord.sessionId, kind: 'actor' },
          actorType: 'web', actorBacking: 'tab', backing: 'tab',
          actorInstanceId: 'web',
          activeTab: { id: 17, windowId: 1, url: `${origin}/items`, origin },
          tabs: { get: async (id: number) => {
            effects.push(`tabs.get:${id}`);
            return { id, windowId: 1, url: `${origin}/items` };
          } },
          scripting: { executeScript: async ({ func }: any) => {
            if (func?.name === 'liveDocumentLocationInjected') return [{
              documentId: 'document-17',
              result: { origin, href: `${origin}/items`, timeOrigin: 17 },
            }];
            if (func?.name === 'hasPasswordFieldInjected') return [{
              documentId: 'document-17', result: { has: false, capped: false },
            }];
            throw new Error(`unexpected document probe: ${func?.name}`);
          } },
          authorizeSiteClientOrigin: async (candidate: string) => candidate === origin,
          siteClients: {
            get: async (candidate: string) => {
              effects.push(`store.get:${candidate}`);
              return structuredClone(record);
            },
            put: async ({ dossier, body: nextBody }: any) => {
              effects.push('store.put');
              record = storedRecord(origin, nextBody, dossier.summary);
              return structuredClone(record.meta);
            },
            remove: async () => { effects.push('store.remove'); record = null; },
            recordRun: async ({ ok }: any) => { effects.push(`store.recordRun:${ok}`); },
          },
          confirm: async (request: any) => {
            confirmations.push(request);
            effects.push('confirm');
            return 'yes_once';
          },
          jsOffscreenClient: { execHeadless: async (source: string, options: any) => {
            effects.push('worker.exec');
            expect(source).toContain(body);
            expect(source).toContain('return await client.list()');
            expect(options).toMatchObject({
              timeoutMs: 5_000, siteFetch: origin,
              ownerSessionId: actorRecord.sessionId,
            });
            return { value: ['host-owned'], durationMs: 2, error: null };
          } },
          scriptRuns: {
            mintRunId: () => 'site-run-1',
            register: () => { effects.push('run.register'); },
            release: () => { effects.push('run.release'); },
          },
          siteCapture: {
            start: async (request: any) => {
              effects.push('capture.start');
              expect(request).toMatchObject({
                tabId: 17, origins: [origin, 'https://api.example.test'],
                documentId: 'document-17',
              });
              return { tap: 'scripting' };
            },
            stop: async (request: any) => {
              effects.push('capture.stop');
              expect(request).toMatchObject({
                tabId: 17, origins: [origin, 'https://api.example.test'],
              });
              return {
                deriver: 'capture', dropped: 0,
                originDigests: [{
                  origin, auth: 'browser-session',
                  endpoints: [{ method: 'GET', path: '/items' }],
                }],
              };
            },
          },
          permission: { mode: 'act', confirmActions: false },
          readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
          lifecycle: lifecycle(settlements, beginnings),
          appendAudit: async (entry: any) => { audits.push(entry); },
        };
      },
    });

    expect(result).toMatchObject({ ok: true, started: true, finalText: 'done' });
    expect(result.newMessages).toHaveLength(calls.length * 2 + 2);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      tool: 'site_client_write', origins: [origin], sessionId: actorRecord.sessionId,
    });
    expect(effects).toContain('store.put');
    expect(effects).toContain('worker.exec');
    expect(effects).toContain('capture.start');
    expect(effects).toContain('capture.stop');
    expect(effects).not.toContain('store.get:https://other.example.test');
    expect(effects.indexOf('confirm')).toBeLessThan(effects.indexOf('store.put'));
    // Pure reads do not open a mutation lifecycle. Commit, execution and both
    // capture mutations must track the exact actor/effect intent and settle the
    // same host-owned handle with an exact performed verdict.
    const tracked = [
      {
        operation: 'turn.site-client.commit', effectId: 'write-client:2',
        sideEffect: 'write', args: {
          origin, summary: 'captured API',
          endpoints: [{ method: 'GET', path: '/items' }],
          auth: 'browser-session', deriver: 'capture', body,
        },
      },
      {
        operation: 'turn.site-client.run', effectId: 'run-client:1',
        sideEffect: 'mutate_external',
        args: { origin, code: 'return await client.list()', timeoutMs: 5_000 },
      },
      {
        operation: 'turn.site-client.capture-start', effectId: 'capture-start:1',
        sideEffect: 'mutate_external', args: {},
      },
      {
        operation: 'turn.site-client.capture-stop', effectId: 'capture-stop:1',
        sideEffect: 'mutate_external', args: {},
      },
    ];
    const lifecycleTurnId = beginnings[0]?.turnId;
    expect(typeof lifecycleTurnId).toBe('string');
    const hostTarget = `web:${actorRecord.sessionId}:web:tab:tab:17`;
    const expectedBeginnings = await Promise.all(tracked.map(async (entry) => ({
      callId: entry.effectId,
      tool: {
        name: entry.operation, primitive: 'authority',
        retryClass: 'E', sideEffect: entry.sideEffect,
      },
      sessionId: actorRecord.sessionId,
      ownerSessionId: actorRecord.sessionId,
      target: `${entry.operation}:${hostTarget}:${await canonicalCloneDigest(entry.args, {
        maxBytes: controllerDomainOperationPayloadCap(entry.operation),
      })}`,
      args: entry.args,
      confirmed: false,
      confirmedIntent: false,
      turnId: lifecycleTurnId,
      userInitiated: true,
    })));
    expect(beginnings).toEqual(expectedBeginnings);
    expect(settlements).toEqual(expectedBeginnings.map((entry) => ({
      handle: {
        operationId: `tracked:${entry.callId}`,
        retryClass: entry.tool.retryClass,
        toolName: entry.tool.name,
      },
      result: { ok: true, aborted: false, outcomeKind: 'effect-completed' },
    })));
    expect(contextInputs.every((input) => input.actorType === 'web'
      && input.actorBacking === 'tab' && input.activeTabId === 17)).toBe(true);
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'authority_effect',
      details: expect.objectContaining({
        operation: 'turn.site-client.commit', performed: true, outcomeKnown: true,
      }),
    }));
    const toolBlocks = result.newMessages.flatMap((message: any) => message.toolResults ?? []);
    expect(toolBlocks).toHaveLength(calls.length);
    expect(toolBlocks.every((block: any) => block.outcomeKnown === true)).toBe(true);
    expect(toolBlocks.find((block: any) => block.tool_use_id === 'write-client'))
      .toMatchObject({ authorityPerformed: true });
    expect(toolBlocks.find((block: any) => block.tool_use_id === 'read-client'))
      .toMatchObject({ authorityPerformed: false });
    expect(toolBlocks.find((block: any) => block.tool_use_id === 'foreign-read'))
      .toMatchObject({
        is_error: true, authorityPerformed: false, outcomeKnown: true,
        content: expect.stringContaining('site_client_origin_refused'),
      });

    const replay = await lateRelay?.('site-client/read', {
      operation: 'turn.site-client.read', callId: 'late-read', effectId: 'late-read:1',
      effectSequence: 1, turnGeneration, origin,
    });
    expect(replay).toMatchObject({
      ok: false, error: 'site-client/read: authority mismatch', outcomeKnown: true,
    });
  });

  test.serial('API Web actor runs its exact origin surface and cannot forge capture', async () => {
    const origin = 'https://api.example.test';
    const body = 'return { get: async () => ({ ok: true }) };';
    const actorRecord = {
      kind: 'actor', sessionId: 'api-site-client', actorType: 'web',
      backing: 'api', instanceId: origin,
    };
    let record: any = storedRecord(origin, body);
    let browserEffects = 0;
    let contextBuilds = 0;
    let forgedCapture: any = null;
    const calls: ToolCall[] = [
      { id: 'api-read', name: 'site_client_read', args: { origin } },
      { id: 'api-run', name: 'site_client_run', args: {
        origin, code: 'return await client.get()', timeoutMs: 1_000,
      } },
      { id: 'api-write', name: 'site_client_write', args: {
        origin, summary: 'updated', body: `${body}\n// updated`,
      } },
    ];
    const projection = projectionFor(['site_client_run', 'site_client_read', 'site_client_write']);
    const scriptedModel = modelCallFor(calls);
    const providerEgress = makeScriptedProviderAuthority(() => scriptedModel);
    let previousSelf: typeof globalThis.self | undefined;
    const client = makeOffscreenActorClient({
      ensureHost: async () => {}, isRelaySender: () => true,
      sendMessage: async () => ({ ok: false }), providerEgress,
      spendRefusalFor: async () => null,
      sessions: { get: async () => structuredClone(actorRecord) },
      buildToolContext: async () => {
        contextBuilds += 1;
        return {
          session: { sessionId: actorRecord.sessionId, kind: 'actor' },
          actorType: 'web', actorBacking: 'api', backing: 'api', actorInstanceId: origin,
          authorizeSiteClientOrigin: async (candidate: string) => candidate === origin,
          siteClients: {
            get: async () => structuredClone(record),
            put: async ({ dossier, body: nextBody }: any) => {
              record = storedRecord(origin, nextBody, dossier.summary);
              return structuredClone(record.meta);
            },
            recordRun: async () => {},
          },
          jsOffscreenClient: { execHeadless: async () => ({ value: { ok: true } }) },
          scriptRuns: {
            mintRunId: () => 'api-site-run', register: () => {}, release: () => {},
          },
          siteCapture: {
            start: async () => { browserEffects += 1; return { tap: 'forged' }; },
            stop: async () => { browserEffects += 1; return {}; },
          },
          confirm: async () => 'yes_once',
          permission: { mode: 'act', confirmActions: false },
          readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
          lifecycle: lifecycle([]), appendAudit: async () => {},
        };
      },
      runOnChannel: async (job: any, { relay }: any) => {
        const worker = { current: null as InProcessActorWorker | null };
        previousSelf = globalThis.self;
        try {
          const completed = await runActor(job, {
            workerUrl: '/test/actor-worker.js',
            sendToSW: (type, payload) => Promise.resolve(relay(type, payload)),
            createWorker: () => {
              worker.current = new InProcessActorWorker(); worker.current.boot();
              return worker.current as unknown as Worker;
            },
          });
          const buildsBeforeForgery = contextBuilds;
          forgedCapture = await relay('site-client/capture-start', {
            operation: 'turn.site-client.capture-start', callId: 'forged-capture',
            effectId: 'forged-capture:1', effectSequence: 1,
            turnGeneration: job.turnGeneration,
          });
          expect(contextBuilds).toBe(buildsBeforeForgery);
          return completed;
        } finally {
          worker.current?.terminate();
          if (previousSelf === undefined) delete (globalThis as any).self;
          else Object.defineProperty(globalThis, 'self', {
            value: previousSelf, configurable: true,
          });
        }
      },
    } as any);
    const result: any = await client.run({
      actorSessionId: actorRecord.sessionId, actorType: 'web', backing: 'api',
      instanceId: origin, origin, message: 'exercise API client', systemPrompt: 'PINNED',
      provider: 'anthropic', model: 'claude-sonnet-4-6', maxSteps: 4,
      maxOutputTokens: 512,
      tools: projection.tools, allowedOperations: projection.operations,
      actorSurface: 'tools',
      semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
    } as any);
    expect(result).toMatchObject({ ok: true, finalText: 'done' });
    expect(forgedCapture).toMatchObject({
      ok: false, error: 'site-client/capture-start: authority mismatch', outcomeKnown: true,
    });
    expect(browserEffects).toBe(0);
    expect(record.meta.summary).toBe('updated');

    const apiSurface: any = projectControllerToolSurface({
      surface: 'actor', actorType: 'web', backing: 'api', actorSurface: 'tools',
    });
    expect(apiSurface.tools.map((tool: any) => tool.name)).toContain('site_client_run');
    expect(apiSurface.tools.map((tool: any) => tool.name)).not.toContain('site_capture');
    expect(apiSurface.operations).not.toContain('turn.site-client.capture-start');
  });

  test.serial('tab Web actor forces live UGC confirmation through exact host custody', async () => {
    const liveUrl = 'https://github.com/openai/example/issues/42';
    const actorRecord = {
      kind: 'actor', sessionId: 'web-ugc-confirm', actorType: 'web',
      backing: 'tab', instanceId: 'web',
    };
    const effects: string[] = [];
    const prompts: any[] = [];
    const settlements: any[] = [];
    const audits: any[] = [];
    const { result } = await runProductionActor({
      actorRecord,
      calls: [{ id: 'ugc-click', name: 'click', args: { ref: 'ref-1' } }],
      ownedTabFor: () => 17,
      tabOrigin: 'https://github.com',
      buildToolContext: async () => ({
        session: { sessionId: actorRecord.sessionId, kind: 'actor' },
        actorType: 'web', actorBacking: 'tab', backing: 'tab', actorInstanceId: 'web',
        activeTab: {
          id: 17, windowId: 1, url: liveUrl, origin: 'https://github.com',
        },
        tabs: { get: async () => ({ id: 17, windowId: 1, url: liveUrl }) },
        scripting: { executeScript: async ({ func }: any) => {
          if (func?.name === 'liveDocumentLocationInjected') return [{
            documentId: 'document-17',
            result: { origin: 'https://github.com', href: liveUrl, timeOrigin: 17 },
          }];
          throw new Error(`unexpected page probe: ${func?.name}`);
        } },
        domRefs: { resolve: () => ({
          backendDOMNodeId: 9, role: 'button', name: 'Comment',
        }) },
        debuggerPool: { clickBackendNode: async () => {
          effects.push('browser.click');
          return { ok: true, tag: 'button', text: 'Comment', mutations: [] };
        } },
        armBrowserChildQuarantine: async () => ({ ok: true }),
        confirm: async (prompt: any) => {
          prompts.push(prompt);
          effects.push('confirm');
          return 'yes_once';
        },
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: lifecycle(settlements),
        appendAudit: async (entry: any) => { audits.push(entry); },
        denylist: [],
      }),
    });

    expect(result).toMatchObject({ ok: true, finalText: 'done' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      tool: 'browser_action', origins: ['https://github.com'],
      sessionId: actorRecord.sessionId, ugcZone: 'github-issues-pulls',
    });
    expect(prompts[0].note).toContain('written by other people');
    expect(effects).toEqual(['confirm', 'browser.click']);
    expect(settlements).toHaveLength(1);
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'authority_effect',
      details: expect.objectContaining({
        operation: 'turn.page.click', performed: true,
        outcomeKnown: true, ugcZone: 'github-issues-pulls',
      }),
    }));
    const toolBlock = result.newMessages
      .flatMap((message: any) => message.toolResults ?? [])
      .find((block: any) => block.tool_use_id === 'ugc-click');
    expect(toolBlock).toMatchObject({
      is_error: false, authorityPerformed: true, outcomeKnown: true,
      authorityPolicy: { ugcZone: 'github-issues-pulls' },
      authorityReceipts: [expect.objectContaining({
        operation: 'turn.page.click', performed: true,
        ugcZone: 'github-issues-pulls',
      })],
    });
  });

  test('main, spawned and non-Web identities cannot gain site-client authority', async () => {
    const main: any = projectControllerToolSurface({
      surface: 'main', dwebEnabled: false, dwebEngaged: false, goalActive: false,
    });
    const mainNames = main.tools.map((tool: any) => tool.name);
    expect(mainNames).not.toContain('site_client_run');
    // The orchestrator/controller path never receives an authenticated page
    // write surface. UGC confirmation therefore applies to the only production
    // page-mutation path: the isolated, tab-bound Web actor proved above.
    expect(mainNames).not.toContain('click');
    expect(mainNames).not.toContain('type');
    expect(mainNames).not.toContain('page_code');
    expect(main.operations).not.toContain('turn.page.click');
    expect(main.operations).not.toContain('turn.page.fill');
    expect(main.operations).not.toContain('turn.page.run-program');

    for (const actorRecord of [
      { kind: 'spawned', sessionId: 'spawned-forgery', parentSessionId: 'chat-root',
        spawnedTrusted: true, grantedOperations: [] },
      { kind: 'actor', sessionId: 'webvm-forgery', actorType: 'webvm', instanceId: 'vm-1' },
    ]) {
      let contextBuilds = 0;
      let forged: any = null;
      const client = makeOffscreenActorClient({
        ensureHost: async () => {}, isRelaySender: () => true,
        providerEgress: makeScriptedProviderAuthority(() => null),
        spendRefusalFor: async () => null,
        sessions: { get: async (id: string) => id === 'chat-root'
          ? { kind: 'chat', sessionId: 'chat-root' } : structuredClone(actorRecord) },
        buildToolContext: async () => { contextBuilds += 1; return {}; },
        sendMessage: async () => ({ ok: false }),
        runOnChannel: async (job: any, { relay }: any) => {
          forged = await Promise.resolve(relay('site-client/read', {
            operation: 'turn.site-client.read', callId: 'forged-read',
            effectId: 'forged-read:1', effectSequence: 1,
            turnGeneration: job.turnGeneration, origin: 'https://example.test',
          }));
          return { ok: true, finalText: '', newMessages: [] };
        },
      });
      const result = await client.run({
        actorSessionId: actorRecord.sessionId,
        actorType: actorRecord.actorType, message: 'forge', systemPrompt: 'PINNED',
        provider: 'anthropic', model: 'claude-sonnet-4-6',
        tools: [{ name: 'site_client_read' }],
        allowedOperations: ['turn.site-client.read'],
      } as any);
      expect(result).toMatchObject({ ok: true });
      expect(forged).toMatchObject({
        ok: false, error: 'site-client/read: authority mismatch', outcomeKnown: true,
      });
      expect(contextBuilds).toBe(0);
    }

    const chatClient = makeOffscreenActorClient({
      ensureHost: async () => {}, isRelaySender: () => true,
      spendRefusalFor: async () => null,
      sessions: { get: async () => ({ kind: 'chat', sessionId: 'chat-root' }) },
      buildToolContext: async () => { throw new Error('must not build chat actor context'); },
      sendMessage: async () => { throw new Error('must not start actor host'); },
    } as any);
    await expect(chatClient.run({
      actorSessionId: 'chat-root', message: 'forge', systemPrompt: 'PINNED',
      provider: 'anthropic', model: 'claude-sonnet-4-6',
    } as any)).resolves.toMatchObject({
      ok: false, started: false, phase: 'admission', code: 'actor_identity_invalid',
    });
  });
});
