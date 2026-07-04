// Top-level docs must not point at files that don't exist. The 0.2.1 doc
// cut deleted the per-module READMEs and README/CLAUDE/SECURITY kept
// referencing them for days; this gate makes that class of drift fail CI.
//
//   bun packaging/check-doc-paths.ts
//
// Checks README.md, CLAUDE.md, SECURITY.md, CONTRIBUTING.md. CHANGELOG.md
// is deliberately excluded: it is a historical record and may reference
// files that were later deleted.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './lib.ts';

export const CHECKED_DOCS = ['README.md', 'CLAUDE.md', 'SECURITY.md', 'CONTRIBUTING.md'];

// A backticked token or link target is treated as a repo-path claim only
// when it looks like one: has a slash, no spaces, no glob/placeholder
// characters, no URL scheme. Everything else (commands, npm names,
// hostnames, patterns) is ignored.
const GLOBBY = /[*?<>{}()|\s…]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Strip fenced code blocks; their contents are prose/diagrams, not claims. */
const stripFences = (md: string): string => md.replace(/^```[\s\S]*?^```/gm, '');

/** Pull every repo-path claim out of one markdown document. */
export const extractPathRefs = (md: string): string[] => {
  const body = stripFences(md);
  const refs = new Set<string>();

  // Markdown link targets: [text](target) — skip anchors and external URLs.
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const t = m[1].split('#')[0];
    if (t === '' || SCHEME.test(t)) continue;
    refs.add(t);
  }
  // HTML img/src targets.
  for (const m of body.matchAll(/src="([^"]+)"/g)) {
    if (!SCHEME.test(m[1])) refs.add(m[1]);
  }
  // Backticked tokens that look like paths.
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1];
    if (!t.includes('/') || GLOBBY.test(t) || SCHEME.test(t) || t.startsWith('@')) continue;
    refs.add(t.replace(/[.,;:]+$/, ''));
  }
  return [...refs];
};

/** The roots a doc path claim may be relative to. Docs use module-relative
 *  shorthand constantly: `peerd-egress/vault/` means extension/peerd-egress/
 *  vault/, and `tools/exposure.js` or `dom/walk-injected.js` are relative to
 *  a peerd-* module. */
export const resolutionRoots = (root: string = REPO_ROOT): string[] => {
  const modules = existsSync(join(root, 'extension'))
    ? readdirSync(join(root, 'extension')).filter((d) => d.startsWith('peerd-'))
      .map((d) => join(root, 'extension', d))
    : [];
  return [root, join(root, 'extension'), ...modules];
};

export const resolvesInRepo = (ref: string, roots: string[]): boolean =>
  roots.some((r) => existsSync(join(r, ref)));

/** Only flag refs whose first segment is a real directory under one of the
 *  resolution roots: a missing peerd-runtime/x is drift; UsefulSensors/x is
 *  a Hugging Face id and none of our business. Leading-slash refs are URL
 *  paths (`/api/tags`), never repo paths. */
export const isCheckableRef = (ref: string, roots: string[]): boolean => {
  if (ref.startsWith('/')) return false;
  const first = ref.split('/')[0];
  if (first === '.' || first === '..') return true; // relative link: always checkable
  return roots.some((r) => existsSync(join(r, first)));
};

/** Gitignored paths (run artifacts like scripts/cdp/artifacts/) are output
 *  locations, not repo files; docs may legitimately name them. */
export const isGitignored = (ref: string, root: string = REPO_ROOT): boolean => {
  // Try both forms: a "dir/" ignore rule only matches when the queried path
  // keeps its trailing slash (git can't stat a nonexistent path to learn it
  // is a directory).
  for (const form of new Set([ref, ref.replace(/\/$/, '')])) {
    try {
      execFileSync('git', ['check-ignore', '-q', form], { cwd: root });
      return true;
    } catch { /* not ignored in this form */ }
  }
  return false;
};

const main = () => {
  let bad = 0;
  const roots = resolutionRoots();
  for (const doc of CHECKED_DOCS) {
    const p = join(REPO_ROOT, doc);
    if (!existsSync(p)) continue; // a checked doc may legitimately not exist
    for (const ref of extractPathRefs(readFileSync(p, 'utf8'))) {
      if (!isCheckableRef(ref, roots)) continue;
      if (resolvesInRepo(ref, roots) || isGitignored(ref)) continue;
      console.error(`${doc}: dead path reference: ${ref}`);
      bad++;
    }
  }
  if (bad > 0) {
    console.error(`\ncheck-doc-paths FAILED: ${bad} dead reference(s). Fix the doc or the path.`);
    process.exit(1);
  }
  console.log(`doc paths OK (${CHECKED_DOCS.join(', ')})`);
};

if (import.meta.main) main();
