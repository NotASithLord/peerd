// @ts-check

export const SECRET_PARAM_RE = /(token|secret|password|passwd|api[-_]?key|auth|session|csrf|xsrf|bearer|access[-_]?token|refresh[-_]?token|sig|signature|\bs?sid\b)/i;
export const REDACTED = '<redacted>';

/**
 * Sketch the shape of a JSON-like value without retaining payload values.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export const shapeSketch = (value, depth = 0) => {
  if (value == null) return value === null ? 'null' : 'undefined';
  const type = typeof value;
  if (type === 'string') return 'string';
  if (type === 'number' || type === 'boolean') return type;
  if (type !== 'object') return type;
  if (depth > 3) return '…';
  if (Array.isArray(value)) {
    return value.length ? [shapeSketch(value[0], depth + 1), `…×${value.length}`] : [];
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  let count = 0;
  for (const [key, child] of Object.entries(/** @type {object} */ (value))) {
    if (count++ >= 24) {
      out['…'] = 1;
      break;
    }
    out[key] = SECRET_PARAM_RE.test(key) ? REDACTED : shapeSketch(child, depth + 1);
  }
  return out;
};
