// @ts-check
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

import { wrapUntrusted } from '../prompt-wrap.js';
import { resolveTargetTab, originOfUrl, cdpUnavailableError } from './dom-helpers.js';

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
export const pageKeysTool = {
  name: 'page_keys',
  primitive: 'tab',
  description: [
    'Dispatch real (isTrusted=true) keyboard events through CDP. Use',
    'when a site has keyboard shortcuts that beat its UI ergonomically',
    '(Gmail "* u" to select-all-unread + Shift+I to mark-as-read,',
    'Slack/Linear Cmd+K, etc.) AND when synthetic events would be',
    'rejected (Gmail filters isTrusted=false).',
    '',
    '`keys` is a space-separated sequence of key tokens. Each token',
    'is `+`-joined modifiers ending in the base key:',
    '  "Shift+I"            single combo',
    '  "g i"                sequence: g then i',
    '  "* u"                Gmail: select-all-unread',
    '  "Cmd+K"              command palette',
    '  "Escape"             single key',
    '  "ArrowDown ArrowDown Enter"   navigate + select',
    '',
    'Modifiers: Shift, Ctrl/Control, Alt, Meta/Cmd/Command/Super/Win.',
    'For typing free-form text into an input, use the `type` tool',
    'instead — it\'s cheaper and doesn\'t need the debugger banner.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      keys: {
        type: 'string',
        description: 'Space-separated sequence of key tokens (e.g. "Shift+I", "g i", "* u", "Cmd+K Enter"). Max 1000 chars.',
      },
      tabId: {
        type: 'integer',
        description: 'Optional tab id; defaults to the active tab.',
      },
    },
    required: ['keys'],
  },
  sideEffect: 'write',
  origins: (_args, ctx) => ctx.activeTab?.origin ? [ctx.activeTab.origin] : [],

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
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };

    let events;
    try {
      events = parseKeySequence(args.keys);
    } catch (e) {
      return { ok: false, error: `parse_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (events.length > MAX_TOKENS) {
      return { ok: false, error: `too_many_tokens: ${events.length} > ${MAX_TOKENS}` };
    }

    try {
      await debuggerPool.dispatchKeys(tab.id, events);
    } catch (e) {
      const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
      if (/Detached|debugger is not attached/i.test(msg)) {
        return { ok: false, error: `debugger_detached: ${msg}` };
      }
      if (/Cannot access|cannot attach|chrome:\/\//i.test(msg)) {
        return { ok: false, error: `cannot_attach_to_tab: ${msg}` };
      }
      return { ok: false, error: `dispatch_failed: ${msg}` };
    }

    return {
      ok: true,
      content: wrapUntrusted({
        origin: originOfUrl(tab.url),
        tool: 'page_keys',
        body: `Dispatched ${events.length} key event(s): ${args.keys}`,
      }),
    };
  },
};

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
