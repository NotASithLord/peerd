// @ts-check
// git-credentials — the pure rules for git token storage + host-bound use.
//
// Security-critical, so it lives in ONE tested place. A git token is a bearer
// secret (same class as a model API key): it's stored in the vault, decrypted
// only in the SW at request time, and NEVER shown to the agent or the VM. This
// module owns the three pure decisions around it:
//   1. naming      — host → vault secret name (`git:<host>`), and back
//   2. validation  — is this a storable host? a plausible token?
//   3. HOST-BINDING — given an outbound request URL, which credential host (if
//      any) may authenticate it, and what header shape to use.
//
// The host-binding gate is the anti-exfil core: a token is only ever attached
// to an HTTPS request whose host canonicalizes to the token's exact host. Over
// http it is refused outright (a bearer token must never cross the wire in
// cleartext). Combined with webFetch's redirect refusal + SSRF block, a
// prompt-injected clone of an attacker URL cannot carry your token off-host.

export const GIT_SECRET_PREFIX = 'git:';

/**
 * Canonicalize a host for credential lookup so a forge's API and web/archive
 * hosts share one token. GitHub splits api.github.com vs github.com; GitLab/
 * Gitea use a single host for both, so only the GitHub case needs mapping.
 * @param {string} host
 * @returns {string}
 */
export const canonicalGitHost = (host) => {
  const h = String(host || '').trim().toLowerCase().replace(/^www\./, '');
  if (h === 'api.github.com') return 'github.com';
  return h;
};

// A real public DNS hostname: dot-separated labels ending in an alpha TLD.
// Rejects bare `localhost` (no TLD) and bare IPs (numeric TLD) without needing
// the egress SSRF helper here — the SW's webFetch still enforces the network
// SSRF block at send time; this is just input hygiene for what we STORE.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/**
 * Normalize a user-entered host (accepts a bare host, or a URL we extract the
 * host from) to a canonical, storable hostname — or null if it isn't a valid
 * public host. Used when SAVING a token.
 * @param {string} input
 * @returns {string|null}
 */
export const normalizeGitHost = (input) => {
  let h = String(input || '').trim().toLowerCase();
  if (!h) return null;
  if (h.includes('://')) { try { h = new URL(h).hostname; } catch { return null; } }
  else { h = h.split('/')[0]; }            // strip any accidental path
  h = h.replace(/^www\./, '').replace(/\.$/, '');
  if (!HOSTNAME_RE.test(h)) return null;   // rejects localhost, raw IPs, junk
  return canonicalGitHost(h);
};

/**
 * A plausible token: non-empty, no whitespace, a sane minimum length. Format
 * varies across PAT schemes, so this is a sanity gate, not a validator.
 * @param {string} token
 * @returns {boolean}
 */
export const isPlausibleGitToken = (token) =>
  typeof token === 'string' && token.trim().length >= 8 && !/\s/.test(token.trim());

/**
 * Vault secret name for a (already-canonical) host.
 * @param {string} host
 * @returns {string}
 */
export const gitSecretName = (host) => `${GIT_SECRET_PREFIX}${host}`;

/**
 * Inverse: a vault secret name → its host, or null if not a git secret.
 * @param {string} name
 * @returns {string|null}
 */
export const gitHostFromSecretName = (name) =>
  String(name).startsWith(GIT_SECRET_PREFIX) ? String(name).slice(GIT_SECRET_PREFIX.length) : null;

/**
 * THE HOST-BINDING GATE. Given an outbound request URL, return the canonical
 * credential host that may authenticate it — or null to send anonymously.
 * Refuses anything that isn't HTTPS (no token over cleartext). Does NOT decide
 * whether a token exists; the caller looks up gitSecretName(host) in the vault.
 * @param {string} url
 * @returns {string|null}
 */
export const authHostForRequestUrl = (url) => {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = canonicalGitHost(u.hostname);
  return HOSTNAME_RE.test(host) ? host : null;
};

/**
 * The auth header shape for a canonical host. GitLab wants PRIVATE-TOKEN;
 * GitHub/Gitea/Bitbucket take a Bearer token.
 * @param {string} host  canonical host
 * @param {string} token
 * @returns {Record<string,string>}
 */
export const gitAuthHeader = (host, token) => {
  const h = String(host).toLowerCase();
  if (h === 'gitlab.com' || h.endsWith('.gitlab.com')) return { 'PRIVATE-TOKEN': token };
  return { Authorization: `Bearer ${token}` };
};
