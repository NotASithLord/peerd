// @ts-check

import { definePageAuthorityHandler } from './handler.js';
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
//   2. The origin it confirms is SYSTEM-DERIVED from the LIVE resolved tab
//      (originOfUrl(tab.url)), https-only, fail-closed — never a model-supplied
//      string — and it is RE-VERIFIED after the consent before any auto-click.
//   3. The confirm is UNCONDITIONAL: it calls ctx.confirm DIRECTLY (like
//      site_client_write), so a login prompts EVEN when confirmations are globally
//      off. A login is maximal delegation; INV-13-grade.
//   4. It VERIFIES the target really is a login affordance by reading GROUND TRUTH
//      off the page and running a pure classifier BEFORE it confirms or clicks —
//      so the model cannot spoof the method/provider the confirm names.
//   5. It is WEB-ACTOR-ONLY (exposure.js), and a passkey uses the TRUSTED CDP click
//      (WebAuthn needs transient user activation); it does NOT fake a synthetic
//      gesture when CDP is absent (the no-fake trusted-input posture).

import {
  classifyLoginAffordance,
  isKnownIdp,
  loginTargetReader,
  originOfUrl,
  resolveTargetTab,
  scriptingTarget,
} from '/peerd-runtime/browser-authority.js';
import { clickInjected } from './click.js';

/**
 * Harness-injected ctx extras (the snapshot ref registry), absent from the
 * ToolContext typedef — narrowed through an erased cast, same as click.js.
 *
 * @typedef {{ backendDOMNodeId: number|null, walkId?: number|null, role: string, name: string }} RefEntry
 * @typedef {{ resolve?: (tabId: number, ref: string) => RefEntry | null }} DomRefs
 * @typedef {{ domRefs?: DomRefs }} DomCtxExtras
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const loginTool = definePageAuthorityHandler({

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
    //    non-secure or unknown origin. The origin is derived from the LIVE resolved
    //    tab (originOfUrl(tab.url) — the same normalizer navigate/dom-helpers use),
    //    NOT the possibly-stale ctx.activeTab snapshot, so the value we https-gate,
    //    confirm, audit, and RE-VERIFY against post-consent is where the tab really
    //    is. Still system-derived — never a model-supplied string.
    const origin = originOfUrl(tab.url);
    if (!origin || !origin.startsWith('https://')) {
      return { ok: false, error: 'login_requires_https_origin' };
    }

    // 3) INBOUND. This can never actually fire on login's dispatch paths: ctx.inbound
    //    is set only for synthetic MAIN turns, and login is web-actor-only, reached
    //    through message_actor whose sender gate an inbound (untrusted) turn cannot
    //    pass — so an inbound turn never gets to wake the web actor at all. The REAL
    //    controls are that exposure + that sender gate. This line is inert belt-and-
    //    braces for any FUTURE path that folds ctx.inbound onto an actor dispatch;
    //    it is not a live wall today.
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
        target: scriptingTarget(tab),
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
    const confirmAny = /** @type {((p: Record<string, unknown>, signal?: AbortSignal) => Promise<'yes_once'|'yes_session'|'no'|boolean>) | undefined} */ (
      /** @type {unknown} */ (ctx.confirm));
    if (!confirmAny) return { ok: false, error: 'login_declined', content: 'No confirmation channel available for a sign-in.' };
    const summary = v.method === 'passkey'
      ? `Begin a passkey / security-key sign-in on ${origin}? You'll complete it with your device.`
      : v.verified === true && v.idpOrigin
        ? `Begin sign-in with ${v.provider} on ${origin}? The provider page is ${v.idpOrigin}.`
        : `Begin sign-in with ${v.provider} on ${origin}? peerd could not verify where this ${v.provider} sign-in button leads.`;
    const ans = await confirmAny({
      tool: 'login',
      kind: 'login',
      sideEffect: 'write',
      origins: [origin],
      // Structured fields for a rich login card — safe: origin is system-derived
      // and method/provider/verified come from the ground-truth classifier, not the
      // model. `verified` lets the card soften copy for a destination peerd could not
      // prove is a known IdP (it must not vouch for one).
      method: v.method,
      provider: v.provider ?? null,
      verified: v.verified === true,
      idpOrigin: v.verified === true ? (v.idpOrigin ?? null) : null,
      summary,
      sessionId: ctx.session?.sessionId ?? null,
    }, ctx.abortSignal);
    if (ans !== 'yes_once' && ans !== 'yes_session' && ans !== true) {
      return { ok: false, error: 'login_declined', content: 'User declined the sign-in.' };
    }
    if (ctx.abortSignal?.aborted) return { ok: false, error: 'login_aborted' };

    // Consent names the relying site, not the identity provider it may visit.
    // Re-read the owned tab after consent, then bind a roaming actor to that
    // system-derived origin. The origin lock uses this boundary to permit one
    // bounded sign-in excursion without ever making the provider an actor home.
    const authorizedTab = await resolveTargetTab(args, ctx);
    if (!authorizedTab?.id) return { ok: false, error: 'login_target_gone' };
    if (ctx.abortSignal?.aborted) return { ok: false, error: 'login_aborted' };
    if (originOfUrl(authorizedTab.url) !== origin) {
      return { ok: false, error: 'login_origin_changed', content: 'the page moved during the confirm; re-run login after a fresh snapshot.' };
    }
    const originAuthorized = await ctx.authorizeSignInOrigin?.(origin, ctx.abortSignal);
    if (ctx.abortSignal?.aborted) return { ok: false, error: 'login_aborted' };
    if (originAuthorized !== true) {
      return {
        ok: false,
        error: 'login_origin_authority_refused',
        content: 'The relying-site boundary could not be verified after confirmation. Re-run login from a fresh page snapshot.',
      };
    }

    // 7) INITIATE. peerd AUTO-CLICKS only when it has (a) VERIFIED the destination is
    //    a known IdP, (b) a STABLE walkId (a snapshot node the page cannot re-point —
    //    a raw selector or a CDP-only backend ref is NOT stable across the up-to-120s
    //    confirm), and it then (c) RE-VERIFIES origin + affordance AFTER the consent.
    //    Everything else is ASSISTED-MANUAL: peerd verified the origin and took
    //    consent, then hands the gesture to the user.
    const canAutoClick = v.method === 'sso' && v.verified === true && walkId != null;

    if (!canAutoClick) {
      // ASSISTED-MANUAL. Passkey is ALWAYS here at Tier 0: WebAuthn needs TRANSIENT
      // USER ACTIVATION, which only a TRUSTED (CDP) click grants — and the CDP channel
      // resolves the node by a backendDOMNodeId, a DIFFERENT key than this tool's
      // ground-truth READ (walkId/selector), so an auto-fire could be a confused
      // deputy (consent to one element, a trusted click on another). An SSO lands here
      // when its destination is unverified OR it has no stable walkId to pin the
      // read↔click node. In every case peerd did the load-bearing work — https origin,
      // ground-truth classify, origin-named consent — and hands off the gesture, where
      // the factor belongs anyway. No fake synthetic click. (Trusted passkey auto-click
      // via a CDP SAME-NODE read is the documented Tier-0.1 follow-up.)
      ctx.audit({ type: 'login_gesture_required', details: { origin, method: v.method } }).catch(() => {});
      if (v.method === 'passkey') {
        return {
          ok: true,
          endTurn: true,
          content: 'Finish signing in in the open tab. Click the passkey or security-key button and '
            + 'complete the prompt on your device. peerd never sees your credential. When you are done, '
            + 'tell peerd to continue.',
        };
      }
      if (v.verified === true && v.idpOrigin) {
        const armed = await ctx.authorizeSignInExcursion?.(v.idpOrigin, ctx.abortSignal);
        if (ctx.abortSignal?.aborted) {
          if (armed === true) await ctx.revokeSignInExcursion?.(v.idpOrigin).catch(() => false);
          return { ok: false, error: 'login_aborted' };
        }
        if (armed !== true) {
          return {
            ok: false,
            error: 'login_excursion_authority_refused',
            content: 'The verified provider step could not be authorized. Finish signing in yourself, then tell peerd to continue.',
          };
        }
      }
      // SSO, not auto-clickable. Be non-committal about the destination when unverified
      // — peerd must NOT vouch for where the button leads.
      const provider = v.provider || 'your provider';
      const guidance = v.verified === true
        ? `Click the ${provider} sign-in button. peerd cannot read or act on ${v.idpOrigin}. `
          + `When this tab returns to ${origin}, tell peerd to continue. `
        : `Click the sign-in button only if you trust this page. peerd could not verify that it leads to ${provider}, so peerd cannot follow the destination. When you are done, tell peerd to continue. `;
      return {
        ok: true,
        endTurn: true,
        content: `Finish signing in in the open tab. ${guidance}peerd never sees your credential.`,
      };
    }

    // AUTO — verified SSO + stable walkId. RE-VERIFY after the confirm, before clicking:
    // the page can move the tab or swap the element under a raw ref during the (up-to-
    // 120s) confirm, so re-judge the landing, re-check the live origin, and re-read +
    // re-classify via the SAME walkId; abort on ANY change.
    const tab2 = await resolveTargetTab(args, ctx);
    if (!tab2?.id) return { ok: false, error: 'login_target_gone' };
    if (originOfUrl(tab2.url) !== origin) {
      return { ok: false, error: 'login_origin_changed', content: 'the page moved during the confirm; re-run login after a fresh snapshot.' };
    }
    let d2;
    try {
      const rr = await scripting.executeScript({ target: scriptingTarget(tab2), func: loginTargetReader, args: [null, 0, walkId] });
      const r2 = rr[0]?.result;
      if (!r2 || !r2.ok) return { ok: false, error: 'login_affordance_changed', content: 'the sign-in element changed after you approved; re-run.' };
      d2 = r2.descriptor;
    } catch (e) {
      return { ok: false, error: `login_affordance_changed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    const v2 = classifyLoginAffordance(d2, { isKnownIdp });
    if (!(v2.supported && v2.method === v.method && v2.verified === true
      && v2.provider === v.provider && v2.idpOrigin === v.idpOrigin)) {
      return { ok: false, error: 'login_affordance_changed', content: 'the sign-in element changed after you approved; re-run.' };
    }
    if (ctx.abortSignal?.aborted) return { ok: false, error: 'login_aborted' };
    const idpOrigin = v2.idpOrigin;
    if (!idpOrigin) {
      return { ok: false, error: 'login_affordance_changed', content: 'the verified provider destination is no longer available; re-run.' };
    }

    const armed = await ctx.authorizeSignInExcursion?.(idpOrigin, ctx.abortSignal);
    if (ctx.abortSignal?.aborted) {
      await ctx.revokeSignInExcursion?.(idpOrigin).catch(() => false);
      return { ok: false, error: 'login_aborted' };
    }
    if (armed !== true) {
      return {
        ok: false,
        error: 'login_excursion_authority_refused',
        content: 'The verified provider step could not be authorized. Re-run login from a fresh page snapshot.',
      };
    }

    // Click via the SAME walkId — the stable registry node the read resolved, which
    // the page cannot re-point. expectedCount=1 catches a stale/duplicated ref.
    let scriptResult;
    try {
      const results = await scripting.executeScript({
        target: scriptingTarget(tab2),
        func: clickInjected,
        // The login tool already bound this exact IdP destination to a fresh
        // user confirmation and a one-shot excursion grant. That narrower
        // authority is the only caller allowed through the generic form guard.
        args: [null, 0, walkId, 1, idpOrigin],
      });
      scriptResult = results[0]?.result;
    } catch (e) {
      await ctx.revokeSignInExcursion?.(idpOrigin).catch(() => false);
      return { ok: false, error: `login_click_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (!scriptResult) {
      await ctx.revokeSignInExcursion?.(idpOrigin).catch(() => false);
      return { ok: false, error: 'login_click_failed' };
    }
    if (!scriptResult.ok) {
      await ctx.revokeSignInExcursion?.(idpOrigin).catch(() => false);
      return { ok: false, error: `login_click_failed: ${scriptResult.error ?? 'click_failed'}` };
    }

    // 8) AUDIT (best-effort — never let an audit hiccup fail the login).
    ctx.audit({
      type: 'login_initiated',
      details: { origin, method: v.method, provider: v.provider, idpOrigin },
    }).catch(() => {});

    // 9) RETURN a system-authored plain success. No untrusted page text is emitted,
    //    so no fence is needed — keep the message peerd-authored.
    return {
      ok: true,
      endTurn: true,
      content: `Finish signing in in the open tab. peerd is paused and cannot read or act on ${idpOrigin}. `
        + `When this tab returns to ${origin}, tell peerd to continue. peerd never sees your credential.`,
    };
  },
});
