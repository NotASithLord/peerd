import { describe, expect, test } from 'bun:test';
import { recoverMirrorState } from '../../extension/engine-tabs/notebook-tab/mirror-state.js';

describe('Notebook mirror recovery', () => {
  test('recovers a replacement that saved before its marker committed', () => {
    const saved = JSON.stringify({ pending: true, code: 'agent next', originalCode: 'user draft', previousCode: null });
    expect(recoverMirrorState(saved, 'agent next')).toEqual({ code: 'agent next' });
    expect(recoverMirrorState(saved, 'user draft')).toBeNull();
  });
  test('an unstarted agent replacement keeps the previous agent identity', () => {
    const saved = JSON.stringify({ pending: true, code: 'next', originalCode: 'prior', previousCode: 'prior' });
    expect(recoverMirrorState(saved, 'prior')).toEqual({ code: 'prior' });
  });
  test('unknown images and old incomplete markers remain fail closed', () => {
    expect(() => recoverMirrorState('{"pending":true}', 'draft')).toThrow();
    expect(() => recoverMirrorState(JSON.stringify({ pending: true, code: 'next', originalCode: 'prior', previousCode: null }), 'torn')).toThrow();
  });
  test('ordinary completed markers keep their identity', () => {
    expect(recoverMirrorState(null, 'draft')).toBeNull();
    expect(recoverMirrorState('{"code":"prior"}', 'edited')).toEqual({ code: 'prior' });
  });
});
