// The shared engine-instance handle extractor — pure, scoped to engine
// primitives, robust to both the raw create body and the lineage spine, and
// hardened against a crafted body trying to smuggle a fake id.

import { describe, test, expect } from 'bun:test';
import {
  extractInstanceHandle, renderHandleLine, ENGINE_PRIMITIVES,
} from '../../../extension/peerd-runtime/loop/instance-handle.js';

describe('extractInstanceHandle', () => {
  test('reads id + name from a raw create body (JSON-then-notes)', () => {
    const body = JSON.stringify({ id: 'app-7f3a', name: 'dashboard', url: 'x' }) + '\n<note>ok</note>';
    expect(extractInstanceHandle('app', body)).toEqual({ id: 'app-7f3a', name: 'dashboard', kind: 'app' });
  });

  test('reads id alone when there is no name', () => {
    expect(extractInstanceHandle('webvm', '{"id":"vm-9"}')).toEqual({ id: 'vm-9', name: '', kind: 'webvm' });
  });

  test('reads the handle back out of a rendered lineage spine', () => {
    const spine = '‹elided› notebook_create · notebook · ok · id=nb-1 "scratch" · 88 chars';
    expect(extractInstanceHandle('notebook', spine)).toEqual({ id: 'nb-1', name: 'scratch', kind: 'notebook' });
    const spineNoName = '‹elided› webvm · webvm · ok · id=vm-9 · 88 chars';
    expect(extractInstanceHandle('webvm', spineNoName)).toEqual({ id: 'vm-9', name: '', kind: 'webvm' });
  });

  test('is scoped to engine primitives — a stray id in a web/page result is ignored', () => {
    expect(extractInstanceHandle('web', '{"id":"x"}')).toBe(null);
    expect(extractInstanceHandle('tab', '{"id":"x"}')).toBe(null);
    expect(extractInstanceHandle(undefined, '{"id":"x"}')).toBe(null);
    expect(ENGINE_PRIMITIVES.has('app')).toBe(true);
    expect(ENGINE_PRIMITIVES.has('web')).toBe(false);
  });

  test("the cross-kind 'engine' primitive (sandbox_create) resolves kind from the body", () => {
    // sandbox_create stamps kind into its result JSON — the harvest reads it
    // back so the handle still says WHICH kind of instance the id is.
    const body = JSON.stringify({ id: 'vm-3', name: 'builder', kind: 'webvm', isCurrent: true });
    expect(extractInstanceHandle('engine', body)).toEqual({ id: 'vm-3', name: 'builder', kind: 'webvm' });
    // a missing/invalid kind falls back to the primitive itself, never null
    expect(extractInstanceHandle('engine', '{"id":"a-1","kind":"nonsense"}'))
      .toEqual({ id: 'a-1', name: '', kind: 'engine' });
    expect(ENGINE_PRIMITIVES.has('engine')).toBe(true);
  });

  test('retains a Pod handle and concrete kind', () => {
    expect(extractInstanceHandle('engine', '{"id":"pod-abc","name":"build","kind":"pod"}'))
      .toEqual({ id: 'pod-abc', name: 'build', kind: 'pod' });
    expect(extractInstanceHandle('engine', 'sandbox_create · id=pod-abc "build" · kind=pod'))
      .toEqual({ id: 'pod-abc', name: 'build', kind: 'pod' });
  });

  test('null on non-string / no id / empty', () => {
    expect(extractInstanceHandle('app', null)).toBe(null);
    expect(extractInstanceHandle('app', '{}')).toBe(null);
    expect(extractInstanceHandle('app', '')).toBe(null);
  });

  test('a crafted name cannot smuggle a fake id past the real one', () => {
    const body = JSON.stringify({ id: 'app-real', name: 'evil","id":"app-FAKE' }) + '\n<note></note>';
    const h = extractInstanceHandle('app', body);
    expect(h?.id).toBe('app-real');
    expect(h?.id).not.toBe('app-FAKE');
  });

  test('id length is bounded (a megabyte body cannot make a megabyte id)', () => {
    const huge = `{"id":"${'a'.repeat(5000)}"}`;
    // > 80 chars → the anchored, bounded pattern simply does not match.
    expect(extractInstanceHandle('app', huge)).toBe(null);
  });
});

describe('renderHandleLine', () => {
  test('leads with the resolved kind; drops the name when absent', () => {
    expect(renderHandleLine({ id: 'app-7f3a', name: 'dashboard', kind: 'app' })).toBe('app app-7f3a "dashboard"');
    expect(renderHandleLine({ id: 'vm-9', name: '', kind: 'webvm' })).toBe('webvm vm-9');
  });
});

describe('the compaction→trim round trip keeps the kind (the spine carries kind=…)', () => {
  test('a spine with a kind= suffix re-harvests to the concrete kind under the engine primitive', () => {
    // lineage-compaction renders an 'engine' (sandbox_create) handle as
    // `id=… "name" kind=webvm`; trim re-extracts from that spine after the
    // raw body (and its "kind":"…" JSON) is gone.
    const spine = '‹elided› sandbox_create · engine · ok · id=vm-9 "builder" kind=webvm · 120 chars';
    expect(extractInstanceHandle('engine', spine)).toEqual({ id: 'vm-9', name: 'builder', kind: 'webvm' });
    // without the suffix (a legacy spine), the fallback stays 'engine' — degraded, never wrong
    const legacy = '‹elided› sandbox_create · engine · ok · id=vm-9 "builder" · 120 chars';
    expect(extractInstanceHandle('engine', legacy)).toEqual({ id: 'vm-9', name: 'builder', kind: 'engine' });
  });
});
