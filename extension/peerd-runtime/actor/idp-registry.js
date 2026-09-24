// @ts-check
/** @type {ReadonlySet<string>} */
const IDP_ORIGINS = new Set([
  'https://accounts.google.com',
  'https://login.microsoftonline.com',
  'https://login.live.com',
  'https://login.microsoft.com',
  'https://appleid.apple.com',
  'https://signin.aws.amazon.com',
  'https://login.yahoo.com',
  'https://id.atlassian.com',
  'https://auth.atlassian.com',
  'https://accounts.spotify.com',
  'https://identity.linuxfoundation.org',
]);

/** @type {readonly string[]} */
const IDP_SUFFIXES = Object.freeze([
  'okta.com',
  'oktapreview.com',
  'auth0.com',
  'onelogin.com',
  'pingidentity.com',
  'duosecurity.com',
  'cloudflareaccess.com',
  'workos.com',
  'authkit.app',
  'miniorange.com',
  'jumpcloud.com',
]);

/** @param {string} host */
const hostIsKnownIdp = (host) => {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  for (const origin of IDP_ORIGINS) {
    if (new URL(origin).hostname === normalized) return true;
  }
  return IDP_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
};

/** @param {unknown} input @returns {boolean} */
export const isKnownIdpHost = (input) => {
  let u;
  try { u = new URL(String(input ?? '')); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return hostIsKnownIdp(u.hostname);
};

/** @param {unknown} input @returns {boolean} */
export const isKnownIdp = (input) => {
  let u;
  try { u = new URL(String(input ?? '')); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host.endsWith('.')) return false;
  const origin = `https://${host}${u.port && u.port !== '443' ? `:${u.port}` : ''}`;
  if (IDP_ORIGINS.has(origin)) return true;
  if (u.port && u.port !== '443') return false;
  return hostIsKnownIdp(host);
};

export const knownIdpSeeds = () => Object.freeze({
  origins: Object.freeze([...IDP_ORIGINS]),
  suffixes: IDP_SUFFIXES,
});

/** @returns {string[]} */
export const knownIdpDomains = () => {
  const domains = new Set(IDP_SUFFIXES);
  for (const origin of IDP_ORIGINS) {
    try { domains.add(new URL(origin).hostname); } catch {}
  }
  return [...domains].sort();
};
