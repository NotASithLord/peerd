import { describe, expect, test } from 'bun:test';
import {
  actorOperationGrant,
  makeOffscreenActorClient,
} from '../../extension/background/offscreen-actor-client.js';
import { projectControllerToolSurface } from '../../extension/peerd-runtime/controller-tool-projection.js';
import { ACTOR_RELAY_ROUTES } from '../../extension/shared/actor-channel-protocol.js';
import {
  APP_PROGRAM_EXACT_OPERATIONS,
  PAGE_PROGRAM_EXACT_OPERATIONS,
} from '../../extension/shared/page-program-authority.js';
import {
  CONTROLLER_DOMAIN_OPERATIONS,
} from '../../extension/shared/controller-kernel-quota.js';

const operations = Object.keys(CONTROLLER_DOMAIN_OPERATIONS);
const policyFor = (operation: string) => CONTROLLER_DOMAIN_OPERATIONS[
  operation as keyof typeof CONTROLLER_DOMAIN_OPERATIONS
];
const except = (operation: string, names: string[]) => !names.includes(operation);

const identities = [
  {
    name: 'tab Web',
    record: { kind: 'actor', actorType: 'web', backing: 'tab', instanceId: 'web' },
    expected: (operation: string) => ['page', 'resource', 'siteclient']
      .includes(policyFor(operation).authorityClass)
      && except(operation, ['turn.page.open-tab', 'turn.page.capture-foreground']),
  },
  {
    name: 'API Web',
    record: {
      kind: 'actor', actorType: 'web', backing: 'api', instanceId: 'https://api.example.test',
    },
    expected: (operation: string) => ['resource', 'siteclient']
      .includes(policyFor(operation).authorityClass)
      && except(operation, [
        'turn.resource.extract-document',
        'turn.site-client.capture-start', 'turn.site-client.capture-stop',
      ]),
  },
  {
    name: 'WebVM',
    record: { kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' },
    expected: (operation: string) => policyFor(operation).authorityClass === 'vm',
  },
  {
    name: 'Notebook',
    record: { kind: 'actor', actorType: 'notebook', instanceId: 'notebook-1' },
    expected: (operation: string) => ['notebook', 'repository', 'editing']
      .includes(policyFor(operation).authorityClass)
      && except(operation, ['turn.repository.read-pod', 'turn.repository.destroy-pod']),
  },
  {
    name: 'Pod',
    record: { kind: 'actor', actorType: 'pod', instanceId: 'pod-1' },
    expected: (operation: string) => ['pod', 'repository']
      .includes(policyFor(operation).authorityClass),
  },
  {
    name: 'App',
    record: { kind: 'actor', actorType: 'app', instanceId: 'app-1' },
    expected: (operation: string) => ['app', 'repository', 'editing']
      .includes(policyFor(operation).authorityClass)
      && except(operation, [
        'turn.app.open', 'turn.app.search',
        'turn.repository.read-pod', 'turn.repository.destroy-pod',
      ]),
  },
  {
    name: 'dweb',
    record: { kind: 'actor', actorType: 'dweb', instanceId: 'dweb' },
    expected: (operation: string) => policyFor(operation).authorityClass === 'dweb',
  },
] as const;

describe('actor exact-operation ceiling', () => {
  for (const identity of identities) {
    test(`${identity.name} admits exactly its fixed host capabilities`, () => {
      const grant = new Set(actorOperationGrant(identity.record, false));
      for (const operation of operations) {
        expect(grant.has(operation), `${identity.name}: ${operation}`)
          .toBe(identity.expected(operation));
      }
      expect(actorOperationGrant(identity.record, false)).not.toContain('turn.future.write');
    });
  }

  test('inbound dweb admits only discovery and peer reads', () => {
    const record = { kind: 'actor', actorType: 'dweb', instanceId: 'dweb' };
    const grant = new Set(actorOperationGrant(record, true));
    for (const operation of operations) {
      expect(grant.has(operation), operation).toBe([
        'turn.dweb.discover-apps', 'turn.dweb.read-peers',
      ].includes(operation));
    }
  });

  test('inbound non-dweb and unknown identities receive no operations', () => {
    for (const record of [
      { kind: 'actor', actorType: 'web', backing: 'tab', instanceId: 'web' },
      { kind: 'actor', actorType: 'unknown', instanceId: 'unknown' },
      { kind: 'chat', sessionId: 'chat-1' },
    ]) {
      expect(actorOperationGrant(record, true)).toEqual([]);
      if (record.actorType === 'unknown' || record.kind === 'chat') {
        expect(actorOperationGrant(record, false)).toEqual([]);
      }
    }
  });

  test('spawned grants retain only explicitly persisted known operations', () => {
    for (const operation of operations) {
      expect(actorOperationGrant({
        kind: 'spawned', grantedOperations: [operation, 'turn.future.write'],
      }, false)).toEqual([operation]);
    }
    expect(actorOperationGrant({ kind: 'spawned', grantedOperations: null }, false)).toEqual([]);
  });

  test('every admitted exact operation has a real actor relay handler', () => {
    const routes = makeOffscreenActorClient({
      ensureHost: async () => {},
      isRelaySender: () => true,
      sendMessage: async () => ({ ok: true }),
      spendRefusalFor: async () => null,
      sessions: { get: async () => null },
      buildToolContext: async () => ({}),
      inboundDwebToolNames: [],
    } as any).routes;
    const exceptions: Record<string, string> = {
      'turn.actor.tasks': 'actor/tasks-read',
      'turn.actor.cancel': 'actor/task-cancel',
      'turn.actor.message': 'actor/message-deliver',
    };
    const routeFor = (operation: string) => exceptions[operation]
      ?? operation.slice('turn.'.length).replace('.', '/');
    const admitted = new Set(identities.flatMap((identity) =>
      [...actorOperationGrant(identity.record, false)]));
    for (const operation of admitted) {
      const route = routeFor(operation);
      expect(ACTOR_RELAY_ROUTES, operation).toContain(route);
      expect(Object.hasOwn(routes, route), `${operation} -> ${route}`).toBe(true);
    }
  });

  test('model surfaces stay exact subsets of the fixed actor ceiling', () => {
    const cases = [
      { actorType: 'webvm', record: identities[2].record, count: 7 },
      { actorType: 'notebook', record: identities[3].record, count: 22 },
      { actorType: 'pod', record: identities[4].record, count: 23 },
      { actorType: 'app', actorSurface: 'tools', record: identities[5].record, count: 25 },
      { actorType: 'web', backing: 'api', actorSurface: 'tools', record: identities[1].record, count: 8 },
      { actorType: 'dweb', record: identities[6].record, count: 7 },
      { actorType: 'dweb', inbound: true, record: identities[6].record, count: 2 },
    ] as const;
    for (const candidate of cases) {
      const projected: any = projectControllerToolSurface({
        surface: 'actor', actorType: candidate.actorType,
        ...('backing' in candidate ? { backing: candidate.backing } : {}),
        ...('actorSurface' in candidate ? { actorSurface: candidate.actorSurface } : {}),
        ...('inbound' in candidate ? { inbound: candidate.inbound } : {}),
        toolManifest: null, runtimeCapabilities: null, headlessAvailable: true,
      });
      const ceiling = new Set(actorOperationGrant(
        candidate.record, 'inbound' in candidate && candidate.inbound === true,
      ));
      expect(projected.ok).toBe(true);
      expect(projected.operations).toHaveLength(candidate.count);
      expect(projected.operations.every((operation: string) => ceiling.has(operation))).toBe(true);
      expect(new Set(projected.operations)).toEqual(ceiling);
    }
  });

  test('code surfaces advertise only the outer container while hidden children stay parent-bound', () => {
    const web: any = projectControllerToolSurface({
      surface: 'actor', actorType: 'web', backing: 'tab', actorSurface: 'code',
      toolManifest: null, runtimeCapabilities: null, headlessAvailable: true,
    });
    expect(web.tools.map((tool: any) => tool.name)).toEqual(['page_code', 'site_client_run']);
    expect(web.operations).toEqual(['turn.page.run-program', 'turn.site-client.run']);
    const webCeiling = new Set(actorOperationGrant(identities[0].record, false));
    expect(new Set([...web.operations, ...PAGE_PROGRAM_EXACT_OPERATIONS])).toEqual(webCeiling);

    const app: any = projectControllerToolSurface({
      surface: 'actor', actorType: 'app', actorSurface: 'code',
      toolManifest: null, runtimeCapabilities: null, headlessAvailable: true,
    });
    expect(app.tools.map((tool: any) => tool.name)).not.toContain('app_observe');
    expect(app.tools.map((tool: any) => tool.name)).not.toContain('app_act');
    expect(app.operations).toContain('turn.app.run-code');
    expect(app.operations).not.toContain('turn.app.observe');
    expect(app.operations).not.toContain('turn.app.act');
    expect(APP_PROGRAM_EXACT_OPERATIONS).toEqual(['turn.app.observe', 'turn.app.act']);
  });
});
