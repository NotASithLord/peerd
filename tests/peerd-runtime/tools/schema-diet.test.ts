// Schema diet (tool-ergonomics design 6a): the three dominant tools' every-turn
// descriptors (name + description + schema) were trimmed by MOVING reference
// prose off the always-on main surface — message_actor's schema prose into its
// description, script's peerd:std/wasi reference into the once-per-session
// SCRIPT_BUILTINS_NOTE (kept out of JS_PITFALLS_NOTE, which also rides the
// notebook actor's every-turn prompt), sandbox_create's per-kind how-to into
// the create-result
// notes. NO field/mode/capability was removed. These pin the achieved sizes and
// assert the net main-surface delta is meaningfully negative, and that every
// message_actor field the tool's execute() reads still exists in the schema.

import { describe, test, expect } from 'bun:test';

// The shared test bootstrap provides the browser identity required by the
// sandbox_create import graph. Do not replace it here: browser-api.js binds the
// object by identity, so a file-local replacement can poison later suites.
const { messageActorTool } = await import('../../../extension/peerd-runtime/tools/defs/message-actor.js');
const { scriptTool } = await import('../../../extension/peerd-runtime/tools/defs/script.js');
const { sandboxCreateTool } = await import('../../../extension/peerd-runtime/tools/defs/sandbox-create.js');
const { APP_RUNTIME_NOTE, JS_PITFALLS_NOTE, SCRIPT_BUILTINS_NOTE } = await import('../../../extension/peerd-runtime/tools/defs/code-style-note.js');
const { getToolMetadata } = await import('../../../extension/peerd-runtime/semantic.js');

const messageActorMetadata = getToolMetadata(messageActorTool.name);
const scriptMetadata = getToolMetadata(scriptTool.name);
const sandboxCreateMetadata = getToolMetadata(sandboxCreateTool.name);

const descriptorChars = (t: any) =>
  (t.name || '').length + (t.description || '').length + JSON.stringify(t.schema || {}).length;

// The pre-diet baseline (measured on the batch-base commit) — the scorecard the
// diet must beat. Kept as literals so a regression that re-inflates a descriptor
// trips the test with the exact number to explain.
const BASELINE = { message_actor: 4454, script: 3337, sandbox_create: 2293 };
const BASELINE_SUM = BASELINE.message_actor + BASELINE.script + BASELINE.sandbox_create; // 10084

describe('schema diet — descriptor sizes dropped, no capability lost', () => {
  test('message_actor schema is under the ~1200-char target (was 2561)', () => {
    const schemaChars = JSON.stringify(messageActorMetadata.schema).length;
    expect(schemaChars).toBeLessThan(1200);
    // and the whole descriptor shrank vs baseline
    expect(descriptorChars(messageActorMetadata)).toBeLessThan(BASELINE.message_actor);
  });

  test('message_actor keeps EVERY field its execute() reads (no capability loss)', () => {
    const props = (messageActorMetadata.schema as any).properties;
    // execute() reads args.to, args.message, args.oneShot, args.await
    for (const field of ['to', 'message', 'oneShot', 'await']) {
      expect(props[field]).toBeDefined();
    }
    expect((messageActorMetadata.schema as any).required).toEqual(['to', 'message']);
  });

  test('script description shrank; the peerd:std/wasi reference MOVED to the once-per-session note', () => {
    expect(scriptMetadata.description.length).toBeLessThan(BASELINE.script - 400);
    // the runWasi signature + the parsing helpers left the every-turn description…
    expect(scriptMetadata.description).not.toContain('runWasi(bytes');
    // …and landed in SCRIPT_BUILTINS_NOTE (script-only, disclosed once per session
    // on the first run — kept OUT of JS_PITFALLS_NOTE so it doesn't grow the
    // Notebook actor's every-turn prompt; invariant #2).
    expect(SCRIPT_BUILTINS_NOTE).toContain('runWasi(bytes');
    expect(SCRIPT_BUILTINS_NOTE).toContain('parseCsv');
    expect(SCRIPT_BUILTINS_NOTE).toContain('demoModule()');
    // JS_PITFALLS_NOTE rides the Notebook actor's per-turn system prompt, so the
    // moved reference must NOT be in it (would be unpaid always-on growth).
    expect(JS_PITFALLS_NOTE).not.toContain('runWasi(bytes');
    expect(JS_PITFALLS_NOTE).not.toContain('parseCsv');
  });

  test('sandbox_create description shrank (per-kind how-to moved to create-result notes)', () => {
    expect(sandboxCreateMetadata.description.length).toBeLessThan(BASELINE.sandbox_create - 200);
    // still routes all four kinds (the taxonomy the model picks from stays)
    for (const kind of ['webvm', 'notebook', 'pod', 'app']) {
      expect(sandboxCreateMetadata.description).toContain(`"${kind}"`);
    }
    expect(sandboxCreateMetadata.description).toContain('NO ambient network');
    expect(APP_RUNTIME_NOTE).toContain('NO ambient network');
    expect(APP_RUNTIME_NOTE).toContain('consent-gated parent dweb bridge');
  });

  test('net main-surface delta across the three tools is meaningfully negative', () => {
    const sum = descriptorChars(messageActorMetadata)
      + descriptorChars(scriptMetadata)
      + descriptorChars(sandboxCreateMetadata);
    expect(sum).toBeLessThan(BASELINE_SUM);
    // a real diet, not a rounding win: at least ~1500 chars off the main surface
    expect(BASELINE_SUM - sum).toBeGreaterThan(1500);
  });
});
