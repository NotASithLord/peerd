// @ts-check
// origin-credential-routes — the SW message handlers for API-key provisioning.
//
// DESIGN-18 P1. Three routes back the Settings → API integrations UI: list the ORIGINS
// the vault holds an `origin:<origin>` key for, set one (https-only canonicalize +
// build the {header,value} secret), and delete one. Keys are WRITE-ONLY from the UI's
// point of view — `list` returns origins + the header NAME only, never the value; the
// value is decrypted just-in-time at the egress boundary (withApiCredentials).
//
// The exact shape + the IO-injected factory mirror git-credential-routes.js so the
// validation + error mapping is bun-testable without a SW. The pure origin/key policy
// lives in origin-credentials.js; this composes it over an injected vault + audit.

import { normalizeKeyedOrigin, originSecretName, originFromSecretName, buildOriginSecret, parseOriginAuth } from './origin-credentials.js';

/**
 * Build the origin-credential route handlers.
 * @param {Object} deps
 * @param {{ listSecretNames: () => Promise<string[]>, getSecret: (name: string) => Promise<string|null>, setSecret: (name: string, value: string) => Promise<void>, deleteSecret: (name: string) => Promise<void> }} deps.vault
 * @param {(e: any) => boolean} deps.isLockedError  maps a thrown error to the 'locked' response
 * @param {(e: any) => void} [deps.audit]
 * @returns {{ 'origin-cred/list': Function, 'origin-cred/set': Function, 'origin-cred/delete': Function }}
 */
export const makeOriginCredentialRoutes = ({ vault, isLockedError, audit }) => {
  /** @param {any} e */
  const auditSafe = (e) => { try { audit?.(e); } catch { /* best effort */ } };
  /** @param {() => Promise<any>} fn */
  const guard = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (isLockedError(e)) return { ok: false, error: 'locked' };
      throw e;
    }
  };

  return {
    // List origins we hold a key for + the header NAME each uses (so the UI can show
    // "api.stripe.com · Authorization" without ever decrypting the value). A malformed
    // stored secret degrades to header:null rather than failing the whole list.
    'origin-cred/list': () => guard(async () => {
      const names = await vault.listSecretNames();
      const origins = names.map(originFromSecretName).filter(Boolean).sort();
      /** @type {Array<{ origin: string, header: string | null }>} */
      const integrations = [];
      for (const origin of /** @type {string[]} */ (origins)) {
        let header = null;
        try { const auth = parseOriginAuth(await vault.getSecret(originSecretName(origin))); header = auth ? auth.header : null; }
        catch { header = null; }
        integrations.push({ origin, header });
      }
      return { ok: true, integrations };
    }),

    /** @param {{ origin?: string, key?: string, header?: string, scheme?: 'bearer' | 'raw' }} arg */
    'origin-cred/set': ({ origin, key, header, scheme }) => guard(async () => {
      const canonical = normalizeKeyedOrigin(String(origin ?? ''));
      if (!canonical) return { ok: false, error: 'bad-origin' };   // rule 2: https public host only
      const secret = buildOriginSecret({ key, header, scheme });
      if (!secret) return { ok: false, error: 'bad-key' };
      await vault.setSecret(originSecretName(canonical), secret);
      // Audit the ORIGIN only — never the key (rule 6).
      auditSafe({ type: 'origin_credential_added', details: { origin: canonical } });
      return { ok: true, origin: canonical };
    }),

    /** @param {{ origin?: string }} arg */
    'origin-cred/delete': ({ origin }) => guard(async () => {
      const canonical = normalizeKeyedOrigin(String(origin ?? '')) ?? String(origin ?? '');
      if (!canonical) return { ok: false, error: 'bad-origin' };
      await vault.deleteSecret(originSecretName(canonical));
      auditSafe({ type: 'origin_credential_removed', details: { origin: canonical } });
      return { ok: true };
    }),
  };
};
