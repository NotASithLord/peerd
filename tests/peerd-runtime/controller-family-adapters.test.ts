import { describe, expect, test } from 'bun:test';
import {
  executeControllerActorTool,
  executeControllerDwebTool,
  executeControllerEditingTool,
  executeControllerExecutionTool,
  executeControllerPodTool,
  executeControllerRepositoryTool,
  executeControllerResourceTool,
  executeControllerScheduleTool,
  executeControllerSiteClientTool,
} from '../../extension/peerd-runtime/controller-turn.js';

const signal = new AbortController().signal;
const calls = () => {
  const seen: Array<{ method: string; args: unknown[] }> = [];
  const method = (name: string, result: unknown) => async (...args: unknown[]) => {
    seen.push({ method: name, args });
    return structuredClone(result);
  };
  return { seen, method };
};

const expectUnavailable = async (
  execute: (name: string) => Promise<unknown>, code: string,
) => {
  await expect(execute('__unknown_controller_tool__')).rejects.toMatchObject({
    code, outcomeKnown: true,
  });
};

describe('controller semantic-family authority adapters', () => {
  test('actor projection wires actor_tasks to the finite listTasks authority', async () => {
    const spy = calls();
    const result = await executeControllerActorTool('actor_tasks', {}, {
      sessionId: 'chat-1', sessionDepth: 2, sessionKind: 'chat', inbound: false,
    }, {
      spawnSync: spy.method('spawnSync', {}), spawnAsync: spy.method('spawnAsync', {}),
      listTasks: spy.method('listTasks', [{ taskId: 'task-1', task: 'inspect', status: 'running', lastOutput: '' }]),
      cancelTask: spy.method('cancelTask', {}), message: spy.method('message', {}),
    }, { callId: 'call-1', signal });
    expect(result).toMatchObject({ ok: true });
    expect(spy.seen).toEqual([{ method: 'listTasks', args: [] }]);
    await expectUnavailable((name) => executeControllerActorTool(name, {}, {}, {} as any, {
      callId: 'call-unknown', signal,
    }), 'controller-actor-tool-unavailable');
  });

  test('Pod projection preserves exact status arguments and session custody', async () => {
    const spy = calls();
    const authority = {
      resolve: spy.method('resolve', 'pod-1'), readRemote: spy.method('readRemote', null),
      confirmGit: spy.method('confirmGit', 'yes_once'),
      executeCommand: spy.method('executeCommand', {}),
      readStatus: spy.method('readStatus', {
        podId: 'pod-1', job: { id: 'job-1', state: 'running', output: 'progress' },
      }),
      cancelJob: spy.method('cancelJob', {}), readFile: spy.method('readFile', ''),
      writeFile: spy.method('writeFile', 'pod-1'),
    };
    const result = await executeControllerPodTool('pod_status', {
      podId: 'pod-1', jobId: 'job-1', stream: 'stdout', offset: 4, limit: 10,
    }, { sessionId: 'chat-1' }, authority, { signal });
    expect(result).toMatchObject({ ok: true });
    expect(spy.seen).toEqual([{ method: 'readStatus', args: [{
      podId: 'pod-1', jobId: 'job-1', stream: 'stdout', offset: 4, limit: 10,
      sessionId: 'chat-1',
    }] }]);
    await expectUnavailable((name) => executeControllerPodTool(
      name, {}, {}, authority, { signal },
    ), 'controller-pod-tool-unavailable');
  });

  test('repository projection wires repo_history to read-only repository methods', async () => {
    const spy = calls();
    const authority = {
      readStatus: spy.method('readStatus', { clean: true }),
      readHistory: spy.method('readHistory', [{ oid: 'abc', message: 'initial' }]),
      readRemote: spy.method('readRemote', null),
      readDiff: spy.method('readDiff', { from: 'HEAD', to: null, files: [], patch: '' }),
    };
    const result = await executeControllerRepositoryTool(
      'repo_history', { depth: 7 }, { actorType: 'app', actorInstanceId: 'app-1' },
      authority, { signal },
    );
    expect(result).toMatchObject({ ok: true });
    expect(spy.seen).toEqual([
      { method: 'readStatus', args: [] },
      { method: 'readHistory', args: [7] },
      { method: 'readRemote', args: [] },
    ]);
    await expectUnavailable((name) => executeControllerRepositoryTool(
      name, {}, {}, authority, { signal },
    ), 'controller-repository-tool-unavailable');
  });

  test('resource projection executes read_result through only the opaque pager read', async () => {
    const spy = calls();
    const authority = {
      readResult: spy.method('readResult', {
        ok: true,
        record: {
          key: 'result:one', ownerSessionId: 'chat-1', producer: 'script', fenced: false,
          originLabel: 'script', format: 'text', text: 'answer',
        },
      }),
    };
    const result = await executeControllerResourceTool(
      'read_result', { key: 'result:one' }, authority,
    );
    expect(result).toMatchObject({ ok: true });
    expect(spy.seen).toEqual([{ method: 'readResult', args: ['result:one'] }]);
    await expectUnavailable((name) => executeControllerResourceTool(
      name, {}, authority,
    ), 'controller-resource-tool-unavailable');
  });

  test('site-client projection normalizes the origin before the exact stored-client read', async () => {
    const spy = calls();
    const authority = {
      readStoredClient: spy.method('readStoredClient', {
        ok: true,
        record: {
          meta: { summary: 'API', auth: 'browser session', endpoints: [], capturedAt: Date.now() },
          body: 'export default {}',
        },
      }),
    };
    const result = await executeControllerSiteClientTool(
      'site_client_read', { origin: 'https://example.test/path' }, authority,
    );
    expect(result).toMatchObject({ ok: true });
    expect(spy.seen).toEqual([{
      method: 'readStoredClient', args: ['https://example.test'],
    }]);
    await expectUnavailable((name) => executeControllerSiteClientTool(
      name, {}, authority,
    ), 'controller-site-client-tool-unavailable');
  });

  test('execution projection passes only the derived headless execution request', async () => {
    const spy = calls();
    const authority = {
      runHeadlessScript: spy.method('runHeadlessScript', {
        ok: true, result: { durationMs: 1, value: 2 },
      }),
    };
    const result = await executeControllerExecutionTool(
      'script', { code: 'return 1 + 1', timeoutMs: 500 }, authority,
      { sessionId: 'chat-adapter', sessionKind: 'chat', messages: [] },
    );
    expect(result).toMatchObject({ ok: true });
    expect(spy.seen).toEqual([{ method: 'runHeadlessScript', args: [{
      code: 'return 1 + 1', actors: false, provider: false,
      workspace: false, timeoutMs: 500,
    }] }]);
    await expectUnavailable((name) => executeControllerExecutionTool(
      name, {}, authority,
    ), 'controller-execution-tool-unavailable');
  });

  test('editing projection executes the complete read/apply/write behavior', async () => {
    const spy = calls();
    const authority = {
      readEditTarget: spy.method('readEditTarget', { ok: true, exists: false, source: '' }),
      writeEditTarget: spy.method('writeEditTarget', { ok: true }),
    };
    const result = await executeControllerEditingTool('edit_file', {
      path: 'index.js', edits: '<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE\n',
    }, authority);
    expect(result).toMatchObject({ ok: true });
    expect(spy.seen).toEqual([
      { method: 'readEditTarget', args: [{ kind: 'app', targetId: null, path: 'index.js' }] },
      { method: 'writeEditTarget', args: [{
        kind: 'app', targetId: null, path: 'index.js', content: 'export const value = 1;',
      }] },
    ]);
    await expectUnavailable((name) => executeControllerEditingTool(
      name, {}, authority,
    ), 'controller-editing-tool-unavailable');
  });

  test('schedule projection wires schedule_list to the routine snapshot only', async () => {
    const spy = calls();
    const authority = {
      readRoutines: spy.method('readRoutines', []),
      armConfirmedRoutine: spy.method('armConfirmedRoutine', {}),
      cancelRoutine: spy.method('cancelRoutine', {}),
    };
    expect(await executeControllerScheduleTool('schedule_list', {}, authority))
      .toEqual({ ok: true, content: 'No background routines registered.' });
    expect(spy.seen).toEqual([{ method: 'readRoutines', args: [] }]);
    await expectUnavailable((name) => executeControllerScheduleTool(
      name, {}, authority,
    ), 'controller-schedule-tool-unavailable');
  });

  test('dweb projection wires dweb_peers to the read-only mesh snapshot', async () => {
    const spy = calls();
    const authority = {
      discoverApps: spy.method('discoverApps', {}),
      publishConfirmedApp: spy.method('publishConfirmedApp', {}),
      installConfirmedApp: spy.method('installConfirmedApp', {}),
      readPeers: spy.method('readPeers', { ok: true, running: true, did: 'did:key:z1', peers: [] }),
      setPeerBlocked: spy.method('setPeerBlocked', {}),
      setDiscoveryEnabled: spy.method('setDiscoveryEnabled', {}),
      runMeshProgram: spy.method('runMeshProgram', {}),
    };
    const result = await executeControllerDwebTool(
      'dweb_peers', {}, { sessionId: 'chat-1', dwebAvailable: true }, authority,
    );
    expect(result).toMatchObject({ ok: true });
    expect(spy.seen).toEqual([{ method: 'readPeers', args: [] }]);
    await expectUnavailable((name) => executeControllerDwebTool(
      name, {}, {}, authority,
    ), 'controller-dweb-tool-unavailable');
  });
});
