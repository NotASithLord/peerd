import { describe, expect, test } from 'bun:test';
import {
  detachDebuggerWithCustody,
  enableDebuggerWithCustody,
  makeDebuggerNavigationGuard,
} from '../../extension/background/debugger-custody.js';

describe('debugger document custody', () => {
  test('a public to private navigation detaches the pooled session immediately', async () => {
    const detached: number[] = [];
    const guard = makeDebuggerNavigationGuard({
      isAttached: (tabId) => tabId === 7,
      detach: async (tabId) => { detached.push(tabId); },
    });

    guard(7, { status: 'loading', url: 'http://127.0.0.1/admin' });
    await Promise.resolve();
    expect(detached).toEqual([7]);
  });

  test('metadata-only updates do not disturb a checked document', async () => {
    const detached: number[] = [];
    const guard = makeDebuggerNavigationGuard({
      isAttached: () => true,
      detach: async (tabId) => { detached.push(tabId); },
    });

    guard(7, { status: 'complete' });
    await Promise.resolve();
    expect(detached).toEqual([]);
  });
});

describe('debugger attachment custody', () => {
  test('a Runtime setup failure clears custody only after confirmed cleanup', async () => {
    let attached = false;
    await expect(enableDebuggerWithCustody({
      enable: async () => { throw new Error('Runtime unavailable'); },
      detach: async () => {},
      markAttached: () => { attached = true; },
      clearAttached: () => { attached = false; },
      markQuarantined: () => {},
      clearQuarantined: () => {},
    })).rejects.toThrow('Runtime unavailable');
    expect(attached).toBe(false);
  });

  test('a failed Runtime cleanup keeps the live attachment visible', async () => {
    let attached = false;
    await expect(enableDebuggerWithCustody({
      enable: async () => { throw new Error('Runtime unavailable'); },
      detach: async () => { throw new Error('detach failed'); },
      markAttached: () => { attached = true; },
      clearAttached: () => { attached = false; },
      markQuarantined: () => {},
      clearQuarantined: () => {},
    })).rejects.toThrow('Runtime unavailable');
    expect(attached).toBe(true);
  });

  test('a failed explicit detach retains custody for retry', async () => {
    let attached = true;
    await expect(detachDebuggerWithCustody({
      detach: async () => { throw new Error('detach failed'); },
      clearCustody: () => { attached = false; },
    })).rejects.toThrow('detach failed');
    expect(attached).toBe(true);
  });
});
