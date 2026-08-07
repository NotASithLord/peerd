// @ts-check
// Credentialless one-way client for sealed Contributor Metrics batches.
// This preview-only source stays unexported until #346 has a verified origin;
// wiring an invented host would create an accidental rollout surface.

export const CONTRIBUTION_PATH = '/v1/contributions';
export const CONTRIBUTION_SCHEMA_VERSION = 1;
export const CONTRIBUTION_MAX_ROWS = 256;
export const CONTRIBUTION_MAX_BODY_BYTES = 256 * 1024;
export const CONTRIBUTION_MAX_RESPONSE_BYTES = 512;
export const CONTRIBUTION_REQUEST_TIMEOUT_MS = 8_000;

const RECEIPT_KEYS = Object.freeze(['schemaVersion', 'status']);
const BATCH_KEYS = Object.freeze(['schemaVersion', 'batchId', 'rows']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ContributionClientError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = 'ContributionClientError';
    this.code = code;
  }
}

/** @param {unknown} value @param {readonly string[]} expected */
const hasExactKeys = (value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

/** @param {string} value */
const utf8Size = (value) => new TextEncoder().encode(value).byteLength;

/** @param {unknown} raw */
const requireExactOrigin = (raw) => {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ContributionClientError('contribution-origin-disabled');
  }
  /** @type {URL} */
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new ContributionClientError('contribution-origin-invalid'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== raw
      || parsed.username !== '' || parsed.password !== ''
      || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new ContributionClientError('contribution-origin-invalid');
  }
  return parsed.origin;
};

/** @param {unknown} body */
export const validateContributionBatchBytes = (body) => {
  if (typeof body !== 'string') throw new ContributionClientError('contribution-body-invalid');
  const bodyBytes = utf8Size(body);
  if (bodyBytes > CONTRIBUTION_MAX_BODY_BYTES) {
    throw new ContributionClientError('contribution-body-too-large');
  }
  /** @type {unknown} */
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { throw new ContributionClientError('contribution-body-invalid'); }
  if (!hasExactKeys(parsed, BATCH_KEYS)) throw new ContributionClientError('contribution-body-invalid');
  const batch = /** @type {{ schemaVersion?: unknown, batchId?: unknown, rows?: unknown }} */ (parsed);
  if (batch.schemaVersion !== CONTRIBUTION_SCHEMA_VERSION
      || typeof batch.batchId !== 'string' || !UUID_V4.test(batch.batchId)
      || !Array.isArray(batch.rows) || batch.rows.length < 1
      || batch.rows.length > CONTRIBUTION_MAX_ROWS
      || JSON.stringify({
        schemaVersion: batch.schemaVersion, batchId: batch.batchId, rows: batch.rows,
      }) !== body) {
    throw new ContributionClientError('contribution-body-invalid');
  }
  const canonicalBytes = JSON.stringify({
    schemaVersion: batch.schemaVersion, rows: batch.rows,
  });
  return Object.freeze({
    body, bodyBytes, rowCount: batch.rows.length, batchId: batch.batchId, canonicalBytes,
  });
};

/** @param {Response} response */
const readBoundedResponse = async (response) => {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared)
      || Number(declared) > CONTRIBUTION_MAX_RESPONSE_BYTES)) {
    throw new ContributionClientError('contribution-response-too-large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new ContributionClientError('contribution-response-invalid');
      }
      total += value.byteLength;
      if (total > CONTRIBUTION_MAX_RESPONSE_BYTES) {
        throw new ContributionClientError('contribution-response-too-large');
      }
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* the original refusal wins */ }
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ContributionClientError('contribution-response-invalid'); }
};

/** @param {string} body */
const parseReceipt = (body) => {
  /** @type {unknown} */
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { throw new ContributionClientError('contribution-receipt-invalid'); }
  if (!hasExactKeys(parsed, RECEIPT_KEYS)) {
    throw new ContributionClientError('contribution-receipt-invalid');
  }
  const receipt = /** @type {{ schemaVersion?: unknown, status?: unknown }} */ (parsed);
  if (receipt.schemaVersion !== CONTRIBUTION_SCHEMA_VERSION
      || (receipt.status !== 'accepted' && receipt.status !== 'rejected')) {
    throw new ContributionClientError('contribution-receipt-invalid');
  }
  return /** @type {'accepted'|'rejected'} */ (receipt.status);
};

/**
 * @param {Object} deps
 * @param {string|null|undefined} deps.origin
 * @param {(input: string, init: RequestInit) => Promise<Response>} [deps.fetchImpl]
 * @param {(entry: { type: string, details: Record<string, number|string> }) => Promise<unknown>} deps.audit
 * @param {(bytes: string) => { schemaVersion: number, rows: readonly unknown[] }} deps.validateCanonicalBytes
 * @param {(callback: () => void, delay: number) => any} [deps.setTimer]
 * @param {(timer: any) => void} [deps.clearTimer]
 */
export const makeContributionClient = ({
  origin, fetchImpl = globalThis.fetch, audit, validateCanonicalBytes,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
}) => {
  const configuredOrigin = requireExactOrigin(origin);
  if (typeof fetchImpl !== 'function' || typeof audit !== 'function'
      || typeof validateCanonicalBytes !== 'function') {
    throw new TypeError('contribution client requires fetchImpl, audit, and canonical validation');
  }
  const endpoint = `${configuredOrigin}${CONTRIBUTION_PATH}`;

  /** @param {{ body: string, signal?: AbortSignal }} input */
  const send = async ({ body, signal }) => {
    const sealed = validateContributionBatchBytes(body);
    // why validate again here: storage is not a trust boundary. Every actual
    // send re-enters #345's complete closed-row validator; the shallow batch
    // wrapper check alone must never admit an arbitrary URL/content property.
    let canonical;
    try { canonical = validateCanonicalBytes(sealed.canonicalBytes); }
    catch { throw new ContributionClientError('contribution-body-invalid'); }
    if (!canonical || canonical.schemaVersion !== CONTRIBUTION_SCHEMA_VERSION
        || !Array.isArray(canonical.rows) || canonical.rows.length !== sealed.rowCount
        || JSON.stringify(canonical) !== sealed.canonicalBytes) {
      throw new ContributionClientError('contribution-body-invalid');
    }
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
    }, CONTRIBUTION_REQUEST_TIMEOUT_MS);
    try {
      // why audit before fetch: if the append-only log is unavailable, do not
      // create an unrecorded network attempt. The surrounding finally still
      // removes the timer/listener if the audit write itself fails.
      await audit({
        type: 'contribution-upload-attempt',
        details: { bodyBytes: sealed.bodyBytes, rowCount: sealed.rowCount },
      });
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sealed.body,
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (response.url && response.url !== endpoint) {
        throw new ContributionClientError('contribution-response-origin-mismatch');
      }
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (mediaType !== 'application/json') {
        throw new ContributionClientError('contribution-response-content-type-invalid');
      }
      const receipt = parseReceipt(await readBoundedResponse(response));
      if ((receipt === 'accepted' && response.status !== 202)
          || (receipt === 'rejected' && (response.status < 400 || response.status > 599))) {
        throw new ContributionClientError('contribution-receipt-invalid');
      }
      const accepted = receipt === 'accepted';
      await audit({
        type: accepted ? 'contribution-upload-accepted' : 'contribution-upload-rejected',
        details: { status: response.status, rowCount: sealed.rowCount },
      });
      return Object.freeze({ accepted, status: response.status });
    } catch (error) {
      const code = timedOut ? 'contribution-timeout'
        : controller.signal.aborted ? 'contribution-aborted'
          : error instanceof ContributionClientError ? error.code
            : 'contribution-network-failed';
      try {
        await audit({
          type: 'contribution-upload-failed',
          details: { status: 0, rowCount: sealed.rowCount, reason: code },
        });
      } catch { /* preserve the bounded client failure, never server text */ }
      if (error instanceof ContributionClientError && error.code === code) throw error;
      throw new ContributionClientError(code);
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  };

  return Object.freeze({ origin: configuredOrigin, endpoint, send });
};
