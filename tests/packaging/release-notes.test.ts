// Release notes are extracted from CHANGELOG.md (packaging/release-notes.ts),
// shared by the local release path and the CI release job. These tests pin
// the extraction so a refactor can't silently ship boilerplate or empty
// notes again.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractChangelogSection, buildReleaseNotes, INSTALL_FOOTER } from '../../packaging/release-notes.ts';
import { REPO_ROOT, readVersion } from '../../packaging/lib.ts';

const FIXTURE = `# Changelog

Header prose.

## [Unreleased]

## [0.2.0] - 2026-06-29

Intro line for 0.2.0.

### Added
- **Thing one.** Does a thing (#12).

---

## [0.1.0] - 2026

### Added
- **Base.** The first cut.

[Unreleased]: https://example.com/compare/v0.1.0...HEAD
[0.1.0]: https://example.com/releases/tag/v0.1.0
`;

describe('extractChangelogSection', () => {
  test('pulls exactly one version section, without its heading', () => {
    const s = extractChangelogSection(FIXTURE, '0.2.0');
    expect(s).toContain('Intro line for 0.2.0.');
    expect(s).toContain('Thing one');
    expect(s).toContain('#12');
    expect(s).not.toContain('## [0.2.0]');
    // stops at the next version heading
    expect(s).not.toContain('0.1.0');
    expect(s).not.toContain('Base');
  });

  test('strips the trailing --- separator', () => {
    const s = extractChangelogSection(FIXTURE, '0.2.0');
    expect(s.endsWith('---')).toBe(false);
  });

  test('the last section drops the link-reference block', () => {
    const s = extractChangelogSection(FIXTURE, '0.1.0');
    expect(s).toContain('The first cut.');
    expect(s).not.toContain('https://example.com');
  });

  test('throws on a version with no section', () => {
    expect(() => extractChangelogSection(FIXTURE, '9.9.9')).toThrow('no "## [9.9.9]" section');
  });

  test('throws on an empty section', () => {
    expect(() => extractChangelogSection(FIXTURE, 'Unreleased')).toThrow('empty');
  });
});

describe('buildReleaseNotes', () => {
  test('is the section plus the install footer', () => {
    const n = buildReleaseNotes(FIXTURE, '0.2.0');
    expect(n).toContain('Thing one');
    expect(n).toContain(INSTALL_FOOTER);
    expect(n.indexOf(INSTALL_FOOTER)).toBeGreaterThan(n.indexOf('Thing one'));
  });

  test('the footer is plain: no em dashes', () => {
    expect(INSTALL_FOOTER.includes('—')).toBe(false);
  });
});

describe('the real CHANGELOG.md', () => {
  // Drift guard: package.json's version must always have a changelog
  // section, so a release PR that bumps the version without writing the
  // changelog fails CI here, before anything is tagged.
  test(`has a section for the current version (${readVersion()})`, () => {
    const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
    expect(buildReleaseNotes(changelog, readVersion()).length).toBeGreaterThan(100);
  });
});
