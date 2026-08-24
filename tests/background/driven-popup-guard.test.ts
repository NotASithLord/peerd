import { describe, expect, test } from 'bun:test';
import {
  makeDrivenPopupGuard,
  popupSourceState,
} from '../../extension/background/driven-popup-guard.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('driven popup network guard', () => {
  test('source ownership stays unknown until browser-session custody hydrates', () => {
    expect(popupSourceState(7, [], false)).toBe('unknown');
    expect(popupSourceState(7, [], true)).toBe('user');
    expect(popupSourceState(7, [7], false)).toBe('driven');
  });

  test('blanks, guards, and resumes a public child of an exact driven source', async () => {
    const events: string[] = [];
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'driven',
      neutralize: async () => { events.push('blank'); },
      adoptFromSource: async (sourceTabId, childTabId) => {
        events.push(`guard:${sourceTabId}:${childTabId}`);
        return { ok: true, adopted: true };
      },
      classifyTarget: () => ({ allowed: true }),
      onGuarded: ({ sourceTabId, tabId }) => { events.push(`release:${sourceTabId}:${tabId}`); },
      resume: async (_tabId, url) => { events.push(`resume:${url}`); },
    });

    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'https://example.com/popup' });
    await tick();
    expect(events).toEqual([
      'blank',
      'guard:7:9',
      'resume:https://example.com/popup',
      'release:7:9',
    ]);
  });

  test('the event receipt remains pending until child custody and resume settle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'driven',
      neutralize: async () => {},
      adoptFromSource: async () => { await gate; return { ok: true, adopted: true }; },
      classifyTarget: () => ({ allowed: true }),
      resume: async () => {},
    });
    const receipt = guard.onNavigationTarget({
      sourceTabId: 7, tabId: 9, url: 'https://example.com/popup',
    });
    let settled = false;
    void receipt?.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    release();
    await receipt;
    expect(settled).toBe(true);
  });

  test('never changes a child of a positively user-owned source', async () => {
    const events: string[] = [];
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'user',
      neutralize: async () => { events.push('blank'); },
      adoptFromSource: async () => { events.push('guard'); return { ok: true, adopted: true }; },
      classifyTarget: () => ({ allowed: true }),
      resume: async () => { events.push('resume'); },
    });

    guard.onCreated({ id: 9, openerTabId: 7, pendingUrl: 'http://127.0.0.1/private' });
    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'http://127.0.0.1/private' });
    await tick();
    expect(events).toEqual([]);
  });

  test('queues unknown startup ownership without blanking a user child', async () => {
    const events: string[] = [];
    let state: 'unknown'|'user'|'driven' = 'unknown';
    const guard = makeDrivenPopupGuard({
      sourceState: () => state,
      neutralize: async () => { events.push('blank'); },
      adoptFromSource: async () => { events.push('guard'); return { ok: true, adopted: true }; },
      classifyTarget: () => ({ allowed: true }),
      resume: async () => { events.push('resume'); },
    });

    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'https://example.com/' });
    await tick();
    expect(events).toEqual([]);
    state = 'user';
    guard.onBootReady();
    await tick();
    expect(events).toEqual([]);
  });

  test('guards a queued startup child once its source hydrates as driven', async () => {
    const events: string[] = [];
    let state: 'unknown'|'driven' = 'unknown';
    const guard = makeDrivenPopupGuard({
      sourceState: () => state,
      neutralize: async () => { events.push('blank'); },
      adoptFromSource: async () => { events.push('guard'); return { ok: true, adopted: true }; },
      classifyTarget: () => ({ allowed: true }),
      resume: async () => { events.push('resume'); },
    });

    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'https://example.com/' });
    state = 'driven';
    guard.onBootReady();
    await tick();
    expect(events).toEqual(['blank', 'guard', 'resume']);
  });

  test('uses surviving exact-source rules before touching a cold-start child', async () => {
    const events: string[] = [];
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'unknown',
      adoptUnknownFromSource: async (sourceTabId, childTabId) => {
        events.push(`startup-guard:${sourceTabId}:${childTabId}`);
        return true;
      },
      neutralize: async () => { events.push('blank'); },
      adoptFromSource: async () => { events.push('durable-guard'); return { ok: true, adopted: true }; },
      classifyTarget: () => ({ allowed: true }),
      resume: async () => { events.push('resume'); },
    });

    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'https://example.com/' });
    await tick();
    await tick();
    expect(events).toEqual([
      'startup-guard:7:9',
      'blank',
      'durable-guard',
      'resume',
    ]);
  });

  test('an absent startup rule proof still leaves an unknown user child untouched', async () => {
    const events: string[] = [];
    let state: 'unknown'|'user' = 'unknown';
    const guard = makeDrivenPopupGuard({
      sourceState: () => state,
      adoptUnknownFromSource: async () => { events.push('check'); return false; },
      neutralize: async () => { events.push('blank'); },
      adoptFromSource: async () => { events.push('guard'); return { ok: true, adopted: true }; },
      classifyTarget: () => ({ allowed: true }),
      resume: async () => { events.push('resume'); },
    });

    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'https://example.com/' });
    await tick();
    expect(events).toEqual(['check']);
    state = 'user';
    guard.onBootReady();
    await tick();
    expect(events).toEqual(['check']);
  });

  test('closes a child if exact source custody disappears during adoption', async () => {
    const events: string[] = [];
    const failed: any[] = [];
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'driven',
      neutralize: async () => { events.push('blank'); },
      close: async () => { events.push('close'); },
      adoptFromSource: async () => ({ ok: true, adopted: false }),
      classifyTarget: () => ({ allowed: true }),
      onFailed: (event) => { failed.push(event); },
      resume: async () => { events.push('resume'); },
    });

    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'https://example.com/' });
    await tick();
    expect(events).toEqual(['blank', 'close']);
    expect(failed).toEqual([{
      sourceTabId: 7, tabId: 9, reason: 'child_guard_failed', child: 'closed', guarded: false,
    }]);
  });

  test('closes a protected child and emits only a fixed reason', async () => {
    const events: string[] = [];
    const blocked: any[] = [];
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'driven',
      neutralize: async () => { events.push('blank'); },
      close: async () => { events.push('close'); },
      adoptFromSource: async () => { events.push('guard'); return { ok: true, adopted: true }; },
      classifyTarget: () => ({ allowed: false, reason: 'private_network' }),
      onBlocked: (event) => { blocked.push(event); },
      resume: async () => { events.push('resume'); },
    });

    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'http://127.0.0.1/secret' });
    await tick();
    expect(events).toEqual(['blank', 'guard', 'close']);
    expect(blocked).toEqual([{
      sourceTabId: 7, tabId: 9, reason: 'private_network', child: 'closed', guarded: true,
      outcome: 'not_run',
    }]);
    expect(JSON.stringify(blocked)).not.toContain('127.0.0.1');
  });

  test('reports and closes a public child that cannot resume', async () => {
    const events: string[] = [];
    const failed: any[] = [];
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'driven',
      neutralize: async () => { events.push('blank'); },
      close: async () => { events.push('close'); },
      adoptFromSource: async () => ({ ok: true, adopted: true }),
      classifyTarget: () => ({ allowed: true }),
      onFailed: (event) => { failed.push(event); },
      resume: async () => { throw new Error('tab closed'); },
    });

    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'https://example.com/' });
    await tick();
    await tick();
    expect(events).toEqual(['blank', 'close']);
    expect(failed).toEqual([{
      sourceTabId: 7, tabId: 9, reason: 'child_resume_failed', child: 'closed', guarded: true,
    }]);
  });

  test('reports a guarded child whose destination stays unverified', async () => {
    const blank: any[] = [];
    let reportBlank = () => {};
    const blankReported = new Promise<void>((resolve) => { reportBlank = resolve; });
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'driven',
      neutralize: async () => {},
      adoptFromSource: async () => ({ ok: true, adopted: true }),
      classifyTarget: () => ({ allowed: true }),
      onBlank: (event) => { blank.push(event); reportBlank(); },
      blankDelayMs: 1,
      resume: async () => {},
    });

    guard.onCreated({ id: 9, openerTabId: 7, url: 'about:blank' });
    await blankReported;
    expect(blank).toEqual([{
      sourceTabId: 7, tabId: 9, reason: 'child_destination_unverified', child: 'left_blank', guarded: true,
    }]);
  });

  test('reports an uncontained child when close and blank both fail', async () => {
    const events: string[] = [];
    const blocked: any[] = [];
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'driven',
      neutralize: async () => { events.push('blank'); throw new Error('update rejected'); },
      close: async () => { events.push('close'); throw new Error('remove rejected'); },
      adoptFromSource: async () => { events.push('guard'); return { ok: true, adopted: true }; },
      classifyTarget: () => ({ allowed: false, reason: 'private_network' }),
      onBlocked: (event) => { blocked.push(event); },
      resume: async () => {},
    });

    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'http://127.0.0.1/secret' });
    await tick();
    await tick();
    expect(events).toEqual(['blank', 'guard', 'close', 'blank']);
    expect(blocked).toEqual([{
      sourceTabId: 7, tabId: 9, reason: 'private_network', child: 'uncontained', guarded: true,
      outcome: 'unverified',
    }]);
  });

  test('recovers Firefox destination ordering without duplicate adoption', async () => {
    const events: string[] = [];
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'driven',
      neutralize: async () => { events.push('blank'); },
      adoptFromSource: async () => { events.push('guard'); return { ok: true, adopted: true }; },
      classifyTarget: () => ({ allowed: true }),
      resume: async (_tabId, url) => { events.push(`resume:${url}`); },
    });

    guard.onCreated({ id: 9, openerTabId: 7, url: 'about:blank' });
    await tick();
    expect(events).toEqual(['blank', 'guard']);
    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'https://example.com/late' });
    await tick();
    expect(events).toEqual(['blank', 'guard', 'resume:https://example.com/late']);
  });

  test('deduplicates navigation-target before tabs.onCreated', async () => {
    const events: string[] = [];
    const guard = makeDrivenPopupGuard({
      sourceState: () => 'driven',
      neutralize: async () => { events.push('blank'); },
      adoptFromSource: async () => { events.push('guard'); return { ok: true, adopted: true }; },
      classifyTarget: () => ({ allowed: true }),
      resume: async (_tabId, url) => { events.push(`resume:${url}`); },
    });

    guard.onNavigationTarget({ sourceTabId: 7, tabId: 9, url: 'https://example.com/early' });
    await tick();
    guard.onCreated({ id: 9, openerTabId: 7, url: 'about:blank' });
    await tick();
    expect(events).toEqual(['blank', 'guard', 'resume:https://example.com/early']);
  });
});
