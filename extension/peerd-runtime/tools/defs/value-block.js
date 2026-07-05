// @ts-check
// tools/defs/value-block.js — the shared [VALUE] block for a JS run's tool
// result (script headless + js_notebook eval).
//
// Capped AT THE SOURCE, not just by the loop's blind head+tail redaction: a
// giant returned value (the field case: a ~437k-char hand-rolled chart spec)
// would otherwise reach the model as broken JSON with its middle elided — the
// model can't tell that from a real value and keeps reasoning on garbage. A
// clean cut plus an explicit instruction ("return something smaller") is a
// signal the model can actually act on. The Notebook pane still shows the
// (separately capped) full render; this only shapes the MODEL's copy.

const VALUE_MAX_CHARS = 6000;

/**
 * Append the [VALUE] block for a run result value to `lines`.
 * @param {string[]} lines @param {unknown} value
 */
export const pushValueBlock = (lines, value) => {
  if (value === undefined) return;
  lines.push('[VALUE]');
  let text;
  try { text = JSON.stringify(value, null, 2); }
  catch { text = String(value); }
  if (typeof text !== 'string') text = String(text);
  if (text.length <= VALUE_MAX_CHARS) {
    lines.push(text);
    return;
  }
  lines.push(text.slice(0, VALUE_MAX_CHARS));
  lines.push(`[VALUE TRUNCATED — ${text.length.toLocaleString()} chars total. Return a COMPACT value (an aggregate, a slice, or a chart()/table() descriptor from peerd:std); recompute rather than re-request this blob.]`);
};
