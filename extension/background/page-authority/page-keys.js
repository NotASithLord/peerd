// @ts-check

import { definePageAuthorityHandler } from './handler.js';
// page_keys — dispatch real, trusted keyboard events via CDP.
//
// JS-synthesized KeyboardEvents (the kind dispatchEvent produces) carry
// isTrusted=false. Hostile SPAs like Gmail filter those out — they
// only respect keyboard input the user actually generated. CDP's
// Input.dispatchKeyEvent produces events with isTrusted=true that
// pass every gate; that's how DevTools' "Toggle device toolbar" can
// simulate user typing.
//
// Use cases:
//   • Gmail's keyboard shortcuts (`*` then `u` to select all unread,
//     `Shift+I` to mark as read, `g` then `i` to go to inbox)
//   • Slack's quick-switcher (`Cmd+K`)
//   • Linear's command palette (`Cmd+K`)
//   • Any app where clicking through 50 UI elements equals one
//     keyboard shortcut.
//
// Input format ("keys" string):
//   Space-separated tokens, each a single key combo. Each token can
//   contain `+`-joined modifiers ending with the base key:
//
//     "Shift+I"        → keydown(I, shift) + keyup(I, shift)
//     "g i"            → press g, then press i (sequence)
//     "* u"            → press *, then press u (Gmail bulk-select)
//     "Cmd+K"          → keydown(K, meta) + keyup(K, meta)
//     "Enter"          → press Enter
//     "ArrowDown ArrowDown Enter" → down arrow twice + Enter
//
// Same trust model as page_exec: requires debugger attach (banner
// shows), denylist-gated against the active tab.

import {
  browserTargetRefusalResult,
  cdpUnavailableError,
  resolveTargetTab,
  unverifiedBrowserTargetVerdict,
} from '/peerd-runtime/browser-authority.js';

const MAX_KEYS_LENGTH = 1000;
const MAX_TOKENS = 200;

/**
 * Harness-injected CDP pool — not on the ToolContext typedef, so page_keys
 * narrows ctx through this with an erased cast. events is the parsed key list.
 *
 * @typedef {{ key: string, modifiers: number, text?: string }} KeyEvent
 * @typedef {{ dispatchKeys?: (tabId: number, events: KeyEvent[]) => Promise<unknown> }} DebuggerPool
 */

/** @type {Record<string, number>} */
const MODIFIER_BITS = {
  'alt': 1, 'ctrl': 2, 'control': 2, 'meta': 4, 'cmd': 4, 'command': 4,
  'shift': 8, 'super': 4, 'win': 4,
};

/** @type {import('/shared/tool-types.js').Tool} */
export const pageKeysTool = definePageAuthorityHandler({

  execute: async (args, ctx) => {
    if (typeof args?.keys !== 'string' || args.keys.length === 0) {
      return { ok: false, error: 'keys_required' };
    }
    if (args.keys.length > MAX_KEYS_LENGTH) {
      return { ok: false, error: `keys_too_long: ${args.keys.length} > ${MAX_KEYS_LENGTH}` };
    }
    // why: debuggerPool is SW-injected onto ctx but absent from the
    // ToolContext typedef — narrow it through an erased cast.
    const debuggerPool = /** @type {{ debuggerPool?: DebuggerPool }} */ (ctx).debuggerPool;
    if (!debuggerPool || typeof debuggerPool.dispatchKeys !== 'function') {
      // No scripting fallback on purpose: the point of this tool is
      // TRUSTED (isTrusted=true) keystrokes, which only CDP can produce —
      // synthetic KeyboardEvents would be a fake, not a fallback.
      return {
        ok: false,
        // why: cdpUnavailableReason rides on ctx (SW-set), off the typedef.
        error: cdpUnavailableError(/** @type {{ cdpUnavailableReason?: string|null }} */ (ctx), 'trusted (isTrusted) keyboard input',
          'Use type {selector|ref} for form fields; keyboard-shortcut-driven UIs cannot be driven here.'),
      };
    }
    let events;
    try {
      events = parseKeySequence(args.keys);
    } catch (e) {
      return { ok: false, error: `parse_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (events.length > MAX_TOKENS) {
      return { ok: false, error: `too_many_tokens: ${events.length} > ${MAX_TOKENS}` };
    }
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };

    // CDP trusted input is tab-scoped. Input.dispatchKeyEvent has no document,
    // frame, execution-context, or loader target, so a navigation between the
    // verified-document check and dispatch could deliver keys to a private
    // replacement page. There is no honest trusted-input fallback.
    return browserTargetRefusalResult(unverifiedBrowserTargetVerdict({
      message: 'Trusted keyboard input cannot be bound to the verified document, so peerd did not send any keys.',
      correction: 'Use type with a selector or element ref. That operation is bound to the checked document.',
    }), { effectCompleted: false });

  },
});

/**
 * Parse a "keys" string into CDP-event objects.
 *   "Shift+I g"  → [{key:'I', code:'KeyI', modifiers:8}, {key:'g', code:'KeyG'}]
 */
/**
 * @param {string} keys
 * @returns {KeyEvent[]}
 */
const parseKeySequence = (keys) => {
  const tokens = keys.trim().split(/\s+/).filter(Boolean);
  /** @type {KeyEvent[]} */
  const events = [];
  for (const tok of tokens) {
    const parts = tok.split('+').filter(Boolean);
    if (parts.length === 0) throw new Error(`empty token: "${tok}"`);
    const baseKey = parts[parts.length - 1];
    const modKeys = parts.slice(0, -1);
    let modBits = 0;
    for (const m of modKeys) {
      const bit = MODIFIER_BITS[m.toLowerCase()];
      if (!bit) throw new Error(`unknown modifier: "${m}"`);
      modBits |= bit;
    }
    events.push({
      key: baseKey,
      modifiers: modBits,
      // Printable, non-modified, single-character: also emit a text
      // event so input boxes accept it. Shortcuts like "Shift+I"
      // skip this — they want the keydown, not a typed letter.
      ...(modBits === 0 && /^[\x20-\x7E]$/.test(baseKey) ? { text: baseKey } : {}),
    });
  }
  return events;
};

// Exported for unit tests.
export const _parseKeySequenceForTests = parseKeySequence;
