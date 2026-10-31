import { describe, test, expect } from 'bun:test';
import {
  SANDBOX_VERBS, SANDBOX_ACTOR_TYPES, canonicalSandboxHistory, canonicalSandboxLoopEvent,
  canonicalSandboxToolName, isSandboxActorType, projectSandboxTrimSummary,
  projectSandboxHistory, projectSandboxText, projectSandboxTools, sandboxVerbsFor,
} from '../../../extension/peerd-runtime/tools/sandbox-verbs.js';
import { ACTOR_CAPABILITY_MANIFESTS } from '../../../extension/peerd-runtime/actor/capability-manifest.js';
import { TOOL_METADATA_RECORDS } from '../../../extension/peerd-runtime/tools/metadata/catalog.js';

describe('sandbox verb family', () => {
  test('every mapped tool is a real catalog tool owned by that kind of actor', () => {
    for (const [verb, byKind] of Object.entries(SANDBOX_VERBS)) {
      expect(Object.hasOwn(TOOL_METADATA_RECORDS, verb)).toBe(false);
      for (const [kind, canonical] of Object.entries(byKind)) {
        expect(SANDBOX_ACTOR_TYPES).toContain(kind);
        expect(Object.hasOwn(TOOL_METADATA_RECORDS, canonical)).toBe(true);
        expect(ACTOR_CAPABILITY_MANIFESTS[kind].tools).toContain(canonical);
      }
    }
  });

  test('the mapping is one-to-one within each kind, so translation round-trips', () => {
    for (const kind of SANDBOX_ACTOR_TYPES) {
      const verbs = sandboxVerbsFor(kind);
      expect(new Set(verbs.values()).size).toBe(verbs.size);
      for (const [canonical, verb] of verbs) {
        expect(canonicalSandboxToolName(kind, verb)).toBe(canonical);
      }
    }
  });

  test('a verb a kind does not have refuses rather than guessing', () => {
    expect(canonicalSandboxToolName('webvm', 'sandbox_read')).toBeNull();
    expect(canonicalSandboxToolName('app', 'sandbox_exec')).toBeNull();
    expect(projectSandboxTools('webvm', [{ name: 'vm_boot' }]).map((t) => t.name)).toEqual(['sandbox_exec']);
  });

  test('instance destruction and the App playtest keep their own unambiguous names', () => {
    const renamed = new Set(Object.values(SANDBOX_VERBS).flatMap((byKind) => Object.values(byKind)));
    for (const kept of ['vm_delete', 'js_delete', 'pod_destroy', 'app_delete', 'app_code']) {
      expect(renamed.has(kept)).toBe(false);
    }
    expect(projectSandboxTools('pod', [{ name: 'pod_destroy' }, { name: 'pod_exec' }]).map((t) => t.name))
      .toEqual(['pod_destroy', 'sandbox_exec']);
  });

  test('a projection that would duplicate a tool name fails loudly', () => {
    expect(() => projectSandboxTools('pod', [{ name: 'pod_exec' }, { name: 'sandbox_exec' }])).toThrow(TypeError);
  });

  test('stored trim summaries are projected for the model and canonical again on the way out', () => {
    const stored = { covered: 1, tools: { js_notebook: 2, edit_file: 1 } };
    expect(projectSandboxTrimSummary('notebook', stored)).toEqual({ covered: 1, tools: { sandbox_exec: 2, edit_file: 1 } });
    expect(projectSandboxTrimSummary('web', stored)).toBe(stored);
    expect(projectSandboxTrimSummary('notebook', null)).toBeNull();
  });

  test('non-sandbox actors and non-verb names pass through untouched', () => {
    for (const kind of ['web', 'dweb', undefined, 'api']) {
      expect(isSandboxActorType(kind)).toBe(false);
      expect(canonicalSandboxToolName(kind, 'sandbox_exec')).toBe('sandbox_exec');
      expect(projectSandboxText(kind, 'use vm_boot then app_code')).toBe('use vm_boot then app_code');
      const tools = [{ name: 'vm_boot', description: 'x' }];
      expect(projectSandboxTools(kind, tools)).toEqual(tools);
    }
    expect(canonicalSandboxToolName('webvm', 'vm_import')).toBe('vm_import');
    expect(canonicalSandboxToolName('webvm', 'pod_exec')).toBe('pod_exec');
  });

  test('a canonical name sent directly is not translated (the host gate decides it)', () => {
    expect(canonicalSandboxToolName('pod', 'vm_boot')).toBe('vm_boot');
    expect(canonicalSandboxToolName('pod', 'pod_exec')).toBe('pod_exec');
  });

  test('descriptors keep their own schema and description, with cross-references rewritten', () => {
    const schema = { type: 'object', properties: { cmd: { type: 'string' } } };
    const [exec, imported] = projectSandboxTools('webvm', [
      { name: 'vm_boot', description: 'Run a shell command. Use vm_import for binaries.', schema },
      { name: 'vm_import', description: 'Stage bytes; prefer vm_boot for pip.', schema },
    ]);
    expect(exec).toEqual({
      name: 'sandbox_exec', description: 'Run a shell command. Use vm_import for binaries.', schema,
    });
    expect(imported.name).toBe('vm_import');
    expect(imported.description).toBe('Stage bytes; prefer sandbox_exec for pip.');
  });

  test('text projection matches whole identifiers only and only for that kind', () => {
    expect(projectSandboxText('app', 'app_write_file, app_write_files, xapp_code, app_code.'))
      .toBe('sandbox_write, app_write_files, xapp_code, app_code.');
    expect(projectSandboxText('notebook', 'js_notebook or app_code')).toBe('sandbox_exec or app_code');
  });

  test('prior tool calls are projected so history matches the shown tools', () => {
    const untouched = { role: 'user', content: 'hi' };
    const result = { role: 'user', toolResults: [{ tool_use_id: 't1', meta: { toolName: 'pod_exec' } }] };
    const history: any[] = [
      untouched,
      { role: 'assistant', toolUses: [{ id: 't1', name: 'pod_exec', input: { command: 'ls' } }, { id: 't2', name: 'pod_status', input: {} }] },
      result,
    ];
    const projected = projectSandboxHistory('pod', history);
    expect(projected[0]).toBe(untouched);
    // Result metadata follows the same names, symmetrically with the way out.
    expect(projected[2].toolResults[0].meta.toolName).toBe('sandbox_exec');
    expect(result.toolResults[0].meta.toolName).toBe('pod_exec');
    expect(projected[1].toolUses).toEqual([
      { id: 't1', name: 'sandbox_exec', input: { command: 'ls' } },
      { id: 't2', name: 'pod_status', input: {} },
    ]);
    expect(history[1].toolUses[0].name).toBe('pod_exec');
    expect(projectSandboxHistory('pod', projected)).toEqual(projected);
  });

  test('everything leaving the worker is canonical again; a refused verb keeps its name', () => {
    const turn = [{ role: 'assistant', toolUses: [
      { id: 'a', name: 'sandbox_exec', input: { cmd: 'ls' } },
      { id: 'b', name: 'sandbox_read', input: { path: '/x' } },
      { id: 'c', name: 'vm_import', input: {} },
    ] }];
    expect(canonicalSandboxHistory('webvm', turn)[0].toolUses.map((use: any) => use.name))
      .toEqual(['vm_boot', 'sandbox_read', 'vm_import']);
    // Round trip: projecting and canonicalizing returns the stored form.
    const stored = [{ role: 'assistant', toolUses: [{ id: 'a', name: 'js_notebook', input: {} }] }];
    expect(canonicalSandboxHistory('notebook', projectSandboxHistory('notebook', stored))).toEqual(stored);
    expect(canonicalSandboxHistory('web', turn)).toEqual(turn);
  });

  test('loop events leave with canonical tool names, including a state snapshot', () => {
    const use = { type: 'tool-use', sessionId: 's', messageId: 'm', toolUseId: 't', name: 'sandbox_write', input: {} };
    expect(canonicalSandboxLoopEvent('pod', use)).toEqual({ ...use, name: 'pod_write' });
    const state = {
      type: 'state',
      session: {
        sessionId: 's',
        messages: [
          { role: 'assistant', toolUses: [{ id: 't', name: 'sandbox_exec', input: {} }] },
          { role: 'user', toolResults: [{ tool_use_id: 't', meta: { toolName: 'sandbox_exec' } }] },
        ],
        trimSummary: { covered: 3, tools: { sandbox_exec: 2, pod_status: 1, pod_exec: 1 } },
      },
    };
    const out: any = canonicalSandboxLoopEvent('pod', state);
    expect(out.session.messages[0].toolUses[0].name).toBe('pod_exec');
    expect(out.session.messages[1].toolResults[0].meta.toolName).toBe('pod_exec');
    expect(out.session.trimSummary).toEqual({ covered: 3, tools: { pod_exec: 3, pod_status: 1 } });
    // A loop-built failure result names the tool the model used; it leaves canonical.
    const failed = { type: 'tool-result', sessionId: 's', toolUseId: 't', result: { ok: false, meta: { toolName: 'sandbox_write' } } };
    expect((canonicalSandboxLoopEvent('pod', failed) as any).result.meta.toolName).toBe('pod_write');
    const delta = { type: 'delta', sessionId: 's', messageId: 'm', text: 'sandbox_write' };
    expect(canonicalSandboxLoopEvent('pod', delta)).toBe(delta);
    expect(canonicalSandboxLoopEvent('web', use)).toBe(use);
  });
});
