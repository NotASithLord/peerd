import { describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CONTROLLER_DOMAIN_OPERATIONS,
  ORCHESTRATOR_OPERATION_GRANT,
} from '../../extension/shared/controller-kernel-quota.js';

type Call = { domain: string; method: string; args: unknown[] };
type Binding = {
  domain: string;
  operation: string;
  args: Record<string, unknown>;
  semanticToken?: string;
};
type Step = { operation: string; value: Record<string, unknown> };
type Spec = {
  domain: string;
  method: string;
  value: Record<string, unknown>;
  actor?: { actorType: string; instanceId: string; backing?: string };
  prelude?: Step[];
  expected?: string[];
};

const MATRIX_CHILD = 'PEERD_EXACT_OPERATION_MATRIX_CHILD';
if (process.env[MATRIX_CHILD] !== '1') {
  describe('controller exact-operation executable routing', () => {
    test('the isolated matrix executes every canonical operation without leaking module spies', () => {
      const result = spawnSync(process.execPath, [
        'test', fileURLToPath(import.meta.url), '--timeout', '5000',
      ], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, [MATRIX_CHILD]: '1' },
      });
      const diagnostic = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(result.status, diagnostic).toBe(0);
    });
  });
} else {
let calls: Call[] = [];
let bindings: Binding[] = [];
const record = (domain: string, method: string, args: unknown[]) => {
  calls.push({ domain, method, args });
  if (domain === 'actor' && method === 'spawnSync') return { sessionId: 'actor-1' };
  if (domain === 'actor' && method === 'spawnAsync') return { taskId: 'task-1' };
  if (domain === 'pod' && method === 'cancel') return { cancelled: true };
  if (domain === 'repository' && method === 'checkpoint') return { created: true };
  if (domain === 'repository' && method === 'restore') return { restored: true };
  if (domain === 'app' && method === 'updateApp') return { id: 'app-1' };
  if (domain === 'app' && method === 'deleteApp') return true;
  if (domain === 'resource' && method === 'spillResult'
      || domain === 'execution' && method === 'spillScriptValue') return 'result:one';
  if (domain === 'schedule' && method === 'cancelRoutine') return true;
  if (/^(list|search|readActorRoster|readRoutines|readAutomatableTabs|readAuditEntries)/.test(method)) return [];
  if (/^confirm/.test(method)) return 'yes_once';
  return { ok: true };
};
const authoritySpy = (domain: string) => new Proxy({}, {
  get: (_target, property) => (...args: unknown[]) => record(domain, String(property), args),
});

const binderModules = [
  ['repository-tool-authority.js', 'bindRepositoryToolAuthority', 'repository'],
  ['vm-tool-authority.js', 'bindVmToolAuthority', 'vm'],
  ['notebook-tool-authority.js', 'bindNotebookToolAuthority', 'notebook'],
  ['app-tool-authority.js', 'bindAppToolAuthority', 'app'],
  ['persistence-tool-authority.js', 'bindPersistenceToolAuthority', 'persistence'],
  ['page-tool-authority.js', 'bindPageToolAuthority', 'page'],
  ['resource-tool-authority.js', 'bindResourceToolAuthority', 'resource'],
  ['site-client-tool-authority.js', 'bindSiteClientToolAuthority', 'siteclient'],
  ['execution-tool-authority.js', 'bindExecutionToolAuthority', 'execution'],
  ['editing-tool-authority.js', 'bindEditingToolAuthority', 'editing'],
  ['introspection-tool-authority.js', 'bindIntrospectionToolAuthority', 'introspection'],
  ['schedule-tool-authority.js', 'bindScheduleToolAuthority', 'schedule'],
  ['dweb-tool-authority.js', 'bindDwebToolAuthority', 'dweb'],
] as const;
for (const [file, exportName, domain] of binderModules) {
  mock.module(`../../extension/background/${file}`, () => ({
    [exportName]: (_state: unknown, input: any) => {
      const inputArgs = domain === 'page' && Object.hasOwn(input.args ?? {}, 'args')
        ? input.args.args : input.args;
      bindings.push({
        domain, operation: input.operation, args: inputArgs,
        ...(typeof input.pageProgramSemanticToken === 'string'
          ? { semanticToken: input.pageProgramSemanticToken } : {}),
        ...(typeof input.appProgramSemanticToken === 'string'
          ? { semanticToken: input.appProgramSemanticToken } : {}),
      });
      return authoritySpy(domain);
    },
  }));
}

const { makeControllerTurnBridge } = await import(
  '../../extension/background/controller-turn-bridge.js'
);
const { makeOffscreenActorClient } = await import(
  '../../extension/background/offscreen-actor-client.js'
);

const actorFor = (domain: string) => {
  if (domain === 'pod' || domain === 'repository') {
    return { actorType: 'pod', instanceId: 'pod-1' };
  }
  if (domain === 'vm') return { actorType: 'webvm', instanceId: 'vm-1' };
  if (domain === 'notebook') return { actorType: 'notebook', instanceId: 'notebook-1' };
  if (domain === 'app' || domain === 'editing') {
    return { actorType: 'app', instanceId: 'app-1' };
  }
  if (domain === 'page' || domain === 'resource' || domain === 'siteclient') {
    return { actorType: 'web', instanceId: 'web', backing: 'tab' };
  }
  if (domain === 'dweb') return { actorType: 'dweb', instanceId: 'dweb' };
  throw new TypeError(`no actor transport for ${domain}`);
};

const op = (
  domain: string, name: string, method: string,
  value: Record<string, unknown> = {}, extra: Partial<Spec> = {},
) => [`turn.${name}`, {
  method, value, ...extra, domain,
  ...(ORCHESTRATOR_OPERATION_GRANT.includes(`turn.${name}`)
    ? {} : { actor: actorFor(domain) }),
}] as const;

const podId = 'pod-1';
const origin = 'https://example.test';
const specs = Object.fromEntries([
  op('local', 'goal.complete', 'completeGoalRun', { summary: 'done' }),
  op('actor', 'actor.spawn-sync', 'spawnSync', {
    task: 'inspect', allowRecursion: false, grantedToolNames: [], grantedOperations: [],
  }),
  op('actor', 'actor.spawn-async', 'spawnAsync', {
    task: 'inspect', allowRecursion: false, grantedToolNames: [], grantedOperations: [],
  }),
  op('actor', 'actor.tasks', 'listTasks'),
  op('actor', 'actor.cancel', 'cancelTask', { taskId: 'task-1' }),
  op('actor', 'actor.message', 'deliverMessage', {
    to: 'actor-1', message: 'inspect', oneShot: false, awaitReply: false,
    degradeToAsync: true, awaitCapMs: 1000,
  }),
  op('pod', 'pod.resolve', 'resolveId', { podId }),
  op('pod', 'pod.read-remote', 'getRemote', { podId }, {
    prelude: [{ operation: 'turn.pod.resolve', value: { podId, command: 'git fetch' } }],
    expected: ['pod.resolveId', 'pod.getRemote'],
  }),
  op('pod', 'pod.confirm-git', 'confirm', { op: 'fetch' }, {
    prelude: [
      { operation: 'turn.pod.resolve', value: { podId, command: 'git fetch' } },
      { operation: 'turn.pod.read-remote', value: { podId } },
    ],
    expected: ['pod.resolveId', 'pod.getRemote', 'pod.confirm'],
  }),
  op('pod', 'pod.exec', 'exec', {
    command: 'echo hi', podId, timeoutMs: 1000, background: false, remoteGitGrant: null,
  }, {
    prelude: [{ operation: 'turn.pod.resolve', value: { podId, command: 'echo hi' } }],
    expected: ['pod.resolveId', 'pod.exec'],
  }),
  op('pod', 'pod.status', 'status', {
    podId, jobId: 'job-1', stream: 'stdout', offset: 0, limit: 10,
  }),
  op('pod', 'pod.cancel', 'cancel', { podId, jobId: 'job-1' }),
  op('pod', 'pod.read-file', 'readFile', { podId, path: '/work/a.txt' }),
  op('pod', 'pod.write-file', 'writeFile', { podId, path: '/work/a.txt', content: 'a' }),
  op('repository', 'repository.read-pod', 'readPod', { podId }),
  op('repository', 'repository.destroy-pod', 'destroyPod', { podId }),
  op('repository', 'repository.read-status', 'readStatus'),
  op('repository', 'repository.read-history', 'readHistory', { depth: 20 }),
  op('repository', 'repository.read-remote', 'readRemote'),
  op('repository', 'repository.read-diff', 'readDiff', { from: 'HEAD', to: null }),
  op('repository', 'repository.confirm-restore', 'confirmRestore', { to: 'HEAD~1' }),
  op('repository', 'repository.checkpoint', 'checkpoint', { message: 'checkpoint' }),
  op('repository', 'repository.branch', 'branch', { name: 'feature' }),
  op('repository', 'repository.checkout', 'checkout', { name: 'main' }),
  op('repository', 'repository.restore', 'restore', { to: 'HEAD~1' }),
  op('repository', 'repository.confirm-remote', 'confirmRemote', {
    op: 'link', target: 'https://github.com/openai/example.git', branch: undefined,
  }),
  op('repository', 'repository.link', 'link', { url: 'https://github.com/openai/example.git' }),
  op('repository', 'repository.fetch', 'fetch', { target: 'https://github.com/openai/example.git' }),
  op('repository', 'repository.push', 'push', {
    target: 'https://github.com/openai/example.git', branch: 'main',
  }),
  op('vm', 'vm.read', 'readVm', { vmId: 'vm-1' }),
  op('vm', 'vm.list', 'listVms'),
  op('vm', 'vm.set-default', 'setDefaultVm', { vmId: 'vm-1' }),
  op('vm', 'vm.run', 'runVm', { command: 'pwd', timeoutMs: 1000, vmId: 'vm-1' }),
  op('vm', 'vm.import-file', 'importFile', {
    url: `${origin}/a`, path: '/a', maxBytes: 50 * 1024 * 1024,
  }),
  op('vm', 'vm.write-text-file', 'writeTextFile', { path: '/a', content: 'a' }),
  op('vm', 'vm.destroy', 'destroyVm', { vmId: 'vm-1' }),
  op('notebook', 'notebook.read', 'readNotebook', { notebookId: 'notebook-1' }),
  op('notebook', 'notebook.list', 'listNotebooks'),
  op('notebook', 'notebook.set-default', 'setDefaultNotebook', { notebookId: 'notebook-1' }),
  op('notebook', 'notebook.run', 'runNotebook', {
    code: 'return 1', timeoutMs: 1000, notebookId: 'notebook-1',
  }),
  op('notebook', 'notebook.write-file', 'writeFile', {
    path: '/a', content: 'a', notebookId: 'notebook-1',
  }),
  op('notebook', 'notebook.read-file', 'readFile', { path: '/a', notebookId: 'notebook-1' }),
  op('notebook', 'notebook.destroy', 'destroyNotebook', { notebookId: 'notebook-1' }),
  op('app', 'app.update', 'updateApp', {
    appId: 'app-1', name: 'App', html: '<p>a</p>', tags: ['test'], entryFile: 'index.html',
  }),
  op('app', 'app.open', 'openApp', { appId: 'app-1' }),
  op('app', 'app.search', 'searchApps', { query: 'app' }),
  op('app', 'app.read', 'readApp', { appId: 'app-1' }),
  op('app', 'app.delete', 'deleteApp', { appId: 'app-1' }),
  op('app', 'app.write-file', 'writeFile', {
    appId: 'app-1', path: 'index.html', content: '<p>a</p>',
  }),
  op('app', 'app.read-file', 'readFile', { appId: 'app-1', path: 'index.html' }),
  op('app', 'app.list-files', 'listFiles', { appId: 'app-1' }),
  op('app', 'app.delete-file', 'deleteFile', { appId: 'app-1', path: 'old.html' }),
  op('app', 'app.observe', 'observeRuntime'),
  op('app', 'app.act', 'actRuntime', { action: 'click', params: { selector: '#save' } }),
  op('app', 'app.run-code', 'runCode', {
    code: 'return 1', timeoutMs: 1000, appProgramSemanticToken: 'app-program-token',
  }),
  op('persistence', 'memory.read-scope', 'readMemoryScope', { scope: { kind: 'global' } }),
  op('persistence', 'memory.read-subtree', 'readMemorySubtree', {
    workspace: 'default', subpath: '/',
  }),
  op('persistence', 'memory.write', 'writeMemory', {
    scope: { kind: 'global' }, body: 'remember this',
  }),
  op('persistence', 'todo.read', 'readTodos'),
  op('persistence', 'todo.replace', 'replaceTodos', { version: '[]', todos: [] }),
  op('page', 'page.open-tab', 'openProtectedBackgroundTab', { args: { url: origin } }),
  op('page', 'page.read', 'readOwnedPage', { args: { tabId: 7 } }),
  op('page', 'page.snapshot', 'captureOwnedAccessibilityTree', { args: { tabId: 7 } }),
  op('page', 'page.read-state', 'readOwnedFrameworkState', { args: { tabId: 7 } }),
  op('page', 'page.watch-changes', 'drainOwnedDomChanges', { args: { tabId: 7 } }),
  op('page', 'page.query-dom', 'queryOwnedDom', { args: { tabId: 7, selector: 'body' } }),
  op('page', 'page.navigate', 'navigateOwnedTab', { args: { tabId: 7, url: `${origin}/next` } }),
  op('page', 'page.fill', 'fillOwnedTarget', { args: { tabId: 7, selector: '#q', text: 'hi' } }),
  op('page', 'page.click', 'clickOwnedTarget', { args: { tabId: 7, selector: '#go' } }),
  op('page', 'page.login', 'performConfirmedOwnedLogin', { args: { tabId: 7 } }),
  op('page', 'page.run-program', 'runOwnedPageProgram', {
    args: { tabId: 7, code: 'return 1', timeoutMs: 1000 },
    pageProgramSemanticToken: 'page-program-token',
  }),
  op('page', 'page.capture-foreground', 'captureForegroundPixels', { args: {} }),
  op('page', 'page.capture-owned', 'captureOwnedTabPixels', { args: { tabId: 7 } }),
  op('resource', 'resource.confirm-web-write', 'confirmWebWrite', {
    url: origin, method: 'POST', headers: {}, body: 'x',
  }),
  op('resource', 'resource.request-web-text', 'requestWebText', {
    url: origin, method: 'GET', headers: {}, body: undefined,
  }),
  op('resource', 'resource.extract-markdown', 'extractReadableMarkdown', {
    html: '<p>a</p>', url: origin,
  }),
  op('resource', 'resource.extract-document', 'extractDocument', {
    url: `${origin}/a.pdf`, format: 'pdf', engine: 'pdfjs',
  }),
  op('resource', 'resource.spill-result', 'spillResult', {
    url: origin, format: 'text', text: 'a', producer: 'fetch_url',
    fenced: true, originLabel: origin,
  }),
  op('resource', 'resource.read-result', 'readResult', { key: 'result:one' }),
  op('siteclient', 'site-client.read', 'readStoredClient', { origin }),
  op('siteclient', 'site-client.run', 'runStoredClient', {
    origin, code: 'return client.get()', timeoutMs: 1000,
  }),
  op('siteclient', 'site-client.commit', 'commitConfirmedClient', {
    origin, summary: 'client', endpoints: ['/'], auth: 'browser', deriver: 'capture',
    body: 'return {};',
  }),
  op('siteclient', 'site-client.capture-start', 'startOwnedCapture'),
  op('siteclient', 'site-client.capture-stop', 'stopOwnedCapture'),
  op('execution', 'execution.create-webvm', 'createWebVm', { plan: { name: 'VM' } }),
  op('execution', 'execution.create-notebook', 'createNotebook', { plan: { name: 'Notebook' } }),
  op('execution', 'execution.create-pod', 'createPod', { plan: { name: 'Pod' } }),
  op('execution', 'execution.create-app', 'createApp', { plan: { name: 'App', html: '<p>a</p>' } }),
  op('execution', 'execution.run-script', 'runHeadlessScript', {
    code: 'return 1', actors: false, provider: false, workspace: false, timeoutMs: null,
  }),
  op('execution', 'execution.spill-script', 'spillScriptValue', {
    text: 'a', fenced: false, originLabel: 'script',
  }),
  op('editing', 'editing.read-target', 'readEditTarget', {
    kind: 'app', targetId: 'app-1', path: 'index.html',
  }),
  op('editing', 'editing.write-target', 'writeEditTarget', {
    kind: 'app', targetId: 'app-1', path: 'index.html', content: '<p>b</p>',
  }),
  op('introspection', 'introspection.actor-roster', 'readActorRoster'),
  op('introspection', 'introspection.provider-posture', 'readProviderPosture'),
  op('introspection', 'introspection.storage-snapshot', 'readStorageSnapshot', { prefix: 'vault' }),
  op('introspection', 'introspection.automatable-tabs', 'readAutomatableTabs'),
  op('introspection', 'introspection.denylist-patterns', 'readDenylistPatterns'),
  op('introspection', 'introspection.audit-entries', 'readAuditEntries'),
  op('introspection', 'introspection.installed-skill', 'readInstalledSkill', { name: 'test' }),
  op('schedule', 'schedule.read-routines', 'readRoutines'),
  op('schedule', 'schedule.arm-confirmed-routine', 'armConfirmedRoutine', {
    prompt: 'check', every: '1h', dailyAt: null, mode: 'act',
  }),
  op('schedule', 'schedule.cancel-routine', 'cancelRoutine', { id: 'routine-1' }),
  op('dweb', 'dweb.discover-apps', 'discoverApps'),
  op('dweb', 'dweb.publish-confirmed-app', 'publishConfirmedApp', { appId: 'app-1' }),
  op('dweb', 'dweb.install-confirmed-app', 'installConfirmedApp', {
    uri: 'peerd://app/one', name: 'App',
  }),
  op('dweb', 'dweb.read-peers', 'readPeers'),
  op('dweb', 'dweb.set-peer-blocked', 'setPeerBlocked', {
    did: 'did:key:z6MkTest', block: true, reason: 'test',
  }),
  op('dweb', 'dweb.set-discovery-enabled', 'setDiscoveryEnabled', { enabled: true }),
  op('dweb', 'dweb.run-mesh-program', 'runMeshProgram', {
    code: 'return mesh.peers()', timeoutMs: 1000,
  }),
]) as Record<string, Spec>;

const domainFor = (operation: string) => CONTROLLER_DOMAIN_OPERATIONS[
  operation as keyof typeof CONTROLLER_DOMAIN_OPERATIONS
].authorityClass;
const expectedCalls = (spec: Spec) => spec.expected ?? [`${spec.domain}.${spec.method}`];

const METHOD_ARGUMENT_FIELDS = Object.freeze({
  'turn.repository.read-pod': ['podId'],
  'turn.repository.destroy-pod': ['podId'],
  'turn.repository.read-status': [],
  'turn.repository.read-history': ['depth'],
  'turn.repository.read-remote': [],
  'turn.repository.read-diff': ['from', 'to'],
  'turn.repository.confirm-restore': ['to'],
  'turn.repository.checkpoint': ['message'],
  'turn.repository.branch': ['name'],
  'turn.repository.checkout': ['name'],
  'turn.repository.restore': ['to'],
  'turn.repository.confirm-remote': ['op', 'target', 'branch'],
  'turn.repository.link': ['url'],
  'turn.repository.fetch': ['target'],
  'turn.repository.push': ['target', 'branch'],
  'turn.notebook.read': ['notebookId'],
  'turn.notebook.list': [],
  'turn.notebook.set-default': ['notebookId'],
  'turn.notebook.run': ['code', 'timeoutMs', 'notebookId'],
  'turn.notebook.write-file': ['path', 'content', 'notebookId'],
  'turn.notebook.read-file': ['path', 'notebookId'],
  'turn.notebook.destroy': ['notebookId'],
  'turn.app.update': ['appId', 'name', 'html', 'tags', 'entryFile'],
  'turn.app.open': ['appId'],
  'turn.app.search': ['query'],
  'turn.app.read': ['appId'],
  'turn.app.delete': ['appId'],
  'turn.app.write-file': ['appId', 'path', 'content'],
  'turn.app.read-file': ['appId', 'path'],
  'turn.app.list-files': ['appId'],
  'turn.app.delete-file': ['appId', 'path'],
  'turn.app.observe': [],
  'turn.app.act': ['action', 'params'],
  'turn.app.run-code': ['code', 'timeoutMs'],
  'turn.page.open-tab': [],
  'turn.page.read': [],
  'turn.page.snapshot': [],
  'turn.page.read-state': [],
  'turn.page.watch-changes': [],
  'turn.page.query-dom': [],
  'turn.page.navigate': [],
  'turn.page.fill': [],
  'turn.page.click': [],
  'turn.page.login': [],
  'turn.page.run-program': [],
  'turn.page.capture-foreground': [],
  'turn.page.capture-owned': [],
  'turn.dweb.discover-apps': [],
  'turn.dweb.publish-confirmed-app': ['appId'],
  'turn.dweb.install-confirmed-app': ['uri', 'name'],
  'turn.dweb.read-peers': [],
  'turn.dweb.set-peer-blocked': ['did', 'block', 'reason'],
  'turn.dweb.set-discovery-enabled': ['enabled'],
  'turn.dweb.run-mesh-program': ['code', 'timeoutMs'],
} as Record<string, string[]>);

const assertShapedArguments = (
  operation: string, spec: Spec, observed: Call[], sessionId: string,
) => {
  for (const call of observed) {
    const label = `${call.domain}.${call.method}`;
    if (label === 'pod.resolveId') {
      expect(call.args, operation).toEqual([{ sessionId, podId }]);
    } else if (label === 'pod.getRemote') {
      expect(call.args, operation).toEqual([{ kind: 'pod', id: podId }]);
    } else if (label === 'pod.confirm') {
      expect(call.args[0], operation).toMatchObject({
        tool: 'pod_exec', kind: 'git_fetch', origins: ['https://github.com'],
      });
      expect(call.args[1], operation).toBeInstanceOf(AbortSignal);
    } else if (label === 'pod.exec') {
      expect(call.args[0], operation).toBe('echo hi');
      expect(call.args[1], operation).toMatchObject({
        podId, timeoutMs: 1000, background: false, remoteGitGrant: null,
      });
      expect((call.args[1] as any).signal, operation).toBeInstanceOf(AbortSignal);
    } else if (label === 'pod.status') {
      expect(call.args, operation).toEqual([{
        sessionId, podId, jobId: 'job-1', stream: 'stdout', offset: 0, limit: 10,
      }]);
    } else if (label === 'pod.cancel') {
      expect(call.args, operation).toEqual(['job-1', { sessionId, podId }]);
    } else if (label === 'pod.readFile') {
      expect(call.args, operation).toEqual(['/work/a.txt', { sessionId, podId }]);
    } else if (label === 'pod.writeFile') {
      expect(call.args, operation).toEqual(['/work/a.txt', 'a', { sessionId, podId }]);
    }
  }
  const fields = METHOD_ARGUMENT_FIELDS[operation];
  if (fields) {
    expect(observed.at(-1)?.args, operation)
      .toEqual(fields.map((field) => spec.value[field]));
  }
};

const context = () => ({
  permission: { mode: 'act', confirmActions: false },
  readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
  appendAudit: async () => {},
  lifecycle: {
    requiresIntentConfirmation: async () => ({ required: false }),
    beginTracking: async () => ({ handle: {} }),
    settleTracking: async () => {},
  },
  confirm: (...args: unknown[]) => record('pod', 'confirm', args),
  completeGoalRun: (...args: unknown[]) => record('local', 'completeGoalRun', args),
  actorAuthority: {
    spawnSync: (...args: unknown[]) => record('actor', 'spawnSync', args),
    spawnAsync: (...args: unknown[]) => record('actor', 'spawnAsync', args),
    listTasks: (...args: unknown[]) => record('actor', 'listTasks', args),
    cancelTask: (...args: unknown[]) => record('actor', 'cancelTask', args),
    deliverMessage: (...args: unknown[]) => record('actor', 'deliverMessage', args),
  },
  podClient: {
    resolveId: (...args: unknown[]) => {
      record('pod', 'resolveId', args);
      return podId;
    },
    exec: (...args: unknown[]) => record('pod', 'exec', args),
    status: (...args: unknown[]) => record('pod', 'status', args),
    cancel: (...args: unknown[]) => record('pod', 'cancel', args),
    readFile: (...args: unknown[]) => record('pod', 'readFile', args),
    writeFile: (...args: unknown[]) => record('pod', 'writeFile', args),
  },
  repositories: {
    getRemote: (...args: unknown[]) => {
      record('pod', 'getRemote', args);
      return { url: 'https://github.com/openai/example.git' };
    },
  },
});

const executeMain = async (operation: string, spec: Spec, includeUnknown = false) => {
  calls = [];
  bindings = [];
  const steps = [...(spec.prelude ?? []), { operation, value: spec.value }];
  let bridge!: ReturnType<typeof makeControllerTurnBridge>;
  let operationResult: any = null;
  let unknownResult: any = null;
  const base: any = {
    sessionId: `session-${operation}`, session: { sessionId: `session-${operation}`, kind: 'chat' },
    sessions: { get: async () => ({ sessionId: `session-${operation}`, messages: [] }) },
    tools: [{ name: 'inspect', primitive: 'inspect', sideEffect: 'read' }],
    allowedOperations: [...new Set(steps.map((step) => step.operation))],
    signal: new AbortController().signal,
    ...context(),
  };
  base.loadAuthorityContext = async () => base;
  const getClient = async () => ({
    call: async (capability: string, payload: any, options: any) => {
      const authority = bridge.authorize(payload);
      const kernelContext = {
        capability, authority, signal: options.signal, deadlineAt: Date.now() + 1_000,
      };
      const callId = `call-${operation}`;
      await bridge.handleKernelCall('turn.model.observe-event', {
        runId: payload.runId,
        value: { type: 'tool-use-start', id: callId, name: 'inspect' },
      }, kernelContext);
      for (const [index, step] of steps.entries()) {
        operationResult = await bridge.handleKernelCall(step.operation, {
          runId: payload.runId,
          value: {
            callId, effectId: `${callId}:${index + 1}`, effectSequence: index + 1,
            turnGeneration: payload.turnGeneration, ...step.value,
          },
        }, kernelContext);
      }
      if (includeUnknown) unknownResult = await bridge.handleKernelCall(
        'turn.future.generic', { runId: payload.runId, value: {} }, kernelContext,
      );
      return { ok: false, error: 'matrix-complete', outcomeKnown: true };
    },
  });
  bridge = makeControllerTurnBridge({ getClient, newId: () => `run-${operation}` });
  try {
    for await (const _event of bridge.runUserTurn(base)) { /* no event lane */ }
  } catch (cause) {
    expect(cause).toMatchObject({ message: 'matrix-complete', outcomeKnown: true });
  } finally {
    await bridge.close();
  }
  return { operationResult, unknownResult, calls: [...calls], bindings: [...bindings] };
};

const actorRoute = (operation: string) => operation.slice('turn.'.length).replace('.', '/');
const durableMessages = (callId: string) => [{
  role: 'assistant', content: '', toolUses: [{ id: callId, name: 'inspect', input: {} }],
}, {
  role: 'user', content: '',
  toolResults: [{ tool_use_id: callId, content: 'semantic result', is_error: false }],
}];

const executeActor = async (operation: string, spec: Spec, includeUnknown = false) => {
  calls = [];
  bindings = [];
  if (!spec.actor) throw new TypeError(`missing actor for ${operation}`);
  const steps = [...(spec.prelude ?? []), { operation, value: spec.value }];
  const child = {
    kind: 'actor', sessionId: `actor-${operation}`,
    actorType: spec.actor.actorType, instanceId: spec.actor.instanceId,
    ...(spec.actor.backing ? { backing: spec.actor.backing } : {}),
  };
  let operationResult: any = null;
  let unknownResult: any = null;
  const client = makeOffscreenActorClient({
    ensureHost: async () => {}, sendMessage: async () => ({ ok: true }),
    spendRefusalFor: async () => null,
    settlementCleanupMs: 10,
    sessions: { get: async (id: string) => id === child.sessionId ? structuredClone(child) : null },
    buildToolContext: async () => ({
      session: { sessionId: child.sessionId, kind: 'actor' },
      actorType: spec.actor?.actorType, actorInstanceId: spec.actor?.instanceId,
      ...(spec.actor?.backing ? { backing: spec.actor.backing } : {}),
      ...context(),
    }),
    inboundDwebToolNames: [],
    runOnChannel: async (job: any, { relay }: any) => {
      const callId = `actor-call-${operation}`;
      for (const [index, step] of steps.entries()) {
        const pending = relay(actorRoute(step.operation), {
          operation: step.operation, callId,
          effectId: `${callId}:${index + 1}`, effectSequence: index + 1,
          turnGeneration: job.turnGeneration, ...step.value,
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          operationResult = await Promise.race([
            pending,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(
                `relay did not settle at ${step.operation}`,
              )), 500);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      if (includeUnknown) unknownResult = await relay('future/generic', {
        operation: 'turn.future.generic',
      });
      const completion = await relay('actor/call-complete', {
        callId, turnGeneration: job.turnGeneration,
        result: { ok: true, content: 'semantic result' },
      });
      return { ok: true, completion, newMessages: durableMessages(callId) };
    },
  } as any);
  await client.run({
    actorSessionId: child.sessionId, message: 'matrix', systemPrompt: 'system',
    provider: 'anthropic', model: 'model-1', tools: [{ name: 'inspect' }],
    allowedOperations: [...new Set(steps.map((step) => step.operation))],
    actorType: spec.actor.actorType,
    ...(spec.actor.backing ? { backing: spec.actor.backing } : {}),
  } as any);
  return { operationResult, unknownResult, calls: [...calls], bindings: [...bindings] };
};

const operations = Object.keys(CONTROLLER_DOMAIN_OPERATIONS);
const rows = operations.map((operation) => [operation, specs[operation]] as const);

describe('controller exact-operation executable routing', () => {
  test('the executable matrix is exhaustive over the canonical fixed vocabulary', () => {
    expect(new Set(Object.keys(specs))).toEqual(new Set(operations));
    expect(Object.keys(specs)).toHaveLength(operations.length);
  });

  test.each(rows)('%s reaches only its exact domain dependency', async (operation, spec) => {
    expect(spec, `missing executable fixture for ${operation}`).toBeDefined();
    expect(domainFor(operation), operation).toBe(spec.domain);
    const result = spec.actor
      ? await executeActor(operation, spec) : await executeMain(operation, spec);
    expect(result.operationResult, operation).toBeDefined();
    expect(result.calls.map(({ domain, method }) => `${domain}.${method}`), operation)
      .toEqual(expectedCalls(spec));
    const sessionId = spec.actor ? `actor-${operation}` : `session-${operation}`;
    assertShapedArguments(operation, spec, result.calls, sessionId);
    if (binderModules.some(([, , domain]) => domain === spec.domain)) {
      const { appProgramSemanticToken: _appToken, pageProgramSemanticToken: _pageToken,
        ...ordinaryArgs } = spec.value;
      const pageArgs = spec.domain === 'page'
        ? spec.value.args as Record<string, unknown> : ordinaryArgs;
      const semanticToken = spec.value.appProgramSemanticToken
        ?? spec.value.pageProgramSemanticToken;
      expect(result.bindings, operation).toEqual([{
        domain: spec.domain, operation, args: pageArgs,
        ...(['turn.app.run-code', 'turn.page.run-program'].includes(operation)
          && typeof semanticToken === 'string' ? { semanticToken } : {}),
      }]);
    }
  });

  test('an unknown main operation reaches no domain dependency', async () => {
    const result = await executeMain('turn.actor.tasks', specs['turn.actor.tasks'], true);
    expect(result.unknownResult).toEqual({
      ok: false, code: 'turn-kernel-operation-denied', outcomeKnown: true,
    });
    expect(result.calls.map(({ domain, method }) => `${domain}.${method}`))
      .toEqual(['actor.listTasks']);
  });

  test('an unknown actor relay reaches no domain dependency', async () => {
    const operation = 'turn.vm.list';
    const result = await executeActor(operation, specs[operation], true);
    expect(result.unknownResult).toEqual({
      ok: false, error: 'unknown actor relay: future/generic',
    });
    expect(result.calls.map(({ domain, method }) => `${domain}.${method}`))
      .toEqual(['vm.listVms']);
  });

  test('a refused Pod binding releases its reserved claim before call settlement', async () => {
    const invalid = {
      ...specs['turn.pod.status'],
      value: { podId: 'another-pod', jobId: 'job-1', stream: 'stdout', offset: 0, limit: 10 },
    };
    const result = await executeActor('turn.pod.status', invalid);
    expect(result.operationResult).toEqual({
      ok: false, error: 'pod/status: authority mismatch', outcomeKnown: true,
    });
    expect(result.calls).toEqual([]);
  });
});
}
