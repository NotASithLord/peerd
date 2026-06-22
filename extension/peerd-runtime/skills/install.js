// @ts-check
// Skill install sources — the imperative shell that turns an install
// request into raw SKILL.md text, which the registry then parses + stores.
//
// THREE SOURCES (per the feature spec):
//   (a) local — the user pastes/imports SKILL.md text directly. No egress.
//   (b) git    — a URL to a SKILL.md in a git host (GitHub, GitLab, …).
//   (c) manifest — a peerd-hosted STATIC file URL listing skills to fetch
//                  (NO peerd cloud; it's just a static JSON the user points
//                  at). Each entry resolves to a SKILL.md URL.
//
// LETHAL-TRIFECTA DEFENSE. A git/manifest URL is UNTRUSTED CONTENT — the
// bytes it returns could be authored by an attacker. Two invariants:
//   1. ALL remote fetches go through the injected `webFetch` (peerd-egress
//      denylist + scheme check + audit). NEVER bare fetch. A skill cannot
//      reach a denylisted host even to fetch ITSELF.
//   2. Installing only RECORDS text. The parser (parse.js) refuses to
//      interpret unknown frontmatter as behaviour, so a skill cannot
//      silently widen egress or auto-run code by being installed. Anything
//      it later asks the agent to do still passes the six gates.
//
// We deliberately do NOT shell out to `git`. There is no git binary in the
// browser, and we don't want one: cloning a whole repo is a huge,
// open-ended fetch surface. Instead we resolve a git URL to the single
// raw SKILL.md file over HTTPS (webFetch), which keeps egress tight and
// auditable. WebVM-based real `git clone` is a documented V1.x gap.

export class SkillInstallError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SkillInstallError';
  }
}

// Cap a fetched document so a hostile URL can't stream gigabytes into the
// SW. The parser enforces a tighter body cap; this is the transport guard.
const MAX_FETCH_BYTES = 256 * 1024;
const MAX_MANIFEST_SKILLS = 50;

/**
 * Fetch text via the egress-gated webFetch, with a hard size cap. Shared
 * by the git + manifest paths. `webFetch` already enforces scheme +
 * denylist + audit; we add only the size clamp here.
 *
 * @param {(url: string, init?: RequestInit) => Promise<Response>} webFetch
 * @param {string} url
 * @returns {Promise<string>}
 */
const fetchTextCapped = async (webFetch, url) => {
  let res;
  try {
    res = await webFetch(url);
  } catch (e) {
    // EgressDeniedError (denylist/scheme) surfaces here as a clean install
    // failure — the user sees WHY, and the bytes never arrived.
    throw new SkillInstallError(`fetch blocked or failed: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`);
  }
  if (!res.ok) throw new SkillInstallError(`fetch returned HTTP ${res.status}`);
  const text = await res.text();
  if (new TextEncoder().encode(text).length > MAX_FETCH_BYTES) {
    throw new SkillInstallError(`document exceeds ${MAX_FETCH_BYTES} bytes`);
  }
  return text;
};

/**
 * Map a human-facing git URL to the raw-bytes URL for its SKILL.md.
 * Accepts:
 *   - a direct raw URL (raw.githubusercontent.com/…/SKILL.md) — passed through
 *   - a GitHub blob URL (github.com/u/r/blob/ref/path[/SKILL.md])
 *   - a GitHub repo/dir URL (github.com/u/r[/tree/ref/dir]) — appends SKILL.md
 *     and rewrites to raw.githubusercontent.com
 * Other hosts: if the URL already ends in SKILL.md we pass it through,
 * else we append /SKILL.md. The denylist still governs the final host.
 *
 * @param {string} url
 * @returns {string}
 */
export const resolveGitRawUrl = (url) => {
  let u;
  try { u = new URL(url); } catch { throw new SkillInstallError(`invalid git URL: ${url}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new SkillInstallError(`git URL must be http(s): ${url}`);
  }

  // GitHub page URLs (github.com) must be rewritten to the raw host even
  // when the path already ends in SKILL.md — github.com serves HTML there,
  // not raw bytes. So this branch comes BEFORE the generic raw passthrough.
  if (u.host === 'github.com') {
    const parts = u.pathname.split('/').filter(Boolean); // [user, repo, blob|tree, ref, ...path]
    if (parts.length < 2) throw new SkillInstallError(`unrecognized GitHub URL: ${url}`);
    const [user, repo, kind, ref, ...rest] = parts;
    const branch = (kind === 'blob' || kind === 'tree') ? ref : 'main';
    const path = (kind === 'blob' || kind === 'tree') ? rest : [];
    const file = path.length && /\.md$/i.test(path.at(-1) ?? '') ? path.join('/') : [...path, 'SKILL.md'].join('/');
    return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${file}`;
  }

  // Any other host whose path already points at a SKILL.md (e.g.
  // raw.githubusercontent.com, a GitLab raw URL) → trust it as-is.
  if (/\/SKILL\.md$/i.test(u.pathname)) return u.toString();

  // Generic host with a directory-looking path → append SKILL.md.
  const base = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  u.pathname = `${base}SKILL.md`;
  return u.toString();
};

/**
 * Install from a git URL. Resolves to a raw SKILL.md, fetches via
 * webFetch, hands the text to the registry.
 *
 * @param {Object} deps
 * @param {import('./registry.js').SkillRegistry} deps.registry
 * @param {(url: string, init?: RequestInit) => Promise<Response>} deps.webFetch
 * @param {{ url: string, replace?: boolean }} args
 */
export const installFromGit = async ({ registry, webFetch }, { url, replace }) => {
  const raw = resolveGitRawUrl(url);
  const text = await fetchTextCapped(webFetch, raw);
  return registry.install(text, { source: 'git', origin: url, replace });
};

/**
 * Install from a static manifest URL. The manifest is JSON:
 *   { "skills": [ { "name"?: string, "url": "<SKILL.md url>" }, ... ] }
 * Each `url` is fetched + installed independently. We collect per-skill
 * results so one bad entry doesn't sink the batch.
 *
 * @param {Object} deps
 * @param {import('./registry.js').SkillRegistry} deps.registry
 * @param {(url: string, init?: RequestInit) => Promise<Response>} deps.webFetch
 * @param {{ url: string, replace?: boolean }} args
 * @returns {Promise<{ installed: object[], failed: { url: string, error: string }[] }>}
 */
export const installFromManifest = async ({ registry, webFetch }, { url, replace }) => {
  const text = await fetchTextCapped(webFetch, url);
  let manifest;
  try { manifest = JSON.parse(text); } catch {
    throw new SkillInstallError('manifest is not valid JSON');
  }
  const entries = Array.isArray(manifest?.skills) ? manifest.skills : null;
  if (!entries) throw new SkillInstallError('manifest must have a "skills" array');
  if (entries.length > MAX_MANIFEST_SKILLS) {
    throw new SkillInstallError(`manifest lists ${entries.length} skills; the cap is ${MAX_MANIFEST_SKILLS}`);
  }

  const installed = [];
  const failed = [];
  for (const entry of entries) {
    const skillUrl = typeof entry === 'string' ? entry : entry?.url;
    if (typeof skillUrl !== 'string') {
      failed.push({ url: String(skillUrl), error: 'entry missing url' });
      continue;
    }
    try {
      const skillText = await fetchTextCapped(webFetch, skillUrl);
      const meta = await registry.install(skillText, { source: 'manifest', origin: skillUrl, replace });
      installed.push(meta);
    } catch (e) {
      failed.push({ url: skillUrl, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
    }
  }
  return { installed, failed };
};

/**
 * Install from pasted/imported local text. No egress — the bytes are
 * already in hand. Origin is a user-supplied label (e.g. a directory
 * name) for display only.
 *
 * @param {Object} deps
 * @param {import('./registry.js').SkillRegistry} deps.registry
 * @param {{ text: string, origin?: string, replace?: boolean }} args
 */
export const installFromLocal = ({ registry }, { text, origin, replace }) => {
  if (typeof text !== 'string' || !text.trim()) {
    throw new SkillInstallError('local install requires SKILL.md text');
  }
  return registry.install(text, { source: 'local', origin: origin ?? 'local', replace });
};
