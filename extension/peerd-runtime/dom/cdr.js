// @ts-check
// peerd-runtime/dom — Content Disarm & Reconstruction (CDR) at the page-read
// boundary (issue #244).
//
// PURE (text in -> scrubbed text out), so it is fully unit-testable without a
// browser — same posture as ax-serialize.js.
//
// THREAT MODEL. A page can carry bytes that are INVISIBLE to the human who
// approved the read but fully VISIBLE to the model that reads the serialized
// snapshot: zero-width joiners spelling a hidden instruction, an HTML comment
// the renderer never paints, a bidi override that reorders text so what the
// user sees ("report.pdf") differs from what the model reads ("fdp.troper"),
// tag-block characters that smuggle plain ASCII with zero visual footprint.
// Each is a prompt-injection vector. CDR strips them, surgically — normal
// whitespace, punctuation, the LETTERS of every script, and emoji (INCLUDING
// multi-codepoint ZWJ emoji sequences) survive byte-for-byte.
//
// KNOWN COLLATERAL, because "every non-Latin script survives byte-for-byte" is
// what this said before and it was not true. The universal sweep takes the whole
// General_Category=Cf block, and a handful of Cf characters are ORTHOGRAPHIC
// marks belonging to the scripts it promises to leave alone — verified by
// running disarmText: ARABIC NUMBER SIGN (U+0600), SYRIAC ABBREVIATION MARK
// (U+070F), KAITHI NUMBER SIGN (U+110BD), MONGOLIAN VOWEL SEPARATOR (U+180E).
// They are stripped.
//
// That is the RIGHT call and it is the reason the claim is narrowed rather than
// the sweep: these are invisible by construction, so each one is exactly the
// covert channel this module exists to close, and exempting them would trade a
// real vector for a rendering nicety. What was wrong was the sentence, not the
// behaviour. The two Cf characters that ARE exempted (U+200C, U+200D) earn it by
// being load-bearing for spelling in living scripts — see ZWNJ_RE below.
//
// WHERE CDR SITS. This is the PRE-PASS, not the fence. The data/instruction
// boundary — tainting page text as DATA the model must not obey — is already
// wrapUntrusted's job (tools/prompt-wrap.js). CDR composes IN FRONT of it, so
// we deliberately add no competing wrapper — a second fence would just be a
// thing to keep in sync with the real one. CDR removes the invisible bytes;
// wrapUntrusted fences whatever visible text remains. Defense in depth, each
// layer with one job.
//
// TWO EXPORTS, because the fence is not only used for page markup.
//
//   disarmText(raw)    the UNIVERSAL sweep — invisible + control bytes only.
//                      Wired INSIDE wrapUntrusted (tools/prompt-wrap.js), so
//                      it covers every fenced body automatically and a new
//                      web-sourced tool cannot forget it.
//   disarmMarkup(raw)  disarmText PLUS HTML-comment removal. Applied only
//                      where the body is known to be page MARKUP — read_page's
//                      content mode, and fetch_url on an html/xml response
//                      (fetch_url reads APIs too, and on JSON `<!--` is
//                      visible content, not a hidden comment).
//
// why the split, concretely: wrapUntrusted fences ~27 callsites and only some
// carry page text. The rest carry SOURCE CODE and DIFFS — js_read_file,
// app_read_file, site_client_read, and a2a_run output. The
// invisible/control sweep is safe on all of them (a literal zero-width byte in
// source is the trojan-source attack, not a feature worth preserving). The
// HTML-comment pass is NOT: it would silently eat `<!-- ... -->` out of an HTML
// file the model is about to edit and write back, corrupting the user's file
// from a security pass they never asked for. So the destructive pass stays
// opt-in at the markup producers, and the safe one goes universal.
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

// why: classic zero-width smuggling — ZWSP (U+200B) splits a word so the model
// reads a token the human never sees; WORD JOINER (U+2060) and the BYTE ORDER
// MARK (U+FEFF) are zero-advance too; SOFT HYPHEN (U+00AD) is invisible unless
// a line breaks there. (ZWJ U+200D and ZWNJ U+200C are handled separately —
// each doubles as a legitimate mark: the emoji joiner, and Persian/Indic
// orthography.)
const ZERO_WIDTH = '\\u200B\\u2060\\uFEFF\\u00AD';

// Scripts in which ZWNJ is ORTHOGRAPHY, not decoration. Persian/Urdu (Arabic
// script) uses it to stop a cursive join — `می‌روم` without it is `میروم`, a
// different, wrong spelling; the Indic scripts use it to suppress a conjunct
// ligature. This is not an exhaustive Unicode list, it is the set where
// dropping the character CHANGES THE WORD a reader sees.
const ZWNJ_SCRIPTS = '\\p{Script=Arabic}\\p{Script=Devanagari}\\p{Script=Bengali}'
  + '\\p{Script=Gurmukhi}\\p{Script=Gujarati}\\p{Script=Oriya}\\p{Script=Tamil}'
  + '\\p{Script=Telugu}\\p{Script=Kannada}\\p{Script=Malayalam}\\p{Script=Sinhala}'
  + '\\p{Script=Myanmar}\\p{Script=Thaana}';

// Zero-width NON-joiner, decided by CONTEXT — the same shape as ZWJ_RE below,
// and for the same reason. why it cannot just be stripped: unlike the Cf marks
// named in the header as accepted collateral, this one CHANGES SPELLING, and the
// universal sweep is the ONE pass that runs on every fenced body — including
// source files and diffs the model is about to edit and write back. Stripping
// U+200C wholesale silently misspells Persian, Urdu and Hindi text on the way
// into the model, which is a correctness bug that would surface as the agent
// "helpfully" writing the misspelling back.
//
// KEEP a single ZWNJ only when it sits BETWEEN two letters of a script that
// uses it; strip it everywhere else. That is what closes the vector: an
// attacker cannot use it to split a Latin word, and inside Arabic-script text
// the hidden token would have to be Arabic-script too — visible to the human
// reading the same bytes. Leading capture + lookahead, no lookbehind, matching
// the house pattern.
const ZWNJ_RE = new RegExp(`([${ZWNJ_SCRIPTS}])\\u200C(?=[${ZWNJ_SCRIPTS}])|\\u200C`, 'gu');

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

// A few INVISIBLE marks are General_Category=Mn (a combining mark), NOT Format,
// so the \p{Cf} catch-all below structurally cannot reach them — and unlike the
// variation selectors handled above they carry no legitimate emoji/CJK role to
// preserve. COMBINING GRAPHEME JOINER (U+034F) renders as nothing yet the model
// reads it: splice it between letters to smuggle a token boundary the human
// never sees (the same class of covert channel as ZWSP, a different category).
// why NOT the Mongolian free variation selectors (U+180B-180D/180F, also Mn):
// like ZWNJ they do orthographic glyph-selection work in Mongolian text, so
// stripping them would change the word — accepted collateral, left in place.
const INVISIBLE_MARKS = '\\u034F';

// The invisible-format sweep: the named ranges above UNION \p{Cf}, minus ZWJ
// (already handled). why: `v`-flag set subtraction is the only way to say
// "all format chars EXCEPT the one that doubles as an emoji joiner".
const INVISIBLES_RE = new RegExp(
  `[[${ZERO_WIDTH}${BIDI_CONTROLS}${TAG_BLOCK}${INVISIBLE_MARKS}\\p{Cf}]--[\\u200D\\u200C]]`,
  'gv',
);

// why: HTML comments are never painted, so any instruction inside one is
// invisible to the human and visible to the model. We strip well-formed
// `<!-- ... -->` pairs REGARDLESS of surrounding context — including inside
// code-looking text. That destructiveness is exactly why this pass is NOT in
// the universal sweep: see disarmMarkup below for where it is safe to apply.
// An UNCLOSED `<!--` is left as-is: with no `-->` it can smuggle nothing, so
// removing it would only mangle innocent text.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/gu;

/**
 * The UNIVERSAL sweep: strip bytes that are invisible to a human but visible
 * to the model, leaving every legitimate visible character untouched. Returns
 * '' for a non-string so callers can pass a possibly-undefined body.
 *
 * Safe on ANY fenced body — page text, source code, diffs — because every
 * character it removes is one that renders as nothing. That is what lets it
 * live inside wrapUntrusted and cover all fenced content by construction.
 *
 * @param {unknown} raw  any untrusted text body
 * @returns {string}
 */
export const disarmText = (raw) => {
  if (typeof raw !== 'string') return '';
  return raw
    // 1. Zero-width joiners: strip the standalone ones, keep emoji joiners.
    .replace(ZWJ_RE, (match, emoji) => (emoji ? match : ''))
    // 1b. Zero-width NON-joiners: keep the ones doing orthographic work inside
    //     Persian/Indic text, strip the rest. Same contextual shape as (1).
    .replace(ZWNJ_RE, (match, letter) => (letter ? match : ''))
    // 2. Variation selectors: strip smuggling VS, keep one emoji-presentation
    //    VS15/VS16 after a pictograph. Same emoji-aware phase as ZWJ.
    .replace(VARIATION_SELECTOR_RE, (match, emoji) => (emoji ? match : ''))
    // 3. Remaining invisible format chars (zero-width, bidi, tags, other Cf).
    .replace(INVISIBLES_RE, '')
    // 4. Control-byte runs (invisible separators), preserving TAB/LF/CR.
    .replace(CONTROL_RE, '');
};

/**
 * The MARKUP sweep: disarmText plus HTML-comment removal. Apply ONLY where the
 * body is known to be page markup the model reads as data and never writes
 * back — read_page's content mode, and fetch_url once it has checked the
 * response's content type.
 *
 * Order matters, and it is the reason this composes rather than duplicating:
 * disarmText runs FIRST, so a comment marker obfuscated with zero-width
 * separators, a variation selector, or a NUL byte spliced between its
 * characters is reassembled into a plain `<!--` and only then caught by the
 * comment pass.
 *
 * @param {unknown} raw  serialized page markup / markdown
 * @returns {string}
 */
export const disarmMarkup = (raw) => disarmText(raw).replace(HTML_COMMENT_RE, '');
