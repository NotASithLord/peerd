import { describe, expect, test } from 'bun:test';
import { buildActorFabric } from '../../extension/sidepanel/components/actor-fabric-model.js';

const root = (messages: any[] = []) => ({ sessionId: 'chat-1', messages });

describe('Actor Fabric topology projection', () => {
  test('shows only live bound actors and exposes the resource boundary', () => {
    const fabric = buildActorFabric({
      rootSession: root([{ toolUses: [{ id: 'tu-live', name: 'message_actor' }] }]),
      actors: {
        'tu-live': {
          sessionId: 'web-actor-1', rootSessionId: 'chat-1', parentSessionId: 'chat-1',
          kind: 'web', instanceId: 'web', task: 'check the current price',
          grantedTools: ['read_page'], streaming: true,
          messages: [{ toolUses: [{ id: 'read', name: 'read_page' }] }],
        },
        settled: { sessionId: 'old', kind: 'app', instanceId: 'app-1', streaming: false },
      },
    });

    expect(fabric.nodes).toHaveLength(1);
    expect(fabric.nodes[0]).toMatchObject({
      id: 'actor:web-actor-1', parentId: 'session:chat-1',
      variant: 'bound', label: 'web actor', status: 'working',
      name: 'check the current price', activity: 'Requested read page…',
      scope: 'one web tab · read page',
    });
    expect(fabric.nodes[0].boundary).toContain('fenced reply');
    expect(fabric.activeActors).toBe(1);
    expect(fabric.root).toMatchObject({ variant: 'root', boundaryChip: 'main context' });
  });

  test('nests an actor under the subactor whose transcript delegated to it', () => {
    const fabric = buildActorFabric({
      rootSession: root(),
      spawned: { sessions: {
        child: {
          sessionId: 'child', parentSessionId: 'chat-1', task: 'research safely',
          rootSessionId: 'chat-1', running: true, grantedTools: ['message_actor'],
          messages: [{ toolUses: [{ id: 'tu-child-web', name: 'message_actor' }] }],
        },
      } },
      actors: {
        'tu-child-web': {
          sessionId: 'bound-web', rootSessionId: 'chat-1', parentSessionId: 'child',
          kind: 'web', instanceId: '42', task: 'inspect the target tab',
          grantedTools: ['read_page'], streaming: true,
          messages: [],
        },
      },
    });

    const child = fabric.nodes.find((node) => node.id === 'session:child');
    const web = fabric.nodes.find((node) => node.id === 'actor:bound-web');
    expect(child).toMatchObject({ variant: 'subactor', parentId: 'session:chat-1', scope: 'delegate' });
    expect(web).toMatchObject({ variant: 'bound', parentId: 'session:child' });
  });

  test('deduplicates the async placeholder once its child session is known', () => {
    const fabric = buildActorFabric({
      rootSession: root(),
      spawned: { sessions: {
        child: {
          sessionId: 'child', parentSessionId: 'chat-1', task: 'build calculator',
          rootSessionId: 'chat-1', running: false, messages: [],
        },
      } },
      asyncTasks: {
        'chat-1': [{
          taskId: 'as-1', childSessionId: 'child', task: 'build calculator',
          status: 'done', grantedTools: ['script', 'message_actor'],
        }],
      },
    });

    expect(fabric.nodes).toHaveLength(1);
    expect(fabric.nodes[0]).toMatchObject({
      id: 'session:child', variant: 'subactor', status: 'finishing',
      scope: 'run local code · delegate',
      access: 'script · message_actor',
    });
  });

  test('drops foreign and corrupt ancestry instead of inventing a root edge', () => {
    const fabric = buildActorFabric({
      rootSession: root(),
      spawned: { sessions: {
        a: { sessionId: 'a', parentSessionId: 'b', task: 'private A task', running: true, messages: [] },
        b: { sessionId: 'b', parentSessionId: 'a', task: 'b', running: true, messages: [] },
      } },
      asyncTasks: { 'foreign-chat': [{ taskId: 'foreign', task: 'foreign pending task', status: 'running' }] },
      actors: {
        foreign: {
          sessionId: 'foreign-actor', rootSessionId: 'foreign-chat', parentSessionId: 'foreign-chat',
          kind: 'web', instanceId: 'web', task: 'foreign bound task', streaming: true,
        },
      },
    });
    expect(fabric.nodes).toHaveLength(0);
    expect(fabric.activeActors).toBe(0);
  });

  test('keeps a known child visible while its transcript hydrates', () => {
    const fabric = buildActorFabric({
      rootSession: root(),
      asyncTasks: {
        'chat-1': [{
          taskId: 'as-1', childSessionId: 'child-late', task: 'hydrate me',
          status: 'running', grantedTools: ['script'],
        }],
      },
    });
    expect(fabric.nodes).toHaveLength(1);
    expect(fabric.nodes[0]).toMatchObject({
      id: 'session:child-late', parentId: 'session:chat-1',
      scope: 'run local code',
    });
  });

  test('keeps a settled parent visible while a nested async child hydrates', () => {
    const fabric = buildActorFabric({
      rootSession: root(),
      spawned: { sessions: {
        parent: {
          sessionId: 'parent', parentSessionId: 'chat-1', rootSessionId: 'chat-1',
          task: 'coordinate research', running: false, messages: [],
        },
      } },
      asyncTasks: {
        parent: [{
          taskId: 'as-late', childSessionId: 'late-child', task: 'inspect source',
          status: 'running', grantedTools: ['fetch_url'],
        }],
      },
    });
    expect(fabric.nodes).toHaveLength(2);
    expect(fabric.nodes.find((node) => node.id === 'session:parent')).toMatchObject({
      parentId: 'session:chat-1', status: 'handed-off',
    });
    expect(fabric.nodes.find((node) => node.id === 'session:late-child')).toMatchObject({
      parentId: 'session:parent', scope: 'fetch URL', access: 'fetch_url',
    });
  });

  test('counts only nodes transitively reachable from the viewed root', () => {
    const fabric = buildActorFabric({
      rootSession: root(),
      spawned: { sessions: {
        orphanParent: {
          sessionId: 'orphanParent', parentSessionId: 'missing', rootSessionId: 'chat-1',
          task: 'hidden parent', running: true, messages: [],
        },
        orphanChild: {
          sessionId: 'orphanChild', parentSessionId: 'orphanParent', rootSessionId: 'chat-1',
          task: 'hidden child', running: true, messages: [],
        },
      } },
    });
    expect(fabric.nodes).toEqual([]);
    expect(fabric.activeActors).toBe(0);
  });

  test('does not present an invented tool request as current activity', () => {
    const fabric = buildActorFabric({
      rootSession: root([{ toolUses: [{ id: 'tu', name: 'message_actor' }] }]),
      actors: {
        tu: {
          sessionId: 'actor', rootSessionId: 'chat-1', parentSessionId: 'chat-1',
          kind: 'web', instanceId: 'web', task: 'read safely',
          grantedTools: ['read_page'], streaming: true,
          messages: [{ toolUses: [{ id: 'forged', name: 'vault_export_all_secrets' }] }],
        },
      },
    });
    expect(fabric.nodes[0]?.activity).toBe('Reasoning in its task context…');
  });
});
