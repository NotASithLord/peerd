// Release notes come from CHANGELOG.md, not a template. This script owns
// the extraction so packaging/release.ts and the CI release job share one
// implementation and cannot drift.
//
//   bun packaging/release-notes.ts                   notes for package.json's version
//   bun packaging/release-notes.ts --version=0.2.2   notes for a named version
//
// Prints the notes body to stdout. Exits 1 if CHANGELOG.md has no section
// for the version: a release is never cut with empty or boilerplate notes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readVersion, parseArgs } from './lib.ts';

// The short install pointer appended after the changelog section. Plain
// English, no em dashes (house style).
export const INSTALL_FOOTER = [
  '---',
  '**Install (preview):** Firefox: click the `.xpi` on this page. Chrome: drag',
  'the `.crx` into `chrome://extensions` with Developer mode on. Most users',
  'want the store packages (see the README). The auto-update feeds are',
  'attached here and served at `peerd.ai/updates/`.',
].join('\n');

// Pure: pull one version's section out of a Keep-a-Changelog document.
// The section runs from its "## [X.Y.Z]" heading to the next "## [" heading
// (or end of file), minus the heading itself, trailing "---" separators, and
// the link-reference block at the bottom of the file.
export const extractChangelogSection = (changelog: string, version: string): string => {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) { end = i; break; }
  }
  const body = lines.slice(start + 1, end)
    .filter((l) => !/^\[[^\]]+\]:\s+http/.test(l))   // link-reference lines
    .join('\n')
    .replace(/\n---\s*$/g, '')                        // trailing section separator
    .trim();
  if (body === '') throw new Error(`the "## [${version}]" changelog section is empty`);
  return body;
};

export const buildReleaseNotes = (changelog: string, version: string): string =>
  `${extractChangelogSection(changelog, version)}\n\n${INSTALL_FOOTER}\n`;

// CLI entry (skipped when imported by release.ts or the tests).
if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const version = typeof args.version === 'string' ? args.version : readVersion();
  try {
    const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
    process.stdout.write(buildReleaseNotes(changelog, version));
  } catch (e) {
    console.error(`release-notes FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
