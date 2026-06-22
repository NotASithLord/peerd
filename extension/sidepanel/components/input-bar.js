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
  MicButton, activeTrigger,
  classifyAttachment, ATTACHMENT_CAPS, MAX_ATTACHMENTS_PER_MESSAGE,
  IMAGE_MEDIA_TYPES, formatBytes,
} from '/peerd-runtime/index.js';
import { CommandPalette, visibleCandidates, PALETTE_OPTION_ID } from './command-palette.js';
import { CostChip } from './cost-meter.js';

/** @typedef {import('../chat-reducer.js').ChatState} ChatState */
/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {import('./command-palette.js').Trigger} Trigger */
/** @typedef {import('./command-palette.js').PaletteCandidate} PaletteCandidate */
/** @typedef {import('./command-palette.js').PaletteItems} PaletteItems */

/** @typedef {{ name: string, mediaType: string, size: number, data: string }} StagedAttachment */

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
 * @property {HTMLInputElement|null} fileInputEl
 * @property {string|null} [sendAccent]
 */

const CHAT_INPUT_TARGET = 'chat-input';

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
const ATTACH_ACCEPT = [...IMAGE_MEDIA_TYPES, 'application/pdf', 'text/*'].join(',');

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
      saveDraft(ui._sid, ui.value);
      ui.value = loadDraft(sid);
      ui.transcriptBaseline = '';
      ui._sid = sid;
    }
    const hasKey = state.providers?.hasKey;
    // Attachments are Anthropic-only (image/document content blocks).
    // Same gate expression as chat-view's EffortDial: the session's
    // bound provider, else the one a fresh chat would bind to.
    const canAttach = hasKey
      && (state.session?.provider ?? state.providers?.current) === 'anthropic';

    /** @param {Event} [e] */
    const submit = async (e) => {
      e?.preventDefault?.();
      const text = ui.value.trim();
      if (!text || ui.busy) return;

      // Goal-armed (mode-row toggle): this send launches a Ralph goal run
      // with the draft as its goal instead of a normal turn. Reuses the
      // SW's `/loop` path — byte-identical to typing "/loop <goal>" — then
      // disarms via onGoalSent. Attachments don't apply to a goal, so they
      // stay staged for a later normal send.
      if (goalArmed) {
        ui.busy = true;
        ui.value = '';
        saveDraft(sid, '');
        ui.transcriptBaseline = '';
        closePalette(ui);
        const reply = await send({ type: 'agent/send', text: `/loop ${text}` });
        ui.busy = false;
        // Disarm only on a clean launch; on failure restore the draft and
        // stay armed so the user can retry without re-toggling.
        if (reply?.ok) onGoalSent?.();
        else ui.value = text;
        m.redraw();
        return;
      }

      // why gate at send too (not just the button): staged files must
      // never ride a send the provider can't honor — e.g. the user
      // attached, then switched a fresh chat to Ollama.
      const attachments = canAttach && ui.attachments.length > 0 ? ui.attachments : null;
      ui.busy = true;
      ui.value = '';
      saveDraft(sid, '');          // sent → clear the saved draft for this chat
      ui.transcriptBaseline = '';
      ui.attachments = [];
      ui.attachError = null;
      closePalette(ui);
      const reply = await send({
        type: 'agent/send', text,
        ...(attachments ? { attachments } : {}),
      });
      ui.busy = false;
      if (!reply?.ok) {
        // Put the draft back so the user can retry — files included.
        ui.value = text;
        if (attachments) ui.attachments = attachments;
        // Surface the SW's fail-closed refusal (e.g. an over-cap file)
        // where the chips are; turn-level errors render in the chat.
        if (attachments && reply?.error) ui.attachError = reply.error;
      }
      m.redraw();
    };

    // Stage files: classify + cap-check each (instant feedback, same
    // pure rules the SW enforces), then read to base64. One bad file
    // reports and is skipped; the rest stage — the user asked for each
    // file individually, unlike the send which commits as a unit.
    /** @param {File[]} files */
    const addFiles = async (files) => {
      ui.attachError = null;
      for (const f of files) {
        if (ui.attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
          ui.attachError = `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`;
          break;
        }
        const kind = classifyAttachment({ name: f.name, mediaType: f.type, size: f.size });
        if (kind === 'unsupported') {
          ui.attachError = `"${f.name}": unsupported type — images (PNG/JPEG/GIF/WebP), PDF, or text files.`;
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
      if (!canAttach) return;
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
          if (e.key === 'Enter' || e.key === 'Tab') {
            // Plain Enter/Tab commits the candidate; Shift+Enter (newline) and
            // Cmd/Ctrl+Enter (send) fall through. Skip disabled options.
            if (!(e.metaKey || e.ctrlKey) && !e.shiftKey) {
              const pick = cands[Math.min(ui.paletteIndex, cands.length - 1)];
              if (pick && !pick.disabled) { e.preventDefault(); commit(pick); return; }
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
      // Cmd/Ctrl+Enter also sends, for muscle memory.
      if (e.key === 'Enter' && !e.shiftKey) {
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

    const placeholder = !hasKey
      ? 'Add an API key in Settings to start.'
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
    const armed = hasDraft && hasKey && !listening;
    if (hasDraft && !ui.sendAccent) {
      ui.sendAccent = SEND_ACCENTS[Math.floor(Math.random() * SEND_ACCENTS.length)];
    } else if (!hasDraft) {
      ui.sendAccent = null;
    }

    return m('form.input-bar', { onsubmit: submit }, [
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
            disabled: !hasKey,
            role: 'textbox',
            'aria-autocomplete': 'list',
            'aria-expanded': paletteOpen ? 'true' : 'false',
            'aria-controls': paletteOpen ? 'composer-palette' : undefined,
            'aria-activedescendant': activeDesc,
            oncreate: (/** @type {{ dom: HTMLTextAreaElement }} */ vnode) => { ui.el = vnode.dom; },
            onkeydown: onKeydown,
            onkeyup: refreshTrigger,
            onclick: refreshTrigger,
            onpaste: onPaste,
            oninput: (/** @type {Event} */ e) => {
              ui.value = /** @type {HTMLTextAreaElement} */ (e.target).value;
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
                    onclick: () => { ui.attachments.splice(i, 1); ui.attachError = null; },
                  }, '×'),
                ])),
                ui.attachError ? m('.attach-error', ui.attachError) : null,
              ])
            : null,
          m('.composer-row', [
            // Per-chat usage — small text, far left; tap to expand.
            hasKey ? m(CostChip, { cost: state.cost, streaming: state.streaming }) : null,
            m('.spacer'),
            // Attach — hidden entirely off-Anthropic (the gate above):
            // image/document blocks are an Anthropic wire shape, and a
            // button that silently fails is a lie.
            canAttach ? m('input.attach-input', {
              type: 'file',
              multiple: true,
              accept: ATTACH_ACCEPT,
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
              title: 'Attach files — images, PDF, or text (or paste an image)',
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
                disabled: !hasKey,
              }) : null,
              m('button.send-btn', {
                type: 'submit',
                disabled: !hasKey || ui.busy || !ui.value.trim(),
                'aria-label': goalArmed ? 'Start an autonomous run on this goal'
                  : streaming ? 'Send and steer the current turn' : 'Send',
                title: goalArmed
                  ? 'Start an autonomous run on this goal (plan → build → repeat)'
                  : streaming
                    ? 'Sending will abort the current turn and continue with your new message'
                    : 'Send (⌘/Ctrl + Enter)',
              }, ARROW_ICON()),
            ]),
          ]),
        ]),
      ]),
    ]);
  },
};
