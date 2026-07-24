// @ts-check
// peerd-runtime/dom — Content Disarm & Reconstruction (CDR) at the page-read
// boundary (issue #244).
//
// PURE (text in -> scrubbed text out), so it is fully unit-testable without a
// browser — same posture as ax-serialize.js. The imperative wiring (calling
// this from the injected readers) is a deliberate FOLLOW-UP; this file is only
// the scrubber.
//
// THREAT MODEL. A page can carry bytes that are INVISIBLE to the human who
// approved the read but fully VISIBLE to the model that reads the serialized
// snapshot: zero-width joiners spelling a hidden instruction, an HTML comment
// the renderer never paints, a bidi override that reorders text so what the
// user sees ("report.pdf") differs from what the model reads ("fdp.troper"),
// tag-block characters that smuggle plain ASCII with zero visual footprint.
// Each is a prompt-injection vector. CDR strips them, surgically — normal
// whitespace, punctuation, every non-Latin script, and emoji (INCLUDING
// multi-codepoint ZWJ emoji sequences) survive byte-for-byte.
//
// WHERE CDR SITS. This is the PRE-PASS, not the fence. The data/instruction
// boundary — tainting page text as DATA the model must not obey — is already
// wrapUntrusted's job (tools/prompt-wrap.js). CDR composes IN FRONT of it:
//
//     wrapUntrusted({ origin, tool, body: disarmText(snapshot) })
//
// so we deliberately export ONLY disarmText and add no competing wrapper —
// a second fence would just be a thing to keep in sync with the real one.
// CDR removes the invisible bytes; wrapUntrusted fences whatever visible text
// remains. Defense in depth, each layer with one job.
//
// OUT OF SCOPE (noted, not done here). Stripping nodes hidden by CSS
// (`display:none`, off-screen positioning, `aria-hidden`) needs the RENDER
// tree / computed style, which only the a11y-walk path has — not this
// text-level core, and never the markdown path. That belongs in the injected
// reader wiring (walk-injected.js / ax-serialize.js), a separate follow-up.

// --- The invisible-character vectors (each range IS an injection vector) ---
//
// Every range below is a subset of Unicode General_Category=Format (\p{Cf});
// we spell the high-value ones out so the "why" is auditable, and keep the
// \p{Cf} catch-all in the sweep so a newly-assigned format char is covered
// automatically rather than silently slipping through. Regexes are built from
// `\\u`-escaped strings (never literal invisible bytes) so this source file
// stays pure ASCII and readable in review.

// why: classic zero-width smuggling — ZWSP (U+200B) / ZWNJ (U+200C) split a
// word so the model reads a token the human never sees; WORD JOINER (U+2060)
// and the BYTE ORDER MARK (U+FEFF) are zero-advance too; SOFT HYPHEN (U+00AD)
// is invisible unless a line breaks there. (ZWJ U+200D is handled separately —
// it is also a real emoji joiner.)
const ZERO_WIDTH = '\\u200B\\u200C\\u2060\\uFEFF\\u00AD';

// why: bidi overrides/isolates (U+202A-202E LRE/RLE/PDF/LRO/RLO, U+2066-2069
// LRI/RLI/FSI/PDI) let author bytes render in a DIFFERENT visual order than
// their logical order, so the text a user approves ("open a.pdf") is not the
// text the model reads. Strip the controls -> the model sees the true logical
// sequence, undeceived.
const BIDI_CONTROLS = '\\u202A-\\u202E\\u2066-\\u2069';

// why: the Unicode Tags block (U+E0000-E007F) can encode a full ASCII payload
// with ZERO visual footprint — pure steganographic instruction-smuggling. Rare
// legitimate use (subdivision-flag emoji tag sequences) is acceptable
// collateral at a security boundary; we err toward stripping.
const TAG_BLOCK = '\\u{E0000}-\\u{E007F}';

// why: C0/C1 control bytes and DEL are invisible to a human but an LLM may read
// a NUL or control byte as a separator or a structural marker. The class is
// U+0000-0008, U+000B, U+000C, U+000E-001F, U+007F, U+0080-009F — i.e. every
// control EXCEPT TAB (U+0009) / LF (U+000A) / CR (U+000D), which are real
// layout whitespace a reader depends on. `+` collapses each run in one shot.
const CONTROL_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u0080-\\u009F]+',
  'gu',
);

// Zero-width joiner, decided by CONTEXT. why: U+200D is BOTH a legitimate
// emoji-sequence joiner (man + ZWJ + laptop = the technologist glyph) AND an
// invisible separator an attacker can splice between letters to hide text the
// model still reads. Keep it ONLY when it actually joins two pictographs;
// strip it everywhere else. The left side of a legit join is a pictograph
// OPTIONALLY carrying a Fitzpatrick skin-tone modifier (U+1F3FB–1F3FF, which
// is category Emoji_Modifier — NOT Extended_Pictographic — so `👩🏻‍💻` and
// people-holding-hands sequences would split if we required a bare pictograph)
// and/or a VS16 presentation selector (U+FE0F). Lookahead-only + a leading
// capture — NOT a lookbehind: JSC's variable-width lookbehind does not match
// \p{Extended_Pictographic} across an astral surrogate pair, so a lookbehind
// here would wrongly eat real joiners.
const ZWJ_RE = new RegExp(
  '(\\p{Extended_Pictographic}\\p{Emoji_Modifier}?\\uFE0F?)\\u200D(?=\\p{Extended_Pictographic})|\\u200D',
  'gu',
);

// Variation selectors, decided by CONTEXT. why: VS1–16 (U+FE00–FE0F) and the
// VS Supplement (U+FE00 range's big brother, U+E0100–E01EF, VS17–256) are
// category Mn/Sk — NOT \p{Cf} — so the format sweep below structurally cannot
// reach them. That is the documented 2024 "variation-selector smuggling"
// channel: append VS code points to a base char to encode arbitrary bytes
// with ZERO visual footprint (directly analogous to the Tags block). BUT
// VS15/VS16 (U+FE0E/U+FE0F) are ALSO the legitimate emoji text/emoji
// presentation selectors — ❤+VS16 = ❤️, and ZWJ emoji sequences carry a
// VS16 (rainbow flag = flag + VS16 + ZWJ + rainbow). So: KEEP a single
// VS15/VS16 immediately following an Extended_Pictographic; STRIP everything
// else — a VS on a non-pictograph base, a CHAIN of VS (only the first after a
// pictograph is legit), and the entire Supplement wholesale (CJK ideographic
// variation, essentially never in the web text the actor reads; even a rare
// stripped glyph keeps its base ideograph — the CONTENT survives). Same
// leading-capture / lookahead-free shape as ZWJ_RE, and run in the SAME
// emoji-aware phase so a ZWJ-sequence VS16 survives. Known collateral: a
// keycap emoji's VS16 (digit + VS16 + U+20E3) sits on a non-pictograph base
// and is stripped — the digit still survives, an acceptable boundary tradeoff.
const VARIATION_SELECTOR_RE = new RegExp(
  '(\\p{Extended_Pictographic})[\\uFE0E\\uFE0F]|[\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]',
  'gu',
);

// The invisible-format sweep: the named ranges above UNION \p{Cf}, minus ZWJ
// (already handled). why: `v`-flag set subtraction is the only way to say
// "all format chars EXCEPT the one that doubles as an emoji joiner".
const INVISIBLES_RE = new RegExp(
  `[[${ZERO_WIDTH}${BIDI_CONTROLS}${TAG_BLOCK}\\p{Cf}]--[\\u200D]]`,
  'gv',
);

// why: HTML comments are never painted, so any instruction inside one is
// invisible to the human and visible to the model. We strip well-formed
// `<!-- ... -->` pairs REGARDLESS of surrounding context — including inside
// code-looking text. This can eat a literal comment a user is genuinely
// reading in a code snippet; that is the deliberate security default at the
// READ boundary (a page-text snapshot is data to reason over, not source to
// preserve verbatim). An UNCLOSED `<!--` is left as-is: with no `-->` it can
// smuggle nothing, so removing it would only mangle innocent text.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/gu;

/**
 * Disarm serialized page text: strip content invisible to a human but visible
 * to the model, leaving all legitimate visible text untouched. Returns '' for
 * a non-string so callers can pass a possibly-undefined snapshot.
 *
 * Order matters. Invisible/control bytes are removed FIRST, so an obfuscated
 * comment marker (e.g. `<!--` interleaved with zero-width separators, a
 * variation selector, or a NUL byte) is reassembled into a plain `<!--` and
 * then caught by the comment pass.
 *
 * @param {unknown} raw  serialized page text (a11y snapshot or markdown)
 * @returns {string}
 */
export const disarmText = (raw) => {
  if (typeof raw !== 'string') return '';
  return raw
    // 1. Zero-width joiners: strip the standalone ones, keep emoji joiners.
    .replace(ZWJ_RE, (match, emoji) => (emoji ? match : ''))
    // 2. Variation selectors: strip smuggling VS, keep one emoji-presentation
    //    VS15/VS16 after a pictograph. Same emoji-aware phase as ZWJ.
    .replace(VARIATION_SELECTOR_RE, (match, emoji) => (emoji ? match : ''))
    // 3. Remaining invisible format chars (zero-width, bidi, tags, other Cf).
    .replace(INVISIBLES_RE, '')
    // 4. Control-byte runs (invisible separators), preserving TAB/LF/CR.
    .replace(CONTROL_RE, '')
    // 5. HTML comments — now that any obfuscating invisibles are gone.
    .replace(HTML_COMMENT_RE, '');
};
