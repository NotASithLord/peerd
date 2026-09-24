// @ts-check
// Human confirmation projection for final host-normalized web requests.

const MAX_TARGET_CHARS = 360;

const bounded = (/** @type {string} */ value, max = MAX_TARGET_CHARS) =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 16))}… (${value.length} chars)`;

const utf8Bytes = (/** @type {string} */ value) => new TextEncoder().encode(value).byteLength;

/**
 * @param {{url:string,method:string,headers?:Record<string,string>,body?:string,
 *   source?:'web request'|'site client'}} request
 */
export const finalWebRequestConfirmation = (request) => {
  const parsed = new URL(request.url);
  const method = String(request.method || 'GET').toUpperCase();
  const credentialNote = parsed.username || parsed.password
    ? ' Embedded URL credentials are present but hidden.' : '';
  // why: query values and credentials often are bearer secrets. The user sees
  // the exact origin/path plus the finite query-field shape, never those bytes.
  const queryNames = [...new Set([...parsed.searchParams.keys()])]
    .slice(0, 12).map((name) => bounded(name.replace(/[^a-zA-Z0-9_.-]/g, '�'), 48));
  const queryNote = parsed.search
    ? ` Query fields: ${queryNames.length > 0 ? queryNames.join(', ') : '(unnamed)'}`
      + `${parsed.searchParams.size > queryNames.length ? ', …' : ''}.`
    : '';
  const target = bounded(`${parsed.origin}${parsed.pathname}`);
  const headerCount = request.headers && typeof request.headers === 'object'
    ? Object.keys(request.headers).length : 0;
  const body = typeof request.body === 'string' ? request.body : undefined;
  const bodyNote = body === undefined
    ? 'No request body.'
    : `Request body: ${utf8Bytes(body)} bytes${/json/i.test(
      request.headers?.['content-type'] ?? request.headers?.['Content-Type'] ?? '',
    ) ? ' of JSON' : ''}; contents hidden.`;
  return Object.freeze({
    origins: Object.freeze([parsed.origin]),
    summary: `Allow ${method} ${target} from the ${request.source ?? 'web request'}?`
      + `${queryNote}${credentialNote}\n`
      + `${headerCount} non-credential request header${headerCount === 1 ? '' : 's'}. ${bodyNote}`,
  });
};
