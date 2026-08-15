// @ts-check
// offscreen/muse-glimmer-stream.js - pure visible-channel splitter for the Muse
// Glimmer engine's token stream (used by offscreen/local-model.js).
//
// Muse Glimmer emits Harmony-style channels: the RAW generation is
//   ` to=self<|message|>{reasoning}<|eom|><|start|>assistant to=user<|message|>{content}<|eot|>`
// (or ` to=user<|message|>{content}<|eot|>` when it answers directly). The
// engine streams tokens decoded with skip_special_tokens, which strips the
// <|...|> specials and leaves their PLAIN-TEXT remnants inline:
//   ` to=self{reasoning}assistant to=user{content}`
// Streaming that verbatim would put the model's private reasoning (and the
// channel markers) into the chat bubble, so this splitter tracks the channel
// and reveals only {content}. The reasoning channel is DROPPED for now - the
// local-model delta protocol carries visible text only; surfacing it as a
// thinking stream is a later, protocol-level change.
//
// why cumulative-text input (not deltas): the markers routinely split across
// token boundaries. Deciding on the CUMULATIVE text makes "have we passed the
// marker yet" a plain indexOf instead of a partial-match state machine, and the
// per-yield delta is just the newly-visible suffix.
//
// ACCEPTED RISK: reasoning that happens to contain the literal string
// 'assistant to=user' flips the channel early and streams the rest of the
// reasoning as visible text. The Space's own UI makes the same text-level
// split; disambiguating would need a specials-kept decode the engine does not
// expose to its streaming callers. The FINAL message is immune either way -
// the engine's post-parse works on the raw special tokens, and reconcile()
// refuses a divergent final text rather than doubling it.
//
// PURE on purpose: values in, values out, no engine imports - this is the
// Bun-testable half of the muse generate path (tests/offscreen/).

// The mid-stream marker separating the reasoning channel from the visible one:
// plain-text remnant of `<|eom|><|start|>assistant to=user<|message|>`.
export const MUSE_CONTENT_MARKER = 'assistant to=user';

// Leading channel openers (the remnant of ` to=self<|message|>` /
// ` to=user<|message|>`). The unspaced variants tolerate a tokenizer that
// absorbs the leading space into the previous decode step.
const SELF_OPENERS = Object.freeze([' to=self', 'to=self']);
const USER_OPENERS = Object.freeze([' to=user', 'to=user']);
const ALL_OPENERS = Object.freeze([...SELF_OPENERS, ...USER_OPENERS]);

/**
 * The visible portion of the cumulative stream text so far. Exported for
 * direct testing; the stateful splitter below wraps it with delta emission.
 *
 * @param {string} text cumulative decoded stream (special tokens stripped)
 * @returns {string} the visible-channel text revealed so far
 */
export const museVisibleText = (text) => {
  for (const opener of USER_OPENERS) {
    if (text.startsWith(opener)) return text.slice(opener.length);
  }
  for (const opener of SELF_OPENERS) {
    if (!text.startsWith(opener)) continue;
    // Reasoning first: nothing is visible until the COMPLETE content marker
    // has streamed past (a partial marker at the tail stays hidden - revealing
    // on a partial match could leak marker fragments into the bubble).
    const at = text.indexOf(MUSE_CONTENT_MARKER, opener.length);
    return at === -1 ? '' : text.slice(at + MUSE_CONTENT_MARKER.length);
  }
  // Too short to tell which channel opener this is yet? Hold everything back -
  // the next push decides. why: revealing ' to' early would emit marker bytes
  // that then need un-saying, and a token stream cannot retract.
  if (ALL_OPENERS.some((opener) => opener.startsWith(text))) return '';
  // No channel framing at all (template drift / a non-Harmony fine-tune):
  // everything is visible. Passing prose through beats swallowing the answer.
  return text;
};

/**
 * Stateful wrapper: feed the cumulative text after every yield, get back just
 * the NEWLY visible delta (possibly ''). `reconcile(finalContent)` closes the
 * stream against the engine's authoritative post-parse (lastAssistantMessage):
 * if the stream under-revealed (e.g. generation stopped mid-marker), it
 * returns the missing tail so the caller can flush it; if the stream already
 * said something different, it returns '' - deltas already sent cannot be
 * retracted, and re-appending a divergent full text would double the message.
 */
export const makeMuseChannelSplitter = () => {
  let emitted = '';
  return {
    /** @param {string} cumulativeText @returns {string} newly visible delta */
    push(cumulativeText) {
      const visible = museVisibleText(cumulativeText);
      if (visible.length <= emitted.length) return '';
      const delta = visible.slice(emitted.length);
      emitted = visible;
      return delta;
    },
    /** @param {string | null | undefined} finalContent @returns {string} */
    reconcile(finalContent) {
      if (typeof finalContent !== 'string' || finalContent === '') return '';
      // The engine's post-parse FALLS BACK to the raw special-stripped text
      // when its channel parse fails (e.g. the token budget ran out
      // mid-reasoning), so `finalContent` can arrive channel-framed - flushing
      // it verbatim would dump the hidden reasoning channel into the chat.
      // Re-applying the visibility rule is a no-op for clean content and
      // extracts only the visible part of a raw fallback.
      const visible = museVisibleText(finalContent);
      if (visible === '' || !visible.startsWith(emitted)) return '';
      const tail = visible.slice(emitted.length);
      emitted = visible;
      return tail;
    },
    get visible() { return emitted; },
  };
};
