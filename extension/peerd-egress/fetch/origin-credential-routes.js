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
 *
 * The three `*DpopKey*` seams are what make a DPoP credential a real, complete
 * lifecycle rather than a claim: PROVISION mints the keypair so the thumbprint
 * exists to register, LIST surfaces that public thumbprint (read-only — listing
 * must never mint), and DELETE retires it alongside the token. All three are
 * optional so a caller with no DPoP wiring (and every existing test) still works;
 * the routes then behave exactly as before.
 * @param {Object} deps
 * @param {{ listSecretNames: () => Promise<string[]>, getSecret: (name: string) => Promise<string|null>, setSecret: (name: string, value: string) => Promise<void>, deleteSecret: (name: string) => Promise<void> }} deps.vault
 * @param {(e: any) => boolean} deps.isLockedError  maps a thrown error to the 'locked' response
 * @param {(e: any) => void} [deps.audit]
 * @param {(origin: string) => Promise<string|null>} [deps.ensureDpopKey]  mint-or-load → the public `jkt`
 * @param {(origin: string) => Promise<string|null>} [deps.readDpopJkt]    read-only → the public `jkt` or null
 * @param {(origin: string) => Promise<void>} [deps.deleteDpopKey]         retire the keypair
 * @returns {{ 'origin-cred/list': Function, 'origin-cred/set': Function, 'origin-cred/delete': Function }}
 */
export const makeOriginCredentialRoutes = ({ vault, isLockedError, audit, ensureDpopKey, readDpopJkt, deleteDpopKey }) => {
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
    //
    // For a DPoP credential it also returns the `scheme` and the PUBLIC `jkt`
    // thumbprint. why the jkt is safe to surface — and why it MUST be: it is a hash of
    // a public key, the one key-derived value that is not a secret, and it is precisely
    // what the user has to paste into the authorization server's client registration
    // for the token to be bound at all. Never surfacing it is why DPoP was unreachable.
    // The read is read-ONLY: listing credentials never mints a key.
    'origin-cred/list': () => guard(async () => {
      const names = await vault.listSecretNames();
      const origins = names.map(originFromSecretName).filter(Boolean).sort();
      /** @type {Array<{ origin: string, header: string | null, scheme?: string, jkt?: string | null }>} */
      const integrations = [];
      for (const origin of /** @type {string[]} */ (origins)) {
        let header = null;
        /** @type {string | undefined} */
        let scheme;
        try {
          const auth = parseOriginAuth(await vault.getSecret(originSecretName(origin)));
          header = auth ? auth.header : null;
          scheme = auth?.scheme;
        } catch { header = null; }
        /** @type {string | null | undefined} */
        let jkt;
        if (scheme === 'dpop' && readDpopJkt) {
          try { jkt = await readDpopJkt(origin); } catch { jkt = null; }
        }
        integrations.push({ origin, header, scheme, jkt });
      }
      return { ok: true, integrations };
    }),

    // scheme 'dpop' provisions a proof-of-possession ACCESS TOKEN. The keypair it is
    // spent with is minted HERE, at provisioning time, and the route returns its
    // public `jkt` so the UI can show the user what to register with the server.
    // why not lazily on the first request (as it was): the binding has to exist
    // BEFORE the authorization server issues the token, so a thumbprint that only
    // appears after the first successful call is a thumbprint that arrives too late
    // to bind anything. Minting is still fail-soft — the credential saves either way,
    // and the boundary would mint on demand — so a crypto failure costs the
    // thumbprint, not the save. The private key never passes through this route.
    /** @param {{ origin?: string, key?: string, header?: string, scheme?: 'bearer' | 'raw' | 'dpop' }} arg */
    'origin-cred/set': ({ origin, key, header, scheme }) => guard(async () => {
      const canonical = normalizeKeyedOrigin(String(origin ?? ''));
      if (!canonical) return { ok: false, error: 'bad-origin' };   // rule 2: https public host only
      const secret = buildOriginSecret({ key, header, scheme });
      if (!secret) return { ok: false, error: 'bad-key' };         // includes an unknown scheme (never downgraded)
      await vault.setSecret(originSecretName(canonical), secret);
      /** @type {string | null | undefined} */
      let jkt;
      if (parseOriginAuth(secret)?.scheme === 'dpop' && ensureDpopKey) {
        try { jkt = await ensureDpopKey(canonical); } catch { jkt = null; }
      }
      // Audit the ORIGIN only — never the key (rule 6). The jkt is a public
      // thumbprint, so it is the one credential-derived value safe to record.
      auditSafe({ type: 'origin_credential_added', details: { origin: canonical, ...(jkt ? { jkt } : {}) } });
      return { ok: true, origin: canonical, jkt };
    }),

    // Revoking retires BOTH halves of the credential. The token alone was never the
    // whole thing: the keypair carries a stable `jkt` that the authorization server
    // knows this device by, so leaving it behind meant a later credential for the same
    // origin would re-present the exact fingerprint the user believed they removed —
    // a quiet re-linking of two integrations the user chose to separate.
    /** @param {{ origin?: string }} arg */
    'origin-cred/delete': ({ origin }) => guard(async () => {
      const canonical = normalizeKeyedOrigin(String(origin ?? '')) ?? String(origin ?? '');
      if (!canonical) return { ok: false, error: 'bad-origin' };
      await vault.deleteSecret(originSecretName(canonical));
      // Best-effort, INSIDE the guard and swallowing its own error: the vault delete
      // has already happened, so a failing key store must not turn a successful
      // revocation into an error the user would (wrongly) retry. The audit records
      // which halves actually went, so a stranded keypair is diagnosable.
      let dpopKeyRemoved = false;
      if (deleteDpopKey) {
        try { await deleteDpopKey(canonical); dpopKeyRemoved = true; } catch { dpopKeyRemoved = false; }
      }
      auditSafe({ type: 'origin_credential_removed', details: { origin: canonical, dpopKeyRemoved } });
      return { ok: true };
    }),
  };
};
