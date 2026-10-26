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

const SHAPE_MARKERS = new Set([
  'string', 'number', 'boolean', 'null', 'undefined', 'bigint', 'symbol',
  'function', '…', REDACTED,
]);

/**
 * Accept the bounded shape vocabulary produced by the capture taps without
 * sketching it twice. Page-side tap output remains untrusted: arbitrary leaf
 * strings must never pass through merely because they claim to be a sketch.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export const sanitizeShapeSketch = (value, depth = 0) => {
  if (typeof value === 'string') return SHAPE_MARKERS.has(value) ? value : 'string';
  if (value === null || typeof value !== 'object') return shapeSketch(value);
  if (depth > 3) return '…';
  if (Array.isArray(value)) {
    if (!value.length) return [];
    const count = typeof value[1] === 'string' && /^…×[1-9]\d{0,9}$/.test(value[1])
      ? value[1] : '…';
    return [sanitizeShapeSketch(value[0], depth + 1), count];
  }
  /** @type {Record<string, unknown>} */
  const out = Object.create(null);
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (count++ >= 24) { out['…'] = 1; break; }
    out[key] = SECRET_PARAM_RE.test(key) ? REDACTED
      : key === '…' ? 1 : sanitizeShapeSketch(child, depth + 1);
  }
  return out;
};
