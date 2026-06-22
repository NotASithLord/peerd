// @ts-check
// MicButton — Mithril component. Drops in next to any text input.
//
// Lives in peerd-runtime/voice/ so any peerd UI can import it; the
// directive's "ubiquitous mic button" goal depends on this being
// trivially reachable from every input field.
//
// Attrs:
//   manager      voiceManager instance (created in sidepanel.js)
//   targetId     stable id for the input this button represents; the
//                manager uses it to decide whose chunks to route here
//                vs another mic button on a different input
//   onTranscript callback fired on each chunk:
//                  ({ text, committed, targetId })
//   disabled?    pass true to gray out (e.g. while a turn is streaming)
//
// Render rules:
//   - Hidden entirely when manager.isAvailable() is false (voice mode
//     off, model still downloading, or unsupported in this build).
//   - Idle  → bare mic icon, dim
//   - Active for THIS input → red pulsing icon
//   - The component subscribes to the manager so state changes
//     re-render this button automatically.

import m from '/vendor/mithril/mithril.js';
import { openOptions } from '/shared/open-options.js';

/** @typedef {import('./manager.js').createVoiceManager} createVoiceManager */
/** @typedef {ReturnType<createVoiceManager>} VoiceManager */
/** @typedef {{ text: string, committed: boolean, targetId: string|null }} TranscriptChunk */

/**
 * @typedef {Object} MicButtonAttrs
 * @property {VoiceManager} manager
 * @property {string} targetId
 * @property {(chunk: TranscriptChunk) => void} [onTranscript]
 * @property {boolean} [disabled]
 */

/**
 * @typedef {Object} MicButtonState
 * @property {ReturnType<VoiceManager['getState']>} state
 * @property {(() => void)} [unsub]
 */

/**
 * Mithril vnode wrapper for this component. (Mithril is vendored without
 * types, so we describe the slice of the vnode we touch.)
 * @typedef {{ attrs: MicButtonAttrs, state: MicButtonState }} MicButtonVnode
 */

// Built with native Mithril nodes (m('svg', ...)) rather than m.trust(html).
// Reason: m.trust parses via innerHTML, which works but can surprise on
// SVG namespace edge cases; m() with svg-tagged children gets the right
// namespace deterministically. The head is filled (high contrast at
// small sizes); stand/base strokes are deliberately chunky.
const micIcon = () => m('svg', {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  width: 24,
  height: 24,
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2.4,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
}, [
  m('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3, fill: 'currentColor', stroke: 'none' }),
  m('path', { d: 'M5 11v1a7 7 0 0 0 14 0v-1' }),
  m('line', { x1: 12, y1: 19, x2: 12, y2: 22 }),
  m('line', { x1: 8,  y1: 22, x2: 16, y2: 22 }),
]);

export const MicButton = {
  /** @param {MicButtonVnode} vnode */
  oninit(vnode) {
    const { manager } = vnode.attrs;
    if (!manager) throw new Error('MicButton: missing `manager` attr');
    vnode.state.state = manager.getState();
    vnode.state.unsub = manager.subscribe((s) => {
      vnode.state.state = s;
      m.redraw();
    });
  },

  /** @param {MicButtonVnode} vnode */
  onremove(vnode) {
    vnode.state.unsub?.();
    // why: if THIS button is unmounted while listening, the manager
    // is still pointing at its targetId. Stop so the next mount
    // doesn't surprise the user with a still-hot mic.
    const { manager, targetId } = vnode.attrs;
    if (manager.getState().activeTarget === targetId) {
      manager.stop().catch(() => {});
    }
  },

  /** @param {MicButtonVnode} vnode */
  view: ({ attrs, state }) => {
    const { manager, targetId, onTranscript, disabled = false } = attrs;
    const s = state.state;
    if (!manager.isAvailable() && s.status !== 'listening') return null;

    const activeHere = s.activeTarget === targetId;
    const permissionDenied = s.error === 'mic-permission-denied';

    /** @param {MouseEvent} [e] */
    const handleClick = async (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      if (disabled) return;
      // Amber mic = sticky permission denial. Clicking it again will
      // just re-trigger the auto-denial; send the user to the options
      // Voice page instead, where the help block (with browser + OS
      // instructions + the grant-page button) lives.
      if (permissionDenied) {
        openOptions('voice');
        return;
      }
      try {
        if (activeHere) {
          await manager.stop();
        } else {
          await manager.listenFor(targetId, (chunk) => {
            try { onTranscript?.(chunk); }
            catch (err) { console.error('[MicButton] onTranscript threw', err); }
          });
        }
      } catch (err) {
        // why: typed errors (VoiceNotEnabledError, MicPermissionDeniedError)
        // already populate manager.state.error and trigger a redraw
        // through the subscribe pipe; nothing to do here beyond
        // surfacing the dev trace.
        console.warn('[MicButton] click handler error', err);
      }
    };

    const cls = [
      'mic-button',
      activeHere ? 'is-active' : '',
      permissionDenied ? 'is-permission-needed' : '',
      disabled ? 'is-disabled' : '',
    ].filter(Boolean).join(' ');

    const titleText = permissionDenied
      ? 'Microphone access is blocked. Click for instructions.'
      : activeHere
        ? 'Stop listening (Esc)'
        : 'Voice input';

    return m('button', {
      class: cls,
      type: 'button',
      'aria-label': activeHere ? 'Stop listening' : 'Voice input',
      'aria-pressed': activeHere ? 'true' : 'false',
      title: titleText,
      disabled,
      onclick: handleClick,
    }, micIcon());
  },
};
