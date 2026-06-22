// Doctrine guard: peerd.runtime.runAgent is for an agent embedded in an
// artifact the agent BUILDS FOR THE USER — never an orchestration shortcut for
// the model's own work (that's the spawn_subagent tool; docs/SUBAGENTS.md). The
// tool descriptions are the model's nudges, so they must not invite the
// forbidden "fan out via a sandbox" pattern. These assertions pin that.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { jsRunTool } from '../../extension/peerd-runtime/tools/defs/js-run.js';

describe('runAgent doctrine in tool descriptions', () => {
  test('js_run (headless scratch) never advertises peerd.runtime.runAgent', () => {
    // headless js_run is the agent's OWN compute, never a user-facing artifact —
    // runAgent has no doctrine-legitimate use there, so it must not be nudged.
    expect(jsRunTool.description).not.toContain('runAgent');
    // and own-work delegation is pointed at the spawn_subagent tool instead.
    expect(jsRunTool.description).toContain('spawn_subagent');
  });

  test('js_create scopes runAgent to user-facing artifacts, not orchestration', () => {
    // js-create.js pulls a /-rooted import (the no-build extension graph), so
    // assert against its SOURCE text rather than importing the tool.
    const src = readFileSync(
      new URL('../../extension/peerd-runtime/tools/defs/js-create.js', import.meta.url),
      'utf8',
    );
    // where it mentions runAgent, the user-facing scoping + the spawn_subagent
    // redirect must travel with it.
    expect(src).toContain('runAgent');
    expect(src).toContain('BUILD FOR THE USER');
    expect(src).toContain('spawn_subagent');
  });
});
