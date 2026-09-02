// @ts-check
// Input bar — multi-line textarea + Send button (and Stop while streaming).
//
// V1 behaviors:
//   - Enter sends; Shift+Enter inserts a newline; Cmd/Ctrl+Enter also sends.
//   - Textarea is ALWAYS enabled. Sending while a turn is streaming
//     aborts the in-flight turn (SW handles this in agent/send) and
//     starts a new one with the new message appended — steer-live UX.
//   - A separate Stop button appears next to Send while streaming. It
//     posts agent/stop, which aborts without queueing a new message.
//   - Empty messages are dropped client-side AND server-side.
//   - When voice mode is enabled, a mic button is rendered next to the
//     Send button. Transcription chunks are appended to whatever the
//     user has already typed; committed chunks become the new baseline
//     so the next streaming partial doesn't overwrite the previous one.
//
// Composer palette (feature-04): as the user types `/` (slash command) or
// `@` (file/tab reference), we detect the in-progress trigger via
// activeTrigger() and show the CommandPalette popup above the textarea.
// Arrow keys navigate, Enter/Tab commit, Esc closes — all routed here so
// focus never leaves the textarea. Committing splices the chosen
// candidate's insert text over the trigger span.
//
// File attachments: a ghost paperclip button (file picker) + paste-an-
// image on the textarea. Files become base64 here (FileReader) and ride
// agent/send as attachments:[{name, mediaType, size, data}]; staged
// files render as removable chips above the action row and clear on a
// successful send. ANTHROPIC-ONLY, gated the same way chat-view gates
// the EffortDial — on other providers the button is hidden entirely (a
// control that silently fails is a lie). Validation mirrors the SW's
// pure core (loop/attachments.js) for instant feedback; the SW
// re-validates fail-closed.

import m from '/vendor/mithril/mithril.js';
import {
  MicButton, activeTrigger, classifyAttachment, ATTACHMENT_CAPS, MAX_ATTACHMENTS_PER_MESSAGE,
  DOC_MEDIA_TYPES, IMAGE_MEDIA_TYPES, formatBytes,
} from '/peerd-runtime/ui.js';
import { CommandPalette, visibleCandidates, PALETTE_OPTION_ID } from './command-palette.js';
import { CostChip } from './cost-meter.js';
import {
  composerForState, composerUnavailableCopy, composerWarningCopy,
} from '../provider-readiness.js';

/** @typedef {import('../chat-reducer.js').ChatState} ChatState */
/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {import('./command-palette.js').Trigger} Trigger */
/** @typedef {import('./command-palette.js').PaletteCandidate} PaletteCandidate */
/** @typedef {import('./command-palette.js').PaletteItems} PaletteItems */

/** @typedef {{ name: string, mediaType: string, size: number, data: string }} StagedAttachment */
/** @typedef {{operationId:string,text:string,goal:boolean,sessionId:string|null,hadAttachments:boolean,source?:'composer'|'starter'}} UnconfirmedSend */

/**
 * Component-local state for InputBar.
 * @typedef {Object} InputBarState
 * @property {string|null|undefined} _sid       which chat the draft belongs to
 * @property {string} value
 * @property {boolean} busy
 * @property {string} transcriptBaseline
 * @property {Trigger|null} trigger
 * @property {number} paletteIndex
 * @property {PaletteItems} items
 * @property {string|null} itemsKey
 * @property {HTMLTextAreaElement|null} el
 * @property {StagedAttachment[]} attachments
 * @property {string|null} attachError
 * @property {string|null} sendError
 * @property {UnconfirmedSend|null} unconfirmedSend
 * @property {HTMLInputElement|null} fileInputEl
 * @property {string|null} [sendAccent]
 * @property {(() => void)|null} [resizeListener]
 */

const CHAT_INPUT_TARGET = 'chat-input';

// The last composerPrefill nonce adopted (§4c). MODULE-level, not component
// state: the surface never clears composerPrefill, and InputBar unmounts on
// ordinary navigation (chats list, home view switches) - a marker on vnode
// state would die with it and the remounted bar would re-adopt the stale
// prefill over whatever chat's saved draft is now in view.
let consumedPrefillNonce = 0;

// The five brand custom props (sidepanel :root — same palette as
// shared/brand.css). The send disc draws ONE of these at random per
// draft (picked when the draft starts, stable until cleared — no
// per-keystroke strobing). why: the composer's send moment is the
// panel chrome's single color accent, and randomizing WHICH brand
// color keeps the five-color identity alive without ever showing more
// than one at a time (owner experiment, 2026-06-12).
const SEND_ACCENTS = ['--cyan', '--red', '--amber', '--green', '--magenta'];

const ARROW_ICON = () => m('svg', {
  viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': 'true',
}, m('path', {
  d: 'M8 12.5V3.5M3.5 8L8 3.5L12.5 8',
  fill: 'none', stroke: 'currentColor',
  'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
}));

// Paperclip glyph — monochrome (currentColor), same stroke voice as the
// send arrow above.
const PAPERCLIP_ICON = () => m('svg', {
  viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': 'true',
}, m('path', {
  d: 'M13.2 7.3l-5.6 5.6a3.4 3.4 0 0 1-4.8-4.8L8.6 2.3a2.3 2.3 0 0 1 3.2 3.2l-5.7 5.7a1.13 1.13 0 0 1-1.6-1.6l5.2-5.2',
  fill: 'none', stroke: 'currentColor',
  'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
}));

// What the picker offers = exactly what classifyAttachment admits.
//
// The office/e-book types are listed by EXTENSION as well as media type, and
// that is load-bearing rather than belt-and-braces: the OS media-type registry
// often has no entry for .docx, so a media-type-only `accept` greys the file
// out in the picker even though peerd can read it. classifyAttachment applies
// the same extension fallback, so the two stay in step.
const DOC_ACCEPT_EXTENSIONS = [
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.epub',
  '.doc', '.xls', '.ppt',
];
const ATTACH_ACCEPT = [
  ...IMAGE_MEDIA_TYPES, 'application/pdf', 'text/*',
  ...DOC_MEDIA_TYPES, ...DOC_ACCEPT_EXTENSIONS,
].join(',');
const BASIC_ATTACH_ACCEPT = [...IMAGE_MEDIA_TYPES, 'application/pdf', 'text/*'].join(',');

// File → base64 payload (no data: prefix). FileReader keeps the panel
// off raw ArrayBuffer/btoa chunking for multi-MB files.
/**
 * @param {File} file
 * @returns {Promise<string>}
 */
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(r.error ?? new Error(`could not read ${file.name}`));
  r.readAsDataURL(file);
});

// Grow the textarea to fit its content on every redraw. why: a textarea
// never grows on its own - without this the box stays at its two-row
// minimum and any longer draft hides behind an inner scrollbar. The
// CSS min/max-height still bound it; past the max the box scrolls.
/** @param {HTMLTextAreaElement} el */
const autosize = (el) => {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

// Reset the palette to closed/empty.
/** @param {InputBarState} ui */
const closePalette = (ui) => {
  ui.trigger = null;
  ui.paletteIndex = 0;
};

// Fetch candidate data for the current trigger type, then redraw. Cached
// per trigger-type-key so we don't re-query the SW on every keystroke —
// only when the TYPE of thing being completed changes (commands vs tabs
// vs files). Filtering of the cached list happens client-side, live.
/**
 * @param {InputBarState} ui
 * @param {Send} send
 * @param {Trigger} trigger
 */
const ensureItems = async (ui, send, trigger) => {
  const key = trigger.type === 'command' ? 'command'
    : trigger.kind === 'tab' ? 'tab'
    : trigger.kind === 'file' ? 'file'
    : 'kinds';
  if (ui.itemsKey === key) return;
  ui.itemsKey = key;
  if (key === 'command') {
    const r = await send({ type: 'commands/list' });
    if (r?.ok) ui.items = { ...ui.items, commands: r.commands };
  } else if (key === 'tab') {
    const r = await send({ type: 'composer/tabs' });
    if (r?.ok) ui.items = { ...ui.items, tabs: r.tabs };
  } else if (key === 'file') {
    const r = await send({ type: 'composer/files' });
    if (r?.ok) ui.items = { ...ui.items, files: r.files };
  }
  m.redraw();
};

// Per-chat composer drafts: a half-typed message is saved keyed by sessionId and
// restored when you come back to that chat (the InputBar is keyed by sessionId in
// ChatView, so a switch remounts it and re-reads the right draft). Cleared on send.
/** @param {string|null|undefined} sid */
const draftKey = (sid) => `peerd.draft.${sid || 'new'}`;
/** @param {string|null|undefined} sid */
const loadDraft = (sid) => { try { return localStorage.getItem(draftKey(sid)) || ''; } catch { return ''; } };
/**
 * @param {string|null|undefined} sid
 * @param {string} text
 */
const saveDraft = (sid, text) => {
  try { if (text) localStorage.setItem(draftKey(sid), text); else localStorage.removeItem(draftKey(sid)); }
  catch { /* private mode — drafts are best-effort */ }
};
const unconfirmedKey = (/** @type {string|null|undefined} */ sid) =>
  `peerd.unconfirmed-send.${sid || 'new'}`;
/** @returns {UnconfirmedSend|null} */
const loadUnconfirmed = (/** @type {string|null|undefined} */ sid) => {
  try {
    const value = JSON.parse(localStorage.getItem(unconfirmedKey(sid)) ?? 'null');
    return value && typeof value.operationId === 'string' && typeof value.text === 'string'
      ? {
        operationId: value.operationId,
        text: value.text,
        goal: value.goal === true,
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
        hadAttachments: value.hadAttachments === true,
        source: value.source === 'starter' ? 'starter' : 'composer',
      } : null;
  } catch { return null; }
};
export const hasUnconfirmedAgentSend = (/** @type {string|null|undefined} */ sid) =>
  loadUnconfirmed(sid) !== null || (!!sid && loadUnconfirmed(null) !== null);
/** @param {string|null|undefined} sid @param {InputBarState['unconfirmedSend']} value */
const saveUnconfirmed = (sid, value) => {
  try {
    // Never persist attachment bytes. Delivery checks are status-only; if a
    // reload loses staged bytes, the UI says to reattach only after the kernel
    // proves the original operation did not settle successfully.
    if (value) localStorage.setItem(unconfirmedKey(sid), JSON.stringify({
      operationId: value.operationId,
      text: value.text,
      goal: value.goal,
      sessionId: value.sessionId,
      hadAttachments: value.hadAttachments,
      source: value.source,
    }));
    else localStorage.removeItem(unconfirmedKey(sid));
  } catch { /* private mode keeps the in-memory fence */ }
};

/**
 * @param {Object} options
 * @param {Send} options.send
 * @param {{type:'agent/send'}&Record<string,any>} options.message
 * @param {UnconfirmedSend} options.pending
 * @param {()=>string|null|undefined} [options.currentSessionId]
 */
export const sendAgentWithCustody = async ({ send, message, pending, currentSessionId }) => {
  const originalSessionId = pending.sessionId;
  const settle = (/** @type {UnconfirmedSend|null} */ value) => {
    saveUnconfirmed(originalSessionId, value);
    if (value) return;
    const current = currentSessionId?.();
    // why: a first send can acquire its durable session id while awaiting the
    // reply, but the user can also switch to an unrelated chat. Clear only an
    // adopted copy of this exact operation; never erase that chat's own fence.
    if (current && current !== originalSessionId
      && loadUnconfirmed(current)?.operationId === pending.operationId) {
      saveUnconfirmed(current, null);
    }
  };
  settle(pending);
  try {
    const reply = await send(message);
    if (reply?.outcomeKnown !== false) settle(null);
    return reply;
  } catch (cause) {
    if (/** @type {{outcomeKnown?:unknown}} */ (cause)?.outcomeKnown === true) settle(null);
    throw cause;
  }
};

/**
 * @typedef {{
 *   state: InputBarState,
 *   attrs: {
 *     state: ChatState, send: Send, voiceManager?: any,
 *     goalArmed?: boolean, onGoalSent?: () => void,
 *   },
 * }} InputBarVnode
 */

export const InputBar = {
  /** @param {InputBarVnode} vnode */
  oninit(vnode) {
    // Restore this chat's saved draft (empty for a fresh / never-drafted chat).
    // _sid tracks which chat the draft belongs to; the view swaps drafts when the
    // session changes (keying a lone child among unkeyed siblings throws, so we
    // handle the switch in-place instead of remounting).
    vnode.state._sid = vnode.attrs.state?.session?.sessionId;
    vnode.state.value = loadDraft(vnode.state._sid);
    vnode.state.busy = false;
    // why: the transcriber streams partial chunks until it COMMITS
    // them. We keep a baseline so partials overwrite themselves but
    // committed chunks stick.
    vnode.state.transcriptBaseline = '';
    // Composer palette state.
    vnode.state.trigger = null;       // current activeTrigger() result | null
    vnode.state.paletteIndex = 0;     // active option in the popup
    vnode.state.items = {};           // { commands?, tabs?, files? } cache
    vnode.state.itemsKey = null;      // which type the cache currently holds
    vnode.state.el = null;            // the textarea DOM node
    // File attachments staged for the next send.
    vnode.state.attachments = [];     // [{ name, mediaType, size, data }]
    vnode.state.attachError = null;   // one-line refusal shown by the chips
    vnode.state.unconfirmedSend = loadUnconfirmed(vnode.state._sid)
      ?? (vnode.state._sid ? loadUnconfirmed(null) : null);
    if (vnode.state.unconfirmedSend && !vnode.state.value) {
      vnode.state.value = vnode.state.unconfirmedSend.text;
      saveDraft(vnode.state._sid, vnode.state.value);
    }
    if (vnode.state._sid && vnode.state.unconfirmedSend?.sessionId === null) {
      saveUnconfirmed(vnode.state._sid, vnode.state.unconfirmedSend);
      saveUnconfirmed(null, null);
    }
    vnode.state.sendError = vnode.state.unconfirmedSend
      ? 'Peerd has an unconfirmed message for this chat. Check delivery before sending again.'
      : null;
    vnode.state.fileInputEl = null;   // the hidden <input type=file>
  },

  /** @param {InputBarVnode} vnode */
  onremove(vnode) {
    // Persist the in-progress draft on unmount (chat switch / click-away).
    saveDraft(vnode.attrs.state?.session?.sessionId, vnode.state.value);
  },

  /** @param {InputBarVnode} vnode */
  view: ({ attrs: { state, send, voiceManager, goalArmed, onGoalSent }, state: ui }) => {
    const streaming = !!state.streaming;
    const sid = state.session?.sessionId;
    // Switched chats → save the draft we were holding and load the new chat's.
    if (sid !== ui._sid) {
      const freshChatPending = ui._sid == null ? ui.unconfirmedSend : null;
      saveDraft(ui._sid, ui.value);
      ui.value = loadDraft(sid);
      ui.transcriptBaseline = '';
      // why: staged files belong to the chat they were attached in — InputBar
      // isn't remounted on an in-place switch, so without this the chips (and
      // their base64 bytes) ride into the switched-to chat and upload with ITS
      // next send: a private file into the wrong conversation. Drafts persist
      // text per-chat; attachment bytes don't, so clear them (the user
      // re-stages in the new chat if they meant to).
      ui.attachments = [];
      ui.attachError = null;
      ui.unconfirmedSend = loadUnconfirmed(sid) ?? freshChatPending;
      if (freshChatPending && sid) {
        ui.value = freshChatPending.text;
        saveDraft(sid, ui.value);
        saveDraft(null, '');
        saveUnconfirmed(sid, freshChatPending);
        saveUnconfirmed(null, null);
      }
      ui.sendError = ui.unconfirmedSend
        ? 'Peerd has an unconfirmed message for this chat. Check delivery before sending again.'
        : null;
      ui._sid = sid;
    }
    // A first send creates its session inside the worker. If the state push with
    // that new id wins the race against a lost send reply, the pending fence was
    // necessarily persisted under `new`; adopt it conservatively rather than
    // letting the newly identified chat expose an unfenced Send button.
    if (!ui.unconfirmedSend && sid) {
      const freshPending = loadUnconfirmed(null);
      if (freshPending) {
        ui.unconfirmedSend = freshPending;
        ui.value = freshPending.text;
        saveDraft(sid, ui.value);
        saveDraft(null, '');
        ui.sendError = 'Peerd has an unconfirmed message for this chat. Check delivery before sending again.';
        saveUnconfirmed(sid, freshPending);
        saveUnconfirmed(null, null);
      }
    }
    const persistedPending = loadUnconfirmed(sid) ?? (sid ? loadUnconfirmed(null) : null);
    if (!ui.unconfirmedSend && persistedPending) {
      ui.unconfirmedSend = persistedPending;
      ui.value = persistedPending.text;
      saveDraft(sid, ui.value);
      ui.sendError = 'Message unconfirmed.';
    } else if (ui.unconfirmedSend && !persistedPending && !ui.busy) {
      if (ui.unconfirmedSend.source === 'starter' && ui.value === ui.unconfirmedSend.text) {
        ui.value = '';
        saveDraft(sid, '');
      }
      ui.unconfirmedSend = null;
      ui.sendError = null;
    }
    // §4c one-shot prefill: a card action typed the user's likely next message
    // into the draft. Nonce-guarded so one click adopts once - after that it is
    // an ordinary draft the user edits, sends, or deletes. It never sends.
    const prefill = state.composerPrefill;
    if (prefill && prefill.nonce !== consumedPrefillNonce) {
      consumedPrefillNonce = prefill.nonce;
      ui.value = prefill.text;
      ui.transcriptBaseline = prefill.text;
      saveDraft(sid, prefill.text);
      requestAnimationFrame(() => ui.el?.focus());
    }
    const composer = composerForState(state);
    const canSend = !!composer.canSend;
    const unavailableCopy = canSend ? null : composerUnavailableCopy(composer, { compact: true });
    const warningCopy = composerWarningCopy(composer);
    // Attachments are Anthropic-only (image/document content blocks).
    // Same gate expression as chat-view's EffortDial: the session's
    // bound provider, else the one a fresh chat would bind to.
    const canAttach = canSend && composer.provider === 'anthropic';
    const documentReaderAvailable = state.capabilities?.documentReader?.status === 'available';

    /** @param {Event} [e] */
    const submit = async (e) => {
      e?.preventDefault?.();
      const text = ui.value.trim();
      if (!text || ui.busy || ui.unconfirmedSend || !canSend) return;
      ui.sendError = null;
      const operationId = `send.${Date.now().toString(36)}.${crypto.randomUUID()}`;

      // Goal-armed (mode-row toggle): this send starts an autonomous goal run
      // in THIS chat — the agent keeps taking turns toward the goal until it
      // calls complete_goal (or the cap / Stop). The work streams inline like a
      // normal session. The draft is the (visible) goal; attachments don't
      // apply to a goal, so they stay staged for a later normal send.
      if (goalArmed) {
        const pending = {
          operationId, text, goal: true, sessionId: sid ?? null,
          hadAttachments: false, source: /** @type {const} */ ('composer'),
        };
        ui.busy = true;
        ui.value = '';
        saveDraft(sid, '');
        ui.transcriptBaseline = '';
        closePalette(ui);
        try {
          const reply = await sendAgentWithCustody({
            send,
            message: {
              type: 'agent/send', text, goal: true, operationId,
              sessionId: sid ?? null,
            },
            pending,
            currentSessionId: () => ui._sid,
          });
          // Disarm only on a clean launch. A refused pre-dispatch request is
          // safe to retry; an unknown result is not, because the goal may
          // already be running even though the reply was lost.
          if (reply?.ok) onGoalSent?.();
          else {
            const unresolved = reply?.outcomeKnown === false ? pending : null;
            if (ui._sid === sid) {
              ui.value = text;
              ui.sendError = reply?.outcomeKnown === false
                ? 'Peerd could not confirm whether the goal started. Check this chat before sending it again; your goal remains in the composer.'
                : 'The agent service was unavailable. Your goal is still here; try again.';
              if (unresolved) ui.unconfirmedSend = unresolved;
            } else {
              saveDraft(sid, text);
            }
            if (unresolved) saveUnconfirmed(ui._sid ?? sid, unresolved);
          }
        } catch {
          if (ui._sid === sid) ui.value = text;
          else saveDraft(sid, text);
          ui.sendError = 'Peerd could not confirm whether the goal started. Check this chat before sending it again; your goal remains in the composer.';
          if (ui._sid === sid) ui.unconfirmedSend = pending;
          saveUnconfirmed(ui._sid ?? sid, pending);
        } finally {
          ui.busy = false;
          m.redraw();
        }
        return;
      }

      // why gate at send too (not just the button): staged files must
      // never ride a send the provider can't honor — e.g. the user
      // attached, then switched a fresh chat to Ollama.
      const attachments = canAttach && ui.attachments.length > 0 ? ui.attachments : null;
      const pending = {
        operationId, text, goal: false, sessionId: sid ?? null,
        hadAttachments: !!attachments, source: /** @type {const} */ ('composer'),
      };
      ui.busy = true;
      ui.value = '';
      saveDraft(sid, '');          // sent → clear the saved draft for this chat
      ui.transcriptBaseline = '';
      ui.attachments = [];
      ui.attachError = null;
      closePalette(ui);
      // Render the in-flight ownership immediately. Mithril does not redraw an
      // async event handler until its promise settles, which can leave the
      // stale draft and enabled Send button visible for the entire worker/host
      // wait. The component state already retains the exact recovery copy.
      m.redraw.sync();
      try {
        const reply = await sendAgentWithCustody({
          send,
          message: {
            type: 'agent/send', text, operationId,
            sessionId: sid ?? null,
            ...(attachments ? { attachments } : {}),
          },
          pending,
          currentSessionId: () => ui._sid,
        });
        if (reply?.ok) return;
        // why guard on sid: the user may have switched chats during the await.
        // Restoring into the shared `ui` would dump THIS send's text / files /
        // error into whatever chat is now in view. Same chat → restore inline
        // for an immediate retry (files included). Switched away → put the text
        // back on the ORIGINAL chat's draft (attachment bytes can't ride a
        // draft, so they drop — re-staging is the cost of a failed send + a
        // switch).
        if (ui._sid === sid) {
          ui.value = text;
          if (attachments) ui.attachments = attachments;
          // Surface the SW's fail-closed refusal (e.g. an over-cap file)
          // where the chips are; turn-level errors render in the chat.
          if (attachments && reply?.error) ui.attachError = reply.outcomeKnown === false
            ? 'Peerd could not confirm the attachment send.' : reply.error;
          ui.sendError = reply?.outcomeKnown === false
            ? 'Peerd could not confirm whether the message started. Check this chat before sending the restored draft again.'
            : 'The message was not sent. Your draft was restored; try again.';
          if (reply?.outcomeKnown === false) {
            ui.unconfirmedSend = pending;
            saveUnconfirmed(sid, ui.unconfirmedSend);
          }
        } else {
          saveDraft(sid, text);
          if (reply?.outcomeKnown === false) {
            saveUnconfirmed(sid, pending);
          }
        }
      } catch {
        if (ui._sid === sid) {
          ui.value = text;
          if (attachments) ui.attachments = attachments;
          ui.sendError = 'Peerd could not confirm whether the message started. Check this chat before sending the restored draft again.';
          ui.unconfirmedSend = pending;
          saveUnconfirmed(sid, ui.unconfirmedSend);
        } else {
          saveDraft(sid, text);
          saveUnconfirmed(sid, pending);
        }
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    const checkDelivery = async () => {
      const pending = ui.unconfirmedSend;
      if (!pending || ui.busy) return;
      ui.busy = true;
      try {
        const reply = await send({
          type: 'agent/send', checkOnly: true,
          operationId: pending.operationId, sessionId: pending.sessionId,
        });
        if (reply?.ok) {
          ui.unconfirmedSend = null;
          saveUnconfirmed(sid, null);
          ui.sendError = null;
          if (ui.value.trim() === pending.text.trim()) {
            ui.value = '';
            saveDraft(sid, '');
          }
          if (pending.hadAttachments) {
            ui.attachments = [];
            ui.attachError = null;
          }
          if (pending.goal) onGoalSent?.();
        } else if (reply?.outcomeKnown !== false) {
          ui.unconfirmedSend = null;
          saveUnconfirmed(sid, null);
          ui.sendError = pending.hadAttachments
            ? 'The earlier message did not start. Your text is restored; reattach the files before sending.'
            : 'The earlier message did not start. Your draft is ready to send.';
        } else {
          ui.sendError = pending.hadAttachments
            ? 'Delivery is still unconfirmed. Check the chat before retrying; attached files will never be resent by this check.'
            : 'Delivery is still unconfirmed. Check the chat before sending again.';
        }
      } catch {
        ui.sendError = 'Delivery status is unavailable. The original operation remains fenced.';
      }
      finally { ui.busy = false; m.redraw(); }
    };

    const releaseDeliveryFence = () => {
      const pending = ui.unconfirmedSend;
      if (!pending || ui.busy) return;
      // This is an explicit human acknowledgement, never an automatic replay:
      // keep any restored draft/attachments untouched, clear only the local
      // fence, and let a future Send mint a fresh operation id.
      ui.unconfirmedSend = null;
      saveUnconfirmed(sid, null);
      ui.sendError = pending.hadAttachments && ui.attachments.length === 0
        ? 'Delivery fence cleared. Review this chat and the restored text, then reattach the files before choosing Send.'
        : pending.hadAttachments
          ? 'Delivery fence cleared. Review this chat and the restored text and files before choosing Send.'
        : 'Delivery fence cleared. Review this chat and the restored draft before choosing Send.';
      m.redraw();
    };

    // Stage files: classify + cap-check each (instant feedback, same
    // pure rules the SW enforces), then read to base64. One bad file
    // reports and is skipped; the rest stage — the user asked for each
    // file individually, unlike the send which commits as a unit.
    /** @param {File[]} files */
    const addFiles = async (files) => {
      if (ui.unconfirmedSend) return;
      ui.attachError = null;
      for (const f of files) {
        if (ui.attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
          ui.attachError = `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`;
          break;
        }
        const kind = classifyAttachment({ name: f.name, mediaType: f.type, size: f.size });
        if (kind === 'unsupported') {
          ui.attachError = `"${f.name}": unsupported type — images (PNG/JPEG/GIF/WebP), PDF, `
            + 'Word/Excel/PowerPoint/OpenDocument, RTF, EPUB, or text files.';
          continue;
        }
        if (kind === 'doc' && !documentReaderAvailable) {
          ui.attachError = `"${f.name}": office and e-book conversion is unavailable in this browser. `
            + 'Attach a PDF or plain-text export instead.';
          continue;
        }
        if (f.size > ATTACHMENT_CAPS[kind]) {
          ui.attachError = `"${f.name}" is ${formatBytes(f.size)} — the ${kind} limit is ${formatBytes(ATTACHMENT_CAPS[kind])}.`;
          continue;
        }
        try {
          const data = await fileToBase64(f);
          ui.attachments.push({ name: f.name || 'file', mediaType: f.type, size: f.size, data });
        } catch (err) {
          ui.attachError = /** @type {{ message?: string }} */ (err)?.message ?? String(err);
        }
      }
      m.redraw();
    };

    // Paste-an-image: clipboard image items (screenshots, copied images)
    // stage like picked files. Text pastes fall through untouched.
    /** @param {ClipboardEvent} e */
    const onPaste = (e) => {
      if (!canAttach || ui.unconfirmedSend) return;
      const items = e.clipboardData?.items ?? [];
      /** @type {File[]} */
      const files = [];
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      e.preventDefault();
      addFiles(files);
    };

    /** @param {Event} [e] */
    const stop = async (e) => {
      e?.preventDefault?.();
      await send({ type: 'agent/stop' });
    };

    // Re-derive the trigger from the textarea's value + caret. Called on
    // every input/click/keyup so the palette tracks the caret precisely.
    const refreshTrigger = () => {
      const el = ui.el;
      if (!el) { closePalette(ui); return; }
      const trig = activeTrigger(el.value, el.selectionStart ?? el.value.length);
      const changed = (trig?.type !== ui.trigger?.type) || (trig?.kind !== ui.trigger?.kind);
      ui.trigger = trig;
      if (trig) {
        if (changed) ui.paletteIndex = 0;
        ensureItems(ui, send, trig);
      } else {
        ui.itemsKey = null;
      }
    };

    // Commit the active candidate: splice its insert text over the
    // trigger span [from, to), then place the caret after the insert.
    /** @param {PaletteCandidate} candidate */
    const commit = (candidate) => {
      const el = ui.el;
      if (!el || !ui.trigger) return;
      const { from, to } = ui.trigger;
      const v = ui.value;
      const next = v.slice(0, from) + candidate.insert + v.slice(to);
      ui.value = next;
      ui.transcriptBaseline = next;
      const caret = from + candidate.insert.length;
      closePalette(ui);
      m.redraw();
      // why: restore focus + caret after the redraw paints the new value.
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
        refreshTrigger();
        m.redraw();
      });
    };

    /** @param {KeyboardEvent} e */
    const onKeydown = (e) => {
      // During IME (CJK/kana/pinyin) composition, Enter confirms the IME
      // candidate — never hijack it to send or to commit a palette pick, or the
      // user loses their half-composed text. isComposing + the legacy keyCode
      // 229 both mark an in-progress composition.
      const composing = e.isComposing || e.keyCode === 229;
      // Palette is open: intercept navigation keys so they drive the
      // popup, not the textarea.
      if (ui.trigger) {
        const cands = visibleCandidates(ui.trigger, ui.items);
        if (cands.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            ui.paletteIndex = (ui.paletteIndex + 1) % cands.length;
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            ui.paletteIndex = (ui.paletteIndex - 1 + cands.length) % cands.length;
            return;
          }
          if ((e.key === 'Enter' || e.key === 'Tab') && !composing) {
            // Plain Enter/Tab commits the candidate; Shift+Enter (newline) and
            // Cmd/Ctrl+Enter (send) fall through. ALWAYS consume a plain
            // Enter/Tab here — even when the active candidate is disabled (it
            // commits nothing) — so it never falls through to submit() and
            // sends the literal trigger text (e.g. "@tab:").
            if (!(e.metaKey || e.ctrlKey) && !e.shiftKey) {
              e.preventDefault();
              const pick = cands[Math.min(ui.paletteIndex, cands.length - 1)];
              if (pick && !pick.disabled) commit(pick);
              return;
            }
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            closePalette(ui);
            return;
          }
        }
      }
      // Enter sends; Shift+Enter inserts a newline (textarea default).
      // Cmd/Ctrl+Enter also sends, for muscle memory. Never while composing.
      if (e.key === 'Enter' && !e.shiftKey && !composing) {
        e.preventDefault();
        submit();
      }
    };

    /** @param {{ text: string, committed?: boolean }} arg */
    const onTranscript = ({ text, committed }) => {
      const sep = ui.transcriptBaseline && !/\s$/.test(ui.transcriptBaseline) ? ' ' : '';
      ui.value = ui.transcriptBaseline + sep + text;
      if (committed) ui.transcriptBaseline = ui.value;
      m.redraw();
    };

    const placeholder = !canSend
      ? composerUnavailableCopy(composer, { compact: true })
      : goalArmed
        ? 'Describe a goal to run autonomously…'
        : streaming
          ? 'Type to steer the current turn…'
          : 'Message peerd…';

    // aria-activedescendant points at the active option when the palette
    // is open, so screen readers announce the highlighted candidate.
    const paletteOpen = !!ui.trigger;
    const activeDesc = paletteOpen ? PALETTE_OPTION_ID(ui.paletteIndex) : undefined;

    // The mic→send morph. A draft arms the send disc — EXCEPT while the
    // mic is actively listening: transcript chunks make the value
    // non-empty mid-recording, and morphing the live mic away under the
    // user's voice would orphan the recording with no way to stop it.
    const listening = voiceManager?.getState?.()?.status === 'listening';
    const hasDraft = !!ui.value.trim();
    const armed = hasDraft && canSend && !listening;
    if (hasDraft && !ui.sendAccent) {
      ui.sendAccent = SEND_ACCENTS[Math.floor(Math.random() * SEND_ACCENTS.length)];
    } else if (!hasDraft) {
      ui.sendAccent = null;
    }

    return m('form.input-bar', { onsubmit: submit }, [
      unavailableCopy || warningCopy || ui.sendError ? m('p.composer-readiness-note', {
        id: 'composer-readiness-note',
        role: unavailableCopy || ui.sendError ? 'alert' : 'status',
        'aria-live': unavailableCopy || ui.sendError ? 'assertive' : 'polite',
      }, ui.sendError ?? unavailableCopy ?? warningCopy) : null,
      m('.composer-wrap', [
        paletteOpen ? m(CommandPalette, {
          trigger: ui.trigger,
          items: ui.items,
          index: ui.paletteIndex,
          onselect: commit,
          onhover: (/** @type {number} */ i) => { ui.paletteIndex = i; },
        }) : null,
        // One unified field: the textarea and its action row share a
        // single rounded boundary; every control inside is a ghost.
        m('.composer', [
          m('textarea', {
            rows: 2,
            placeholder,
            value: ui.value,
            role: 'textbox',
            'aria-autocomplete': 'list',
            'aria-expanded': paletteOpen ? 'true' : 'false',
            'aria-controls': paletteOpen ? 'composer-palette' : undefined,
            'aria-activedescendant': activeDesc,
            'aria-describedby': unavailableCopy || warningCopy || ui.sendError
              ? 'composer-readiness-note' : undefined,
            oncreate: (/** @type {{ dom: HTMLTextAreaElement }} */ vnode) => {
              ui.el = vnode.dom;
              autosize(vnode.dom);
              // why a window listener: resizing the panel re-wraps the draft,
              // which changes its content height - and Mithril does not
              // redraw on resize, so no onupdate would fire.
              ui.resizeListener = () => autosize(vnode.dom);
              window.addEventListener('resize', ui.resizeListener);
            },
            onremove: () => {
              if (ui.resizeListener) window.removeEventListener('resize', ui.resizeListener);
              ui.resizeListener = null;
            },
            // why onupdate: every path that changes the value redraws
            // (typing, voice chunks, palette commits, chat switches), so
            // resizing here keeps the height in step with all of them.
            onupdate: (/** @type {{ dom: HTMLTextAreaElement }} */ vnode) => autosize(vnode.dom),
            onkeydown: onKeydown,
            onkeyup: refreshTrigger,
            onclick: refreshTrigger,
            onpaste: onPaste,
            oninput: (/** @type {Event} */ e) => {
              ui.value = /** @type {HTMLTextAreaElement} */ (e.target).value;
              if (!ui.unconfirmedSend) ui.sendError = null;
              saveDraft(sid, ui.value);   // persist the draft as you type (per chat)
              // why: any keyboard edit resets the transcription baseline
              // to the current value so the next voice chunk appends to
              // what the user just typed.
              ui.transcriptBaseline = ui.value;
              refreshTrigger();
            },
          }),
          // Staged attachments — removable chips above the action row;
          // the refusal line (over-cap, unsupported, SW reject) sits
          // with them so cause and evidence share a spot.
          canAttach && (ui.attachments.length > 0 || ui.attachError)
            ? m('.attach-chips', [
                ...ui.attachments.map((a, i) => m('.attach-chip', {
                  title: `${a.name} (${formatBytes(a.size)})`,
                }, [
                  m('span.attach-chip-name', a.name),
                  m('span.attach-chip-size', formatBytes(a.size)),
                  m('button.attach-chip-remove', {
                  type: 'button',
                  'aria-label': `Remove ${a.name}`,
                  disabled: !!ui.unconfirmedSend,
                  onclick: () => {
                    if (ui.unconfirmedSend) return;
                    ui.attachments.splice(i, 1);
                    ui.attachError = null;
                  },
                  }, '×'),
                ])),
                ui.attachError ? m('.attach-error', {
                  role: 'alert',
                  'aria-live': 'assertive',
                }, ui.attachError) : null,
              ])
            : null,
          m('.composer-row', [
            // Per-chat usage — small text, far left; tap to expand.
            canSend ? m(CostChip, { cost: state.cost, streaming: state.streaming }) : null,
            m('.spacer'),
            ui.unconfirmedSend ? m('button.secondary', {
              type: 'button',
              disabled: ui.busy,
              onclick: checkDelivery,
            }, ui.busy ? 'Checking…' : 'Check delivery') : null,
            ui.unconfirmedSend ? m('button.secondary', {
              type: 'button',
              disabled: ui.busy,
              onclick: releaseDeliveryFence,
              title: 'This never resends the earlier message or files',
            }, 'I checked; allow a new message') : null,
            // Attach — hidden entirely off-Anthropic (the gate above):
            // image/document blocks are an Anthropic wire shape, and a
            // button that silently fails is a lie.
            canAttach ? m('input.attach-input', {
              type: 'file',
              multiple: true,
              disabled: !!ui.unconfirmedSend,
              accept: documentReaderAvailable ? ATTACH_ACCEPT : BASIC_ATTACH_ACCEPT,
              style: 'display:none',
              oncreate: (/** @type {{ dom: HTMLInputElement }} */ v) => { ui.fileInputEl = v.dom; },
              onremove: () => { ui.fileInputEl = null; },
              onchange: (/** @type {Event} */ e) => {
                const target = /** @type {HTMLInputElement} */ (e.target);
                const files = Array.from(target.files ?? []);
                // why reset: picking the same file twice must re-fire.
                target.value = '';
                if (files.length > 0) addFiles(files);
              },
            }) : null,
            canAttach ? m('button.attach-btn', {
              type: 'button',
              disabled: !!ui.unconfirmedSend,
              title: documentReaderAvailable
                ? 'Attach files — images, PDFs, office/e-book documents, or text (or paste an image)'
                : 'Attach files — images, PDF, or text (or paste an image)',
              'aria-label': 'Attach files',
              onclick: () => ui.fileInputEl?.click(),
            }, PAPERCLIP_ICON()) : null,
            streaming ? m('button.stop', {
              type: 'button',
              onclick: stop,
              title: 'Stop the agent without sending a new message',
            }, '■ Stop') : null,
            // The morph slot: mic and send disc stacked; .is-armed
            // crossfades mic→send (CSS owns the animation; reduced
            // motion gets a plain swap). The disc's color is the
            // per-draft accent pick.
            m('.composer-slot', {
              class: armed ? 'is-armed' : '',
              style: ui.sendAccent ? `--send-accent: var(${ui.sendAccent})` : undefined,
            }, [
              voiceManager ? m(MicButton, {
                manager: voiceManager,
                targetId: CHAT_INPUT_TARGET,
                onTranscript,
                disabled: false,
              }) : null,
              m('button.send-btn', {
                type: 'submit',
                disabled: !canSend || ui.busy || !!ui.unconfirmedSend || !ui.value.trim(),
                'aria-label': unavailableCopy ?? (goalArmed ? 'Start an autonomous run on this goal'
                  : streaming ? 'Send and steer the current turn' : 'Send'),
                title: unavailableCopy ?? (goalArmed
                  ? 'Start an autonomous run on this goal (plan → build → repeat)'
                  : streaming
                    ? 'Sending will abort the current turn and continue with your new message'
                    : warningCopy ?? 'Send (⌘/Ctrl + Enter)'),
              }, ARROW_ICON()),
            ]),
          ]),
        ]),
      ]),
    ]);
  },
};
