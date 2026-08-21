// @ts-check
// Remote URL and Smart-HTTP boundary. Repository config is data, not authority:
// every request must stay under the exact HTTPS repository path the trusted
// caller bound, and credentials are attached after caller headers are stripped.

const PUBLIC_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/** @param {string} input */
export const normalizeGitRemote = (input) => {
  let url;
  try { url = new URL(String(input || '').trim()); }
  catch { throw new Error('invalid git remote URL'); }
  if (url.protocol !== 'https:') throw new Error('git remotes must use HTTPS');
  if (url.username || url.password) throw new Error('credentials do not belong in a git remote URL');
  if (url.port && url.port !== '443') throw new Error('git remotes must use the standard HTTPS port');
  if (url.search || url.hash) throw new Error('git remote URL must not contain a query or fragment');
  if (!PUBLIC_HOST.test(url.hostname) || /^[\d.]+$/.test(url.hostname)) {
    throw new Error('git remote must use a public hostname');
  }
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); }
  catch { throw new Error('git remote path is malformed'); }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.length < 2 || segments.some((part) => part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error('git remote must name a repository path');
  }
  url.pathname = `/${segments.join('/')}${segments.at(-1)?.endsWith('.git') ? '' : '.git'}`;
  return Object.freeze({ url: url.toString(), host: url.hostname.toLowerCase() });
};

/** @param {{ url: string }} remote @param {string} requestUrl */
export const gitRemoteOwnsRequest = (remote, requestUrl) => {
  try {
    const base = new URL(remote.url);
    const request = new URL(requestUrl);
    if (request.protocol !== 'https:' || request.origin !== base.origin) return false;
    const prefix = base.pathname.replace(/\/$/, '');
    return request.pathname === `${prefix}/info/refs`
      || request.pathname === `${prefix}/git-upload-pack`
      || request.pathname === `${prefix}/git-receive-pack`;
  } catch { return false; }
};

/** @param {string} host @param {string} token */
export const smartHttpAuthHeader = (host, token) => {
  const username = host === 'github.com' ? 'x-access-token'
    : (host === 'gitlab.com' || host.endsWith('.gitlab.com')) ? 'oauth2'
    : 'git';
  const raw = `${username}:${token}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
};

const MAX_GIT_HTTP_BODY = 32 * 1024 * 1024;
const GIT_HTTP_TIMEOUT_MS = 60_000;

/** @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>|undefined} body @param {AbortSignal} [signal] */
const collectBody = async (body, signal) => {
  if (!body) return undefined;
  /** @type {Uint8Array[]} */ const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    if (signal?.aborted) throw new Error('git operation aborted');
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > MAX_GIT_HTTP_BODY) throw new Error('git request body exceeds the transfer ceiling');
    chunks.push(bytes);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
};

/** @param {ReadableStream<Uint8Array>|null} stream @param {() => void} done */
const boundedResponseBody = async function* (stream, done) {
  if (!stream) { done(); return; }
  const reader = stream.getReader();
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const { done: isDone, value } = await reader.read();
      if (isDone) { complete = true; return; }
      total += value.byteLength;
      if (total > MAX_GIT_HTTP_BODY) {
        await reader.cancel('git response body exceeds the transfer ceiling').catch(() => {});
        throw new Error('git response body exceeds the transfer ceiling');
      }
      yield value;
    }
  } finally {
    if (!complete) await reader.cancel('git response consumer stopped').catch(() => {});
    reader.releaseLock();
    done();
  }
};

/**
 * @param {{ remote: { url: string, host: string }, webFetch: (url: string, init?: RequestInit,
 *   context?: { gitRemote: { url: string, host: string } }) => Promise<Response>,
 *   getSecret?: (name: string) => Promise<string|null>, audit?: (event: any) => void, signal?: AbortSignal }} deps
 */
export const createGitHttpClient = ({ remote, webFetch, getSecret, audit, signal }) => ({
  /** @param {{ url: string, method?: string, headers?: Record<string,string>, body?: AsyncIterable<Uint8Array>|Iterable<Uint8Array> }} request */
  request: async ({ url, method = 'GET', headers = {}, body }) => {
    if (!gitRemoteOwnsRequest(remote, url)) throw new Error('git transport escaped its bound repository');
    /** @type {Record<string,string>} */ const cleanHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (lower !== 'authorization' && lower !== 'cookie' && lower !== 'proxy-authorization') cleanHeaders[name] = value;
    }
    let token = null;
    try { token = await getSecret?.(`git:${remote.host}`) ?? null; } catch { /* anonymous */ }
    if (token) {
      cleanHeaders.Authorization = smartHttpAuthHeader(remote.host, token);
      try { audit?.({ type: 'git_auth_attached', details: { host: remote.host, transport: 'smart-http' } }); } catch { /* best effort */ }
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('git request timed out'), GIT_HTTP_TIMEOUT_MS);
    const onAbort = () => controller.abort(signal?.reason ?? 'git operation aborted');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    let payload;
    try { payload = await collectBody(body, controller.signal); }
    catch (error) {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      throw error;
    }
    let response;
    try {
      response = await webFetch(url, {
        method,
        headers: cleanHeaders,
        ...(payload ? { body: payload } : {}),
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
      }, { gitRemote: remote });
    } catch (error) {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      throw error;
    }
    return {
      url: response.url || url,
      method,
      headers: Object.fromEntries(response.headers.entries()),
      body: boundedResponseBody(
        /** @type {ReadableStream<Uint8Array>|null} */ (response.body),
        () => { clearTimeout(timeoutId); signal?.removeEventListener('abort', onAbort); },
      ),
      statusCode: response.status,
      statusMessage: response.statusText,
    };
  },
});
