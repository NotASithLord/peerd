// @ts-check
// First-run onboarding — "Hello, I'm peerd".
//
// Shown ONCE per profile: after vault setup, before the first chat
// (route gating lives in sidepanel.js via needsOnboarding below). Two
// jobs, per the owner's deprioritized "Profiles" direction:
//
//   1. Name your AI peer. The greeting's name is inline-editable and
//      writes peerName on the default profile. It wears the brand
//      letterform colors (owner call, 2026-06-12: the name IS the
//      wordmark concept here — anything you type inherits the same
//      five-color cycle), and at rest it plays a type-and-delete tease
//      so editability is unmissable. The name only ever reflects in
//      chat transcripts — the assistant row label — never in the brand
//      wordmark.
//   2. Seed the user doc: two optional basic-facts questions persisted
//      into memory's 'user' scope (editable later from the options
//      page). Skipping everything writes nothing.
//
// SHAPE (owner call 2026-06-12): a SEQUENTIAL three-step funnel — name
// your peer, "what should I call you", "anything else about you" — one
// question on screen at a time, each with its own Skip, prompts TYPING
// themselves in terminal-style before the input appears. Game-feel
// without breaking the brand: motion is monochrome; the peer name's
// letterforms stay the only color. Reduced motion collapses every
// animation (tease, prompt typing, step slide) to instant.
//
// EDITING MECHANICS (why an <input> + mirror, not contenteditable):
// per-letter color requires one span per character, and rewrapping a
// contenteditable's text into spans on every keystroke yanks the caret.
// Instead the real <input> owns the caret with TRANSPARENT text
// (caret-color stays visible) stretched absolutely over an IN-FLOW
// mirror that renders the same string as colored spans. The mirror
// being in-flow means the wrap is sized by real laid-out glyphs (exact
// for any charset — no `ch` arithmetic), and since both layers paint
// the same string in the same monospace font, the caret always sits
// between the letters the user actually sees.
//
// The SW owns all persistence ('onboarding/complete'); this component
// is a projection plus a single send. Color budget: the rainbow accent
// is the peer name's letterforms (plus the standard accent button); the
// terminal cursor stays monochrome (--fg). The TopBar wordmark mounts
// fresh right after completion and plays its typing intro, same as
// after unlock.

import m from '/vendor/mithril/mithril.js';
import { PEER_NAME_MAX } from '/peerd-runtime/index.js';

/** @typedef {import('../chat-reducer.js').ChatState} ChatState */
/** @typedef {(msg: object) => Promise<any>} Send */

/**
 * The type-and-delete tease loop's transient state.
 * @typedef {{ active: boolean, shown: number, timer: ReturnType<typeof setTimeout>|null }} TeaseState
 */

/**
 * The typed-question reveal state for steps 1/2.
 * @typedef {{ text: string, shown: number, done: boolean, timer: ReturnType<typeof setTimeout>|null }} PromptState
 */

/**
 * Component-local state for OnboardingView.
 * @typedef {Object} OnbState
 * @property {string} peerName
 * @property {string} callMe
 * @property {string} notes
 * @property {boolean} busy
 * @property {string|null} error
 * @property {TeaseState|null} tease
 * @property {number} step
 * @property {''|'out'|'in'} anim
 * @property {PromptState|null} prompt
 * @property {ReturnType<typeof setTimeout>|null} stepTimer
 */

// Same five custom props the composer's send disc draws from (sidepanel
// :root, mirroring shared/brand.css) — p-e-e-r-d order, cycled for
// names longer than five letters.
const LETTER_VARS = ['--cyan', '--red', '--amber', '--green', '--magenta'];

/** @param {string} text */
const letterSpans = (text) => Array.from(text).map((ch, i) =>
  m('span', { style: { color: `var(${LETTER_VARS[i % LETTER_VARS.length]})` } }, ch));

// Type-and-delete tease cadence (ms). Type slower than delete — the
// same asymmetry real typing has; holds long enough to read. Exported
// MUTABLE so tests can shrink the delays to drive the loop in real
// time (same escape-hatch posture as system-prompt's
// _setTemplateForTests) — production code never writes it.
export const TEASE = { type: 95, del: 55, holdFull: 1500, holdEmpty: 450 };

/**
 * Should the panel intercept every route with the onboarding screen?
 * Pure over the panel state shape: only when the vault is usable AND
 * the SW has pushed a default profile whose onboarding latch is still
 * open. INITIAL_STATE assumes complete, so this can only flip true off
 * a real SW push — no first-paint flash for existing installs.
 *
 * @param {ChatState} [state]  side-panel state
 * @returns {boolean}
 */
export const needsOnboarding = (state) => !!(
  state?.vault?.initialized
  && !state.vault.locked
  && state.profile
  && state.profile.onboardingComplete === false
);

// The tease loop: full → hold → delete → gap → retype → hold → … Self-
// scheduling timeout chain; any user interaction (focus/typing) kills
// it permanently via stopTease. Honors prefers-reduced-motion by never
// starting (the static full name simply sits there, cursor already
// hidden by the CSS media query).
/** @param {OnbState} ui */
const startTease = (ui) => {
  const full = ui.peerName;
  const tease = { active: true, shown: full.length, timer: /** @type {ReturnType<typeof setTimeout>|null} */ (null) };
  ui.tease = tease;
  // First step fires after holdFull and must DELETE then — starting the
  // phase machine at 'del' avoids a silent double-length initial hold.
  /** @type {'holdFull'|'del'|'holdEmpty'|'type'} */
  let phase = 'del';
  const step = () => {
    if (!tease.active) return;
    const t = tease;
    let delay = 0;
    if (phase === 'holdFull') { phase = 'del'; delay = TEASE.holdFull; }
    else if (phase === 'del') {
      t.shown -= 1;
      delay = TEASE.del;
      if (t.shown <= 0) { phase = 'holdEmpty'; }
    } else if (phase === 'holdEmpty') { phase = 'type'; delay = TEASE.holdEmpty; }
    else {
      t.shown += 1;
      delay = TEASE.type;
      if (t.shown >= full.length) { phase = 'holdFull'; }
    }
    m.redraw();
    t.timer = setTimeout(step, delay);
  };
  tease.timer = setTimeout(step, TEASE.holdFull);
};

/** @param {OnbState} ui */
const stopTease = (ui) => {
  if (!ui.tease) return;
  ui.tease.active = false;
  if (ui.tease.timer) clearTimeout(ui.tease.timer);
};

// The funnel's three prompts. Step 0's heading is the greeting itself
// (the colored name widget); 1 and 2 are typed questions.
const STEP_PROMPTS = [null, 'What should I call you?', 'Anything else about you I should know?'];
// Exported MUTABLE for tests (TEASE precedent) — production never writes.
export const PROMPT_TYPE = { ms: 22 };

const reducedMotion = () =>
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Type a step's question out character by character (terminal feel —
// the same identity as the boot console and the wordmark intro). The
// input renders only once the question has finished asking itself.
/** @param {OnbState} ui */
const startPromptType = (ui) => {
  stopPromptType(ui);
  const text = STEP_PROMPTS[ui.step];
  if (!text) { ui.prompt = null; return; }
  if (reducedMotion()) { ui.prompt = { text, shown: text.length, done: true, timer: null }; return; }
  const prompt = { text, shown: 0, done: false, timer: /** @type {ReturnType<typeof setTimeout>|null} */ (null) };
  ui.prompt = prompt;
  const tick = () => {
    const pr = ui.prompt;
    if (!pr || pr.text !== text) return;
    pr.shown += 1;
    if (pr.shown >= text.length) { pr.done = true; pr.timer = null; }
    else pr.timer = setTimeout(tick, PROMPT_TYPE.ms);
    m.redraw();
  };
  prompt.timer = setTimeout(tick, PROMPT_TYPE.ms);
};

/** @param {OnbState} ui */
const stopPromptType = (ui) => {
  if (ui.prompt?.timer) clearTimeout(ui.prompt.timer);
};

// Step transition: brief slide-out → swap → slide-in (CSS drives the
// motion; reduced motion swaps instantly).
/**
 * @param {OnbState} ui
 * @param {number} next
 */
const goToStep = (ui, next) => {
  if (ui.busy) return;
  stopTease(ui);
  stopPromptType(ui);
  const swap = () => {
    ui.stepTimer = null;
    ui.step = next;
    ui.anim = 'in';
    startPromptType(ui);
    m.redraw();
  };
  if (reducedMotion()) { ui.anim = ''; swap(); return; }
  ui.anim = 'out';
  m.redraw();
  // Track the slide-transition timer so onremove can cancel it — otherwise an
  // unmount within the 170ms window (e.g. a vault auto-lock) fires swap()
  // against detached component state. Clear any prior one first.
  if (ui.stepTimer) clearTimeout(ui.stepTimer);
  ui.stepTimer = setTimeout(swap, 170);
};

/** @typedef {{ state: OnbState, attrs: { send: Send, state?: ChatState } }} OnbVnode */

export const OnboardingView = {
  /** @param {OnbVnode} vnode */
  oninit(vnode) {
    vnode.state.peerName = vnode.attrs.state?.profile?.peerName || 'peerd';
    vnode.state.callMe = '';
    vnode.state.notes = '';
    vnode.state.busy = false;
    vnode.state.error = null;
    vnode.state.tease = null;
    vnode.state.step = 0;       // 0 name · 1 call-me · 2 notes
    vnode.state.anim = '';      // ''|'out'|'in' — step transition class
    vnode.state.prompt = null;  // typed question state for steps 1/2
    vnode.state.stepTimer = null;
    if (!reducedMotion()) {
      startTease(vnode.state);
    }
  },

  /** @param {OnbVnode} vnode */
  onremove(vnode) {
    stopTease(vnode.state);
    stopPromptType(vnode.state);
    if (vnode.state.stepTimer) clearTimeout(vnode.state.stepTimer);
  },

  /** @param {OnbVnode} vnode */
  view({ attrs: { send }, state: ui }) {
    // why one path for Start AND Skip: both must flip the SW-persisted
    // onboardingComplete latch (the screen never re-fires either way);
    // Skip just sends facts:null so no memory is seeded. An edited peer
    // name survives Skip — renaming is an explicit act even when the
    // facts are skipped.
    /** @param {{ callMe: string, notes: string }|null} facts */
    const finish = async (facts) => {
      if (ui.busy) return;
      stopTease(ui);
      ui.busy = true;
      ui.error = null;
      m.redraw();
      try {
        const reply = await send({ type: 'onboarding/complete', peerName: ui.peerName, facts });
        // On success the SW pushes fresh state and the route gate lifts
        // itself — no local navigation here.
        if (!reply?.ok) ui.error = reply?.error ?? 'Could not save — try again.';
      } catch (e) {
        ui.error = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    // What the mirror shows: the tease's slice while it runs, the real
    // value once the user has touched anything.
    const teasing = !!ui.tease?.active;
    const displayed = teasing ? ui.peerName.slice(0, ui.tease?.shown ?? 0) : ui.peerName;

    // Long names scale the greeting down instead of overflowing the
    // card — the name block is a single unbreakable line (input +
    // mirror), so the type size is the only safe degree of freedom.
    const helloSize = ui.peerName.length > 22 ? 'is-long'
      : ui.peerName.length > 14 ? 'is-mid' : '';

    // why finish-vs-null: skipping every question must write nothing
    // (the original one-shot contract) — empty answers collapse to
    // facts:null so the SW's seedUserDocBody path never runs at all.
    const submit = () => {
      const callMe = ui.callMe.trim();
      const notes = ui.notes.trim();
      finish(callMe === '' && notes === '' ? null : { callMe, notes });
    };

    const promptDone = !!ui.prompt?.done;
    const promptShown = ui.prompt ? ui.prompt.text.slice(0, ui.prompt.shown) : '';

    // Step bodies. ONE on screen at a time — the funnel.
    const stepName = [
      m('h2.onboarding-hello', { class: helloSize }, [
        'Hello, I’m ',
        m('span.peer-name-wrap', {
          title: 'Click to rename your AI peer',
          // The wrap is the visual affordance (dashed underline); a
          // click anywhere on it lands focus in the input.
          onclick: (/** @type {Event} */ e) => {
            /** @type {HTMLInputElement|null} */ (
              /** @type {HTMLElement} */ (e.currentTarget).querySelector('input'))?.focus();
          },
        }, [
          // why mirror-first: the MIRROR is the in-flow element, so the
          // wrap's width is the real laid-out glyph width (correct for
          // CJK/emoji where `ch` math lies); the input is stretched
          // absolutely over it and stays caret-aligned because both
          // render the same string in the same font.
          m('span.peer-name-mirror', { 'aria-hidden': 'true' }, letterSpans(displayed)),
          m('input.peer-name-input', {
            type: 'text',
            spellcheck: 'false',
            autocomplete: 'off',
            maxlength: PEER_NAME_MAX,
            'aria-label': 'Your AI peer’s name — editable',
            value: ui.peerName,
            onfocus: () => { stopTease(ui); },
            oninput: (/** @type {Event} */ e) => { stopTease(ui); ui.peerName = /** @type {HTMLInputElement} */ (e.target).value; },
            onkeydown: (/** @type {KeyboardEvent} */ e) => {
              // Enter = "I'm done naming" — advance the funnel.
              if (e.key === 'Enter') { e.preventDefault(); goToStep(ui, 1); }
            },
            onblur: (/** @type {Event} */ e) => {
              // An emptied name visibly falls back so the user is never
              // staring at a nameless greeting. (The SW normalizes again
              // at the store chokepoint.)
              if (!(/** @type {HTMLInputElement} */ (e.target).value ?? '').trim()) { ui.peerName = 'peerd'; }
            },
          }),
        ]),
        // The peerd.ai-style blinking terminal cursor, trailing the
        // editable name. Monochrome (--fg) per the brand color rule.
        // Decorative — hidden from the a11y tree and reduced-motion.
        m('span.onboarding-cursor', { 'aria-hidden': 'true' }),
      ]),
      m('p.muted.onboarding-edit-hint',
        'That name is editable — click it to rename your AI peer. '
        + 'It shows in your chat transcripts.'),
      m('.onboarding-actions', [
        m('button', {
          type: 'button', disabled: ui.busy,
          onclick: () => goToStep(ui, 1),
        }, 'Continue'),
        m('button.linklike.onboarding-skip', {
          type: 'button', disabled: ui.busy,
          // Skip = don't rename: revert any half-edit, move on.
          onclick: () => { ui.peerName = ui.peerName.trim() || 'peerd'; goToStep(ui, 1); },
        }, 'Skip'),
      ]),
    ];

    // Steps 1/2 share a shape: typed question → (once asked) input +
    // actions fade in. The question types behind the same terminal
    // cursor the greeting uses — the peer is ASKING, not labeling.
    /**
     * @param {{ id: string, value: string, setValue: (v: string) => void, multiline: boolean, last: boolean }} args
     */
    const askStep = ({ id, value, setValue, multiline, last }) => [
      m('h3.onb-ask', [
        promptShown,
        promptDone ? null : m('span.onboarding-cursor', { 'aria-hidden': 'true' }),
      ]),
      promptDone ? [
        m('.onb-box.onb-ask-box',
          multiline
            ? m('textarea', {
                id, rows: 3, value, disabled: ui.busy,
                oncreate: (/** @type {{ dom: HTMLElement }} */ v) => v.dom.focus(),
                oninput: (/** @type {Event} */ e) => setValue(/** @type {HTMLTextAreaElement} */ (e.target).value),
                onkeydown: (/** @type {KeyboardEvent} */ e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
                },
              })
            : m('input', {
                id, type: 'text', autocomplete: 'nickname', value, disabled: ui.busy,
                oncreate: (/** @type {{ dom: HTMLElement }} */ v) => v.dom.focus(),
                oninput: (/** @type {Event} */ e) => setValue(/** @type {HTMLInputElement} */ (e.target).value),
                onkeydown: (/** @type {KeyboardEvent} */ e) => {
                  if (e.key === 'Enter') { e.preventDefault(); goToStep(ui, 2); }
                },
              })),
        m('p.muted.onb-hint-line', 'Optional — it lands in your memory doc, editable any time.'),
        m('.onboarding-actions', [
          m('button', {
            type: 'button', disabled: ui.busy,
            onclick: () => (last ? submit() : goToStep(ui, 2)),
          }, ui.busy ? '…' : last ? 'Start' : 'Continue'),
          m('button.linklike.onboarding-skip', {
            type: 'button', disabled: ui.busy,
            onclick: () => { setValue(''); (last ? submit() : goToStep(ui, 2)); },
          }, 'Skip'),
        ]),
      ] : null,
    ];

    const body = ui.step === 0 ? stepName
      : ui.step === 1 ? askStep({
          id: 'onb-call', value: ui.callMe,
          setValue: (v) => { ui.callMe = v; }, multiline: false, last: false,
        })
      : askStep({
          id: 'onb-notes', value: ui.notes,
          setValue: (v) => { ui.notes = v; }, multiline: true, last: true,
        });

    return m('.onboarding-view', m('.card.onboarding-card', [
      m('.onb-step', {
        class: ui.anim ? `is-${ui.anim}` : '',
        // Game pattern: tapping a still-typing question fast-forwards it
        // — impatience skips the reveal, never blocks on it.
        onclick: () => {
          if (ui.prompt && !ui.prompt.done) {
            stopPromptType(ui);
            ui.prompt.shown = ui.prompt.text.length;
            ui.prompt.done = true;
          }
        },
      }, body),
      // Monochrome progress: where you are in the three questions.
      m('.onb-dots', { 'aria-label': `Step ${ui.step + 1} of 3` },
        [0, 1, 2].map((i) => m('span.onb-dot', {
          class: i === ui.step ? 'is-on' : i < ui.step ? 'is-done' : '',
        }))),
      ui.error ? m('p.error', ui.error) : null,
    ]));
  },
};
