// @ts-check
// Single-use, lease-bound SW <-> repository host capability.

import { base64ToBytes, bytesToBase64 } from './cold-util.js';

export const REPOSITORY_KERNEL_FETCH = 'repository/kernel-fetch';
export const REPOSITORY_KERNEL_FETCH_RESULT = 'repository/kernel-fetch-result';
export const REPOSITORY_CHANNEL_RESULT = 'repository/result';
export const REPOSITORY_CHANNEL_CANCEL = 'repository/cancel';
export const REPOSITORY_MAX_KERNEL_FETCHES = 8;
export const GIT_SECRET_PREFIX = 'git:';
const GIT_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/** @returns {unknown} */
export const encodeRepositoryRpcValue = (/** @type {unknown} */ value) => {
  if (value instanceof Uint8Array) return { __peerdRepositoryBytes: bytesToBase64(value) };
  if (value instanceof ArrayBuffer) {
    return { __peerdRepositoryBytes: bytesToBase64(new Uint8Array(value)) };
  }
  if (Array.isArray(value)) return value.map(encodeRepositoryRpcValue);
  if (!value || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'signal')
    .map(([key, entry]) => [key, encodeRepositoryRpcValue(entry)]));
};

/** @returns {unknown} */
export const decodeRepositoryRpcValue = (/** @type {unknown} */ value) => {
  if (Array.isArray(value)) return value.map(decodeRepositoryRpcValue);
  if (!value || typeof value !== 'object') return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(record).length === 1 && typeof record.__peerdRepositoryBytes === 'string') {
    return base64ToBytes(record.__peerdRepositoryBytes);
  }
  return Object.fromEntries(Object.entries(record)
    .map(([key, entry]) => [key, decodeRepositoryRpcValue(entry)]));
};

/** @param {string} host */
export const canonicalGitHost = (host) => {
  const value = String(host || '').trim().toLowerCase().replace(/^www\./, '');
  return value === 'api.github.com' ? 'github.com' : value;
};
/** @param {string} input */
export const normalizeGitHost = (input) => {
  let host = String(input || '').trim().toLowerCase();
  if (!host) return null;
  if (host.includes('://')) {
    try { host = new URL(host).hostname; } catch { return null; }
  } else host = host.split('/')[0];
  host = canonicalGitHost(host.replace(/\.$/, ''));
  return GIT_HOST_RE.test(host) ? host : null;
};
/** @param {string} token */
export const isPlausibleGitToken = (token) => typeof token === 'string'
  && token.trim().length >= 8 && !/\s/.test(token.trim());
/** @param {string} host */
export const gitSecretName = (host) => `${GIT_SECRET_PREFIX}${host}`;
/** @param {string} name */
export const gitHostFromSecretName = (name) => String(name).startsWith(GIT_SECRET_PREFIX)
  ? String(name).slice(GIT_SECRET_PREFIX.length) : null;
/** @param {string} url */
export const authHostForRequestUrl = (url) => {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  const host = canonicalGitHost(parsed.hostname);
  return GIT_HOST_RE.test(host) ? host : null;
};
/** @param {string} host @param {string} token @returns {Record<string, string>} */
export const gitAuthHeader = (host, token) => host === 'gitlab.com' || host.endsWith('.gitlab.com')
  ? { 'PRIVATE-TOKEN': token } : { Authorization: `Bearer ${token}` };

/**
 * Exact-value, per-host credential effects shared by the legacy and native
 * workers. A lost reply can be finished with the same host/token; the second
 * call observes the committed value and performs no write or duplicate audit.
 * @param {Object} deps
 * @param {{listSecretNames:()=>Promise<string[]>,getSecret?:(name:string)=>Promise<string|null>,setSecret:(name:string,value:string)=>Promise<void>,deleteSecret:(name:string)=>Promise<void>}} deps.vault
 * @param {(cause:unknown)=>boolean} deps.isLockedError
 * @param {(event:any)=>void} [deps.audit]
 */
export const createGitCredentialRoutes = ({ vault, isLockedError, audit }) => {
  /** @type {Map<string,Promise<void>>} */ const tails = new Map();
  /** @template T @param {string} host @param {()=>Promise<T>} operation */
  const enqueue = (host, operation) => {
    const result = (tails.get(host) ?? Promise.resolve()).then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(host, tail);
    void tail.finally(() => { if (tails.get(host) === tail) tails.delete(host); });
    return result;
  };
  const locked = (/** @type {unknown} */ cause) => isLockedError(cause)
    ? { ok: false, error: 'locked' } : null;
  const unknown = (/** @type {unknown} */ cause) => locked(cause) ?? ({
    ok: false, error: 'git-credential-outcome-unknown', code: 'git-credential-outcome-unknown',
    outcomeKnown: false, outcomeKind: 'unknown', retryable: false,
  });
  const guard = async (/** @type {()=>Promise<any>} */ operation) => {
    try { return await operation(); }
    catch (cause) { const refusal = locked(cause); if (refusal) return refusal; throw cause; }
  };
  return Object.freeze({
    'git-cred/list': () => guard(async () => ({
      ok: true,
      hosts: (await vault.listSecretNames()).map(gitHostFromSecretName).filter(Boolean).sort(),
    })),
    'git-cred/set': (/** @type {{host?:string,token?:string}} */ { host, token } = {}) => guard(async () => {
      const canonical = normalizeGitHost(String(host ?? ''));
      const value = typeof token === 'string' ? token.trim() : '';
      if (!canonical) return { ok: false, error: 'bad-host' };
      if (!isPlausibleGitToken(value)) return { ok: false, error: 'bad-token' };
      return enqueue(canonical, async () => {
        const name = gitSecretName(canonical);
        if (vault.getSecret && await vault.getSecret(name) === value) {
          return { ok: true, host: canonical };
        }
        try { await vault.setSecret(name, value); } catch (cause) { return unknown(cause); }
        try { audit?.({ type: 'git_credential_added', details: { host: canonical } }); } catch {}
        return { ok: true, host: canonical };
      });
    }),
    'git-cred/delete': (/** @type {{host?:string}} */ { host } = {}) => guard(async () => {
      const canonical = normalizeGitHost(String(host ?? '')) ?? String(host ?? '');
      if (!canonical) return { ok: false, error: 'bad-host' };
      return enqueue(canonical, async () => {
        const name = gitSecretName(canonical);
        if (!(await vault.listSecretNames()).includes(name)) return { ok: true };
        try { await vault.deleteSecret(name); } catch (cause) { return unknown(cause); }
        try { audit?.({ type: 'git_credential_removed', details: { host: canonical } }); } catch {}
        return { ok: true };
      });
    }),
  });
};
