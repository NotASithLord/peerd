// @ts-check

import {
  BrowserAutomationPolicyError,
  browserDocumentIdentity,
  resolveTargetTab,
  scriptingTarget,
} from '/peerd-runtime/browser-authority.js';
import {
  AppBinaryFileError,
  AppDefaultMissingError,
  AppFileContentError,
} from './app-client.js';
import {
  COMPOSER_FILE_CONTENT_BYTES,
  composerReferenceRequestKey,
  truncateComposerUtf8,
} from '../shared/composer-reference-policy.js';

const throwIfAborted = (/** @type {Record<string,any>} */ ctx) => {
  if (!ctx.signal?.aborted) return;
  throw ctx.signal.reason instanceof Error
    ? ctx.signal.reason : new DOMException('composer stopped', 'AbortError');
};

/** @param {unknown} cause */
const knownFileReferenceError = (cause) => {
  if (!cause || typeof cause !== 'object') return null;
  const error = /** @type {{name?:unknown,outcomeKnown?:unknown}} */ (cause);
  // why: an explicit unknown receipt always wins over the local error type.
  // A channel may preserve a familiar name after dispatch without preserving
  // proof that the host actually completed the read.
  if (error.outcomeKnown === false || error.name === 'AbortError') return null;
  if (cause instanceof AppDefaultMissingError) return 'file_app_unavailable';
  if (cause instanceof AppBinaryFileError) return 'file_reference_not_text';
  if (cause instanceof AppFileContentError) return 'file_reference_invalid';
  if (error.name === 'NotFoundError') return 'file_not_found';
  return null;
};

/** @param {{operation:string,payload:Record<string,any>,context:Record<string,any>,result:any,allowed:boolean}} input */
export const composerReferenceAuditEntry = ({ operation, payload, context, result, allowed }) => {
  const sessionId = context.session?.sessionId ?? null;
  return Object.freeze({
    type: 'composer_reference_authority',
    sessionId,
    details: Object.freeze({
      operation,
      allowed,
      tabId: operation === 'turn.compose.capture-tab' ? payload.tabId : null,
      path: operation === 'turn.compose.read-file' ? payload.path : null,
      sessionId,
      ok: result?.ok === true,
      error: result?.ok === true ? null : result?.error ?? 'composer_reference_failed',
    }),
  });
};

// Injected classic-script body: it must remain self-contained.
function captureComposerTabInjected() {
  'use strict';
  const TEXT_CAP = 4000;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'SVG', 'IFRAME']);
  /** @param {Element} element */
  const visible = (element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width !== 0 || rect.height !== 0;
  };
  /** @type {string[]} */ const chunks = [];
  let length = 0;
  /** @param {Node} node */
  const visit = (node) => {
    if (length >= TEXT_CAP) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = String(node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) { chunks.push(text); length += text.length + 1; }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = /** @type {Element} */ (node);
    if (SKIP.has(element.tagName) || !visible(element)) return;
    for (const child of element.childNodes) visit(child);
  };
  if (document.body) visit(document.body);
  return {
    title: document.title,
    url: location.href,
    text: chunks.join(' ').slice(0, TEXT_CAP),
  };
}

export const createComposerReferenceAuthority = () => {
  return Object.freeze({
    pinContext: async (/** @type {Record<string,any>} */ offered,
      /** @type {readonly {operation:string,payload:Record<string,unknown>}[]} */ requests = []) => {
      if (!offered || typeof offered !== 'object' || !offered.tabs || !offered.scripting) {
        throw new TypeError('composer-reference-context-invalid');
      }
      const activeTab = offered.activeTab ?? null;
      // why: pin semantic posture once per composer call. A chat/tab switch
      // between two references cannot mix sessions or active browser targets.
      const pinned = {
        ...offered,
        actorType: offered.actorType ?? 'composer-reference',
        activeTab: activeTab && typeof activeTab.id === 'number'
          ? Object.freeze({ ...activeTab }) : null,
        denylist: Object.freeze([...(offered.denylist ?? [])]),
        session: offered.session?.sessionId
          ? Object.freeze({ sessionId: offered.session.sessionId }) : undefined,
      };
      // why: target probes are reverse effects, not admission work. Keeping
      // them lazy means plain/file-only input makes zero browser calls and a
      // stopped compose cannot spend time probing references it never uses.
      return Object.freeze({ ...pinned, referenceBindings: new Map() });
    },
    captureTab: async (/** @type {number|null} */ tabId,
      /** @type {Record<string,any>} */ ctx) => {
      try {
        throwIfAborted(ctx);
        const key = composerReferenceRequestKey('turn.compose.capture-tab', { tabId });
        let binding = ctx.referenceBindings?.get(key);
        if (!binding) {
          const pinnedTabId = tabId === null ? ctx.activeTab?.id : tabId;
          if (!Number.isSafeInteger(pinnedTabId) || pinnedTabId <= 0) {
            binding = { error: 'no_target_tab' };
            ctx.referenceBindings?.set(key, binding);
          } else {
            const tab = await resolveTargetTab({ tabId: pinnedTabId }, /** @type {any} */ (ctx));
            throwIfAborted(ctx);
            binding = tab?.id ? {
              tabId: tab.id, identity: browserDocumentIdentity(tab),
            } : { error: 'no_target_tab' };
            // why: retries may repeat this exact read after a channel loss,
            // but may never re-resolve it to a replacement document.
            ctx.referenceBindings?.set(key, binding);
          }
        }
        if (binding?.error) return { ok: false, outcomeKnown: true, error: binding.error };
        if (!binding?.tabId || !binding?.identity) {
          return { ok: false, outcomeKnown: true, error: 'composer_reference_not_authorized' };
        }
        // why: the tab and document identity were host-pinned before the
        // controller started. Revalidate that exact document immediately
        // before and after capture; never resolve a replacement target.
        const identity = binding.identity;
        const tab = await resolveTargetTab({ tabId: binding.tabId }, /** @type {any} */ ({
          ...ctx, authorityDocumentIdentity: identity,
        }));
        throwIfAborted(ctx);
        if (!tab?.id) {
          return { ok: false, outcomeKnown: true, error: 'tab_blocked: target_changed' };
        }
        const results = await ctx.scripting.executeScript({
          target: scriptingTarget(tab),
          func: captureComposerTabInjected,
        });
        throwIfAborted(ctx);
        const snapshot = results?.[0]?.result;
        if (!snapshot || typeof snapshot.url !== 'string') {
          return { ok: false, outcomeKnown: true, error: 'capture_returned_nothing' };
        }
        // why: re-probe the browser-owned document after the read. A redirect
        // or document replacement cannot turn an approved source into bytes
        // from a different origin.
        const stillLive = await resolveTargetTab({ tabId: tab.id }, /** @type {any} */ ({
          ...ctx, authorityDocumentIdentity: identity,
        }));
        throwIfAborted(ctx);
        if (!stillLive) {
          return { ok: false, outcomeKnown: true, error: 'tab_blocked: target_changed' };
        }
        const origin = new URL(snapshot.url).origin;
        if (snapshot.url !== identity.href || origin !== identity.origin) {
          return { ok: false, outcomeKnown: true, error: 'tab_blocked: target_changed' };
        }
        return { ok: true, outcomeKnown: true, value: {
          origin,
          snapshot: {
            title: typeof snapshot.title === 'string' ? snapshot.title.slice(0, 4096) : '',
            url: snapshot.url.slice(0, 4096),
            text: typeof snapshot.text === 'string' ? snapshot.text.slice(0, 4000) : '',
          },
        } };
      } catch (cause) {
        if (cause instanceof BrowserAutomationPolicyError) {
          return { ok: false, outcomeKnown: true, error: `${cause.code}: ${cause.content}` };
        }
        if (cause && typeof cause === 'object'
            && /** @type {{outcomeKnown?:unknown}} */ (cause).outcomeKnown === true) {
          return { ok: false, outcomeKnown: true, error: 'capture_failed' };
        }
        // why: a generic/abort/transport exception cannot prove whether the
        // browser read completed. Preserve uncertainty through the outer
        // compose call instead of fabricating a retryable lookup refusal.
        return { ok: false, outcomeKnown: false, retryable: false,
          error: 'composer_capture_outcome_unknown' };
      }
    },
    readFile: async (/** @type {string} */ path,
      /** @type {Record<string,any>} */ ctx) => {
      if (!ctx.appClient?.readFile) {
        return { ok: false, outcomeKnown: true, error: 'file_store_unavailable' };
      }
      const sessionId = ctx.session?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, outcomeKnown: true, error: 'file_session_unavailable' };
      }
      try {
        throwIfAborted(ctx);
        const content = await ctx.appClient.readFile({
          path, sessionId,
        });
        throwIfAborted(ctx);
        return { ok: true, outcomeKnown: true,
          value: { content: truncateComposerUtf8(content, COMPOSER_FILE_CONTENT_BYTES) } };
      } catch (cause) {
        const knownError = knownFileReferenceError(cause);
        if (knownError) {
          return { ok: false, outcomeKnown: true, error: knownError };
        }
        return { ok: false, outcomeKnown: false, retryable: false,
          error: 'composer_file_read_outcome_unknown' };
      }
    },
  });
};
