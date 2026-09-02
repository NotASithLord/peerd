import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  actorOperationGrant,
  makeOffscreenActorClient,
} from '../../extension/background/offscreen-actor-client.js';
import {
  projectControllerTurnAuthorityClass,
} from '../../extension/background/controller-turn-authority-scope.js';
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

// Independent review inventory: this must not be derived from the production
// policy table or from operation prefixes. A moved/added operation therefore
// requires an explicit decision about which exact host domain owns it.
const EXPECTED_OPERATION_DOMAINS = Object.freeze(Object.fromEntries(([
  ['local', ['turn.goal.complete']],
  ['actor', [
    'turn.actor.spawn-sync', 'turn.actor.spawn-async', 'turn.actor.tasks',
    'turn.actor.cancel', 'turn.actor.message',
  ]],
  ['pod', [
    'turn.pod.resolve', 'turn.pod.read-remote', 'turn.pod.confirm-git',
    'turn.pod.exec', 'turn.pod.status', 'turn.pod.cancel',
    'turn.pod.read-file', 'turn.pod.write-file',
  ]],
  ['repository', [
    'turn.repository.read-pod', 'turn.repository.destroy-pod',
    'turn.repository.read-status', 'turn.repository.read-history',
    'turn.repository.read-remote', 'turn.repository.read-diff',
    'turn.repository.confirm-restore', 'turn.repository.checkpoint',
    'turn.repository.branch', 'turn.repository.checkout', 'turn.repository.restore',
    'turn.repository.confirm-remote', 'turn.repository.link',
    'turn.repository.fetch', 'turn.repository.push',
  ]],
  ['vm', [
    'turn.vm.read', 'turn.vm.list', 'turn.vm.set-default', 'turn.vm.run',
    'turn.vm.import-file', 'turn.vm.write-text-file', 'turn.vm.destroy',
  ]],
  ['notebook', [
    'turn.notebook.read', 'turn.notebook.list', 'turn.notebook.set-default',
    'turn.notebook.run', 'turn.notebook.write-file', 'turn.notebook.read-file',
    'turn.notebook.destroy',
  ]],
  ['app', [
    'turn.app.update', 'turn.app.open', 'turn.app.search', 'turn.app.read',
    'turn.app.delete', 'turn.app.write-file', 'turn.app.read-file',
    'turn.app.list-files', 'turn.app.delete-file', 'turn.app.observe',
    'turn.app.act', 'turn.app.run-code',
  ]],
  ['persistence', [
    'turn.memory.read-scope', 'turn.memory.read-subtree', 'turn.memory.write',
    'turn.todo.read', 'turn.todo.replace',
  ]],
  ['page', [
    'turn.page.open-tab', 'turn.page.read', 'turn.page.snapshot',
    'turn.page.read-state', 'turn.page.watch-changes', 'turn.page.query-dom',
    'turn.page.navigate', 'turn.page.fill', 'turn.page.click', 'turn.page.login',
    'turn.page.run-program', 'turn.page.capture-foreground', 'turn.page.capture-owned',
  ]],
  ['resource', [
    'turn.resource.confirm-web-write', 'turn.resource.request-web-text',
    'turn.resource.extract-markdown', 'turn.resource.extract-document',
    'turn.resource.spill-result', 'turn.resource.read-result',
  ]],
  ['siteclient', [
    'turn.site-client.read', 'turn.site-client.run', 'turn.site-client.commit',
    'turn.site-client.capture-start', 'turn.site-client.capture-stop',
  ]],
  ['execution', [
    'turn.execution.create-webvm', 'turn.execution.create-notebook',
    'turn.execution.create-pod', 'turn.execution.create-app',
    'turn.execution.run-script', 'turn.execution.spill-script',
  ]],
  ['editing', ['turn.editing.read-target', 'turn.editing.write-target']],
  ['introspection', [
    'turn.introspection.actor-roster', 'turn.introspection.provider-posture',
    'turn.introspection.storage-snapshot', 'turn.introspection.automatable-tabs',
    'turn.introspection.denylist-patterns', 'turn.introspection.audit-entries',
    'turn.introspection.installed-skill',
  ]],
  ['schedule', [
    'turn.schedule.read-routines', 'turn.schedule.arm-confirmed-routine',
    'turn.schedule.cancel-routine',
  ]],
  ['dweb', [
    'turn.dweb.discover-apps', 'turn.dweb.publish-confirmed-app',
    'turn.dweb.install-confirmed-app', 'turn.dweb.read-peers',
    'turn.dweb.set-peer-blocked', 'turn.dweb.set-discovery-enabled',
    'turn.dweb.run-mesh-program',
  ]],
] as Array<[string, string[]]>).flatMap(([domain, operations]) =>
  operations.map((operation) => [operation, domain]))));

const DOMAIN_HANDLER_MARKERS: Readonly<Record<string, RegExp>> = Object.freeze({
  local: /completeGoalRun/,
  actor: /actorAuthority/,
  pod: /domainExecutionEntry\([\s\S]*?operation,\s*'pod'/,
  repository: /repositoryExecutionEntry\(/,
  vm: /vmExecutionEntry\(/,
  notebook: /notebookExecutionEntry\(/,
  app: /appExecutionEntry\(/,
  persistence: /persistenceExecutionEntry\(/,
  page: /pageExecutionEntry\(/,
  resource: /resourceExecutionEntry\(/,
  siteclient: /siteClientExecutionEntry\(/,
  execution: /executionEntry\(/,
  editing: /editingEntry\(/,
  introspection: /introspectionExecutionEntry\(/,
  schedule: /scheduleExecutionEntry\(/,
  dweb: /dwebExecutionEntry\(/,
});

const operationCaseBodies = (source: string) => {
  const labels = [...source.matchAll(
    /^\s*case\s+['"](turn\.[^'"]+)['"]\s*:/gm,
  )];
  const bodies = new Map<string, string>();
  const pending: string[] = [];
  for (const [index, label] of labels.entries()) {
    const operation = label[1];
    pending.push(operation);
    const start = Number(label.index) + label[0].length;
    const end = index + 1 < labels.length ? Number(labels[index + 1].index) : source.length;
    const body = source.slice(start, end);
    // Consecutive labels share one handler (spawn-sync/spawn-async).
    if (!body.trim()) continue;
    for (const pendingOperation of pending) bodies.set(pendingOperation, body);
    pending.length = 0;
  }
  return bodies;
};

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
  test('tool ownership and domain policy define the same exact operation set and class', () => {
    const projected = controllerOperationsForTools(CONTROLLER_OWNED_TOOL_NAMES);
    expect(new Set(projected)).toEqual(domainOperationSet);
    expect(projected).toHaveLength(domainOperations.length);

    for (const [toolName, operations] of Object.entries(CONTROLLER_OPERATION_GRANTS)) {
      const authorityClass = controllerAuthorityClassForTool(toolName);
      if (!authorityClass) throw new TypeError(`missing authority class: ${toolName}`);
      for (const operation of operations) {
        expect(policyFor(operation).authorityClass, `${toolName} -> ${operation}`)
          .toBe(authorityClass);
      }
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

  test('every operation reaches only its independently assigned exact domain handler', () => {
    const source = readFileSync(join(
      process.cwd(), 'extension', 'background', 'controller-turn-bridge.js',
    ), 'utf8');
    const cases = [...source.matchAll(/case\s+['"](turn\.[^'"]+)['"]\s*:/g)]
      .map((match) => match[1])
      .filter((operation) => domainOperationSet.has(operation));
    expect(new Set(cases)).toEqual(domainOperationSet);
    expect(cases).toHaveLength(domainOperations.length);

    const expectedOperations = Object.keys(EXPECTED_OPERATION_DOMAINS);
    expect(new Set(expectedOperations)).toEqual(domainOperationSet);
    expect(expectedOperations).toHaveLength(domainOperations.length);

    const bodies = operationCaseBodies(source);
    for (const operation of expectedOperations) {
      const expectedDomain = EXPECTED_OPERATION_DOMAINS[operation];
      const body = bodies.get(operation);
      expect(policyFor(operation).authorityClass, operation).toBe(expectedDomain);
      expect(body, operation).toBeDefined();
      expect(DOMAIN_HANDLER_MARKERS[expectedDomain].test(body!), operation).toBe(true);
      for (const [otherDomain, marker] of Object.entries(DOMAIN_HANDLER_MARKERS)) {
        if (otherDomain !== expectedDomain) expect(marker.test(body!), operation).toBe(false);
      }
      expect(body, operation).not.toContain('turn-kernel-operation-denied');
      expect(projectControllerTurnAuthorityClass({}, expectedDomain), operation).not.toBeNull();
    }
    expect(projectControllerTurnAuthorityClass({}, 'generic')).toBeNull();
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
