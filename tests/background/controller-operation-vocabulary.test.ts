import { describe, expect, test } from 'bun:test';
import {
  actorOperationGrant,
  makeOffscreenActorClient,
} from '../../extension/background/offscreen-actor-client.js';
import {
  CONTROLLER_OPERATION_GRANTS,
  CONTROLLER_OWNED_TOOL_NAMES,
  controllerAuthorityClassForTool,
  controllerOperationsForTools,
} from '../../extension/peerd-runtime/controller-tool-ownership.js';
import {
  projectControllerToolSurface,
} from '../../extension/peerd-runtime/controller-tool-projection.js';
import { ACTOR_RELAY_ROUTES } from '../../extension/shared/actor-channel-protocol.js';
import {
  CONTROLLER_DOMAIN_OPERATIONS,
  ORCHESTRATOR_OPERATION_GRANT,
  createControllerKernelQuota,
} from '../../extension/shared/controller-kernel-quota.js';

const domainOperations = Object.keys(CONTROLLER_DOMAIN_OPERATIONS);
const domainOperationSet = new Set(domainOperations);
const policyFor = (operation: string) => CONTROLLER_DOMAIN_OPERATIONS[
  operation as keyof typeof CONTROLLER_DOMAIN_OPERATIONS
];

const actorClient = () => makeOffscreenActorClient({
  ensureHost: async () => {},
  isRelaySender: () => true,
  sendMessage: async () => ({ ok: true }),
  spendRefusalFor: async () => null,
  sessions: { get: async () => null },
  buildToolContext: async () => ({}),
  inboundDwebToolNames: [],
} as any);

const relayOperation = (route: string) => ({
  'actor/tasks-read': 'turn.actor.tasks',
  'actor/task-cancel': 'turn.actor.cancel',
  'actor/message-deliver': 'turn.actor.message',
}[route] ?? `turn.${route.replace('/', '.')}`);

describe('finite controller authority-operation vocabulary', () => {
  test('tool ownership and domain policy define the same exact operation set', () => {
    const projected = controllerOperationsForTools(CONTROLLER_OWNED_TOOL_NAMES);
    expect(new Set(projected)).toEqual(domainOperationSet);
    expect(projected).toHaveLength(domainOperations.length);

    for (const [toolName, operations] of Object.entries(CONTROLLER_OPERATION_GRANTS)) {
      const authorityClass = controllerAuthorityClassForTool(toolName);
      if (!authorityClass) throw new TypeError(`missing authority class: ${toolName}`);
      // A semantic tool may use a narrowly named support authority in addition
      // to its primary domain (for example read_page stores an oversized result
      // through the shared result resource). Every operation's exact domain is
      // independently pinned below; require only that effectful tools retain a
      // real edge to their declared primary owner.
      if (operations.length > 0) expect(operations.some((operation) =>
        policyFor(operation).authorityClass === authorityClass), toolName).toBe(true);
    }
  });

  test('the main projection, fixed grant, and turn-run quota admit the same exact subset', () => {
    const projected: any = projectControllerToolSurface({
      surface: 'main', toolManifest: null, goalActive: true,
      dwebEnabled: false, dwebEngaged: false,
      actorIsolation: {
        status: 'available', host: 'background-page-worker', reason: null, retryable: false,
      },
      runtimeCapabilities: null,
    });
    expect(projected.ok).toBe(true);
    expect(new Set(projected.operations)).toEqual(new Set(ORCHESTRATOR_OPERATION_GRANT));
    expect(projected.operations).toHaveLength(ORCHESTRATOR_OPERATION_GRANT.length);

    const turnGeneration = 7;
    const quota = createControllerKernelQuota('turn.run', { turnGeneration, maxSteps: 1 });
    for (const [index, operation] of ORCHESTRATOR_OPERATION_GRANT.entries()) {
      const callId = `call-${index}`;
      expect(quota.admit(operation, { value: {
        callId, effectId: `${callId}:1`, effectSequence: 1, turnGeneration,
      } }), operation).toEqual({ ok: true, outcomeKnown: true });
    }
    const mainGrant = new Set(ORCHESTRATOR_OPERATION_GRANT);
    for (const [index, operation] of domainOperations
      .filter((candidate) => !mainGrant.has(candidate)).entries()) {
      const callId = `excluded-${index}`;
      expect(quota.admit(operation, { value: {
        callId, effectId: `${callId}:1`, effectSequence: 1, turnGeneration,
      } }), operation).toEqual({
        ok: false, code: 'kernel-domain-authority-invalid', outcomeKnown: true,
      });
    }
    expect(quota.admit('turn.future.generic', { value: {} }))
      .toEqual({ ok: false, code: 'kernel-operation-denied', outcomeKnown: true });
  });

  test('actor protocol and relay handlers cover exactly every non-local domain operation', () => {
    const routes = Object.keys(actorClient().routes);
    expect(new Set(routes)).toEqual(new Set(ACTOR_RELAY_ROUTES));
    expect(routes).toHaveLength(ACTOR_RELAY_ROUTES.length);

    const relayedDomainOperations = routes.map(relayOperation)
      .filter((operation) => domainOperationSet.has(operation));
    const expected = domainOperations.filter((operation) =>
      policyFor(operation).authorityClass !== 'local');
    expect(new Set(relayedDomainOperations)).toEqual(new Set(expected));
    expect(relayedDomainOperations).toHaveLength(expected.length);

    const identities = [
      {
        name: 'tab Web',
        record: { kind: 'actor', actorType: 'web', backing: 'tab', instanceId: 'web' },
        inputs: [
          { actorType: 'web', backing: 'tab', actorSurface: 'tools' },
          { actorType: 'web', backing: 'tab', actorSurface: 'code' },
        ],
        inbound: false,
      },
      {
        name: 'API Web',
        record: {
          kind: 'actor', actorType: 'web', backing: 'api',
          instanceId: 'https://api.test',
        },
        inputs: [{ actorType: 'web', backing: 'api', actorSurface: 'tools' }],
        inbound: false,
      },
      {
        name: 'WebVM', record: { kind: 'actor', actorType: 'webvm', instanceId: 'vm' },
        inputs: [{ actorType: 'webvm' }], inbound: false,
      },
      {
        name: 'Notebook',
        record: { kind: 'actor', actorType: 'notebook', instanceId: 'notebook' },
        inputs: [{ actorType: 'notebook' }], inbound: false,
      },
      {
        name: 'Pod', record: { kind: 'actor', actorType: 'pod', instanceId: 'pod' },
        inputs: [{ actorType: 'pod' }], inbound: false,
      },
      {
        name: 'App', record: { kind: 'actor', actorType: 'app', instanceId: 'app' },
        inputs: [{ actorType: 'app', actorSurface: 'tools' }], inbound: false,
      },
      {
        name: 'dweb', record: { kind: 'actor', actorType: 'dweb', instanceId: 'dweb' },
        inputs: [{ actorType: 'dweb' }], inbound: false,
      },
      {
        name: 'inbound dweb',
        record: { kind: 'actor', actorType: 'dweb', instanceId: 'dweb' },
        inputs: [{ actorType: 'dweb', inbound: true }], inbound: true,
      },
    ];
    for (const identity of identities) {
      const projectedOperations = identity.inputs.flatMap((input) => {
        const projection: any = projectControllerToolSurface({
          surface: 'actor', ...input, toolManifest: null,
          runtimeCapabilities: null, headlessAvailable: true,
        });
        expect(projection.ok, identity.name).toBe(true);
        return projection.operations;
      });
      const projected = [...new Set(projectedOperations)];
      const granted = actorOperationGrant(identity.record, identity.inbound);
      expect(new Set(projected), identity.name).toEqual(new Set(granted));
      expect(projected, identity.name).toHaveLength(granted.length);
    }
  });
});
