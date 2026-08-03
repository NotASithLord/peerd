// @ts-check
// login — INITIATE a user-gesture login (passkey/WebAuthn or "Sign in with <known
// IdP>") on the current page. Tier 0 of the credential roadmap: it holds NO secret,
// stores NOTHING, and NEVER fills a password. The authentication factor always
// stays with the user (their device for a passkey, the provider for SSO). This tool
// is the enforcement point that turns "click a sign-in button" into a consented,
// origin-verified, affordance-verified, audited action.
//
// Five things make this safe, and each is load-bearing:
//   1. It carries no credential and touches no password field — see the reader in
//      login-affordance.js (structure only, never a value).
//   2. The origin it confirms is SYSTEM-DERIVED (ctx.activeTab.origin), https-only,
//      fail-closed — never a model-supplied string.
//   3. The confirm is UNCONDITIONAL: it calls ctx.confirm DIRECTLY (like
//      site_client_write), so a login prompts EVEN when confirmations are globally
//      off. A login is maximal delegation; INV-13-grade.
//   4. It VERIFIES the target really is a login affordance by reading GROUND TRUTH
//      off the page and running a pure classifier BEFORE it confirms or clicks —
//      so the model cannot spoof the method/provider the confirm names.
//   5. It is WEB-ACTOR-ONLY (exposure.js), and a passkey uses the TRUSTED CDP click
//      (WebAuthn needs transient user activation); it does NOT fake a synthetic
//      gesture when CDP is absent (page_keys' no-fake posture).

import { resolveTargetTab } from './dom-helpers.js';
import { classifyLoginAffordance, loginTargetReader } from '../login-affordance.js';
import { clickInjected } from './click.js';
import { isKnownIdp } from '../../actor/idp-registry.js';

/**
 * Harness-injected ctx extras (the snapshot ref registry), absent from the
 * ToolContext typedef — narrowed through an erased cast, same as click.js.
 *
 * @typedef {{ backendDOMNodeId: number|null, walkId?: number|null, role: string, name: string }} RefEntry
 * @typedef {{ resolve?: (tabId: number, ref: string) => RefEntry | null }} DomRefs
 * @typedef {{ domRefs?: DomRefs }} DomCtxExtras
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const loginTool = {
  name: 'login',
  primitive: 'tab',
  description: [
    'INITIATE a user-gesture sign-in on the current page — a passkey / security-key',
    'ceremony, or a "Sign in with <provider>" button for a recognized identity',
    'provider. peerd holds NO credential: it never fills a password and never stores a',
    'secret; you complete the authentication with your device or on the provider. Target',
    'the sign-in element you found in a prior snapshot via {ref} (preferred) or a CSS',
    '{selector}. The tool reads the element off the page and derives the method/provider',
    'itself (you do NOT pass them), verifies it really is a login affordance, then asks',
    'the user to confirm before acting. Password logins are refused (peerd holds no',
    'credentials); SSO for a full product that only speaks OAuth (GitHub/GitLab/Facebook)',
    'is refused gracefully — sign in there yourself. For a passkey, keep advanced',
    'automation on so the trusted gesture can fire.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description: 'PREFERRED. A sign-in element ref from a snapshot (e.g. "@e7"). For a passkey the trusted click needs a CDP snapshot ref (backend node).',
      },
      selector: {
        type: 'string',
        description: 'CSS selector identifying the sign-in element (from read_page / query_dom). One of ref|selector is required.',
      },
      nth: {
        type: 'integer',
        description: 'Optional 0-indexed match when the SELECTOR matches multiple elements (default 0). Ignored for ref.',
      },
    },
  },
  sideEffect: 'write',
  // SYSTEM-DERIVED origin — never a model-supplied string. The gates denylist-check
  // this, and the confirm below names the same system origin.
  origins: (_args, ctx) => ctx.activeTab?.origin ? [ctx.activeTab.origin] : [],

  execute: async (args, ctx) => {
    // 1) Resolve the tab through the DOM chokepoint (runs the origin lock /
    //    judgeLanding, fails closed for a vanished actor tab).
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };

    // why: domRefs is SW-injected onto ctx but off the ToolContext typedef;
    // scripting is typed opaquely — narrow both, same as click.js.
    const { domRefs } = /** @type {DomCtxExtras} */ (ctx);
    const scripting = /** @type {typeof chrome.scripting} */ (ctx.scripting);

    // 2) ORIGIN FAIL-CLOSED — a credential ceremony must never begin on a
    //    non-secure or unknown origin. The origin is SYSTEM-DERIVED.
    const origin = ctx.activeTab?.origin;
    if (!origin || !origin.startsWith('https://')) {
      return { ok: false, error: 'login_requires_https_origin' };
    }

    // 3) INBOUND defense-in-depth. The primary control is web-actor-only exposure
    //    plus the sender gate; this is belt-and-braces so an inbound (untrusted)
    //    turn that somehow reached here still cannot start a login.
    if (/** @type {{ inbound?: boolean }} */ (ctx).inbound === true) {
      return { ok: false, error: 'login_refused_inbound' };
    }

    // 4) READ GROUND TRUTH — resolve the element the SAME way click.js does (ref's
    //    walkId, or selector+nth) and read a descriptor. A read needs no trusted
    //    input, so scripting is fine on every channel.
    const refStr = typeof args?.ref === 'string' && args.ref.trim() ? args.ref.trim() : null;
    const entry = refStr ? (domRefs?.resolve?.(tab.id, refStr) ?? null) : null;
    if (refStr && !entry) return { ok: false, error: `stale_ref: ${refStr} — re-run snapshot on this tab first` };
    const walkId = entry?.walkId ?? null;
    const selector = typeof args?.selector === 'string' && args.selector.trim() ? args.selector : null;
    const nth = Number.isInteger(args?.nth) && args.nth >= 0 ? args.nth : 0;
    if (walkId == null && !selector) {
      return { ok: false, error: 'login_target_not_found', content: 'Provide a snapshot {ref} (with a walk id) or a CSS {selector} for the sign-in element.' };
    }

    let descriptor;
    try {
      const results = await scripting.executeScript({
        target: { tabId: tab.id },
        func: loginTargetReader,
        args: [selector, nth, walkId],
      });
      const r = results[0]?.result;
      if (!r) return { ok: false, error: 'login_read_failed' };
      if (!r.ok) {
        // A resolution miss is "not found"; anything else surfaces its reason.
        if (/^no_match|^stale_ref|^nth_out_of_range|^selector_or_ref_required/.test(String(r.error))) {
          return { ok: false, error: 'login_target_not_found', content: r.error };
        }
        return { ok: false, error: `login_read_failed: ${r.error}` };
      }
      descriptor = r.descriptor;
    } catch (e) {
      return { ok: false, error: `login_read_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }

    // 5) CLASSIFY from ground truth (idp-registry injected — functional-core rule).
    //    An unsupported verdict is a NORMAL, non-error outcome the model can relay:
    //    no click, and the user/actor learns exactly why.
    const v = classifyLoginAffordance(descriptor, { isKnownIdp });
    if (!v.supported) {
      return { ok: false, error: 'login_unsupported', content: v.reason };
    }

    // 6) ALWAYS CONFIRM — UNCONDITIONAL. Call ctx.confirm DIRECTLY (like
    //    site_client_write) so it prompts EVEN when confirmations are globally off.
    //    The origin is system-derived (step 2) and the method/provider come from the
    //    verified classifier (step 5), so the summary cannot be spoofed by the model.
    const confirmAny = /** @type {((p: Record<string, unknown>) => Promise<'yes_once'|'yes_session'|'no'|boolean>) | undefined} */ (
      /** @type {unknown} */ (ctx.confirm));
    if (!confirmAny) return { ok: false, error: 'login_declined', content: 'No confirmation channel available for a sign-in.' };
    const summary = v.method === 'passkey'
      ? `Begin a passkey / security-key sign-in on ${origin}? You'll complete it with your device.`
      : `Begin sign-in with ${v.provider} on ${origin}? You'll authenticate on ${v.provider}.`;
    const ans = await confirmAny({
      tool: 'login',
      kind: 'login',
      sideEffect: 'write',
      origins: [origin],
      // Structured fields for a rich login card — safe: origin is system-derived
      // and method/provider come from the ground-truth classifier, not the model.
      method: v.method,
      provider: v.provider ?? null,
      summary,
      sessionId: ctx.session?.sessionId ?? null,
    });
    if (ans !== 'yes_once' && ans !== 'yes_session' && ans !== true) {
      return { ok: false, error: 'login_declined', content: 'User declined the sign-in.' };
    }

    // 7) INITIATE the flow.
    if (v.method === 'passkey') {
      // ASSISTED-MANUAL by design at Tier 0. A passkey (WebAuthn) needs TRANSIENT
      // USER ACTIVATION, which only a TRUSTED click grants — and the sole trusted
      // channel (CDP clickBackendNode on the ref's backend node) resolves the node
      // by a DIFFERENT key than this tool's ground-truth READ (walkId/selector).
      // On the CDP channel a ref carries a backendDOMNodeId but no walkId, so the
      // read must fall back to a caller-supplied `selector` — and a compromised web
      // actor could then pass a `selector` matching a real passkey button (so the
      // confirm truthfully says "passkey on <origin>") while the `ref` points the
      // trusted click at a DIFFERENT element: consent to one thing, a trusted click
      // on another. Rather than ship that confused-deputy, Tier 0 does NOT auto-fire
      // the passkey gesture. peerd still did the load-bearing work — verified the
      // https origin, classified the affordance from ground truth, and took the
      // user's origin-named consent — and now hands off the gesture to the user,
      // where the factor belongs anyway. The trusted auto-click is a documented
      // follow-up (Tier 0.1): a CDP SAME-NODE read (resolveNode→callFunctionOn on
      // the backend node) so the read and the click are the same element by
      // construction, closing the mismatch. Until then: no fake synthetic click.
      ctx.audit({ type: 'login_gesture_required', details: { origin, method: v.method } }).catch(() => {});
      return {
        ok: true,
        content: `login_ready: peerd verified the origin (${origin}) and you approved a passkey / `
          + 'security-key sign-in. Complete it yourself now — click the passkey button and finish the '
          + 'prompt on your device. peerd never sees your credential.',
      };
    }

    // sso — an ordinary click is enough: it's navigation the origin-lock corridor
    // already permits toward a known IdP. Click the SAME element the read resolved
    // (identical selector/nth/walkId → identical node, so no read↔click mismatch).
    let scriptResult;
    try {
      const results = await scripting.executeScript({
        target: { tabId: tab.id },
        func: clickInjected,
        args: [selector, nth, walkId, null],
      });
      scriptResult = results[0]?.result;
    } catch (e) {
      return { ok: false, error: `login_click_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (!scriptResult) return { ok: false, error: 'login_click_failed' };
    if (!scriptResult.ok) return { ok: false, error: `login_click_failed: ${scriptResult.error ?? 'click_failed'}` };

    // 8) AUDIT (best-effort — never let an audit hiccup fail the login).
    ctx.audit({ type: 'login_initiated', details: { origin, method: v.method, provider: v.provider } }).catch(() => {});

    // 9) RETURN a system-authored plain success. No untrusted page text is emitted,
    //    so no fence is needed — keep the message peerd-authored.
    return {
      ok: true,
      content: `login initiated on ${origin} via ${v.method}${v.provider ? ` (${v.provider})` : ''}; `
        + 'complete the authentication on the provider.',
    };
  },
};
