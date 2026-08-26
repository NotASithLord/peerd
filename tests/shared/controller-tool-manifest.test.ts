import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { CONTROLLER_TOOL_IMPLEMENTATIONS } from '../../extension/peerd-runtime/controller-tools.js';
import { CONTROLLER_ACTOR_TOOL_NAMES } from '../../extension/peerd-runtime/controller-turn.js';
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
    ]);
    expect(hosted).toEqual([
      ...Object.keys(CONTROLLER_TOOL_IMPLEMENTATIONS), ...CONTROLLER_ACTOR_TOOL_NAMES,
    ]);
    expect(CONTROLLER_TOOL_MANIFEST.tools.now.effects).toEqual([]);
    expect(CONTROLLER_TOOL_MANIFEST.tools.complete_goal.effects.map((effect: any) => effect.operation))
      .toEqual(['goal.end']);
    expect(controllerHostsTool('now')).toBe(true);
    expect(controllerHostsTool('complete_goal')).toBe(true);
    expect(controllerHostsTool('wait_until')).toBe(false);
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

  test('the controller tool graph excludes the durable wait implementation', async () => {
    const graph = await collectStaticModuleGraph(
      EXTENSION_DIR, `${EXTENSION_DIR}/offscreen/controller-tool-runtime.js`,
    );
    const files = new Set([...graph].map((path) => relative(EXTENSION_DIR, path)));
    expect(files.has('peerd-runtime/clock/execute.js')).toBe(true);
    expect(files.has('peerd-runtime/clock/wait-execute.js')).toBe(false);
    expect(files.has('peerd-runtime/clock/tools.js')).toBe(false);
  });
});
