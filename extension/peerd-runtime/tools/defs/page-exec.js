// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// page_exec — devtools-style JS execution in the page world.
//
// Uses chrome.debugger (CDP Runtime.evaluate) instead of
// chrome.scripting.executeScript. The difference matters in two
// situations where page_eval fails:
//
//   1. Trusted Types pages (Gmail, Notion, parts of GitHub, Slack web).
//      These pages reject injected script elements, so page_eval cannot
//      run on them. CDP evaluation is the user-privileged channel (the
//      same one DevTools uses); the allowUnsafeEvalBlockedByCSP flag is
//      its sanctioned opt-in for evaluating on Trusted-Types pages.
//
//   2. Hostile-to-automation pages. The userGesture flag makes
//      gesture-gated APIs (focus management, clipboard, etc.) treat
//      the evaluation as a real user action.
//
// Chrome shows a persistent "X is being debugged by this extension"
// banner across the top of the tab while we're attached. The banner is
// a feature: it's the user-visible signal that automation is active.
// The pool keeps the attachment alive across the SW lifetime so the
// banner doesn't flicker per call.
//
// Trust model: identical to page_eval — same trust boundary, same
// sideEffect, same denylist gating. The capability ceiling is the
// same (arbitrary code in page world). page_exec is just a more
// powerful injection channel.

import { wrapUntrusted } from '../prompt-wrap.js';
import {
  browserDocumentIdentity,
  resolveTargetTab,
  originOfUrl,
  cdpUnavailableError,
} from './dom-helpers.js';
import {
  browserDocumentRefusalFrom,
} from '../browser-automation-policy.js';

const MAX_CODE_CHARS = 200_000;
const MAX_OUTPUT_CHARS = 8000;
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */

/**
 * page_exec deliberately returns the wrapped page body in BOTH the ok and the
 * thrown cases — the captured console/return/error text is what the agent reads
 * either way (the dispatcher spreads it through). The shared ToolResultErr has
 * no `content` slot, so the error branch here is `ToolResult` widened with an
 * optional `content`. why: a JSDoc-only widening of the existing runtime shape,
 * not a behavior change; mirrors the dweb tools' DwebToolResult idiom.
 *
 * @typedef {ToolResult | { ok: false, error: string, content?: string }} PageExecResult
 */

/** @typedef {Omit<Tool, 'execute'> & { execute: (args: any, ctx: import('/shared/tool-types.js').ToolContext) => Promise<PageExecResult> }} PageExecTool */

/**
 * The CDP `Runtime.evaluate` result (plus the pool's captured console). The
 * fields are the dynamic CDP wire shape — read defensively below.
 *
 * @typedef {Object} CdpEvalResult
 * @property {{ type?: string, value?: unknown, description?: string }} [result]
 * @property {{ text: string, exception?: { description?: string } }} [exceptionDetails]
 * @property {string} [_capturedConsole]
 */

/**
 * page_exec's SW-injected ctx extras (off the base ToolContext contract).
 *
 * @typedef {import('/shared/tool-types.js').ToolContext & {
 *   debuggerPool?: { evaluate?: (tabId: number, expression: string, options?: { expectedDocument?: ReturnType<typeof browserDocumentIdentity> }) => Promise<CdpEvalResult> },
 *   cdpUnavailableReason?: string | null,
 * }} PageExecCtx
 */

/** @type {PageExecTool} */
export const pageExecTool = composeTool("page_exec", {

  execute: async (args, toolCtx) => {
    // why: debuggerPool/cdpUnavailableReason ride the opaque base-contract
    // slots (the SW gates CDP on advancedAutomationOn); narrow once here.
    const ctx = /** @type {PageExecCtx} */ (toolCtx);
    if (typeof args?.expression !== 'string' || args.expression.length === 0) {
      return { ok: false, error: 'expression_required' };
    }
    if (args.expression.length > MAX_CODE_CHARS) {
      return { ok: false, error: `expression_too_large: ${args.expression.length} > ${MAX_CODE_CHARS}` };
    }
    const evaluate = ctx.debuggerPool?.evaluate;
    if (typeof evaluate !== 'function') {
      // No scripting fallback here on purpose: CDP evaluation is the ONLY
      // channel that works on Trusted-Types pages — faking it with an
      // injected script would fail on exactly the pages this tool exists
      // for. The error names the real reason (off vs nonexistent).
      return {
        ok: false,
        error: cdpUnavailableError(ctx,
          'debugger-channel JS execution (incl. Trusted-Types pages like Gmail/Notion)',
          'Use page_eval on ordinary pages, or read_page + click/type for interaction.'),
      };
    }
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };

    let cdpResult;
    try {
      cdpResult = await evaluate(tab.id, args.expression, {
        expectedDocument: browserDocumentIdentity(tab),
      });
    } catch (e) {
      const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
      const outcomeKind = /** @type {{ outcomeKind?: string }} */ (e)?.outcomeKind;
      const targetRefusal = browserDocumentRefusalFrom(e);
      if (targetRefusal) return targetRefusal;
      if (outcomeKind === 'host-lost') {
        return {
          ok: false,
          error: `page_exec_outcome_unknown: the debugger channel ended after execution was dispatched (${msg}). Verify the page state before retrying.`,
          outcomeKind,
        };
      }
      // Common: user clicked Cancel on the banner. Detached us mid-flight.
      if (/Detached|debugger is not attached/i.test(msg)) {
        return { ok: false, error: `debugger_detached: ${msg}` };
      }
      // Tab is on a chrome:// or chrome-extension:// URL we can't attach to.
      if (/Cannot access|cannot attach|chrome:\/\//i.test(msg)) {
        return { ok: false, error: `cannot_attach_to_tab: ${msg}` };
      }
      return {
        ok: false,
        error: `debugger_threw: ${msg}`,
        ...(outcomeKind ? { outcomeKind } : {}),
      };
    }

    const origin = originOfUrl(tab.url);
    const exc = cdpResult?.exceptionDetails;
    const threw = !!exc;
    const returnValue = formatReturn(cdpResult?.result);
    const consoleOutput = cdpResult?._capturedConsole ?? '';
    const errorText = exc
      ? exc.text
        + (exc.exception?.description
          ? `\n${exc.exception.description}`
          : '')
      : '';
    return /** @type {PageExecResult} */ ({
      ok: !threw,
      content: wrapUntrusted({
        origin, tool: 'page_exec',
        body: formatBody({ url: tab.url ?? '', threw, returnValue, consoleOutput, errorText }),
      }),
      ...(threw ? { error: errorText.split('\n')[0] } : {}),
    });
  },
});

/** @param {{ type?: string, value?: unknown, description?: string } | undefined} result @returns {string | undefined} */

const formatReturn = (result) => {
  if (!result) return undefined;
  if (result.type === 'undefined') return undefined;
  if (result.value !== undefined) {
    if (typeof result.value === 'string') return result.value;
    try { return JSON.stringify(result.value, null, 2); }
    catch { return String(result.value); }
  }
  return result.description ?? result.type;
};

/** @param {unknown} s @param {number} n @returns {string} */
const truncate = (s, n) => {
  const str = typeof s === 'string' ? s : String(s);
  if (str.length <= n) return str;
  return `${str.slice(0, n)}\n... (${str.length - n} chars elided)`;
};

/** @param {{ url: string, threw: boolean, returnValue?: string, consoleOutput: string, errorText: string }} snap @returns {string} */
const formatBody = (snap) => {
  const lines = [
    `URL: ${snap.url}`,
    `Status: ${snap.threw ? 'threw' : 'ok'}`,
  ];
  if (snap.threw) {
    lines.push('', '[ERROR]', truncate(snap.errorText, MAX_OUTPUT_CHARS));
  }
  if (snap.consoleOutput) {
    lines.push('', '[CONSOLE]', truncate(snap.consoleOutput, MAX_OUTPUT_CHARS));
  }
  if (snap.returnValue !== undefined) {
    lines.push('', '[RETURN]', truncate(snap.returnValue, MAX_OUTPUT_CHARS));
  }
  return lines.filter(Boolean).join('\n');
};
