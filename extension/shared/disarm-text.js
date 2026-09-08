// @ts-check
// Small, browser-neutral invisible-text scrubber shared by cold metadata
// readers. Rich CDR also covers markup; this leaf deliberately owns only the
// universal text pass so a command name cannot pull that feature into wake 1.

const ZERO_WIDTH = '\\u200B\\u2060\\uFEFF\\u00AD';
const ZWNJ_SCRIPTS = '\\p{Script=Arabic}\\p{Script=Devanagari}\\p{Script=Bengali}'
  + '\\p{Script=Gurmukhi}\\p{Script=Gujarati}\\p{Script=Oriya}\\p{Script=Tamil}'
  + '\\p{Script=Telugu}\\p{Script=Kannada}\\p{Script=Malayalam}\\p{Script=Sinhala}'
  + '\\p{Script=Myanmar}\\p{Script=Thaana}';
const ZWNJ_RE = new RegExp(
  `([${ZWNJ_SCRIPTS}])\\u200C(?=[${ZWNJ_SCRIPTS}])|\\u200C`, 'gu',
);
const BIDI_CONTROLS = '\\u202A-\\u202E\\u2066-\\u2069';
const TAG_BLOCK = '\\u{E0000}-\\u{E007F}';
const CONTROL_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u0080-\\u009F]+',
  'gu',
);
const ZWJ_RE = new RegExp(
  '(\\p{Extended_Pictographic}\\p{Emoji_Modifier}?\\uFE0F?)\\u200D(?=\\p{Extended_Pictographic})|\\u200D',
  'gu',
);
const VARIATION_SELECTOR_RE = new RegExp(
  '(\\p{Extended_Pictographic})[\\uFE0E\\uFE0F]|[\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]',
  'gu',
);
const INVISIBLE_MARKS = '\\u034F';
const INVISIBLES_RE = new RegExp(
  `[[${ZERO_WIDTH}${BIDI_CONTROLS}${TAG_BLOCK}${INVISIBLE_MARKS}\\p{Cf}]--[\\u200D\\u200C]]`,
  'gv',
);

/** @param {unknown} raw */
export const disarmText = (raw) => {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(ZWJ_RE, (match, emoji) => (emoji ? match : ''))
    .replace(ZWNJ_RE, (match, letter) => (letter ? match : ''))
    .replace(VARIATION_SELECTOR_RE, (match, emoji) => (emoji ? match : ''))
    .replace(INVISIBLES_RE, '')
    .replace(CONTROL_RE, '');
};
