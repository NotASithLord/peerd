// @ts-check
// git-credential-routes — the SW message handlers for git token provisioning.
//
// Three routes back the Settings → Git credentials UI: list the HOST NAMES the
// vault holds a `git:<host>` token for, set one (validate + canonicalize host,
// sanity-check the token), and delete one. Tokens are write-only from the UI's
// point of view — `list` returns host names ONLY, never values; the token is
// decrypted just-in-time in injectGitAuth at request time (vm-http-fetch.js).
//
// Factored out of service-worker.js as an IO-injected factory so the validation
// + error mapping is bun-testable without a SW. The pure host/token policy lives
// in git-credentials.js; this composes it over an injected vault + audit. All IO
// is injected — no vault/audit import here.

import { normalizeGitHost, gitSecretName, gitHostFromSecretName, isPlausibleGitToken } from './git-credentials.js';

/**
 * Build the git-credential route handlers.
 * @param {Object} deps
 * @param {{ listSecretNames: () => Promise<string[]>, setSecret: (name: string, value: string) => Promise<void>, deleteSecret: (name: string) => Promise<void> }} deps.vault
 * @param {(e: any) => boolean} deps.isLockedError  maps a thrown error to the 'locked' response
 * @param {(e: any) => void} [deps.audit]
 * @returns {{ 'git-cred/list': Function, 'git-cred/set': Function, 'git-cred/delete': Function }}
 */
export const makeGitCredentialRoutes = ({ vault, isLockedError, audit }) => {
  /** @param {any} e */ // why: audit payloads are free-form structured-clone records
  const auditSafe = (e) => { try { audit?.(e); } catch { /* best effort */ } };
  // Map a vault-locked throw to the soft 'locked' result; re-raise anything else.
  /** @param {() => Promise<any>} fn */
  const guard = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (isLockedError(e)) return { ok: false, error: 'locked' };
      throw e;
    }
  };

  return {
    'git-cred/list': () => guard(async () => {
      const names = await vault.listSecretNames();
      const hosts = names.map(gitHostFromSecretName).filter(Boolean).sort();
      return { ok: true, hosts };
    }),

    /** @param {{ host?: string, token?: string }} arg */
    'git-cred/set': ({ host, token }) => guard(async () => {
      const canonical = normalizeGitHost(String(host ?? ''));
      if (!canonical) return { ok: false, error: 'bad-host' };
      const t = typeof token === 'string' ? token.trim() : '';
      if (!isPlausibleGitToken(t)) return { ok: false, error: 'bad-token' };
      await vault.setSecret(gitSecretName(canonical), t);
      auditSafe({ type: 'git_credential_added', details: { host: canonical } });
      return { ok: true, host: canonical };
    }),

    /** @param {{ host?: string }} arg */
    'git-cred/delete': ({ host }) => guard(async () => {
      const canonical = normalizeGitHost(String(host ?? '')) ?? String(host ?? '');
      if (!canonical) return { ok: false, error: 'bad-host' };
      await vault.deleteSecret(gitSecretName(canonical));
      auditSafe({ type: 'git_credential_removed', details: { host: canonical } });
      return { ok: true };
    }),
  };
};
