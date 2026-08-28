// Tool → retry class: the derivation rules, and §16.1's inventory obligation
// ("every side-effecting tool has a retry classification") asserted against the
// REAL authority inventory rather than a hand-copied one — so a new tool
// that lands without a considered class fails here, not in production recovery.

import { describe, test, expect } from 'bun:test';
import {
  retryClassForTool, RETRY_CLASS_OVERRIDES,
} from '../../../extension/peerd-runtime/lifecycle/tool-retry-class.js';
import { isRetryClass } from '../../../extension/peerd-runtime/lifecycle/retry-class.js';

import { listToolAuthorities } from '../../../extension/peerd-runtime/tools/metadata/authority.js';

/** The whole compact authority inventory the SW installs at boot. */
const ALL_TOOLS = listToolAuthorities();

const byName = new Map(ALL_TOOLS.map((t) => [t.name, t] as const));

const classOf = (name: string): string => {
  const tool = byName.get(name);
  if (!tool) throw new Error(`no controller tool named ${name}`);
  return retryClassForTool(tool);
};

describe('explicit declaration precedence', () => {
  test('a valid explicit retryClass wins over every derivation', () => {
    // A tab click would derive E; the def says A, and the def is honoured.
    expect(retryClassForTool({
      name: 'click', sideEffect: 'write', primitive: 'tab', retryClass: 'A',
    })).toBe('A');
    expect(retryClassForTool({
      name: 'inspect', sideEffect: 'read', primitive: 'inspect', retryClass: 'F',
    })).toBe('F');
  });

  test('an INVALID explicit retryClass is ignored, never coerced — derivation still runs', () => {
    // Garbage that looked authoritative must not license a replay: it falls
    // through to the taxonomy, which here says "pure read".
    expect(retryClassForTool({
      name: 'read_page', sideEffect: 'read', primitive: 'tab', retryClass: 'Z',
    })).toBe('A');
    // …and on a non-read the fallthrough is the closed one.
    expect(retryClassForTool({
      name: 'submit', sideEffect: 'mutate_external', primitive: 'tab', retryClass: 'Z',
    })).toBe('E');
    for (const junk of ['', 'a', 'AA', 3, null, {}, [], true]) {
      expect(retryClassForTool({
        name: 'x', sideEffect: 'write', primitive: 'tab', retryClass: junk,
      })).toBe('E');
    }
  });
});

describe('derivation from the declared taxonomy', () => {
  test('an unnamed read is Class A — local reads cost nothing to repeat', () => {
    expect(retryClassForTool({ name: 'inspect', sideEffect: 'read', primitive: 'inspect' })).toBe('A');
    expect(retryClassForTool({ name: 'anything', sideEffect: 'read', primitive: 'web' })).toBe('A');
  });

  test('a named network read is Class B — repeatable, but it spends something', () => {
    expect(retryClassForTool({ name: 'fetch_url', sideEffect: 'read', primitive: 'web' })).toBe('B');
    expect(retryClassForTool({ name: 'read_doc', sideEffect: 'read', primitive: 'web' })).toBe('B');
  });

  test('a write on a workspace primitive is Class C', () => {
    for (const primitive of ['webvm', 'notebook', 'pod', 'app', 'engine', 'dweb']) {
      expect(retryClassForTool({ name: 'w', sideEffect: 'write', primitive })).toBe('C');
    }
  });

  test('a write on a tab primitive is Class E — a click on a live page is not idempotent', () => {
    expect(retryClassForTool({ name: 'w', sideEffect: 'write', primitive: 'tab' })).toBe('E');
  });

  test('a write on any other primitive fails CLOSED to Class E', () => {
    for (const primitive of ['web', 'spawned', 'memory', 'schedule', 'time', 'nonsense', '']) {
      expect(retryClassForTool({ name: 'w', sideEffect: 'write', primitive })).toBe('E');
    }
  });

  test('mutate_external is Class E by default, Class D only where named', () => {
    expect(retryClassForTool({ name: 'w', sideEffect: 'mutate_external', primitive: 'dweb' })).toBe('E');
    expect(retryClassForTool({ name: 'dweb_share', sideEffect: 'mutate_external', primitive: 'dweb' })).toBe('D');
  });

  test('destructive is Class E, and no name override can soften it', () => {
    expect(retryClassForTool({ name: 'w', sideEffect: 'destructive', primitive: 'app' })).toBe('E');
    // fetch_url is a Class B name; declared destructive it is still E.
    expect(retryClassForTool({ name: 'fetch_url', sideEffect: 'destructive', primitive: 'web' })).toBe('E');
    expect(retryClassForTool({ name: 'dweb_share', sideEffect: 'destructive', primitive: 'dweb' })).toBe('E');
  });
});

describe('garbage in, Class E out', () => {
  test('null / undefined / non-objects / empty descriptors all fail closed', () => {
    expect(retryClassForTool(null)).toBe('E');
    expect(retryClassForTool(undefined)).toBe('E');
    expect(retryClassForTool({})).toBe('E');
    for (const junk of [42, 'fetch_url', true, Symbol('x')]) {
      expect(retryClassForTool(junk as unknown as { name?: string })).toBe('E');
    }
  });

  test('an unknown sideEffect is not a read', () => {
    expect(retryClassForTool({ name: 'mystery', sideEffect: 'reads', primitive: 'inspect' })).toBe('E');
    expect(retryClassForTool({ name: 'mystery', primitive: 'inspect' })).toBe('E');
  });
});

describe('§16.1 — the whole controller inventory is classified', () => {
  test('the inventory actually loaded', () => {
    expect(ALL_TOOLS.length).toBeGreaterThan(50);
    expect(byName.size).toBe(ALL_TOOLS.length);
  });

  test('EVERY controller tool resolves to a valid retry class', () => {
    const unclassified = ALL_TOOLS
      .map((tool) => [tool.name, retryClassForTool(tool)] as const)
      .filter(([, cls]) => !isRetryClass(cls));
    expect(unclassified).toEqual([]);
  });

  test('no side-effecting tool is classified as a retry-freely READ class', () => {
    const readClasses = new Set(['A', 'B']);
    const offenders = ALL_TOOLS
      .filter((tool) => tool.sideEffect !== 'read')
      .filter((tool) => readClasses.has(retryClassForTool(tool)))
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });

  test('every destructive tool lands on Class E', () => {
    const destructive = ALL_TOOLS.filter((tool) => tool.sideEffect === 'destructive');
    expect(destructive.length).toBeGreaterThan(0);
    for (const tool of destructive) expect(retryClassForTool(tool)).toBe('E');
  });

  test('the override table has no dead entries — every name is a controller tool', () => {
    const dead = Object.keys(RETRY_CLASS_OVERRIDES).filter((name) => !byName.has(name));
    expect(dead).toEqual([]);
  });

  test('the override table is frozen', () => {
    expect(Object.isFrozen(RETRY_CLASS_OVERRIDES)).toBe(true);
  });
});

describe('spot checks against the real defs', () => {
  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    // A — local reads; a duplicate is invisible.
    ['inspect', 'A'],
    ['read_page', 'A'],
    ['read_result', 'A'],
    ['now', 'A'],
    // B — reads that cross the network.
    ['fetch_url', 'B'],
    ['dweb_discover', 'B'],
    // C — deterministic local workspace writes.
    ['js_write_file', 'C'],
    ['pod_write', 'C'],
    ['vm_write_file', 'C'],
    ['app_write_file', 'C'],
    ['dweb_block', 'C'],
    // D — content-addressed publish: verify, then reuse the key.
    ['dweb_share', 'D'],
    // E — live-page actions, external mutations, arbitrary code, deletes.
    ['click', 'E'],
    ['type', 'E'],
    ['navigate', 'E'],
    ['open_tab', 'E'],
    ['js_notebook', 'E'],
    ['pod_exec', 'E'],
    ['script', 'E'],
    ['app_code', 'E'],
    ['app_act', 'E'],
    ['a2a_run', 'E'],
    ['message_actor', 'E'],
    ['vm_delete', 'E'],
    ['pod_destroy', 'E'],
    ['app_delete', 'E'],
    // F — long-lived resources: recreate, never continue.
    ['sandbox_create', 'F'],
    ['vm_boot', 'F'],
    ['actor_create', 'F'],
  ];

  for (const [name, expected] of EXPECTED) {
    test(`${name} → Class ${expected}`, () => {
      expect(classOf(name)).toBe(expected);
    });
  }
});
