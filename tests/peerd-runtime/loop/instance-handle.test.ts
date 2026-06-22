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
    expect(extractInstanceHandle('app', body)).toEqual({ id: 'app-7f3a', name: 'dashboard' });
  });

  test('reads id alone when there is no name', () => {
    expect(extractInstanceHandle('webvm', '{"id":"vm-9"}')).toEqual({ id: 'vm-9', name: '' });
  });

  test('reads the handle back out of a rendered lineage spine', () => {
    const spine = '‹elided› notebook_create · notebook · ok · id=nb-1 "scratch" · 88 chars';
    expect(extractInstanceHandle('notebook', spine)).toEqual({ id: 'nb-1', name: 'scratch' });
    const spineNoName = '‹elided› webvm · webvm · ok · id=vm-9 · 88 chars';
    expect(extractInstanceHandle('webvm', spineNoName)).toEqual({ id: 'vm-9', name: '' });
  });

  test('is scoped to engine primitives — a stray id in a web/page result is ignored', () => {
    expect(extractInstanceHandle('web', '{"id":"x"}')).toBe(null);
    expect(extractInstanceHandle('tab', '{"id":"x"}')).toBe(null);
    expect(extractInstanceHandle(undefined, '{"id":"x"}')).toBe(null);
    expect(ENGINE_PRIMITIVES.has('app')).toBe(true);
    expect(ENGINE_PRIMITIVES.has('web')).toBe(false);
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
  test('leads with the primitive; drops the name when absent', () => {
    expect(renderHandleLine('app', { id: 'app-7f3a', name: 'dashboard' })).toBe('app app-7f3a "dashboard"');
    expect(renderHandleLine('webvm', { id: 'vm-9', name: '' })).toBe('webvm vm-9');
  });
});
