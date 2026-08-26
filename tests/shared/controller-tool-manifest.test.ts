import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { CONTROLLER_TOOL_IMPLEMENTATIONS } from '../../extension/peerd-runtime/controller-tools.js';
import {
  CONTROLLER_ACTOR_TOOL_NAMES,
  CONTROLLER_POD_TOOL_NAMES,
  CONTROLLER_REPOSITORY_TOOL_NAMES,
  CONTROLLER_VM_TOOL_NAMES,
  CONTROLLER_NOTEBOOK_TOOL_NAMES,
  CONTROLLER_APP_TOOL_NAMES,
  CONTROLLER_PERSISTENCE_TOOL_NAMES,
  CONTROLLER_PAGE_TOOL_NAMES,
  CONTROLLER_INTROSPECTION_TOOL_NAMES,
  CONTROLLER_SCHEDULE_TOOL_NAMES,
} from '../../extension/peerd-runtime/controller-turn.js';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import {
  CONTROLLER_TOOL_MANIFEST,
  controllerHostsTool,
} from '../../extension/shared/controller-tool-manifest.js';

describe('controller tool manifest', () => {
  test('admits only implemented controller tools', () => {
    const hosted = Object.keys(CONTROLLER_TOOL_MANIFEST.tools);
    expect(hosted).toEqual([
      'now', 'complete_goal', 'actor_create', 'actor_tasks', 'actor_cancel', 'message_actor',
      'pod_exec', 'pod_status', 'pod_cancel', 'pod_read', 'pod_write',
      'pod_destroy', 'repo_history', 'repo_version', 'repo_remote',
      'vm_boot', 'vm_import', 'vm_write_file', 'vm_delete',
      'js_notebook', 'js_write_file', 'js_read_file', 'js_delete',
      'app_update', 'app_open', 'app_search', 'app_delete',
      'app_write_file', 'app_read_file', 'app_list_files', 'app_delete_file',
      'app_observe', 'app_act', 'app_code',
      'read_memory', 'remember', 'todo_init', 'todo_check', 'todo_add',
      'open_tab', 'read_page', 'snapshot', 'read_state', 'watch_changes',
      'query_dom', 'page_eval', 'page_exec', 'page_keys', 'navigate', 'type',
      'click', 'login', 'page_code', 'capture', 'view',
      'actor_list', 'inspect', 'wait_until', 'load_skill',
      'schedule_create', 'schedule_list', 'schedule_cancel',
    ]);
    expect(hosted).toEqual([
      ...Object.keys(CONTROLLER_TOOL_IMPLEMENTATIONS),
      ...CONTROLLER_ACTOR_TOOL_NAMES,
      ...CONTROLLER_POD_TOOL_NAMES,
      ...CONTROLLER_REPOSITORY_TOOL_NAMES,
      ...CONTROLLER_VM_TOOL_NAMES,
      ...CONTROLLER_NOTEBOOK_TOOL_NAMES,
      ...CONTROLLER_APP_TOOL_NAMES,
      ...CONTROLLER_PERSISTENCE_TOOL_NAMES,
      ...CONTROLLER_PAGE_TOOL_NAMES,
      ...CONTROLLER_INTROSPECTION_TOOL_NAMES,
      ...CONTROLLER_SCHEDULE_TOOL_NAMES,
    ]);
    expect(CONTROLLER_TOOL_MANIFEST.tools.now.effects).toEqual([]);
    expect(CONTROLLER_TOOL_MANIFEST.tools.complete_goal.effects.map((effect: any) => effect.operation))
      .toEqual(['goal.end']);
    expect(controllerHostsTool('now')).toBe(true);
    expect(controllerHostsTool('complete_goal')).toBe(true);
    expect(controllerHostsTool('wait_until')).toBe(true);
    expect(controllerHostsTool('__proto__')).toBe(false);
  });

  test('digest covers the compiled executable policy', () => {
    const payload = JSON.stringify({
      protocol: CONTROLLER_TOOL_MANIFEST.protocol,
      tools: CONTROLLER_TOOL_MANIFEST.tools,
    });
    expect(createHash('sha256').update(payload).digest('hex'))
      .toBe(CONTROLLER_TOOL_MANIFEST.digest);
  });

  test('the controller tool graph owns the wait implementation', async () => {
    const graph = await collectStaticModuleGraph(
      EXTENSION_DIR, `${EXTENSION_DIR}/offscreen/controller-turn-runtime.js`,
    );
    const files = new Set([...graph].map((path) => relative(EXTENSION_DIR, path)));
    expect(files.has('peerd-runtime/clock/wait-execute.js')).toBe(true);
    expect(files.has('peerd-runtime/clock/tools.js')).toBe(true);
  });
});
