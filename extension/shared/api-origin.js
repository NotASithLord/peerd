// @ts-check

// why: API actors use their canonical public origin as both address and host
// authority pin. Keeping this tiny normalizer in shared code lets actor
// admission and the final resource edge prove the same identity independently.
const API_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/**
 * Normalize an addressed API origin to a canonical public http(s) origin.
 * @param {unknown} input
 * @returns {string|null}
 */
export const normalizeApiOrigin = (input) => {
  let source = String(input ?? '').trim();
  if (!source) return null;
  if (!/^https?:\/\//i.test(source)) source = `https://${source}`;
  let parsed;
  try { parsed = new URL(source); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!API_HOSTNAME_RE.test(parsed.hostname)) return null;
  return parsed.origin;
};
