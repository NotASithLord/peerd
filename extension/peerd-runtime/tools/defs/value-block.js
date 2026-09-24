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
 * Serialize a run value + report whether it overflows the [VALUE] cap.
 * why a separate pure helper: the spill path (script → resultStore) must know the
 * FULL text and the overflow verdict BEFORE formatting, without duplicating the
 * stringify fallback chain here — one serialization contract, two consumers.
 * @param {unknown} value
 * @returns {{ text: string, truncated: boolean } | undefined} undefined when the run returned nothing
 */
export const serializeValue = (value) => {
  if (value === undefined) return undefined;
  let text;
  try { text = JSON.stringify(value, null, 2); }
  catch { text = String(value); }
  if (typeof text !== 'string') text = String(text);
  return { text, truncated: text.length > VALUE_MAX_CHARS };
};

/**
 * Append the [VALUE] block for a run result value to `lines`. A caller that
 * already ran serializeValue (script's spill step) passes the result as
 * `serialized` so the stringify chain runs ONCE per value — everyone else
 * omits it and this serializes itself.
 * @param {string[]} lines @param {unknown} value
 * @param {{ text: string, truncated: boolean }} [serialized]  precomputed serializeValue(value)
 */
export const pushValueBlock = (lines, value, serialized) => {
  const sv = serialized ?? serializeValue(value);
  if (sv === undefined) return;
  lines.push('[VALUE]');
  if (!sv.truncated) {
    lines.push(sv.text);
    return;
  }
  lines.push(sv.text.slice(0, VALUE_MAX_CHARS));
  lines.push(`[VALUE TRUNCATED — ${sv.text.length.toLocaleString()} chars total. Return a COMPACT value (an aggregate, a slice, or a chart()/table() descriptor from peerd:std); recompute rather than re-request this blob.]`);
};
