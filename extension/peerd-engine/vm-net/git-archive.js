// @ts-check
// git-archive — pure planning for `git clone` over plain HTTPS.
//
// The WebVM has no sockets, so real smart-HTTP git (libcurl inside the VM)
// can't run. The honest, broadly-useful substitute is the ARCHIVE endpoints:
// GitHub and GitLab each serve a downloadable zip of a ref over ordinary
// HTTPS, which rides our existing webFetch bridge untouched.
//
// Scope: GitHub and GitLab (the two that matter), plus a best-effort fallback
// for an unrecognized host that tries both layouts. This is a SNAPSHOT clone —
// no `.git`, no history, no push (full-history smart-HTTP is a documented
// follow-up). Snapshot-of-any-ref with private-
// repo auth covers the common "get me this code so I can read/build it" case.
//
// This module is PURE: it turns a clone URL + optional ref into the ordered
// list of archive URLs to try and the metadata the host needs (auth host,
// default-branch API probe). The fetching, unzip, and token injection live in
// the imperative shell (bash wrapper + host handler).

/** @typedef {{ host: string, kind: 'github'|'gitlab'|'unknown', owner: string, repo: string, path: string }} ParsedRepo */
/** @typedef {{ url: string, ext: 'zip'|'tar.gz', stripComponents: number, note: string }} ArchiveCandidate */

/**
 * Parse an https clone URL into structured parts. Accepts `.git` suffixes and
 * nested groups (GitLab subgroups → kept in `path`). Returns null if it isn't
 * a parseable https URL.
 * @param {string} cloneUrl
 * @returns {ParsedRepo | null}
 */
export const parseRepoUrl = (cloneUrl) => {
  let u;
  try { u = new URL(cloneUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!path) return null;
  const segments = path.split('/');
  if (segments.length < 2) return null;

  let kind = /** @type {ParsedRepo['kind']} */ ('unknown');
  if (host === 'github.com') kind = 'github';
  else if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) kind = 'gitlab';

  // owner = first segment, repo = last segment; GitLab subgroups live in
  // between and stay in `path` (their archive URL uses the full namespace).
  const owner = segments[0];
  const repo = segments[segments.length - 1];
  return { host, kind, owner, repo, path };
};

/**
 * Build the ordered archive-download candidates for a repo + ref. When no ref
 * is given, the caller should first try `defaultBranchProbe()` and, failing
 * that, fall through to these candidates (which try main then master).
 *
 * @param {ParsedRepo} parsed
 * @param {string|null} ref a branch, tag, or commit SHA; null → try main/master
 * @returns {ArchiveCandidate[]}
 */
export const archiveCandidates = (parsed, ref = null) => {
  const refs = ref ? [ref] : ['main', 'master'];
  const base = `https://${parsed.host}`;
  // GitHub layout: /<path>/archive/<ref>.zip (works for branches, tags, SHAs).
  /** @param {string} r */
  const githubUrl = (r) => `${base}/${parsed.path}/archive/${encodeURIComponent(r)}.zip`;
  // GitLab layout: /<path>/-/archive/<ref>/<repo>-<ref>.zip.
  /** @param {string} r */
  const gitlabUrl = (r) => `${base}/${parsed.path}/-/archive/${encodeURIComponent(r)}/${parsed.repo}-${r}.zip`;
  /** @type {ArchiveCandidate[]} */
  const out = [];
  for (const r of refs) {
    if (parsed.kind === 'github') {
      out.push({ url: githubUrl(r), ext: 'zip', stripComponents: 1, note: `github ${r}` });
    } else if (parsed.kind === 'gitlab') {
      out.push({ url: gitlabUrl(r), ext: 'zip', stripComponents: 1, note: `gitlab ${r}` });
    } else {
      // Unknown host (e.g. self-hosted GitHub Enterprise / GitLab): try the
      // GitHub layout, then the GitLab layout — the two we support.
      out.push({ url: githubUrl(r), ext: 'zip', stripComponents: 1, note: `github-style ${r}` });
      out.push({ url: gitlabUrl(r), ext: 'zip', stripComponents: 1, note: `gitlab-style ${r}` });
    }
  }
  return out;
};

/**
 * The API URL that returns a repo's default branch, when known. Lets the host
 * resolve the real default branch instead of guessing main/master — important
 * for repos whose default is `develop`, `trunk`, etc. Returns null when we have
 * no API probe for the host (caller falls back to the main/master candidates).
 * @param {ParsedRepo} parsed
 * @returns {{ url: string, jsonPath: string[] } | null}
 */
export const defaultBranchProbe = (parsed) => {
  switch (parsed.kind) {
    case 'github':
      return { url: `https://api.github.com/repos/${parsed.path}`, jsonPath: ['default_branch'] };
    case 'gitlab':
      return {
        url: `https://${parsed.host}/api/v4/projects/${encodeURIComponent(parsed.path)}`,
        jsonPath: ['default_branch'],
      };
    default:
      return null;
  }
};

// Credential naming + auth-header shape moved to git-credentials.js (the single
// home for token storage + host-bound use); the host-side injection imports
// authHostForRequestUrl / gitSecretName / gitAuthHeader from there.
