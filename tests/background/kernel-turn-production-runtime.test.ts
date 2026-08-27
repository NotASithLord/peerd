import { describe, expect, test } from 'bun:test';
import { createKernelTurnProductionRuntime } from '../../extension/background/kernel-turn-production-runtime.js';
import { createKernelTurnCustody } from '../../extension/background/kernel-turn-custody.js';
import { KERNEL_PAGE_PROGRAM_ROUTE_NAMES } from '../../extension/shared/kernel-feature-route-inventory.js';

const sendCustody = () => ({
  validOperationId: () => false, operationWindowValid: () => false,
  sendFingerprint: async () => '', unknownSend: () => ({}),
  sendReceiptStatus: async () => ({}),
  withSendReceipt: async (_id: any, _binding: any, operation: any) => operation(),
});

describe('kernel turn production runtime', () => {
  test('constructs one shared state graph and pins live activity Stop provenance', async () => {
    const marked = new Set([7]);
    const releases: number[] = [];
    const seen: any[] = [];
    let driverAssembly: any;
    let driven: any;
    const sessionCache = {
      sessionGet: async (key: string) => key === 'currentSessionId' ? 'root' : undefined,
      sessionSet: async () => {}, sessionDelete: async () => {},
    };
    const browser = { tabs: {}, scripting: {} };
    const idb = { get: async () => undefined };
    const kv = {};
    const vault = { isLocked: () => false };
    const auditLog = {
      append: async () => {}, list: async () => [], verify: async () => ({ ok: true }),
    };
    const settingsStore = { get: () => ({ auditLogMaxEntries: 10 }) };
    const uiPorts = {};
    const custody = createKernelTurnCustody({
      browser, idb, kv, sessionCache, vault, auditLog, settingsStore, uiPorts,
      makePageActivity: () => ({
        markedTabs: () => [...marked],
        release: async (tabId: number) => { releases.push(tabId); marked.delete(tabId); },
      }),
    });
    const runtime = await createKernelTurnProductionRuntime({
      seams: {
        runUserTurn: async () => {}, renderSystemPrompt: async () => '',
        projectTurnTools: async () => [],
        withRun: async (operation: () => Promise<void>) => operation(),
      },
      browser, idb, kv, sessionCache, vault, auditLog, settingsStore, uiPorts, custody,
      pushState: async () => {}, postChatNote: () => {}, ensureReady: async () => {},
      factories: {
        makeActorRuntime: (shared: any) => {
          seen.push(shared);
          return {
            actorCount: async () => ({ activeActors: 1 }),
            actorOverview: async () => ({ roots: [] }),
            relays: {
              engineReady: Promise.resolve(),
              scriptRuns: { ownerFor: () => null },
              validateGeneration: async () => true,
              retireStale: async () => {},
              appActorChat: async () => ({ ok: true }),
              broadcastAgentTab: () => {}, onUiConnect: () => {},
              showWebTabHint: () => {}, isDrivenSource: () => false,
              webActorSessionForTab: () => null,
              resumeSchedules: async () => {},
              eventOwners: {
                onCreated: () => {}, onUpdated: () => {}, onRemoved: () => {},
                onActivated: () => {}, onNavigationTarget: () => {},
                onBeforeRequest: () => undefined, reconcile: async () => {},
              },
              relayRoutes: Object.fromEntries([
                'a2a/call', 'actors/list', 'actors/call', 'site-fetch/call',
                ...KERNEL_PAGE_PROGRAM_ROUTE_NAMES,
              ].map((name) => [name, async () => ({ ok: true })])),
            },
          };
        },
        makeDriverDeps: (shared: any) => { seen.push(shared); return {}; },
        makeDriver: (assembly: any) => {
          driverAssembly = assembly;
          return {
            runAgentTurn: async (args: any) => { driven = args; return { ok: true }; },
            maybeAutoResume: async () => {},
          };
        },
        makeGoals: () => ({
          start: async () => ({ ok: true }), stop: async () => {}, resume: async () => {},
          activeStates: () => [],
        }),
        goalMaxIterations: 12,
        makeRouteDeps: (shared: any) => {
          seen.push(shared);
          return {
            turn: {
              makeAgentSendCustody: sendCustody,
              pushState: async () => {}, buildToolContext: async () => ({}),
              applyComposer: async ({ text }: any) => ({ text, refs: [] }),
              commandSources: {}, prepareUserAttachmentsWithDocs: async ({ text }: any) => ({
                text, attachments: null,
              }),
              runInit: async () => {}, handleSystemCommand: async () => {},
              handleToolsCommand: async () => {}, postChatNote: () => {},
              spawnActor: async () => {},
              ensureSession: async () => 'root', actorRecoveryReady: async () => true,
              contextSnapshots: { snapshotsForMany: () => [], limits: () => ({}) },
              assembleDebugBundle: (value: any) => value, childSessionIdsOf: () => [],
              CHANNEL: 'store',
            },
            session: {}, isolation: { retryActorIsolation: async () => ({ ok: true }) },
          };
        },
      },
      goal: {
        kv: { get: async () => null, set: async () => {}, delete: async () => {} },
        beforeStart: async () => {}, hasUnresolvedSideEffects: async () => false,
        onEvent: () => {}, onRunEnd: () => {}, bind: () => {},
      },
    });

    expect(seen).toHaveLength(3);
    expect(seen[0].sessions).toBe(seen[1].sessions);
    expect(seen[1].turnSlots).toBe(seen[2].turnSlots);
    expect(runtime.relays.scriptRuns.ownerFor()).toBeNull();
    expect(runtime.relays.isActivityStopSender(
      { tab: { id: 7 } }, { type: 'agent/stop', activity: 'live' },
    )).toBe(true);
    expect(runtime.relays.isActivityStopSender(
      { tab: { id: 8 } }, { type: 'agent/stop', activity: 'live' },
    )).toBe(false);
    expect(runtime.relays.isActivityStopSender(
      { tab: { id: 7 } }, { type: 'agent/stop' },
    )).toBe(false);
    await expect(runtime.turnDeps.runAgentTurn({ sessionId: 'root', userText: 'direct' }))
      .resolves.toEqual({ ok: true });
    expect(driverAssembly.sessions).toBe(runtime.relays.sessions);
    await expect((runtime.turnDeps as any).runAgentTurn).toBeFunction();
    expect(driven).toEqual({ sessionId: 'root', userText: 'direct' });
    await runtime.close();
    expect(releases).toEqual([7]);
  });
});
