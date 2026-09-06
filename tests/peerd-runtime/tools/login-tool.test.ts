// The `login` tool's GATE, driven with a fake ctx (mirrors how the other tool
// tests build one). These assert the security contract the pure classifier can't:
// origin fail-closed (https only), the inbound refusal, the UNCONDITIONAL confirm
// (called even with a confirmations-off setting present), a decline meaning NO
// click, and that no page-driving happens until after a supported+confirmed verdict.
// The passkey path asserts the Tier-0 assisted-manual posture: origin-verified
// consent, then the gesture is handed to the user — never a trusted auto-click
// (which could be a confused deputy: the read and the CDP click can resolve to
// different nodes) and never a fake synthetic click.

import { describe, test, expect } from 'bun:test';
import { performConfirmedOwnedLoginAuthority } from '../../../extension/background/page-authority/login.js';
import { loginTool as controllerLoginTool } from '../../../extension/peerd-runtime/tools/defs/login.js';

const loginTool = { execute: (args: any, ctx: any) => controllerLoginTool.execute(args, {
  ...ctx,
  pageAuthority: {
    performConfirmedOwnedLogin: () => performConfirmedOwnedLoginAuthority(args, ctx),
  },
}) };
import { HOST_EFFECT_OUTCOME } from '../../../extension/background/host-effect-verdict.js';
import { browserProbeResult } from '../../helpers/browser-scripting.ts';

interface Over {
  descriptor?: Record<string, unknown>;
  readerResult?: unknown;
  clickResult?: unknown;
  confirmAnswer?: unknown;
  domRefs?: unknown;
  debuggerPool?: unknown;
  settings?: Record<string, unknown>;
  inbound?: boolean;
  origin?: string;
  activeTab?: unknown;
  authorizeAnswer?: boolean;
  authorize?: (origin: string, signal?: AbortSignal) => Promise<boolean>;
  excursionAnswer?: boolean;
  authorizeExcursion?: (origin: string, signal?: AbortSignal) => Promise<boolean>;
  revokeExcursion?: (origin: string, signal?: AbortSignal) => Promise<boolean>;
  tabsGet?: (id: number) => Promise<any>;
  probeUrl?: () => string;
  abortSignal?: AbortSignal;
}

const makeCtx = (over: Over = {}) => {
  const calls = {
    execute: [] as any[],
    confirm: [] as any[],
    audit: [] as any[],
    cdp: [] as any[],
    authorize: [] as string[],
    authorizeExcursion: [] as string[],
    revokeExcursion: [] as string[],
  };
  const origin = over.origin ?? 'https://acct.example.com';
  const ctx: any = {
    session: { sessionId: 's1' },
    activeTab: over.activeTab ?? { id: 1, url: `${origin}/login`, origin },
    tabs: { get: over.tabsGet ?? (async (id: number) => ({ id, url: `${origin}/login` })) },
    denylist: [],
    scripting: {
      executeScript: async (opts: any) => {
        const fn = opts?.func?.name;
        // The DOM chokepoint's live probe (issues 267/276) injects once per tool
        // call, BEFORE login's own https/inbound refusals — deliberately, since
        // those are judged against the live resolved tab. It reads nothing back
        // into the turn and drives nothing, so it is not "page-driving" in the
        // sense the counts below pin.
        const probe = browserProbeResult(opts, { url: over.probeUrl?.() ?? `${origin}/login` });
        if (probe) return probe;
        calls.execute.push(opts);
        if (fn === 'loginTargetReader') {
          return [{ result: over.readerResult ?? { ok: true, descriptor: over.descriptor ?? { tag: 'button', name: 'x' } } }];
        }
        if (fn === 'clickInjected') {
          return [{ result: over.clickResult ?? { ok: true, tag: 'button', text: 'Sign in', matchedCount: 1, nth: 0 } }];
        }
        return [{ result: null }];
      },
    },
    confirm: async (p: any) => { calls.confirm.push(p); return over.confirmAnswer ?? 'no'; },
    authorizeSignInOrigin: async (value: string, signal?: AbortSignal) => {
      calls.authorize.push(value);
      if (over.authorize) return over.authorize(value, signal);
      return over.authorizeAnswer ?? true;
    },
    authorizeSignInExcursion: async (value: string, signal?: AbortSignal) => {
      calls.authorizeExcursion.push(value);
      if (over.authorizeExcursion) return over.authorizeExcursion(value, signal);
      return over.excursionAnswer ?? true;
    },
    revokeSignInExcursion: async (value: string, signal?: AbortSignal) => {
      calls.revokeExcursion.push(value);
      if (over.revokeExcursion) return over.revokeExcursion(value, signal);
      return true;
    },
    audit: async (e: any) => { calls.audit.push(e); },
    domRefs: over.domRefs,
    debuggerPool: over.debuggerPool,
    settings: over.settings,
    permission: { mode: 'act', confirmActions: true },
    readAuthorityPermission: async () => ({ mode: 'act', confirmActions: true }),
    inbound: over.inbound,
    abortSignal: over.abortSignal,
    _calls: calls,
  };
  return { ctx, calls };
};

// A supported SSO descriptor by default.
const ssoDescriptor = { tag: 'button', name: 'Sign in with Google' };

describe('login tool — origin fail-closed', () => {
  test('a non-https active origin is refused before any read', async () => {
    const { ctx, calls } = makeCtx({ origin: 'http://acct.example.com', activeTab: { id: 1, url: 'http://acct.example.com/login', origin: 'http://acct.example.com' } });
    const r = await loginTool.execute({ selector: '#signin' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_requires_https_origin');
    expect(calls.execute.length).toBe(0);
    expect(calls.confirm.length).toBe(0);
  });

  test('no target tab → no_target_tab', async () => {
    const { ctx } = makeCtx();
    ctx.tabs.get = async () => { throw new Error('gone'); };
    const r = await loginTool.execute({ selector: '#signin' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('no_target_tab');
  });
});

describe('login tool — inbound defense-in-depth', () => {
  test('an inbound (untrusted) turn cannot start a login', async () => {
    const { ctx, calls } = makeCtx({ inbound: true, descriptor: ssoDescriptor, confirmAnswer: 'yes_once' });
    const r = await loginTool.execute({ selector: '#signin' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_refused_inbound');
    expect(calls.execute.length).toBe(0);
    expect(calls.confirm.length).toBe(0);
  });
});

describe('login tool — verify before confirm; unsupported is graceful', () => {
  test('a password affordance is refused with NO confirm and NO click (no fill)', async () => {
    const { ctx, calls } = makeCtx({ descriptor: { tag: 'input', type: 'password' } });
    const r = await loginTool.execute({ selector: 'input[type=password]' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_unsupported');
    // read happened; NOTHING was confirmed or clicked
    expect(calls.confirm.length).toBe(0);
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);
  });

  test('an unsupported SSO provider (GitHub) is refused gracefully — no click', async () => {
    const { ctx, calls } = makeCtx({ descriptor: { tag: 'button', name: 'Continue with GitHub' } });
    const r = await loginTool.execute({ selector: '#gh' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_unsupported');
    expect(calls.confirm.length).toBe(0);
  });
});

describe('login tool — the confirm is UNCONDITIONAL', () => {
  test('confirm is called even when a confirmActions:false setting is present', async () => {
    const { ctx, calls } = makeCtx({
      descriptor: ssoDescriptor,
      settings: { confirmActions: false },
      confirmAnswer: 'no',
    });
    await loginTool.execute({ selector: '#signin' }, ctx);
    expect(calls.confirm.length).toBe(1);
    // the prompt names the SYSTEM origin and the ground-truth method/provider
    expect(calls.confirm[0].origins).toEqual(['https://acct.example.com']);
    expect(calls.confirm[0].method).toBe('sso');
    expect(String(calls.confirm[0].provider).toLowerCase()).toContain('google');
  });

  test('declining means NO click and login_declined', async () => {
    const { ctx, calls } = makeCtx({ descriptor: ssoDescriptor, confirmAnswer: 'no' });
    const r = await loginTool.execute({ selector: '#signin' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_declined');
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);
    expect(calls.audit.length).toBe(0);
    expect(calls.authorize.length).toBe(0);
  });

  test('confirmation binds the actor to the live relying-site origin', async () => {
    const { ctx, calls } = makeCtx({ descriptor: ssoDescriptor, confirmAnswer: 'yes_once' });
    const r = await loginTool.execute({ selector: '#signin' }, ctx);
    expect(r.ok).toBe(true);
    expect(calls.authorize).toEqual(['https://acct.example.com']);
  });

  test('a refused relying-site boundary performs no click', async () => {
    const { ctx, calls } = makeCtx({
      descriptor: verifiedSsoDescriptor,
      domRefs: walkDomRefs,
      confirmAnswer: 'yes_once',
      authorizeAnswer: false,
    });
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_origin_authority_refused');
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);
  });

  test('Stop during the post-confirm tab read cannot authorize or click', async () => {
    const controller = new AbortController();
    let tabReads = 0;
    const { ctx, calls } = makeCtx({
      descriptor: verifiedSsoDescriptor,
      domRefs: walkDomRefs,
      confirmAnswer: 'yes_once',
      abortSignal: controller.signal,
      tabsGet: async (id) => {
        tabReads += 1;
        if (tabReads === 2) controller.abort();
        return { id, url: 'https://acct.example.com/login' };
      },
    });
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_aborted');
    expect(calls.authorize).toEqual([]);
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);
  });

  test('Stop during origin authorization cannot click', async () => {
    const controller = new AbortController();
    const { ctx, calls } = makeCtx({
      descriptor: verifiedSsoDescriptor,
      domRefs: walkDomRefs,
      confirmAnswer: 'yes_once',
      abortSignal: controller.signal,
      authorize: async () => { controller.abort(); return false; },
    });
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_aborted');
    expect(r).toMatchObject({
      performed: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure',
    });
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled(r)).toBe('not-performed');
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);
  });

  test('Stop after the relying-site origin is durably bound remains performed', async () => {
    const controller = new AbortController();
    const { ctx, calls } = makeCtx({
      descriptor: verifiedSsoDescriptor,
      domRefs: walkDomRefs,
      confirmAnswer: 'yes_once',
      abortSignal: controller.signal,
      authorize: async () => { controller.abort(); return true; },
    });
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r).toMatchObject({
      ok: false, error: 'login_aborted', performed: true,
      outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
    });
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled(r)).toBe('performed');
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);
  });
});

// A VERIFIED SSO descriptor (destination is a known IdP) — the ONLY thing peerd
// auto-clicks, and only with a stable walkId. Name alone is not enough (Fix 2).
const verifiedSsoDescriptor = { tag: 'button', name: 'Sign in with Google', href: 'https://accounts.google.com/o/oauth2/v2/auth' };
const walkDomRefs = { resolve: () => ({ backendDOMNodeId: null, walkId: 5, role: 'button', name: 'Sign in with Google' }) };

describe('login tool — SSO auto-click ONLY for a verified IdP + stable walkId', () => {
  test('verified sso + walkId → re-verifies, clicks the SAME walkId, audits login_initiated', async () => {
    const { ctx, calls } = makeCtx({ descriptor: verifiedSsoDescriptor, domRefs: walkDomRefs, confirmAnswer: 'yes_once' });
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(true);
    expect(String((r as any).content)).toContain('Finish signing in in the open tab');
    const clicks = calls.execute.filter((o) => o.func?.name === 'clickInjected');
    expect(clicks.length).toBe(1);
    // the click is by walkId (not a raw selector) with expectedCount=1
    // The login tool has already confirmed and armed this exact IdP excursion,
    // so the effect-point exception is pinned to that exact origin.
    expect(clicks[0].args).toEqual([null, 0, 5, 1, 'https://accounts.google.com']);
    // the confirm carried verified:true
    expect(calls.confirm[0].verified).toBe(true);
    expect(calls.confirm[0].idpOrigin).toBe('https://accounts.google.com');
    expect(calls.confirm[0].summary).toContain('https://accounts.google.com');
    expect(calls.authorizeExcursion).toEqual(['https://accounts.google.com']);
    expect(String((r as any).content)).toContain('Finish signing in in the open tab');
    expect(calls.audit.some((e) => e.type === 'login_initiated')).toBe(true);
  });

  test('a name-only "Sign in with Google" (no walkId) is ASSISTED-MANUAL — no click', async () => {
    const { ctx, calls } = makeCtx({ descriptor: ssoDescriptor, confirmAnswer: 'yes_once' });
    const r = await loginTool.execute({ selector: '#signin' }, ctx);
    expect(r.ok).toBe(true);
    expect(String((r as any).content)).toContain('could not verify');
    // unverified destination → the confirm must NOT vouch for it
    expect(calls.confirm[0].verified).toBe(false);
    expect(calls.confirm[0].idpOrigin).toBe(null);
    expect(calls.authorizeExcursion).toEqual([]);
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);
    expect(calls.audit.some((e) => e.type === 'login_gesture_required')).toBe(true);
    expect(calls.audit.some((e) => e.type === 'login_initiated')).toBe(false);
  });

  test('a VERIFIED sso but NO walkId (selector only) is still ASSISTED-MANUAL — no click', async () => {
    const { ctx, calls } = makeCtx({ descriptor: verifiedSsoDescriptor, confirmAnswer: 'yes_once' });
    const r = await loginTool.execute({ selector: '#signin' }, ctx);
    expect(r.ok).toBe(true);
    expect(String((r as any).content)).toContain('Finish signing in in the open tab');
    expect(calls.confirm[0].verified).toBe(true);
    expect(calls.authorizeExcursion).toEqual(['https://accounts.google.com']);
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);
    expect(calls.audit.some((e) => e.type === 'login_gesture_required')).toBe(true);
  });

  test('a refused exact-provider grant prevents auto-click', async () => {
    const { ctx, calls } = makeCtx({
      descriptor: verifiedSsoDescriptor,
      domRefs: walkDomRefs,
      confirmAnswer: 'yes_once',
      excursionAnswer: false,
    });
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_excursion_authority_refused');
    expect(r).toMatchObject({
      performed: true, outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
    });
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled(r)).toBe('performed');
    expect(calls.authorizeExcursion).toEqual(['https://accounts.google.com']);
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected')).toEqual([]);
  });

  test('a failed auto-click revokes only the exact pending provider grant', async () => {
    const { ctx, calls } = makeCtx({
      descriptor: verifiedSsoDescriptor,
      domRefs: walkDomRefs,
      confirmAnswer: 'yes_once',
      clickResult: { ok: false, error: 'stale_ref' },
    });
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('login_click_failed');
    expect(r).toMatchObject({ performed: true, outcomeKnown: false, retryable: false });
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled(r)).toBe('unknown');
    expect(calls.authorizeExcursion).toEqual(['https://accounts.google.com']);
    expect(calls.revokeExcursion).toEqual(['https://accounts.google.com']);
  });
});

describe('login tool — post-confirm re-verification aborts on any change', () => {
  test('origin change during the confirm → login_origin_changed, no click', async () => {
    const calls = { confirm: [] as any[], audit: [] as any[], click: 0 };
    let getCount = 0;
    const ctx: any = {
      session: { sessionId: 's1' },
      activeTab: { id: 1, url: 'https://acct.example.com/login', origin: 'https://acct.example.com' },
      // 1st resolve (pre-confirm) → acct.example.com; 2nd (post-confirm) → a DIFFERENT origin
      tabs: { get: async (id: number) => { getCount += 1; return { id, url: getCount <= 1 ? 'https://acct.example.com/login' : 'https://evil.example.com/login' }; } },
      denylist: [],
      scripting: {
        executeScript: async (opts: any) => {
          const url = getCount <= 1
            ? 'https://acct.example.com/login'
            : 'https://evil.example.com/login';
          const probe = browserProbeResult(opts, {
            url,
            documentId: getCount <= 1 ? 'login-before' : 'login-after',
          });
          if (probe) return probe;
          if (opts?.func?.name === 'loginTargetReader') return [{ result: { ok: true, descriptor: verifiedSsoDescriptor } }];
          if (opts?.func?.name === 'clickInjected') { calls.click += 1; return [{ result: { ok: true } }]; }
          return [{ result: null }];
        },
      },
      confirm: async (p: any) => { calls.confirm.push(p); return 'yes_once'; },
      permission: { mode: 'act', confirmActions: true },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: true }),
      authorizeSignInOrigin: async () => true,
      audit: async (e: any) => { calls.audit.push(e); },
      domRefs: walkDomRefs,
    };
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_origin_changed');
    expect(calls.click).toBe(0);
    expect(calls.audit.some((e) => e.type === 'login_initiated')).toBe(false);
  });

  test('affordance change during the confirm → login_affordance_changed, no click', async () => {
    const calls = { confirm: [] as any[], audit: [] as any[], click: 0 };
    let readCount = 0;
    const ctx: any = {
      session: { sessionId: 's1' },
      activeTab: { id: 1, url: 'https://acct.example.com/login', origin: 'https://acct.example.com' },
      tabs: { get: async (id: number) => ({ id, url: 'https://acct.example.com/login' }) },
      denylist: [],
      scripting: {
        executeScript: async (opts: any) => {
          const probe = browserProbeResult(opts, { url: 'https://acct.example.com/login' });
          if (probe) return probe;
          if (opts?.func?.name === 'loginTargetReader') {
            readCount += 1;
            // 1st read: verified Google. 2nd (post-confirm) read: the node was swapped
            // to a non-IdP "Delete account" — must abort.
            return [{ result: { ok: true, descriptor: readCount <= 1 ? verifiedSsoDescriptor : { tag: 'button', name: 'Delete account' } } }];
          }
          if (opts?.func?.name === 'clickInjected') { calls.click += 1; return [{ result: { ok: true } }]; }
          return [{ result: null }];
        },
      },
      confirm: async (p: any) => { calls.confirm.push(p); return 'yes_once'; },
      permission: { mode: 'act', confirmActions: true },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: true }),
      authorizeSignInOrigin: async () => true,
      audit: async (e: any) => { calls.audit.push(e); },
      domRefs: walkDomRefs,
    };
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_affordance_changed');
    expect(r).toMatchObject({
      performed: true, outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
    });
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled(r)).toBe('performed');
    expect(calls.click).toBe(0);
  });

  test('a target lost after durable origin binding remains performed', async () => {
    let reads = 0;
    const { ctx } = makeCtx({
      descriptor: verifiedSsoDescriptor,
      domRefs: walkDomRefs,
      confirmAnswer: 'yes_once',
      tabsGet: async (id) => {
        reads += 1;
        if (reads === 3) throw new Error('gone');
        return { id, url: 'https://acct.example.com/login' };
      },
    });
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r).toMatchObject({
      ok: false, error: 'login_target_gone', performed: true,
      outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
    });
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled(r)).toBe('performed');
  });

  test('an origin change after durable origin binding remains performed', async () => {
    let bound = false;
    let reads = 0;
    const { ctx } = makeCtx({
      descriptor: verifiedSsoDescriptor,
      domRefs: walkDomRefs,
      confirmAnswer: 'yes_once',
      authorize: async () => { bound = true; return true; },
      probeUrl: () => bound
        ? 'https://changed.example/login' : 'https://acct.example.com/login',
      tabsGet: async (id) => {
        reads += 1;
        return {
          id,
          url: bound ? 'https://changed.example/login' : 'https://acct.example.com/login',
        };
      },
    });
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(bound).toBe(true);
    expect(reads).toBe(3);
    expect(r).toMatchObject({
      ok: false, error: 'login_origin_changed', performed: true,
      outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
    });
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled(r)).toBe('performed');
  });

  test('an unproven excursion rollback after Stop is performed and unknown', async () => {
    const controller = new AbortController();
    const { ctx } = makeCtx({
      descriptor: verifiedSsoDescriptor,
      domRefs: walkDomRefs,
      confirmAnswer: 'yes_once',
      abortSignal: controller.signal,
      authorizeExcursion: async () => { controller.abort(); return true; },
      revokeExcursion: async () => false,
    });
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r).toMatchObject({
      ok: false, error: 'login_aborted', performed: true,
      outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    });
    expect(HOST_EFFECT_OUTCOME.pageMutation.fulfilled(r)).toBe('unknown');
  });
});

describe('login tool — passkey is assisted-manual at Tier 0 (no auto-click)', () => {
  const passkeyDescriptor = { tag: 'button', name: 'Sign in with a passkey' };

  test('even WITH a CDP pool present, a confirmed passkey does NOT auto-click — it hands the gesture to the user', async () => {
    // The confused-deputy guard: the ground-truth read (walkId/selector) and a CDP
    // trusted click (backend node) can resolve to different elements, so Tier 0
    // never fires the trusted click. It must not call clickBackendNode OR
    // clickInjected — the user completes the gesture.
    const cdp: any[] = [];
    const debuggerPool = { clickBackendNode: async (tabId: number, id: number) => { cdp.push([tabId, id]); return { ok: true }; } };
    const domRefs = { resolve: () => ({ backendDOMNodeId: 42, walkId: null, role: 'button', name: 'passkey' }) };
    const { ctx, calls } = makeCtx({ descriptor: passkeyDescriptor, confirmAnswer: 'yes_session', debuggerPool, domRefs });
    const r = await loginTool.execute({ ref: '@e1', selector: '#pk' }, ctx);
    expect(r.ok).toBe(true);
    expect(String((r as any).content)).toContain('passkey or security-key button');
    expect(cdp.length).toBe(0);              // NO trusted click
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);  // NO synthetic click
    expect(calls.audit.some((e) => e.type === 'login_gesture_required')).toBe(true);
    expect(calls.audit.some((e) => e.type === 'login_initiated')).toBe(false);
    expect(calls.authorizeExcursion).toEqual([]);
  });

  test('the origin-verified consent still fires before handing off', async () => {
    const { ctx, calls } = makeCtx({ descriptor: passkeyDescriptor, confirmAnswer: 'yes_once' });
    const r = await loginTool.execute({ selector: '#pk' }, ctx);
    expect(r.ok).toBe(true);
    expect(calls.confirm.length).toBe(1);
    expect(calls.confirm[0].method).toBe('passkey');
    expect(String((r as any).content)).toContain('complete the prompt on your device');
  });
});
