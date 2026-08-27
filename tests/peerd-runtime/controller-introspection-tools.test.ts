import { describe, expect, test } from 'bun:test';
import {
  CONTROLLER_INTROSPECTION_TOOL_NAMES,
  controllerHostsIntrospectionTool,
  executeControllerIntrospectionTool,
} from '../../extension/peerd-runtime/controller-introspection-tools.js';

describe('controller-owned introspection semantics', () => {
  test('owns one finite catalog without a caller-selected operation', () => {
    expect(Object.isFrozen(CONTROLLER_INTROSPECTION_TOOL_NAMES)).toBe(true);
    expect(CONTROLLER_INTROSPECTION_TOOL_NAMES).toEqual([
      'actor_list', 'inspect', 'load_skill',
    ]);
    expect(controllerHostsIntrospectionTool('inspect')).toBe(true);
    expect(controllerHostsIntrospectionTool('storage.get')).toBe(false);
    expect(controllerHostsIntrospectionTool('__proto__')).toBe(false);
  });

  test('shapes an authority-filtered actor roster in the controller', async () => {
    const result: any = await executeControllerIntrospectionTool(
      'actor_list', {}, {}, {
        readActorRoster: async () => ({
          engines: [{
            type: 'webvm', currentId: 'vm-1', liveIds: ['vm-1'],
            records: [{ id: 'vm-1', name: 'project', pinned: true }],
          }],
          tabs: [{ id: 7, url: 'https://example.test/x', title: 'Docs', active: true }],
          integrations: [], restrictedTabsHidden: 2, unavailable: [],
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.structured.deniedCount).toBe(2);
    expect(result.content).toContain('project');
    expect(result.content).toContain('https://example.test');
  });

  test('selects the exact inspect facet without exposing storage machinery', async () => {
    let reads = 0;
    const result: any = await executeControllerIntrospectionTool(
      'inspect', { kind: 'storage', prefix: 'vault:' }, {}, {
        readStorageSnapshot: async (prefix: string) => {
          reads += 1;
          expect(prefix).toBe('vault:');
          return { 'vault:key': 'ciphertext' };
        },
      },
    );
    expect(reads).toBe(1);
    expect(JSON.parse(result.content)).toEqual({ 'vault:key': 'ciphertext' });
  });

  test('frames an exact installed-skill read with the projected session watermark', async () => {
    const result: any = await executeControllerIntrospectionTool(
      'load_skill', { name: 'writer' }, {
        sessionId: 's1', messageCount: 4, trimCovered: 0,
      }, {
        readInstalledSkill: async () => ({
          meta: { name: 'writer', version: '1' }, body: 'write carefully',
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('<skill name="writer" version="1">');
    expect(result.content).toContain('write carefully');
  });
});
