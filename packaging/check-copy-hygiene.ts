// Copy-hygiene gate for project-authored text.
//
// Existing prose contains substantial em-dash punctuation, so that rule is a
// no-new-occurrences ratchet over branch and worktree additions. Authorship
// markers are different: the current tree is clean, so they are checked across
// every current authored text file and every relevant commit.
//
// Run: bun run check:copy
// CI sets COPY_HYGIENE_BASE to the pull-request base or push-before commit.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { REPO_ROOT, parseArgs } from './lib.ts';
import { SOURCE_EXTENSIONS } from './check-source-hygiene.ts';

export type CopyViolationKind = 'dash-punctuation' | 'authorship-marker';

export type CopyViolation = {
  path: string;
  line: number;
  kind: CopyViolationKind;
  detail: string;
};

export type AddedLine = { line: number; text: string };

export type CommitMetadata = {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  body: string;
};

const EXCLUDED_PREFIXES = Object.freeze([
  '.agents/',
  '.codex/',
  'extension/vendor/',
  'vendor/',
  'web-prototype/public/',
  'update-feeds/',
  'scripts/cdp/baselines/',
]);

const EXCLUDED_FILES = Object.freeze(new Set([
  'AGENTS.md',
  'LICENSE',
  'badges/e2e-chrome.json',
  'badges/functional-tests.json',
  'badges/inbrowser-chrome.json',
  'badges/inbrowser-gecko.json',
  'badges/red-team.json',
  'badges/tscheck.json',
  'bun.lock',
  'docs/security/RED-TEAM-RESULTS.md',
  'extension/manifest.json',
  'extension/shared/channel-config.js',
  'packaging/security-baseline.json',
]));

const EXTENSIONLESS_COPY_FILES = Object.freeze(new Set(['Dockerfile', '.gitignore']));
const ENVIRONMENT_COPY_FILES = Object.freeze(new Set(['AGENTS.md', 'CLAUDE.md', 'CODEX.md']));

const DASH_CHARACTER = String.fromCodePoint(0x2014);
const DASH_ENCODINGS = Object.freeze([
  '\\' + 'u' + '2014',
]);
const DASH_ENCODING_PATTERNS = Object.freeze([
  new RegExp('&' + 'mdash(?:;|(?=[^a-z0-9=])|$)', 'i'),
  new RegExp('&#' + '0*8212(?:;|(?=[^0-9])|$)', 'i'),
  new RegExp('&#x' + '0*2014(?:;|(?=[^0-9a-f])|$)', 'i'),
  new RegExp('\\\\u\\{0*' + '2014\\}', 'i'),
  new RegExp('\\\\0{0,2}' + '2014(?:\\s|$|(?=[^0-9a-f]))', 'i'),
]);

const ASSISTANT_NAMES = '(?:codex|chatgpt|openai|(?:anthropic\\s+)?claude|'
  + '(?:github\\s+)?copilot|an?\\s+ai\\s+(?:assistant|agent|bot)|ai)';
const ATTRIBUTION_KEYS = '(?:co-authored-by|authored-by|generated-by|assisted-by|written-by)';
const ATTRIBUTION_TRAILER = new RegExp(
  `\\b${ATTRIBUTION_KEYS}\\s*:\\s*[^\\n]*\\b${ASSISTANT_NAMES}\\b`,
  'i',
);
const ATTRIBUTION_SENTENCE = new RegExp(
  `\\b(?:generated|written|authored|drafted|created|edited|assisted)\\s+`
    + `(?:by|with|using|via)\\s+(?:(?:the|an?)\\s+)?(?<assistant>${ASSISTANT_NAMES})\\b`,
  'gi',
);
const ATTRIBUTION_ADJECTIVE = new RegExp(
  `\\b(?<assistant>${ASSISTANT_NAMES})[- ](?:generated|written|authored|drafted|created|edited)\\b`,
  'gi',
);
const ASSISTANT_IDENTITY = new RegExp(
  `(?:^|[^a-z0-9])(?:codex|chatgpt|openai|claude|copilot|ai[ -]?(?:assistant|agent|bot))`
    + '(?:[^a-z0-9]|$)',
  'i',
);
const TECHNICAL_COPY_NOUNS = '(?:responses?|requests?|outputs?|completions?|embeddings?|'
  + 'inferences?|tokens?|tool\\s+calls?)';
const TECHNICAL_SUBJECT = new RegExp(
  `^[^a-z0-9]*(?:(?:the|an?)\\s+)?(?:adapter\\s+|model\\s+)?${TECHNICAL_COPY_NOUNS}\\s+`
    + '(?:(?:is|was|are|were|gets?|got)\\s+)?$',
  'i',
);
const TECHNICAL_OBJECT = new RegExp(
  `^\\s+(?:(?:api|provider|adapter|model)[ -])?${TECHNICAL_COPY_NOUNS}\\b`,
  'i',
);

const normalizePath = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\//, '');

export const isCopyPath = (input: string): boolean => {
  const path = normalizePath(input);
  if (EXCLUDED_FILES.has(path) || EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  const name = basename(path);
  if (ENVIRONMENT_COPY_FILES.has(name)) return false;
  if (EXTENSIONLESS_COPY_FILES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
};

export const hasDashPunctuation = (line: string): boolean => {
  if (line.includes(DASH_CHARACTER)) return true;
  const folded = line.toLowerCase();
  return DASH_ENCODINGS.some((encoding) => folded.includes(encoding.toLowerCase()))
    || DASH_ENCODING_PATTERNS.some((pattern) => pattern.test(line));
};

export const hasAuthorshipMarker = (line: string): boolean =>
  ATTRIBUTION_TRAILER.test(line)
  || [...line.matchAll(ATTRIBUTION_SENTENCE)].some((match) => {
    // why: provider documentation describes request and response generation.
    // Only those concrete runtime subjects are exempt from authorship wording.
    if (match.groups?.assistant?.toLowerCase() !== 'openai') return true;
    const before = line.slice(0, match.index);
    return !TECHNICAL_SUBJECT.test(before);
  })
  || [...line.matchAll(ATTRIBUTION_ADJECTIVE)].some((match) => {
    if (match.groups?.assistant?.toLowerCase() !== 'openai') return true;
    const after = line.slice((match.index ?? 0) + match[0].length);
    return !TECHNICAL_OBJECT.test(after);
  });

export const scanCopyLine = (
  path: string,
  lineNumber: number,
  line: string,
  checks: { dash?: boolean; authorship?: boolean } = {},
): CopyViolation[] => {
  const violations: CopyViolation[] = [];
  if (checks.dash === true && hasDashPunctuation(line)) {
    violations.push({
      path,
      line: lineNumber,
      kind: 'dash-punctuation',
      detail: 'replace the dash with plain punctuation or rewrite the sentence',
    });
  }
  if (checks.authorship === true && hasAuthorshipMarker(line)) {
    violations.push({
      path,
      line: lineNumber,
      kind: 'authorship-marker',
      detail: 'remove the assistant authorship marker',
    });
  }
  return violations;
};

export const scanCopyText = (
  path: string,
  text: string,
  checks: { dash?: boolean; authorship?: boolean },
): CopyViolation[] => text.split(/\r?\n/).flatMap((line, index) =>
  scanCopyLine(path, index + 1, line, checks));

export const extractAddedLines = (patch: string): AddedLine[] => {
  const added: AddedLine[] = [];
  let currentLine = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      currentLine = Number.parseInt(hunk[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      added.push({ line: currentLine, text: line.slice(1) });
      currentLine++;
    } else if (line.startsWith('-') || line.startsWith('\\')) {
      continue;
    } else {
      currentLine++;
    }
  }
  return added;
};

export const scanCommitMetadata = (commit: CommitMetadata): CopyViolation[] => {
  const path = `commit:${commit.sha.slice(0, 12)}`;
  const identity = [
    commit.authorName,
    commit.authorEmail,
    commit.committerName,
    commit.committerEmail,
  ].find((value) => ASSISTANT_IDENTITY.test(value) || /^ai$/i.test(value.trim()));
  const violations: CopyViolation[] = identity
    ? [{
        path,
        line: 1,
        kind: 'authorship-marker',
        detail: 'commit author or committer names an assistant identity',
      }]
    : [];
  return violations.concat(scanCopyText(path, commit.body, { authorship: true, dash: true }));
};

const gitText = (root: string, args: string[]): string => execFileSync(
  'git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const gitPaths = (root: string, args: string[]): string[] =>
  gitText(root, args).split('\0').filter(Boolean).map(normalizePath);

const refExists = (root: string, ref: string): boolean => {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

export const resolveMergeBase = (root: string, requested?: string): string => {
  const explicit = requested && !/^0+$/.test(requested) ? requested : null;
  if (explicit && !refExists(root, explicit)) {
    throw new Error(`copy-hygiene base ${explicit} is unavailable; fetch the base history first`);
  }
  const candidate = explicit
    ?? (refExists(root, 'origin/main') ? 'origin/main' : null)
    ?? (refExists(root, 'main') ? 'main' : 'HEAD');
  return gitText(root, ['merge-base', candidate, 'HEAD']).trim();
};

const readCommits = (root: string, mergeBase: string): CommitMetadata[] => {
  const head = gitText(root, ['rev-parse', 'HEAD']).trim();
  const selection = mergeBase === head ? ['-1', 'HEAD'] : [`${mergeBase}..HEAD`];
  const field = String.fromCodePoint(0x1f);
  const record = String.fromCodePoint(0x1e);
  const format = `%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e`;
  const raw = gitText(root, ['log', `--format=${format}`, ...selection]);
  return raw.split(record).flatMap((entry) => {
    const clean = entry.replace(/^\n+/, '');
    if (!clean) return [];
    const [sha, authorName, authorEmail, committerName, committerEmail, ...body] = clean.split(field);
    if (!sha || body.length === 0) return [];
    return [{
      sha,
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      committerName: committerName ?? '',
      committerEmail: committerEmail ?? '',
      body: body.join(field).replace(/\n+$/, ''),
    }];
  });
};

export const collectRepositoryViolations = (
  root: string = REPO_ROOT,
  options: { base?: string } = {},
): CopyViolation[] => {
  const mergeBase = resolveMergeBase(root, options.base);
  const tracked = gitPaths(root, ['ls-files', '-z']);
  const untracked = gitPaths(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const current = [...new Set([...tracked, ...untracked])]
    .filter(isCopyPath)
    .filter((path) => existsSync(join(root, path)));

  const violations: CopyViolation[] = [];
  for (const path of current) {
    violations.push(...scanCopyText(path, readFileSync(join(root, path), 'utf8'), { authorship: true }));
  }

  const changed = gitPaths(root, [
    'diff', '--name-only', '--diff-filter=ACMR', '-z', mergeBase, '--',
  ]).filter(isCopyPath);
  for (const path of changed) {
    const patch = gitText(root, [
      'diff', '--no-color', '--no-ext-diff', '--unified=0', mergeBase, '--', path,
    ]);
    for (const added of extractAddedLines(patch)) {
      violations.push(...scanCopyLine(path, added.line, added.text, { dash: true }));
    }
  }

  const changedSet = new Set(changed);
  for (const path of untracked.filter(isCopyPath).filter((value) => !changedSet.has(value))) {
    if (!existsSync(join(root, path))) continue;
    violations.push(...scanCopyText(path, readFileSync(join(root, path), 'utf8'), { dash: true }));
  }

  for (const commit of readCommits(root, mergeBase)) {
    violations.push(...scanCommitMetadata(commit));
  }

  return violations.sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind));
};

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));
  const requested = typeof args.base === 'string'
    ? args.base
    : process.env.COPY_HYGIENE_BASE;
  let violations: CopyViolation[];
  try {
    violations = collectRepositoryViolations(REPO_ROOT, { base: requested });
  } catch (error) {
    console.error(`copy hygiene FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (violations.length === 0) {
    console.log('copy hygiene OK (no new em dashes or assistant authorship markers)');
    return;
  }
  console.error('COPY HYGIENE FAILED:');
  for (const violation of violations) {
    console.error(`  ${violation.path}:${violation.line} [${violation.kind}] ${violation.detail}`);
  }
  console.error(`\nFix ${violations.length} copy-hygiene violation(s) before committing.`);
  process.exit(1);
};

if (import.meta.main) main();
