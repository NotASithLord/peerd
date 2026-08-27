// Debugger pool — owns chrome.debugger attach/detach lifecycle for exact
// document-bound accessibility, action, screenshot, state, and capture effects.
//
// Why a pool instead of attach-per-call:
//   - Each attach/detach is a separate "DevTools is debugging this tab"
//     banner flicker — looks awful and slows the loop.
//   - CDP setup costs (Runtime.enable, listener wire-up) are ~50ms
//     per attach; amortized over N evals it's negligible.
//   - Concurrent evals on the same tab share the same protocol channel,
//     so we need centralized event routing anyway.
//
// Lifecycle:
//   - attach(tabId): idempotent; first call attaches + enables Runtime
//   - tab close → automatic detach via chrome.tabs.onRemoved
//   - chrome.debugger.onDetach → invalidate state (user clicked "Cancel"
//     on the banner, another extension attached, etc.)
//
import browser from '/shared/browser-api.js';
import { shapeSketch } from '/peerd-runtime/kernel-browser.js';
import {
  createNetworkCaptureRegistry,
  networkCaptureRequestPolicy,
} from './network-capture-registry.js';
import { createRuntimeContextRegistry } from './runtime-context-registry.js';
import {
  detachDebuggerWithCustody,
  enableDebuggerWithCustody,
  makeDebuggerNavigationGuard,
} from './debugger-custody.js';

const PROTOCOL_VERSION = '1.3';

/**
 * @typedef {Object} ExpectedDocument
 * @property {string} origin
 * @property {string} href
 * @property {string} documentId
 * @property {number} timeOrigin
 */

// Classic-script body injected through chrome.scripting. It deliberately has
// no closure state: the browser serializes only this function body.
export function exactDocumentBridgeInjected() {
  'use strict';
  let origin = null;
  let href = null;
  let timeOrigin = null;
  try { origin = location.origin; } catch (e) { origin = null; }
  try { href = location.href; } catch (e) { href = null; }
  try { timeOrigin = Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : null; } catch (e) { timeOrigin = null; }
  return { origin, href, timeOrigin };
}

/** @param {string} message */
const preEffectTargetError = (message = 'browser_target_changed') => {
  const error = new Error(message);
  error.outcomeKind = 'pre-effect-failure';
  return error;
};

/** @param {unknown} value */
const hostLostError = (value) => {
  const message = value instanceof Error ? value.message : String(value);
  const error = new Error(`browser_evaluate_after_dispatch: ${message}`);
  error.outcomeKind = 'host-lost';
  return error;
};

/** @param {unknown} expected @returns {expected is ExpectedDocument} */
const isExpectedDocument = (expected) => {
  const value = /** @type {Partial<ExpectedDocument> | null} */ (expected);
  return !!value
    && /^https?:\/\//.test(value.origin ?? '')
    && typeof value.href === 'string'
    && typeof value.documentId === 'string'
    && Number.isFinite(value.timeOrigin);
};

export const createDebuggerPool = (/** @type {{bindTabEvents?:boolean,bindTabRemoval?:boolean}} */ options = {}) => {
  /** @type {Set<number>} tabIds we've successfully attached to */
  const attached = new Set();
  /** @type {Set<number>} attached tabs whose setup or cleanup is uncertain */
  const quarantined = new Set();
  const runtimeContexts = createRuntimeContextRegistry();
  // One capture per tab. Identity-aware finish prevents a settling old stop
  // from deleting a replacement capture on the same tab.
  const networkCaptures = createNetworkCaptureRegistry();
  // why: `chrome.debugger` may not exist in this build at all. It's a
  // CHANNEL-GATED permission — required (install-time) in the preview/dev
  // manifests where CDP is the default, but stripped from the store Chrome
  // build (initial submission, until re-added post-approval) and from every
  // Firefox package (see packaging/gen-manifest.ts STORE_STRIPPED_PERMISSIONS /
  // CHROME_ONLY_PERMISSIONS, docs/store/OPEN-DECISIONS.md §1). NOT an
  // optional/runtime-granted permission — Chrome forbids `debugger` under
  // optional_permissions. Where the namespace is absent, touching
  // `browser.debugger.onEvent` at construction would throw and take down the
  // whole service worker at module-eval time. We therefore register the
  // global debugger listeners LAZILY, the first time we actually attach — by
  // which point the namespace necessarily exists (attach itself needs it).
  // Idempotent; the flag makes re-attach cheap.
  let globalListenersBound = false;
  // DESIGN-19 Tap A: bound once, the first time a Network capture starts.
  let netListenerBound = false;
  const ensureGlobalListeners = () => {
    if (globalListenersBound) return;
    globalListenersBound = true;

    // Global event router. chrome.debugger.onEvent fires for ALL attached
    // tabs; we dispatch by source.tabId to the right buffer.
    browser.debugger.onEvent.addListener((source, method, params) => {
      const tabId = source.tabId;
      if (typeof tabId !== 'number') return;
      runtimeContexts.observe(tabId, method, params);
    });

    // User-initiated detach (banner "Cancel" button, other extension
    // attached, target crashed). Reset our state so the next call
    // re-attaches cleanly instead of throwing "not attached".
    browser.debugger.onDetach.addListener((source, reason) => {
      console.log('[debugger-pool] detach', source.tabId, reason);
      attached.delete(source.tabId);
      quarantined.delete(source.tabId);
      runtimeContexts.release(source.tabId);
      networkCaptures.discard(source.tabId);
    });
  };

  const onTabRemoved = (/** @type {number} */ tabId) => {
    attached.delete(tabId);
    quarantined.delete(tabId);
    runtimeContexts.release(tabId);
    networkCaptures.discard(tabId);
  };
  if (options.bindTabRemoval !== false) browser.tabs.onRemoved.addListener(onTabRemoved);

  const attach = async (tabId) => {
    // why per-tab: the `debugger` permission Chrome granted is GLOBAL (an
    // API permission can't be origin-scoped), but we only ever attach to a
    // tab a CDP tool is actually driving — so the banner + debugging touch
    // just that tab, never idle ones. If a store reviewer ever challenges
    // the global grant, this is the hook point for a per-origin allowlist
    // (gate on the tab's origin before attaching). Deferred — see
    // docs/store/OPEN-DECISIONS.md §1. The denylist already refuses
    // sensitive origins upstream of here.
    ensureGlobalListeners();
    if (quarantined.has(tabId)) {
      throw new Error('debugger_cleanup_pending');
    }
    if (attached.has(tabId)) return;
    console.log('[debugger-pool] attaching to tab', tabId);
    try {
      await browser.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (e) {
      // Common race: SW restored mid-flight, browser thinks we're
      // still attached. Forcing detach + retry is cheap.
      if (/already attached/i.test(e?.message ?? '')) {
        try { await browser.debugger.detach({ tabId }); }
        catch (cleanupError) {
          attached.add(tabId);
          quarantined.add(tabId);
          throw cleanupError;
        }
        await browser.debugger.attach({ tabId }, PROTOCOL_VERSION);
      } else {
        console.error('[debugger-pool] attach failed', e);
        throw e;
      }
    }
    await enableDebuggerWithCustody({
      enable: () => browser.debugger.sendCommand({ tabId }, 'Runtime.enable'),
      detach: () => browser.debugger.detach({ tabId }),
      markAttached: () => { attached.add(tabId); },
      clearAttached: () => { attached.delete(tabId); },
      markQuarantined: () => { quarantined.add(tabId); },
      clearQuarantined: () => { quarantined.delete(tabId); },
    });
    console.log('[debugger-pool] attached + Runtime enabled on', tabId);
  };

  // Focus emulation changes the page's observable focus state, so it is armed
  // only after attachToExpectedDocument proves the exact public document.
  const enableFocusEmulation = async (tabId) => {
    // why: the driven tab is usually BACKGROUNDED — peerd never steals focus
    // (DESIGN-12). But Gmail-class pages gate keyboard shortcuts, caret
    // placement, and focus/blur-driven behavior on document.hasFocus(), which
    // is false for a background tab. Focus EMULATION makes the page believe
    // it's focused without raising anything — the no-steal replacement for
    // Page.bringToFront, which yanked the whole browser window to the OS
    // foreground on every key dispatch and hijacked the user's focus while
    // they worked in other apps/windows. Cleared automatically on detach;
    // re-applied here on every (re-)attach. Best-effort: an engine without
    // the command just loses the emulation, never the attach.
    try {
      await browser.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (e) {
      console.debug('[debugger-pool] focus emulation unavailable', e?.message ?? e);
    }
  };

  const detach = async (tabId) => {
    networkCaptures.discard(tabId);
    if (!attached.has(tabId)) {
      quarantined.delete(tabId);
      runtimeContexts.release(tabId);
      return;
    }
    try {
      await detachDebuggerWithCustody({
        detach: () => browser.debugger.detach({ tabId }),
        clearCustody: () => {
          attached.delete(tabId);
          quarantined.delete(tabId);
        },
      });
    } catch (e) {
      console.warn('[debugger-pool] detach threw; custody retained', e);
      throw e;
    }
    runtimeContexts.release(tabId);
  };

  // The attachment belongs to the document proved by the scripting bridge.
  // A navigation revokes it immediately, including a public to private hop;
  // the next CDP call must attach and prove the new document from scratch.
  const onTabUpdated = makeDebuggerNavigationGuard({
    isAttached: (tabId) => attached.has(tabId),
    detach,
  });
  if (options.bindTabEvents !== false) browser.tabs.onUpdated.addListener(onTabUpdated);

  // --- DOM navigation: a11y snapshot + ref-resolved click/type ----------

  /** @param {number} tabId */
  const mainFrameIdentity = async (tabId) => {
    const result = await browser.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
    const frame = result?.frameTree?.frame;
    let origin = '';
    try { origin = new URL(frame?.url ?? '').origin; } catch { origin = ''; }
    let href = '';
    try { href = new URL(frame?.url ?? '').href; } catch { href = ''; }
    return { origin, href, loaderId: frame?.loaderId ?? null, frameId: frame?.id ?? null };
  };

  /** @param {number} tabId @param {number} contextId @param {ExpectedDocument} expected */
  const runtimeDocumentMatches = async (tabId, contextId, expected) => {
    const result = await browser.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: '({ origin: location.origin, href: location.href, timeOrigin: performance.timeOrigin })',
      contextId,
      returnByValue: true,
    });
    const value = result?.result?.value;
    return value?.origin === expected.origin
      && value?.href === expected.href
      && value?.timeOrigin === expected.timeOrigin;
  };

  /**
   * Attach only while the tab still hosts the expected main document. A target
   * mismatch ends the pooled debugger session before any capability-specific
   * command runs.
   * @param {number} tabId
   * @param {ExpectedDocument | null} expectedDocument
   */
  const attachToExpectedDocument = async (tabId, expectedDocument) => {
    if (!isExpectedDocument(expectedDocument)) throw preEffectTargetError('browser_target_unverified');
    let bridged;
    try {
      [bridged] = await browser.scripting.executeScript({
        target: { tabId, documentIds: [expectedDocument.documentId] },
        func: exactDocumentBridgeInjected,
      });
    } catch {
      await detach(tabId);
      throw preEffectTargetError();
    }
    if (bridged?.documentId !== expectedDocument.documentId
        || bridged?.result?.origin !== expectedDocument.origin
        || bridged?.result?.href !== expectedDocument.href
        || bridged?.result?.timeOrigin !== expectedDocument.timeOrigin) {
      await detach(tabId);
      throw preEffectTargetError();
    }
    try { await attach(tabId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw preEffectTargetError(`browser_debugger_before_dispatch: ${message}`);
    }
    const identity = await mainFrameIdentity(tabId);
    if (identity.origin !== expectedDocument.origin
        || identity.href !== expectedDocument.href
        || !identity.loaderId
        || !identity.frameId) {
      await detach(tabId);
      throw preEffectTargetError();
    }
    const contextId = runtimeContexts.selectMain(tabId, identity.frameId, expectedDocument.origin);
    if (contextId === null
        || !await runtimeDocumentMatches(tabId, contextId, expectedDocument)) {
      await detach(tabId);
      throw preEffectTargetError('browser_target_unverified');
    }
    await enableFocusEmulation(tabId);
    return { ...identity, contextId };
  };

  /**
   * Resolve DOM action bodies in an extension-owned world. The page's main
   * world can replace URL, closest, and form accessors; none may decide whether
   * the host guard runs. The exact-document check also closes navigation races
   * between the main-world bind and isolated-world creation.
   * @param {number} tabId
   * @param {{ frameId: string }} bound
   * @param {ExpectedDocument} expectedDocument
   */
  const isolatedActionContext = async (tabId, bound, expectedDocument) => {
    try {
      const created = await browser.debugger.sendCommand({ tabId }, 'Page.createIsolatedWorld', {
        frameId: bound.frameId,
        worldName: 'peerd-browser-action',
        grantUniveralAccess: false,
      });
      const contextId = created?.executionContextId;
      if (typeof contextId === 'number'
          && await runtimeDocumentMatches(tabId, contextId, expectedDocument)) {
        return contextId;
      }
    } catch { /* the exact document or debugger session may have changed */ }
    try {
      await detach(tabId);
    } catch { /* custody cleanup is best-effort on a pre-effect refusal */ }
    throw preEffectTargetError('browser_target_unverified');
  };

  /**
   * Return read-only CDP output only when it came from the same exact document
   * bridged before the operation. Any navigation discards the result.
   * @param {number} tabId
   * @param {ExpectedDocument} expectedDocument
   * @param {{ loaderId: string, contextId: number }} bound
   * @param {() => Promise<any>} operation
   */
  const readFromExpectedDocument = async (tabId, expectedDocument, bound, operation) => {
    const result = await operation();
    const after = await mainFrameIdentity(tabId);
    if (after.origin !== expectedDocument.origin
        || after.href !== expectedDocument.href
        || after.loaderId !== bound.loaderId
        || !await runtimeDocumentMatches(tabId, bound.contextId, expectedDocument)) {
      throw preEffectTargetError();
    }
    return result;
  };

  // Action-result attribution (Phase 2). Shared page-side snippets spliced
  // into the click/type callFunctionOn bodies: set up a MutationObserver
  // BEFORE the action (OBS_SETUP), then await a bounded window and collect
  // a compact, SEMANTIC summary of what changed (OBS_COLLECT → __m). var/
  // ES5 style because the body is serialized into the page. Validated on
  // real DOM via Claude-in-Chrome before shipping.
  const OBS_SETUP = `
    var __add = new Set(), __rem = new Set(), __att = new Set();
    var __desc = function (n) {
      var t = n.tagName ? n.tagName.toLowerCase() : '';
      var role = n.getAttribute && n.getAttribute('role');
      var label = (n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('placeholder')))
        || ((n.innerText || '').trim().slice(0, 40));
      return (role || t) + (label ? ' "' + label + '"' : '');
    };
    var __obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'childList') {
          m.addedNodes.forEach(function (n) { if (n.nodeType === 1) __add.add(__desc(n)); });
          m.removedNodes.forEach(function (n) { if (n.nodeType === 1) __rem.add(__desc(n)); });
        } else if (m.type === 'attributes') {
          __att.add(__desc(m.target) + ' @' + m.attributeName);
        }
      }
    });
    __obs.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-expanded','aria-checked','aria-disabled','disabled','value','class','hidden','aria-hidden','aria-selected'] });`;
  const OBS_COLLECT = `
    await new Promise(function (r) { setTimeout(r, 400); });
    __obs.disconnect();
    var __m = { added: Array.from(__add).slice(0, 8), removed: Array.from(__rem).slice(0, 8),
      attr: Array.from(__att).slice(0, 8),
      counts: { added: __add.size, removed: __rem.size, attr: __att.size } };`;

  // Fetch the full accessibility tree (CDP semantic subset: role, name,
  // state, backendDOMNodeId per node). The pure serializer in
  // peerd-runtime/dom/ax-serialize.js turns this into the model's snapshot.
  const getAxTree = async (tabId, expectedDocument) => {
    const bound = await attachToExpectedDocument(tabId, expectedDocument);
    const res = await readFromExpectedDocument(tabId, expectedDocument, bound, async () => {
      // Accessibility must be enabled before getFullAXTree; idempotent.
      await browser.debugger.sendCommand({ tabId }, 'Accessibility.enable').catch(() => {});
      return browser.debugger.sendCommand({ tabId }, 'Accessibility.getFullAXTree', {});
    });
    return res?.nodes ?? [];
  };

  // Screenshot the viewport of a SPECIFIC tab by id — even a backgrounded one,
  // with NO focus steal (unlike chrome.tabs.captureVisibleTab, which only ever
  // grabs the window's foreground tab). This is what lets the `view` tool
  // capture the runner's pinned tab and gate the captured pixels to THAT tab.
  // JPEG keeps a viewport shot small enough to ship as a model vision block.
  /** @param {number} tabId @param {{ format?: 'jpeg'|'png', quality?: number, expectedDocument?: ExpectedDocument }} [opts] */
  const captureScreenshot = async (tabId, {
    format = 'jpeg', quality = 70, expectedDocument,
  } = {}) => {
    const bound = await attachToExpectedDocument(tabId, expectedDocument ?? null);
    const params = format === 'jpeg' ? { format, quality } : { format };
    const res = await readFromExpectedDocument(
      tabId,
      expectedDocument,
      bound,
      () => browser.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params),
    );
    return { data: res?.data ?? '', mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png' };
  };

  // Click a node by its backendDOMNodeId (from a ref, never a selector).
  // CDP resolves the exact node → no ambiguity, no "selector not found".
  // Synthetic el.click(); a real-event upgrade (DOM.getBoxModel +
  // Input.dispatchMouseEvent) is a follow-up for isTrusted-gating sites.
  // Reports the action's DOM effect via OBS_SETUP/COLLECT (Phase 2).
  const clickBackendNode = async (tabId, backendDOMNodeId, expectedDocument) => {
    const bound = await attachToExpectedDocument(tabId, expectedDocument);
    const actionContextId = await isolatedActionContext(tabId, bound, expectedDocument);
    await browser.debugger.sendCommand({ tabId }, 'DOM.enable').catch(() => {});
    const resolved = await browser.debugger.sendCommand(
      { tabId }, 'DOM.resolveNode', {
        backendNodeId: backendDOMNodeId,
        executionContextId: actionContextId,
      },
    );
    const objectId = resolved?.object?.objectId;
    if (!objectId) return { ok: false, error: 'node_unresolvable' };
    const guardTag = crypto.randomUUID();
    try {
      const out = await browser.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `async function (expectedHref, expectedTimeOrigin, guardTag) {
          if (!this.ownerDocument || this.ownerDocument.location.href !== expectedHref
              || !this.ownerDocument.defaultView
              || this.ownerDocument.defaultView.performance.timeOrigin !== expectedTimeOrigin) {
            return { __peerdDocumentGuard: guardTag };
          }
          this.scrollIntoView({ block: 'center', inline: 'center' });
          var tag = this.tagName ? this.tagName.toLowerCase() : '';
          var text = ((this.innerText || this.value || '') + '').trim().slice(0, 80);
          // why: native form activation carries live values that never appear
          // in click's args. Decide on the exact node and document immediately
          // before the effect, so action/formaction mutation cannot race a
          // separate preflight.
          var directSubmitter = typeof this.closest === 'function' ? this.closest('button,input') : null;
          var activationLabel = !directSubmitter && typeof this.closest === 'function'
            ? this.closest('label') : null;
          var submitter = directSubmitter || (activationLabel && activationLabel.control) || null;
          var submitterTag = submitter && submitter.tagName ? submitter.tagName.toLowerCase() : '';
          var submitterType = submitter && submitter.type ? submitter.type.toLowerCase() : '';
          var isSubmitter = (submitterTag === 'button' && submitterType === 'submit')
            || (submitterTag === 'input' && (submitterType === 'submit' || submitterType === 'image'));
          var form = isSubmitter ? submitter.form : null;
          if (form) {
            var getAttribute = Element.prototype.getAttribute;
            var submitterMethod = getAttribute.call(submitter, 'formmethod');
            var method = (submitterMethod || getAttribute.call(form, 'method') || 'get').toLowerCase();
            if (method !== 'dialog') {
              try {
                var submitterAction = getAttribute.call(submitter, 'formaction');
                var formAction = getAttribute.call(form, 'action');
                var action = submitterAction !== null ? submitterAction : formAction;
                var actionOrigin = action
                  ? new URL(action, this.ownerDocument.baseURI).origin
                  : this.ownerDocument.location.origin;
                if (actionOrigin !== this.ownerDocument.location.origin) {
                  return { ok: false, error: 'cross_origin_form_submission_blocked' };
                }
              } catch (e) {
                return { ok: false, error: 'cross_origin_form_submission_blocked' };
              }
            }
          }
          ${OBS_SETUP}
          if (typeof this.click === 'function') { this.click(); }
          else { this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
          ${OBS_COLLECT}
          return { tag: tag, text: text, mutations: __m };
        }`,
        arguments: [
          { value: expectedDocument.href },
          { value: expectedDocument.timeOrigin },
          { value: guardTag },
        ],
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      const v = out?.result?.value ?? {};
      if (v.__peerdDocumentGuard === guardTag) {
        return { ok: false, error: 'browser_target_changed', outcomeKind: 'pre-effect-failure' };
      }
      if (out?.exceptionDetails) {
        return { ok: false, error: `click_failed: ${out.exceptionDetails.text ?? 'page function threw'}` };
      }
      if (v.ok === false) return { ok: false, error: v.error ?? 'click_failed', outcomeKind: 'pre-effect-failure' };
      return { ok: true, tag: v.tag ?? '', text: v.text ?? '', mutations: v.mutations ?? null };
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (/context was destroyed|inspected target navigated|target closed|no longer exists|cannot find context/i.test(msg)) {
        return {
          ok: false,
          error: `click_outcome_unknown: the document changed while the action was dispatched (${msg})`,
          outcomeKind: 'host-lost',
        };
      }
      return { ok: false, error: `click_failed: ${msg}` };
    }
  };

  // Set the value of an input/textarea/contenteditable identified by its
  // backendDOMNodeId (from a ref). Uses the native value setter so React's
  // value tracking sees the change, then fires input/change (+ optional
  // Enter / requestSubmit). Args are passed via CDP `arguments`, never
  // string-interpolated — no injection surface.
  const setValueBackendNode = async (tabId, backendDOMNodeId, text, submit, expectedDocument) => {
    const bound = await attachToExpectedDocument(tabId, expectedDocument);
    const actionContextId = await isolatedActionContext(tabId, bound, expectedDocument);
    await browser.debugger.sendCommand({ tabId }, 'DOM.enable').catch(() => {});
    const resolved = await browser.debugger.sendCommand(
      { tabId }, 'DOM.resolveNode', {
        backendNodeId: backendDOMNodeId,
        executionContextId: actionContextId,
      },
    );
    const objectId = resolved?.object?.objectId;
    if (!objectId) return { ok: false, error: 'node_unresolvable' };
    const guardTag = crypto.randomUUID();
    try {
      const out = await browser.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `async function (text, submit, expectedHref, expectedTimeOrigin, guardTag) {
          if (!this.ownerDocument || this.ownerDocument.location.href !== expectedHref
              || !this.ownerDocument.defaultView
              || this.ownerDocument.defaultView.performance.timeOrigin !== expectedTimeOrigin) {
            return { __peerdDocumentGuard: guardTag };
          }
          this.scrollIntoView({ block: 'center' });
          // why: refuse before setting actor-provided text or firing input
          // handlers. The native form destination is otherwise absent from
          // type's tool args and invisible to the egress tripwire.
          var targetForm = submit ? this.form : null;
          var targetFormMethod = targetForm
            ? Element.prototype.getAttribute.call(targetForm, 'method')
            : null;
          if (targetForm && (targetFormMethod || 'get').toLowerCase() !== 'dialog') {
            try {
              var action = Element.prototype.getAttribute.call(targetForm, 'action');
              var actionOrigin = action
                ? new URL(action, this.ownerDocument.baseURI).origin
                : this.ownerDocument.location.origin;
              if (actionOrigin !== this.ownerDocument.location.origin) {
                return { ok: false, error: 'cross_origin_form_submission_blocked' };
              }
            } catch (e) {
              return { ok: false, error: 'cross_origin_form_submission_blocked' };
            }
          }
          if (typeof this.focus === 'function') this.focus();
          var tag = this.tagName ? this.tagName.toLowerCase() : '';
          ${OBS_SETUP}
          if (tag === 'input' || tag === 'textarea') {
            var proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            var d = Object.getOwnPropertyDescriptor(proto, 'value');
            if (d && d.set) { d.set.call(this, text); } else { this.value = text; }
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (tag === 'select') {
            // Native <select>: the model passes the option's visible LABEL
            // (that's all the a11y tree exposes); resolve it to the option's
            // value attribute (often different — label "Two" -> value "2") and
            // set THAT, else the browser silently ignores the assignment.
            var want = (text + '').trim();
            var opts = Array.prototype.slice.call(this.options || []);
            var match = null, i;
            for (i = 0; i < opts.length; i++) { if (((opts[i].label || opts[i].text || '') + '').trim() === want) { match = opts[i]; break; } }
            if (!match) { for (i = 0; i < opts.length; i++) { if (opts[i].value === want) { match = opts[i]; break; } } }
            if (!match) { for (i = 0; i < opts.length; i++) { if (((opts[i].text || '') + '').trim().toLowerCase() === want.toLowerCase()) { match = opts[i]; break; } } }
            if (!match) {
              __obs.disconnect();
              var avail = opts.map(function (o) { return ((o.text || '') + '').trim(); }).filter(Boolean).slice(0, 25);
              return { ok: false, error: 'no_option_matching: "' + want + '" — available: ' + avail.join(' | ') };
            }
            var sd = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
            if (sd && sd.set) { sd.set.call(this, match.value); } else { this.value = match.value; }
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (this.isContentEditable) {
            this.innerText = text;
            this.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            __obs.disconnect();
            return { ok: false, error: 'not_typable: ' + tag };
          }
          if (submit) {
            var mk = function (k) { return new KeyboardEvent(k, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }); };
            this.dispatchEvent(mk('keydown')); this.dispatchEvent(mk('keypress')); this.dispatchEvent(mk('keyup'));
            if (this.form && typeof this.form.requestSubmit === 'function') { try { this.form.requestSubmit(); } catch (e) {} }
          }
          ${OBS_COLLECT}
          return { ok: true, tag: tag, mutations: __m };
        }`,
        arguments: [
          { value: String(text ?? '') },
          { value: !!submit },
          { value: expectedDocument.href },
          { value: expectedDocument.timeOrigin },
          { value: guardTag },
        ],
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      const v = out?.result?.value ?? {};
      if (v.__peerdDocumentGuard === guardTag) {
        return { ok: false, error: 'browser_target_changed', outcomeKind: 'pre-effect-failure' };
      }
      if (out?.exceptionDetails) {
        return { ok: false, error: `type_failed: ${out.exceptionDetails.text ?? 'page function threw'}` };
      }
      if (v.ok === false) return {
        ok: false,
        error: v.error ?? 'type_failed',
        ...(v.error === 'cross_origin_form_submission_blocked' ? { outcomeKind: 'pre-effect-failure' } : {}),
      };
      return { ok: true, tag: v.tag ?? '', mutations: v.mutations ?? null };
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (/context was destroyed|inspected target navigated|target closed|no longer exists|cannot find context/i.test(msg)) {
        return {
          ok: false,
          error: `type_outcome_unknown: the document changed while the action was dispatched (${msg})`,
          outcomeKind: 'host-lost',
        };
      }
      return { ok: false, error: `type_failed: ${msg}` };
    }
  };

  // Read the framework component state behind a node (by backendDOMNodeId,
  // from a ref). Runs in the page's MAIN world via CDP, where the React
  // fiber / Vue component handles live. Returns { framework, component,
  // props, state } or { framework: null }. Validated live on react.dev.
  const readFrameworkState = async (tabId, backendDOMNodeId, expectedDocument) => {
    const bound = await attachToExpectedDocument(tabId, expectedDocument);
    await browser.debugger.sendCommand({ tabId }, 'DOM.enable').catch(() => {});
    const resolved = await browser.debugger.sendCommand(
      { tabId }, 'DOM.resolveNode', {
        backendNodeId: backendDOMNodeId,
        executionContextId: bound.contextId,
      },
    );
    const objectId = resolved?.object?.objectId;
    if (!objectId) return { ok: false, error: 'node_unresolvable' };
    const guardTag = crypto.randomUUID();
    const out = await browser.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: FRAMEWORK_STATE_FN,
      arguments: [
        { value: expectedDocument.href },
        { value: expectedDocument.timeOrigin },
        { value: guardTag },
      ],
      returnByValue: true,
    });
    const value = out?.result?.value ?? {};
    if (value.__peerdDocumentGuard === guardTag) {
      return { ok: false, error: 'browser_target_changed', outcomeKind: 'pre-effect-failure' };
    }
    if (out?.exceptionDetails) {
      return { ok: false, error: `read_state_failed: ${out.exceptionDetails.text ?? 'page function threw'}` };
    }
    return { ok: true, ...value };
  };

  // ── DESIGN-19 Tap A: CDP Network capture ─────────────────────────────────
  // Record the page's OWN requests while the web actor drives it, on preview/dev
  // where CDP ships (the same channel gate as every other debugger-pool path). Far
  // higher fidelity than the scripting fetch/XHR tap (Tap B): sees all requests
  // incl. workers, with real timing. CREDENTIALS ARE SANITIZED AT THIS BOUNDARY —
  // request headers are reduced to posture MARKERS (bearer/cookie presence), never
  // values; response bodies are size-capped samples. Nothing here stores a secret.
  const RESP_BODY_SAMPLE = 4_000;
  // Match the injected tap's ring-buffer posture. Long capture sessions stay
  // bounded even on pages that poll or stream many distinct requests.
  const NETWORK_CAPTURE_EVENT_CAP = 300;
  // Window for in-flight getResponseBody reads to land after Network.disable.
  const SETTLE_MS = 200;

  const onNetworkEvent = (/** @type {any} */ source, /** @type {string} */ method, /** @type {any} */ params) => {
    const cap = networkCaptures.get(source.tabId);
    if (!cap) return;
    if (method === 'Network.requestWillBeSent') {
      const req = params.request ?? {};
      const requestPolicy = networkCaptureRequestPolicy(req.url, params.type);
      if (requestPolicy === 'discard') {
        networkCaptures.discard(source.tabId);
        browser.debugger.sendCommand({ tabId: source.tabId }, 'Network.disable', {}).catch(() => {});
        return;
      }
      if (requestPolicy === 'ignore') return;
      const h = req.headers ?? {};
      // Posture markers ONLY — never the credential value.
      const hasAuth = Object.keys(h).some((k) => k.toLowerCase() === 'authorization');
      const bearer = hasAuth && /bearer/i.test(String(h.Authorization ?? h.authorization ?? ''));
      const hasCookie = Object.keys(h).some((k) => k.toLowerCase() === 'cookie');
      networkCaptures.record(source.tabId, params.requestId, {
        method: req.method ?? 'GET', url: req.url ?? '',
        reqHeaders: { ...(bearer ? { authorization: 'Bearer' } : hasAuth ? { authorization: 'present' } : {}), ...(hasCookie ? { cookie: 'present' } : {}) },
      }, NETWORK_CAPTURE_EVENT_CAP);
    } else if (method === 'Network.responseReceived') {
      const e = cap.get(params.requestId);
      if (e) { e.status = params.response?.status; e.contentType = params.response?.mimeType; }
    } else if (method === 'Network.loadingFinished') {
      const e = cap.get(params.requestId);
      // Best-effort response body sample for JSON-ish responses (shape sketch fuel).
      if (e && /json|javascript|text/i.test(e.contentType ?? '')) {
        browser.debugger.sendCommand({ tabId: source.tabId }, 'Network.getResponseBody', { requestId: params.requestId })
          .then((/** @type {any} */ r) => {
            if (!networkCaptures.isCurrent(source.tabId, cap)) return; // capture stopped or replaced
            const raw = typeof r?.body === 'string' ? (r.base64Encoded ? '' : r.body) : '';
            if (raw) {
              try { e.resSample = shapeSketch(JSON.parse(raw.slice(0, RESP_BODY_SAMPLE * 4))); }
              catch { e.resSample = 'string'; }
            }
          })
          .catch(() => {});
      }
    }
  };

  const startNetworkCapture = async (/** @type {number} */ tabId, /** @type {ExpectedDocument} */ expectedDocument) => {
    await attachToExpectedDocument(tabId, expectedDocument);
    ensureGlobalListeners();
    if (!netListenerBound) {
      netListenerBound = true;
      browser.debugger.onEvent.addListener(onNetworkEvent);
    }
    networkCaptures.begin(tabId);
    await browser.debugger.sendCommand({ tabId }, 'Network.enable', {}).catch(() => {});
  };

  const stopNetworkCapture = async (/** @type {number} */ tabId) => {
    const cap = networkCaptures.get(tabId);
    // why keep the map ALIVE during the settle: getResponseBody promises started on
    // loadingFinished write their sample back only while the registry entry is
    // truthy (the onNetworkEvent guard). Deleting first would make every in-flight
    // sample bail. So: stop new events (Network.disable), give pending body reads a
    // brief window to land, snapshot, THEN delete. Endpoints survive regardless
    // (recorded on requestWillBeSent); this only recovers the shape-sketch notes.
    await browser.debugger.sendCommand({ tabId }, 'Network.disable', {}).catch(() => {});
    await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });
    return networkCaptures.finish(tabId, cap);
  };

  // Policy cancellation must stop observing immediately and discard all bytes.
  // Delete before Network.disable so late protocol events cannot refill state.
  const discardNetworkCapture = async (/** @type {number} */ tabId) => {
    const hadCapture = networkCaptures.discard(tabId);
    if (!hadCapture) return;
    await browser.debugger.sendCommand({ tabId }, 'Network.disable', {}).catch(() => {});
  };

  // Tab removal and debugger detach already tear down the protocol session.
  // This synchronous hook only releases the manager's matching registry entry.
  const releaseNetworkCapture = (/** @type {number} */ tabId) => {
    networkCaptures.discard(tabId);
  };

  return {
    attach, detach, getAxTree, captureScreenshot,
    clickBackendNode, setValueBackendNode,
    readFrameworkState,
    startNetworkCapture, stopNetworkCapture, discardNetworkCapture,
    releaseNetworkCapture, onTabRemoved, onTabUpdated,
    isAttached: (tabId) => attached.has(tabId),
  };
};

// Page-side framework introspection (React fiber / Vue component → props +
// state). ES5, serialized into the page. Walks up the React fiber to the
// nearest function/class COMPONENT (host elements give props only);
// extracts useState values from the hooks linked list. Vue 3 via
// __vueParentComponent, Vue 2 via __vue__. safe() caps depth/breadth and
// stringifies functions so the result is always returnByValue-able.
//
// SYNC NOTE: peerd-runtime/dom/framework-state.js (readFrameworkStateInjected)
// is the no-CDP twin of this function — the same fiber/Vue walk reached via
// chrome.scripting world:'MAIN' (selector-resolved) instead of CDP
// callFunctionOn (this-bound). The two can't share source (scripting can't
// serialize an import; CDP needs a string), so any fix to the walk below must
// be mirrored there.
const FRAMEWORK_STATE_FN = `function (expectedHref, expectedTimeOrigin, guardTag) {
  var el = this;
  if (!el.ownerDocument || el.ownerDocument.location.href !== expectedHref
      || !el.ownerDocument.defaultView
      || el.ownerDocument.defaultView.performance.timeOrigin !== expectedTimeOrigin) {
    return { __peerdDocumentGuard: guardTag };
  }
  function safe(v, d) {
    d = d || 0;
    if (v == null) return v;
    var t = typeof v;
    if (t === 'function') return '<fn>';
    if (t !== 'object') return t === 'string' ? v.slice(0, 80) : v;
    if (d > 2) return '<…>';
    if (Array.isArray(v)) return '[' + v.length + (v.length ? ' items' : '') + ']';
    var o = {}, n = 0;
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (/^(_owner|_store|ref|key|__|\\$\\$typeof)/.test(k)) continue;
      if (n++ >= 12) { o['…'] = 1; break; }
      try { o[k] = safe(v[k], d + 1); } catch (e) { o[k] = '<err>'; }
    }
    return o;
  }
  var rk = Object.keys(el).find(function (k) {
    return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
  });
  if (rk) {
    var fiber = el[rk], hostProps = null;
    for (var i = 0; i < 40 && fiber; i++) {
      var type = fiber.type;
      if (typeof type === 'function') {
        var isClass = type.prototype && type.prototype.isReactComponent;
        var state;
        if (isClass) {
          state = safe(fiber.memoizedState);
        } else {
          state = []; var h = fiber.memoizedState;
          for (var j = 0; j < 24 && h; j++) {
            var ms = h.memoizedState;
            // skip effect/ref/context hook nodes — keep useState-ish values
            if (ms !== undefined && typeof ms !== 'function' && !(ms && (ms.tag !== undefined || ms.create !== undefined))) {
              state.push(safe(ms));
            }
            h = h.next;
          }
        }
        return { framework: 'react', component: type.displayName || type.name || '(anonymous)', props: safe(fiber.memoizedProps), state: state };
      }
      if (typeof type === 'string' && !hostProps) hostProps = safe(fiber.memoizedProps);
      fiber = fiber.return;
    }
    return { framework: 'react', component: null, props: hostProps, note: 'no component fiber above this node' };
  }
  if (el.__vueParentComponent) {
    var c = el.__vueParentComponent;
    return { framework: 'vue3', component: (c.type && (c.type.name || c.type.__name)) || null, props: safe(c.props), state: safe(c.setupState || c.data) };
  }
  if (el.__vue__) {
    var v = el.__vue__;
    return { framework: 'vue2', component: (v.$options && v.$options.name) || null, props: safe(v.$props), state: safe(v.$data) };
  }
  return { framework: null, note: 'no React/Vue markers on this element' };
}`;
