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
import { loginTool } from '../../../extension/peerd-runtime/tools/defs/login.js';

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
}

const makeCtx = (over: Over = {}) => {
  const calls = {
    execute: [] as any[],
    confirm: [] as any[],
    audit: [] as any[],
    cdp: [] as any[],
  };
  const origin = over.origin ?? 'https://acct.example.com';
  const ctx: any = {
    session: { sessionId: 's1' },
    activeTab: over.activeTab ?? { id: 1, url: `${origin}/login`, origin },
    tabs: { get: async (id: number) => ({ id, url: `${origin}/login` }) },
    denylist: [],
    scripting: {
      executeScript: async (opts: any) => {
        const fn = opts?.func?.name;
        // The DOM chokepoint's live probe (issues 267/276) injects once per tool
        // call, BEFORE login's own https/inbound refusals — deliberately, since
        // those are judged against the live resolved tab. It reads nothing back
        // into the turn and drives nothing, so it is not "page-driving" in the
        // sense the counts below pin.
        if (fn === 'hasPasswordFieldInjected') return [{ result: { has: false, origin, href: `${origin}/login` } }];
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
    audit: async (e: any) => { calls.audit.push(e); },
    domRefs: over.domRefs,
    debuggerPool: over.debuggerPool,
    settings: over.settings,
    inbound: over.inbound,
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
    expect(String((r as any).content)).toContain('login initiated');
    const clicks = calls.execute.filter((o) => o.func?.name === 'clickInjected');
    expect(clicks.length).toBe(1);
    // the click is by walkId (not a raw selector) with expectedCount=1
    expect(clicks[0].args).toEqual([null, 0, 5, 1]);
    // the confirm carried verified:true
    expect(calls.confirm[0].verified).toBe(true);
    expect(calls.audit.some((e) => e.type === 'login_initiated')).toBe(true);
  });

  test('a name-only "Sign in with Google" (no walkId) is ASSISTED-MANUAL — no click', async () => {
    const { ctx, calls } = makeCtx({ descriptor: ssoDescriptor, confirmAnswer: 'yes_once' });
    const r = await loginTool.execute({ selector: '#signin' }, ctx);
    expect(r.ok).toBe(true);
    expect(String((r as any).content)).toContain('login_ready');
    // unverified destination → the confirm must NOT vouch for it
    expect(calls.confirm[0].verified).toBe(false);
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);
    expect(calls.audit.some((e) => e.type === 'login_gesture_required')).toBe(true);
    expect(calls.audit.some((e) => e.type === 'login_initiated')).toBe(false);
  });

  test('a VERIFIED sso but NO walkId (selector only) is still ASSISTED-MANUAL — no click', async () => {
    const { ctx, calls } = makeCtx({ descriptor: verifiedSsoDescriptor, confirmAnswer: 'yes_once' });
    const r = await loginTool.execute({ selector: '#signin' }, ctx);
    expect(r.ok).toBe(true);
    expect(String((r as any).content)).toContain('login_ready');
    expect(calls.confirm[0].verified).toBe(true);
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);
    expect(calls.audit.some((e) => e.type === 'login_gesture_required')).toBe(true);
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
          if (opts?.func?.name === 'loginTargetReader') return [{ result: { ok: true, descriptor: verifiedSsoDescriptor } }];
          if (opts?.func?.name === 'clickInjected') { calls.click += 1; return [{ result: { ok: true } }]; }
          return [{ result: null }];
        },
      },
      confirm: async (p: any) => { calls.confirm.push(p); return 'yes_once'; },
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
      audit: async (e: any) => { calls.audit.push(e); },
      domRefs: walkDomRefs,
    };
    const r = await loginTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('login_affordance_changed');
    expect(calls.click).toBe(0);
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
    expect(String((r as any).content)).toContain('login_ready');
    expect(cdp.length).toBe(0);              // NO trusted click
    expect(calls.execute.filter((o) => o.func?.name === 'clickInjected').length).toBe(0);  // NO synthetic click
    expect(calls.audit.some((e) => e.type === 'login_gesture_required')).toBe(true);
    expect(calls.audit.some((e) => e.type === 'login_initiated')).toBe(false);
  });

  test('the origin-verified consent still fires before handing off', async () => {
    const { ctx, calls } = makeCtx({ descriptor: passkeyDescriptor, confirmAnswer: 'yes_once' });
    const r = await loginTool.execute({ selector: '#pk' }, ctx);
    expect(r.ok).toBe(true);
    expect(calls.confirm.length).toBe(1);
    expect(calls.confirm[0].method).toBe('passkey');
    expect(String((r as any).content)).toContain('Complete it yourself');
  });
});
