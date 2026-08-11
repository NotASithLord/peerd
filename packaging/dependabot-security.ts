// Fail-closed policy and release preparation for Dependabot security PRs.
//
// This file is deliberately executed from the trusted BASE checkout by
// .github/workflows/dependabot-security-release.yml. A dependency PR is allowed
// to touch the candidate checkout, but it cannot replace the policy judging it.
//
//   bun packaging/dependabot-security.ts verify \
//     --repo=. --base-sha=<sha> --head-sha=<sha> \
//     --ecosystem=bun --group=bun-security-patches \
//     --update-type=version-update:semver-patch --dependencies=foo,bar \
//     --metadata='[...]' --minimum-age-days=3
//
//   bun packaging/dependabot-security.ts prepare \
//     --repo=. --base-sha=<sha> --ecosystem=bun \
//     --dependencies=foo,bar --pr=123 --date=2026-08-10
//
//   bun packaging/dependabot-security.ts observe-bun \
//     --repo=. --base-sha=<sha> --head-sha=<sha>
//
//   bun packaging/dependabot-security.ts verify-observations \
//     --repository=owner/repo --pr=123 --head-sha=<sha>
//
//   bun packaging/dependabot-security.ts validate-prepared \
//     --repo=. --base-sha=<sha> --head-sha=<sha> --ecosystem=bun \
//     --dependencies=foo,bar --pr=123 --date=2026-08-10

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';

const SECURITY_GROUPS = {
  bun: 'bun-security-patches',
  // fetch-metadata derives this from Dependabot's branch prefix, whose
  // internal spelling is github_actions (the YAML ecosystem uses a hyphen).
  github_actions: 'actions-security-patches',
} as const;

type SupportedEcosystem = keyof typeof SECURITY_GROUPS;

const MINIMUM_SECURITY_AGE_DAYS: Record<SupportedEcosystem, number> = {
  // Bun patches get the shorter window only because exact package/version
  // malware checks from both GitHub and Socket surround the merge.
  bun: 3,
  // SHA-pinned Actions do not have equivalent malware-alert coverage.
  github_actions: 30,
};

const SOCKET_SCANNER_PACKAGE = '@socketsecurity/bun-security-scanner';
const MALWARE_OBSERVATION_WORKFLOW = 'dependabot-malware-observation.yml';
const MALWARE_OBSERVATION_HOURS = 72;
const MALWARE_OBSERVATION_MAX_GAP_HOURS = 6;

type UpdatedDependency = {
  dependencyName: string;
  newVersion: string;
  updateType: string;
};

export type LockedNpmReplacement = {
  lockKey: string;
  dependencyName: string;
  previousVersion: string;
  newVersion: string;
  integrity: string;
};

export type MalwareObservation = {
  headSha: string;
  conclusion: string;
  completedAt: string;
};

type JsonFetcher = typeof fetch;

type ActionUpdate = {
  repository: string;
  sha: string;
  version: string;
};

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const BASE_BUN_PATHS = new Set(['package.json', 'bun.lock']);
const GENERATED_RELEASE_PATHS = new Set([
  'CHANGELOG.md',
  'package.json',
  'extension/manifest.json',
]);
const CODEMIRROR_VENDOR_PATHS = new Set([
  'extension/vendor/codemirror/cm.js',
  'extension/vendor/codemirror/SOURCE.txt',
  'extension/vendor/vendor.lock.json',
]);
const VENDOR_LOCK_PATH = 'extension/vendor/vendor.lock.json';

const fail = (message: string): never => {
  throw new Error(`Dependabot security policy rejected the PR: ${message}`);
};

const parseArgs = (argv: string[]): { command: string; values: Record<string, string> } => {
  const [command = '', ...rest] = argv;
  const values: Record<string, string> = {};
  for (const arg of rest) {
    if (!arg.startsWith('--') || !arg.includes('=')) fail(`invalid argument ${JSON.stringify(arg)}`);
    const split = arg.indexOf('=');
    values[arg.slice(2, split)] = arg.slice(split + 1);
  }
  return { command, values };
};

const required = (values: Record<string, string>, name: string): string => {
  const value = values[name];
  if (!value) fail(`missing --${name}`);
  return value;
};

const assertSha = (sha: string, name: string): void => {
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`${name} is not a full commit SHA`);
};

const normalizePath = (path: string): string => path.replaceAll('\\', '/');

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

const run = (repo: string, executable: string, args: string[]): void => {
  execFileSync(executable, args, { cwd: repo, stdio: 'inherit' });
};

const changedPaths = (repo: string, baseSha: string, headSha?: string): string[] => {
  const range = headSha ? `${baseSha}..${headSha}` : baseSha;
  return git(repo, ['diff', '--name-only', '-z', range, '--'])
    .split('\0')
    .filter(Boolean)
    .map(normalizePath)
    .sort();
};

const readAt = (repo: string, sha: string, path: string): string =>
  git(repo, ['show', `${sha}:${path}`]);

export const parseDependencyNames = (raw: string): string[] => {
  const names = [...new Set(raw.split(',').map((name) => name.trim()).filter(Boolean))].sort();
  if (names.length === 0) fail('Dependabot did not report an updated dependency');
  for (const name of names) {
    if (!/^[A-Za-z0-9@][A-Za-z0-9@/_.-]*$/.test(name)) {
      fail(`unexpected dependency name ${JSON.stringify(name)}`);
    }
  }
  return names;
};

const withoutDependencySections = (value: Record<string, unknown>): Record<string, unknown> => {
  const copy = structuredClone(value);
  for (const section of DEPENDENCY_SECTIONS) delete copy[section];
  return copy;
};

const dependencyMap = (value: Record<string, unknown>, section: string): Record<string, string> => {
  const candidate = value[section];
  if (candidate === undefined) return {};
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail(`package.json ${section} is not an object`);
  }
  const map = candidate as Record<string, unknown>;
  for (const [name, version] of Object.entries(map)) {
    if (typeof version !== 'string') fail(`package.json ${section}.${name} is not a string`);
  }
  return map as Record<string, string>;
};

/** Verify that package.json changed only versions Dependabot authenticated. */
export const validatePackageJsonChange = (
  baseText: string,
  headText: string,
  dependencies: string[],
  expectedVersions: Record<string, string> = {},
): string[] => {
  const base = JSON.parse(baseText) as Record<string, unknown>;
  const head = JSON.parse(headText) as Record<string, unknown>;

  if (!isDeepStrictEqual(withoutDependencySections(base), withoutDependencySections(head))) {
    fail('package.json changed outside dependency version maps');
  }

  const authenticated = new Set(dependencies);
  const changed = new Set<string>();
  for (const section of DEPENDENCY_SECTIONS) {
    const before = dependencyMap(base, section);
    const after = dependencyMap(head, section);
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[name] === after[name]) continue;
      if (!authenticated.has(name)) {
        fail(`package.json changed unauthenticated dependency ${name}`);
      }
      if (!(name in before) || !(name in after)) {
        fail(`package.json added or removed dependency ${name}`);
      }
      const expected = expectedVersions[name]?.replace(/^v/, '');
      if (expected !== undefined
        && after[name] !== expected
        && after[name] !== `^${expected}`
        && after[name] !== `~${expected}`) {
        fail(`package.json ${section}.${name} does not match authenticated version ${expected}`);
      }
      changed.add(name);
    }
  }
  return [...changed].sort();
};

const ACTION_USE = /^(?<prefix>\s*(?:-\s*)?uses:\s+)(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?<subpath>\/[A-Za-z0-9_./-]+)?@(?<sha>[0-9a-f]{40})\s+#\s+(?<version>v?\d+\.\d+\.\d+)\s*$/;
const DIFF_FILE = /^diff --git a\/(?<before>\S+) b\/(?<after>\S+)$/;
const DIFF_HUNK = /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/;

const parseActionsDiff = (diff: string): ActionUpdate[] => {
  const additions: Array<{ slot: string, update: ActionUpdate }> = [];
  const deletions: string[] = [];
  let file = '';
  let hunk = '';
  let additionOrdinal = 0;
  let deletionOrdinal = 0;
  for (const line of diff.split('\n')) {
    if (!line || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('diff --git ')) {
      const groups = DIFF_FILE.exec(line)?.groups
        ?? fail('GitHub Actions update has an unrecognized file diff');
      if (groups.before !== groups.after) fail('GitHub Actions update moved a workflow file');
      file = groups.before;
      hunk = '';
      additionOrdinal = 0;
      deletionOrdinal = 0;
      continue;
    }
    if (line.startsWith('@@ ')) {
      const groups = DIFF_HUNK.exec(line)?.groups
        ?? fail('GitHub Actions update has an unrecognized diff hunk');
      const oldCount = Number(groups.oldCount ?? '1');
      const newCount = Number(groups.newCount ?? '1');
      if (groups.oldStart !== groups.newStart || oldCount !== newCount) {
        fail('GitHub Actions update relocated a uses: line');
      }
      hunk = `${groups.oldStart}:${oldCount}`;
      additionOrdinal = 0;
      deletionOrdinal = 0;
      continue;
    }
    if (line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('+') || line.startsWith('-')) {
      if (!file || !hunk) fail('GitHub Actions update has a change outside a file hunk');
      const match = ACTION_USE.exec(line.slice(1));
      const groups = match?.groups
        ?? fail('GitHub Actions update changed more than a SHA-pinned uses: line');
      const ordinal = line.startsWith('+') ? additionOrdinal++ : deletionOrdinal++;
      const slot = `${file}:${hunk}:${ordinal}:${groups.prefix}${groups.repository}${groups.subpath ?? ''}`;
      if (line.startsWith('+')) {
        additions.push({
          slot,
          update: {
            repository: groups.repository,
            sha: groups.sha,
            version: groups.version,
          },
        });
      } else {
        deletions.push(slot);
      }
    }
  }
  if (additions.length === 0
    || !isDeepStrictEqual(additions.map(({ slot }) => slot).sort(), deletions.sort())) {
    fail('GitHub Actions update is not a one-for-one immutable SHA replacement');
  }
  return additions.map(({ update }) => update);
};

/** Verify an Actions diff consists only of one-for-one immutable SHA bumps. */
export const validateActionsDiff = (diff: string): number => {
  return parseActionsDiff(diff).length;
};

export const assertAtLeastDaysOld = (
  publishedAt: string,
  minimumAgeDays: number,
  now = new Date(),
): number => {
  if (!Number.isSafeInteger(minimumAgeDays) || minimumAgeDays < 1) fail('minimum age is invalid');
  const published = new Date(publishedAt);
  if (!Number.isFinite(published.getTime())) fail(`invalid publication timestamp ${JSON.stringify(publishedAt)}`);
  const ageMs = now.getTime() - published.getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  if (ageDays < minimumAgeDays) {
    fail(`replacement was published ${ageDays} days ago; ${minimumAgeDays} days of seasoning are required`);
  }
  return ageDays;
};

export const minimumSecurityAgeDays = (ecosystem: SupportedEcosystem): number =>
  MINIMUM_SECURITY_AGE_DAYS[ecosystem];

type LockedNpmPackage = {
  lockKey: string;
  dependencyName: string;
  version: string;
  integrity: string;
  serialized: string;
};

const parseLockedNpmCoordinate = (resolution: string): { dependencyName: string, version: string } => {
  const split = resolution.lastIndexOf('@');
  if (split <= 0) fail(`bun.lock package resolution ${JSON.stringify(resolution)} is not an npm coordinate`);
  const dependencyName = resolution.slice(0, split);
  const version = resolution.slice(split + 1);
  parseDependencyNames(dependencyName);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`bun.lock package resolution ${resolution} is not a stable plain semver release`);
  }
  return { dependencyName, version };
};

const parseBunLockPackages = (text: string): Map<string, LockedNpmPackage> => {
  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(text) as unknown;
  } catch {
    fail('bun.lock is not valid JSONC');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('bun.lock root is malformed');
  const packages = (parsed as Record<string, unknown>).packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    fail('bun.lock has no package table');
  }
  const result = new Map<string, LockedNpmPackage>();
  for (const [lockKey, raw] of Object.entries(packages as Record<string, unknown>)) {
    if (!Array.isArray(raw) || typeof raw[0] !== 'string' || typeof raw[3] !== 'string') {
      fail(`bun.lock package ${lockKey} is not an integrity-pinned registry package`);
    }
    const entry = raw as unknown[];
    const resolution = entry[0] as string;
    const integrity = entry[3] as string;
    const { dependencyName, version } = parseLockedNpmCoordinate(resolution);
    if (!/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      fail(`bun.lock package ${lockKey} has an invalid integrity digest`);
    }
    result.set(lockKey, {
      lockKey,
      dependencyName,
      version,
      integrity,
      serialized: JSON.stringify(raw),
    });
  }
  return result;
};

const semverParts = (version: string): [number, number, number] => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    ?? fail(`version ${JSON.stringify(version)} is not stable plain semver`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** Return every resolved npm package replacement in a Bun lockfile update. */
export const changedBunLockPackages = (
  baseText: string,
  headText: string,
): LockedNpmReplacement[] => {
  const base = parseBunLockPackages(baseText);
  const head = parseBunLockPackages(headText);
  const replacements: LockedNpmReplacement[] = [];
  for (const [lockKey, current] of head) {
    const existing = base.get(lockKey);
    if (!existing) {
      fail(`bun.lock introduced new dependency slot ${lockKey} (${current.dependencyName}@${current.version})`);
    }
    const previous = existing as LockedNpmPackage;
    if (previous.serialized === current.serialized) continue;
    if (previous.dependencyName !== current.dependencyName) {
      fail(`bun.lock replaced ${previous.dependencyName} with ${current.dependencyName} at ${lockKey}`);
    }
    if (previous.version === current.version) {
      fail(`bun.lock changed ${current.dependencyName}@${current.version} without a version replacement`);
    }
    const [oldMajor, oldMinor, oldPatch] = semverParts(previous.version);
    const [newMajor, newMinor, newPatch] = semverParts(current.version);
    if (oldMajor !== newMajor || oldMinor !== newMinor || newPatch <= oldPatch) {
      fail(`bun.lock replacement ${current.dependencyName} ${previous.version} -> ${current.version} is not a semantic patch update`);
    }
    replacements.push({
      lockKey,
      dependencyName: current.dependencyName,
      previousVersion: previous.version,
      newVersion: current.version,
      integrity: current.integrity,
    });
  }
  if (replacements.length === 0) fail('bun.lock has no resolved package replacements');
  return replacements.sort((left, right) => left.lockKey.localeCompare(right.lockKey));
};

export const assertTrustedSocketScanner = (updates: Array<{ dependencyName: string }>): void => {
  if (updates.some(({ dependencyName }) => dependencyName === SOCKET_SCANNER_PACKAGE)) {
    fail(`${SOCKET_SCANNER_PACKAGE} updates cannot use the three-day no-human path because the scanner cannot approve itself`);
  }
};

export const assertNoGitHubMalwareAdvisories = (
  advisories: unknown,
  coordinate: string,
  withdrawn: boolean,
): void => {
  if (!Array.isArray(advisories)) {
    fail(`GitHub malware lookup for ${coordinate} returned invalid JSON`);
  }
  const entries = advisories as unknown[];
  if (entries.length === 0) return;
  const identifiers = entries.map((advisory: unknown) => {
    if (!advisory || typeof advisory !== 'object' || Array.isArray(advisory)) return 'unknown advisory';
    const ghsa = (advisory as Record<string, unknown>).ghsa_id;
    return typeof ghsa === 'string' ? ghsa : 'unknown advisory';
  });
  const status = withdrawn ? 'withdrawn' : 'active';
  fail(`${coordinate} matched ${status} GitHub malware advisory ${identifiers.join(', ')}`);
};

const parseMetadata = (raw: string, dependencies: string[]): UpdatedDependency[] => {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.length === 0) fail('updated-dependencies-json is empty or invalid');
  const entries = value as unknown[];
  const updates: UpdatedDependency[] = entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') fail('updated dependency metadata is not an object');
    const record = entry as Record<string, unknown>;
    if (typeof record.dependencyName !== 'string' || typeof record.newVersion !== 'string'
      || typeof record.updateType !== 'string') fail('updated dependency metadata is incomplete');
    if (record.updateType !== 'version-update:semver-patch') {
      fail(`metadata for ${record.dependencyName} is not a semantic patch update`);
    }
    const dependencyName = record.dependencyName as string;
    const newVersion = record.newVersion as string;
    const updateType = record.updateType as string;
    if (!/^v?\d+\.\d+\.\d+$/.test(newVersion)) {
      fail(`replacement version for ${dependencyName} is not a stable plain semver release`);
    }
    return {
      dependencyName,
      newVersion,
      updateType,
    };
  });
  const metadataNames = [...new Set(updates.map((entry) => entry.dependencyName))].sort();
  if (!isDeepStrictEqual(metadataNames, [...dependencies].sort())) {
    fail('dependency names do not match authenticated updated-dependencies-json');
  }
  return updates;
};

const fetchJson = async (
  url: string,
  githubToken?: string,
  fetcher: JsonFetcher = fetch,
): Promise<Record<string, unknown>> => {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json, application/json',
    'User-Agent': 'peerd-dependabot-security-policy',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const response = await fetcher(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`metadata lookup ${url} returned HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`metadata lookup ${url} returned invalid JSON`);
  return value as Record<string, unknown>;
};

const fetchJsonArray = async (
  url: string,
  githubToken?: string,
  fetcher: JsonFetcher = fetch,
): Promise<unknown[]> => {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'peerd-dependabot-security-policy',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const response = await fetcher(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`metadata lookup ${url} returned HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (!Array.isArray(value)) fail(`metadata lookup ${url} returned invalid JSON`);
  return value as unknown[];
};

export const verifyNoGitHubNpmMalware = async (
  updates: Array<{ dependencyName: string, newVersion: string }>,
  githubToken = process.env.GH_API_TOKEN,
  fetcher: JsonFetcher = fetch,
): Promise<void> => {
  for (const update of updates) {
    const version = update.newVersion.replace(/^v/, '');
    const coordinate = `${update.dependencyName}@${version}`;
    // Query active and withdrawn records separately. A withdrawn advisory still
    // proves the release tripped GitHub's malware feed during seasoning, so it
    // permanently disqualifies the three-day no-human path.
    for (const withdrawn of [false, true]) {
      const query = new URLSearchParams({
        type: 'malware',
        ecosystem: 'npm',
        affects: coordinate,
        is_withdrawn: String(withdrawn),
        per_page: '1',
      });
      const advisories = await fetchJsonArray(
        `https://api.github.com/advisories?${query.toString()}`,
        githubToken,
        fetcher,
      );
      assertNoGitHubMalwareAdvisories(advisories, coordinate, withdrawn);
    }
    console.log(`clean GitHub malware history: ${coordinate}`);
  }
};

export const assertMalwareObservationWindow = (
  observations: MalwareObservation[],
  headSha: string,
  requiredHours = MALWARE_OBSERVATION_HOURS,
  maximumGapHours = MALWARE_OBSERVATION_MAX_GAP_HOURS,
  now = new Date(),
): number => {
  assertSha(headSha, 'observation head SHA');
  if (!Number.isSafeInteger(requiredHours) || requiredHours < 1
    || !Number.isSafeInteger(maximumGapHours) || maximumGapHours < 1) {
    fail('malware observation window is invalid');
  }
  const matching = observations
    .filter((observation) => observation.headSha === headSha)
    .map((observation) => {
      const completed = new Date(observation.completedAt);
      if (!Number.isFinite(completed.getTime())) fail('malware observation has an invalid completion time');
      return { ...observation, completed };
    })
    .sort((left, right) => left.completed.getTime() - right.completed.getTime());
  if (matching.length === 0) fail('no malware observations exist for the exact candidate head');

  const maximumGapMs = maximumGapHours * 3_600_000;
  let cleanStart: Date | undefined;
  let previousClean: Date | undefined;
  for (const observation of matching) {
    if (observation.conclusion !== 'success') {
      cleanStart = undefined;
      previousClean = undefined;
      continue;
    }
    if (!previousClean || observation.completed.getTime() - previousClean.getTime() > maximumGapMs) {
      cleanStart = observation.completed;
    }
    previousClean = observation.completed;
  }
  if (!cleanStart || !previousClean) fail('the latest malware observation is not clean');
  const windowStart = cleanStart as Date;
  const latestClean = previousClean as Date;
  const freshnessMs = now.getTime() - latestClean.getTime();
  if (freshnessMs < 0 || freshnessMs > maximumGapMs) {
    fail(`the latest clean malware observation is more than ${maximumGapHours} hours old`);
  }
  const cleanHours = Math.floor((latestClean.getTime() - windowStart.getTime()) / 3_600_000);
  if (cleanHours < requiredHours) {
    fail(`the exact candidate has only ${cleanHours} continuous clean observation hours; ${requiredHours} are required`);
  }
  return cleanHours;
};

const loadMalwareObservations = async (
  repository: string,
  pr: number,
  headSha: string,
  githubToken: string,
  now = new Date(),
): Promise<MalwareObservation[]> => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('GitHub repository is invalid');
  if (!Number.isSafeInteger(pr) || pr < 1) fail('observation PR number is invalid');
  assertSha(headSha, 'observation head SHA');
  const since = new Date(now.getTime() - (MALWARE_OBSERVATION_HOURS + MALWARE_OBSERVATION_MAX_GAP_HOURS) * 3_600_000);
  const query = new URLSearchParams({
    created: `>=${since.toISOString()}`,
    per_page: '100',
  });
  const response = await fetchJson(
    `https://api.github.com/repos/${repository}/actions/workflows/${MALWARE_OBSERVATION_WORKFLOW}/runs?${query}`,
    githubToken,
  );
  const runValue = response.workflow_runs;
  if (!Array.isArray(runValue)) fail('malware observation workflow-runs response is malformed');
  const runs = runValue as unknown[];
  const jobName = `observe Bun malware window (PR ${pr}, ${headSha})`;
  const observations: MalwareObservation[] = [];
  for (const run of runs) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) fail('malware observation run is malformed');
    const id = (run as Record<string, unknown>).id;
    if (!Number.isSafeInteger(id)) fail('malware observation run has no numeric ID');
    const response = await fetchJson(
      `https://api.github.com/repos/${repository}/actions/runs/${String(id)}/jobs?filter=latest&per_page=100`,
      githubToken,
    );
    if (!Array.isArray(response.jobs)) fail('malware observation jobs response is malformed');
    for (const job of response.jobs as unknown[]) {
      if (!job || typeof job !== 'object' || Array.isArray(job)) fail('malware observation job is malformed');
      const record = job as Record<string, unknown>;
      if (record.name !== jobName) continue;
      if (typeof record.conclusion !== 'string' || typeof record.completed_at !== 'string') {
        fail('malware observation job is incomplete');
      }
      const conclusion = record.conclusion as string;
      const completedAt = record.completed_at as string;
      observations.push({
        headSha,
        conclusion,
        completedAt,
      });
    }
  }
  return observations;
};

const verifyObservationWindow = async (values: Record<string, string>): Promise<void> => {
  const repository = required(values, 'repository');
  const pr = Number(required(values, 'pr'));
  const headSha = required(values, 'head-sha');
  const githubToken = process.env.GH_API_TOKEN ?? fail('GH_API_TOKEN is required for observation verification');
  const observations = await loadMalwareObservations(repository, pr, headSha, githubToken);
  const cleanHours = assertMalwareObservationWindow(observations, headSha);
  console.log(`verified ${cleanHours} continuous clean malware observation hours for PR #${pr} at ${headSha}`);
};

export const verifyNpmSeasoning = async (
  updates: Array<{ dependencyName: string, newVersion: string, integrity?: string }>,
  minimumAgeDays?: number,
  fetcher: JsonFetcher = fetch,
): Promise<void> => {
  const packuments = new Map<string, Record<string, unknown>>();
  for (const update of updates) {
    let packument = packuments.get(update.dependencyName);
    if (!packument) {
      packument = await fetchJson(
        `https://registry.npmjs.org/${encodeURIComponent(update.dependencyName)}`,
        undefined,
        fetcher,
      );
      packuments.set(update.dependencyName, packument);
    }
    const version = update.newVersion.replace(/^v/, '');
    const times = packument.time;
    const versions = packument.versions;
    if (!times || typeof times !== 'object' || Array.isArray(times)
      || !versions || typeof versions !== 'object' || Array.isArray(versions)) {
      fail(`npm registry metadata for ${update.dependencyName} lacks versions or publication times`);
    }
    const publishedAt = (times as Record<string, unknown>)[version];
    const manifest = (versions as Record<string, unknown>)[version];
    if (typeof publishedAt !== 'string' || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      fail(`npm registry has no exact ${update.dependencyName}@${version} release metadata`);
    }
    const dist = (manifest as Record<string, unknown>).dist;
    if (!dist || typeof dist !== 'object' || Array.isArray(dist)
      || typeof (dist as Record<string, unknown>).integrity !== 'string') {
      fail(`npm release ${update.dependencyName}@${version} has no registry integrity digest`);
    }
    const registryIntegrity = (dist as Record<string, unknown>).integrity as string;
    if (update.integrity !== undefined
      && !registryIntegrity.split(/\s+/).includes(update.integrity)) {
      fail(`bun.lock integrity for ${update.dependencyName}@${version} does not match the npm registry`);
    }
    if (typeof (manifest as Record<string, unknown>).deprecated === 'string') {
      fail(`npm release ${update.dependencyName}@${version} is deprecated`);
    }
    if (minimumAgeDays === undefined) {
      if (!Number.isFinite(new Date(publishedAt as string).getTime())) {
        fail(`invalid publication timestamp ${JSON.stringify(publishedAt)}`);
      }
      console.log(`verified npm release metadata: ${update.dependencyName}@${version}`);
    } else {
      const age = assertAtLeastDaysOld(publishedAt as string, minimumAgeDays);
      console.log(`seasoned npm release: ${update.dependencyName}@${version} (${age} days old)`);
    }
  }
};

const githubApi = async (path: string): Promise<Record<string, unknown>> =>
  fetchJson(`https://api.github.com${path}`, process.env.GH_API_TOKEN);

const resolveTagCommit = async (repository: string, tag: string): Promise<string> => {
  const ref = await githubApi(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  const object = ref.object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail(`GitHub tag ${repository}@${tag} has no object`);
  let type = (object as Record<string, unknown>).type;
  let sha = (object as Record<string, unknown>).sha;
  if (typeof type !== 'string' || typeof sha !== 'string') fail(`GitHub tag ${repository}@${tag} is malformed`);
  if (type === 'tag') {
    const annotated = await githubApi(`/repos/${repository}/git/tags/${sha}`);
    const target = annotated.object;
    if (!target || typeof target !== 'object' || Array.isArray(target)) fail(`annotated tag ${repository}@${tag} has no target`);
    type = (target as Record<string, unknown>).type;
    sha = (target as Record<string, unknown>).sha;
  }
  if (type !== 'commit' || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    fail(`GitHub tag ${repository}@${tag} does not resolve directly to a commit`);
  }
  return sha as string;
};

const verifyActionsSeasoning = async (
  updates: UpdatedDependency[],
  actionUpdates: ActionUpdate[],
  minimumAgeDays: number,
): Promise<void> => {
  const metadata = new Map(updates.map((entry) => [entry.dependencyName.toLowerCase(), entry]));
  const unique = new Map(actionUpdates.map((entry) => [`${entry.repository}@${entry.sha}`, entry]));
  for (const action of unique.values()) {
    const update = metadata.get(action.repository.toLowerCase())
      ?? fail(`Actions diff contains ${action.repository}, absent from authenticated metadata`);
    if (action.version.replace(/^v/, '') !== update.newVersion.replace(/^v/, '')) {
      fail(`Actions version comment for ${action.repository} does not match authenticated metadata`);
    }
    const release = await githubApi(`/repos/${action.repository}/releases/tags/${encodeURIComponent(action.version)}`);
    if (release.draft !== false || release.prerelease !== false || typeof release.published_at !== 'string') {
      fail(`GitHub Action ${action.repository}@${action.version} is not a stable published release`);
    }
    const taggedSha = await resolveTagCommit(action.repository, action.version);
    if (taggedSha !== action.sha) fail(`GitHub Action ${action.repository}@${action.version} tag does not match pinned SHA`);
    const commit = await githubApi(`/repos/${action.repository}/commits/${action.sha}`);
    const inner = commit.commit;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) fail(`GitHub Action ${action.repository} commit is malformed`);
    const verification = (inner as Record<string, unknown>).verification;
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)
      || (verification as Record<string, unknown>).verified !== true) {
      fail(`GitHub Action ${action.repository}@${action.version} commit is not GitHub-verified`);
    }
    const age = assertAtLeastDaysOld(release.published_at as string, minimumAgeDays);
    console.log(`seasoned GitHub Action release: ${action.repository}@${action.version} (${age} days old)`);
  }
  for (const update of updates) {
    if (![...unique.values()].some((action) => action.repository.toLowerCase() === update.dependencyName.toLowerCase())) {
      fail(`authenticated Actions metadata contains ${update.dependencyName}, absent from the diff`);
    }
  }
};

export const nextPatchVersion = (version: string): string => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    ?? fail(`package version ${JSON.stringify(version)} is not plain semver`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
};

export const addSecurityChangelog = (
  changelog: string,
  version: string,
  date: string,
  dependencies: string[],
  pr: number,
): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('release date is not YYYY-MM-DD');
  if (!Number.isSafeInteger(pr) || pr <= 0) fail('PR number is invalid');
  if (changelog.includes(`## [${version}]`)) fail(`CHANGELOG.md already has a ${version} section`);
  const marker = '## [Unreleased]\n';
  if (!changelog.includes(marker)) fail('CHANGELOG.md has no Unreleased section');
  const named = dependencies.map((name) => `\`${name}\``).join(', ');
  const section = `\n## [${version}] - ${date}\n\n### Security\n- Updated ${named} through verified Dependabot security PR #${pr}. The update\n  remains dependency-only and must pass the full protected CI and supply-chain\n  gates before this patch release is tagged.\n`;
  return changelog.replace(marker, `${marker}${section}`);
};

export const assertRecentUtcDate = (date: string, now = new Date()): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('release date is not YYYY-MM-DD');
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (date !== today && date !== yesterday) {
    fail('release date is not the current UTC date (or the previous date across a midnight handoff)');
  }
};

const assertInitialPaths = (ecosystem: SupportedEcosystem, paths: string[]): void => {
  if (paths.length === 0) fail('the PR has no file changes');
  for (const path of paths) {
    if (ecosystem === 'bun') {
      if (!BASE_BUN_PATHS.has(path)) fail(`Bun security PR changed disallowed path ${path}`);
    } else if (!path.startsWith('.github/workflows/') || !/\.ya?ml$/.test(path)) {
      fail(`GitHub Actions security PR changed disallowed path ${path}`);
    }
  }
};

const bunLockReplacements = (
  repo: string,
  baseSha: string,
  headSha: string,
  paths: string[],
): LockedNpmReplacement[] => {
  if (!paths.includes('bun.lock')) fail('Bun security PR did not replace a resolved package in bun.lock');
  const replacements = changedBunLockPackages(
    readAt(repo, baseSha, 'bun.lock'),
    readAt(repo, headSha, 'bun.lock'),
  );
  assertTrustedSocketScanner(replacements);
  return replacements;
};

const assertMetadataMatchesResolvedReplacements = (
  metadata: UpdatedDependency[],
  replacements: LockedNpmReplacement[],
): void => {
  const coordinates = new Set(replacements.map(({ dependencyName, newVersion }) => `${dependencyName}@${newVersion}`));
  for (const update of metadata) {
    const coordinate = `${update.dependencyName}@${update.newVersion.replace(/^v/, '')}`;
    if (!coordinates.has(coordinate)) {
      fail(`authenticated update ${coordinate} is absent from the resolved bun.lock replacements`);
    }
  }
};

const observeBun = async (values: Record<string, string>): Promise<void> => {
  const repo = resolve(required(values, 'repo'));
  const baseSha = required(values, 'base-sha');
  const headSha = required(values, 'head-sha');
  assertSha(baseSha, 'base SHA');
  assertSha(headSha, 'head SHA');
  const paths = changedPaths(repo, baseSha, headSha);
  assertInitialPaths('bun', paths);
  const replacements = bunLockReplacements(repo, baseSha, headSha, paths);
  await verifyNpmSeasoning(replacements);
  await verifyNoGitHubNpmMalware(replacements);
  console.log(`observed clean Bun replacement graph at ${headSha}: ${replacements.map(({ dependencyName, newVersion }) => `${dependencyName}@${newVersion}`).join(', ')}`);
};

const verify = async (values: Record<string, string>): Promise<void> => {
  const repo = resolve(required(values, 'repo'));
  const baseSha = required(values, 'base-sha');
  const headSha = required(values, 'head-sha');
  assertSha(baseSha, 'base SHA');
  assertSha(headSha, 'head SHA');
  const ecosystem = required(values, 'ecosystem') as SupportedEcosystem;
  if (!(ecosystem in SECURITY_GROUPS)) fail(`unsupported ecosystem ${ecosystem}`);
  if (required(values, 'group') !== SECURITY_GROUPS[ecosystem]) {
    fail('PR is not in the configured Dependabot security-only group');
  }
  if (required(values, 'update-type') !== 'version-update:semver-patch') {
    fail('only semantic patch dependency updates are eligible for no-human merge');
  }
  const dependencies = parseDependencyNames(required(values, 'dependencies'));
  const metadata = parseMetadata(required(values, 'metadata'), dependencies);
  const minimumAgeDays = Number(required(values, 'minimum-age-days'));
  const policyMinimumAgeDays = minimumSecurityAgeDays(ecosystem);
  if (!Number.isSafeInteger(minimumAgeDays) || minimumAgeDays < policyMinimumAgeDays) {
    fail(`${ecosystem} no-human security updates require at least ${policyMinimumAgeDays} days of replacement seasoning`);
  }
  const paths = changedPaths(repo, baseSha, headSha);
  assertInitialPaths(ecosystem, paths);

  if (ecosystem === 'bun') {
    if (paths.includes('package.json')) {
      validatePackageJsonChange(
        readAt(repo, baseSha, 'package.json'),
        readAt(repo, headSha, 'package.json'),
        dependencies,
        Object.fromEntries(metadata.map(({ dependencyName, newVersion }) => [dependencyName, newVersion])),
      );
    }
    const replacements = bunLockReplacements(repo, baseSha, headSha, paths);
    assertMetadataMatchesResolvedReplacements(metadata, replacements);
    assertTrustedSocketScanner(metadata);
    await verifyNpmSeasoning(replacements, minimumAgeDays);
    await verifyNoGitHubNpmMalware(replacements);
  } else {
    const diff = git(repo, ['diff', '--no-ext-diff', '--unified=0', `${baseSha}..${headSha}`, '--', ...paths]);
    const actionUpdates = parseActionsDiff(diff);
    await verifyActionsSeasoning(metadata, actionUpdates, minimumAgeDays);
  }

  console.log(`verified seasoned ${ecosystem} security patch for ${dependencies.join(', ')} (${paths.join(', ')})`);
};

const writeOutput = (name: string, value: string): void => {
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${name}=${value}\n`);
};

const prepare = (values: Record<string, string>): void => {
  const repo = resolve(required(values, 'repo'));
  const baseSha = required(values, 'base-sha');
  assertSha(baseSha, 'base SHA');
  const ecosystem = required(values, 'ecosystem') as SupportedEcosystem;
  if (!(ecosystem in SECURITY_GROUPS)) fail(`unsupported ecosystem ${ecosystem}`);
  const dependencies = parseDependencyNames(required(values, 'dependencies'));
  const pr = Number(required(values, 'pr'));
  const date = required(values, 'date');
  assertRecentUtcDate(date);

  const packagePath = resolve(repo, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
  const currentVersion = packageJson.version;
  if (typeof currentVersion !== 'string') fail('package.json has no string version');
  const version = nextPatchVersion(currentVersion as string);
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const changelogPath = resolve(repo, 'CHANGELOG.md');
  writeFileSync(changelogPath, addSecurityChangelog(
    readFileSync(changelogPath, 'utf8'),
    version,
    date,
    dependencies,
    pr,
  ));

  // CodeMirror is the checked-in library we can safely rebuild without human
  // judgment: its source dependencies are in bun.lock, its bundle is generated
  // deterministically, and every emitted byte is covered by vendor.lock.json.
  // Rebuild on every Bun security PR; unrelated graph changes yield no diff.
  if (ecosystem === 'bun') {
    run(repo, 'bun', ['run', 'vendor:codemirror']);
    run(repo, 'bun', ['packaging/check-vendor.ts', '--write']);
  }
  run(repo, 'bun', ['packaging/gen-manifest.ts', '--channel=dev', '--browser=chrome']);
  run(repo, 'bun', ['run', 'check:vendor']);
  run(repo, 'bun', ['install', '--frozen-lockfile']);

  const initial = new Set(changedPaths(repo, baseSha));
  const allowed = new Set([...initial, ...GENERATED_RELEASE_PATHS]);
  if (ecosystem === 'bun') {
    for (const path of CODEMIRROR_VENDOR_PATHS) allowed.add(path);
  }
  for (const path of initial) {
    if (ecosystem === 'bun') {
      if (!BASE_BUN_PATHS.has(path) && !GENERATED_RELEASE_PATHS.has(path)
        && !CODEMIRROR_VENDOR_PATHS.has(path)) fail(`unexpected prepared path ${path}`);
    } else if (!path.startsWith('.github/workflows/') && !GENERATED_RELEASE_PATHS.has(path)) {
      fail(`unexpected prepared path ${path}`);
    }
  }
  const finalPaths = changedPaths(repo, baseSha);
  for (const path of finalPaths) {
    if (!allowed.has(path)) fail(`release preparation generated disallowed path ${path}`);
  }
  for (const requiredPath of GENERATED_RELEASE_PATHS) {
    if (!finalPaths.includes(requiredPath)) fail(`release preparation did not update ${requiredPath}`);
  }
  execFileSync('git', ['-C', repo, 'diff', '--check', baseSha, '--'], { stdio: 'inherit' });

  writeOutput('version', version);
  writeOutput('tag', `v${version}`);
  writeOutput('release-date', date);
  writeOutput('vendored-codemirror', String(
    finalPaths.some((path) => CODEMIRROR_VENDOR_PATHS.has(path)),
  ));
  console.log(JSON.stringify({ version, dependencies, finalPaths }, null, 2));
};

const sha256 = (value: Buffer | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

/**
 * Revalidate the untrusted generation artifact in a fresh privileged runner.
 * This command uses only the trusted base policy and Node/Bun built-ins. It
 * never installs or executes code from the candidate dependency graph.
 */
export const validatePrepared = (values: Record<string, string>): void => {
  const repo = resolve(required(values, 'repo'));
  const baseSha = required(values, 'base-sha');
  const headSha = required(values, 'head-sha');
  assertSha(baseSha, 'base SHA');
  assertSha(headSha, 'head SHA');
  const ecosystem = required(values, 'ecosystem') as SupportedEcosystem;
  if (!(ecosystem in SECURITY_GROUPS)) fail(`unsupported ecosystem ${ecosystem}`);
  const dependencies = parseDependencyNames(required(values, 'dependencies'));
  const pr = Number(required(values, 'pr'));
  const date = required(values, 'date');
  assertRecentUtcDate(date);

  const initialPaths = changedPaths(repo, baseSha, headSha);
  assertInitialPaths(ecosystem, initialPaths);
  if (ecosystem === 'bun' && initialPaths.includes('package.json')) {
    validatePackageJsonChange(
      readAt(repo, baseSha, 'package.json'),
      readAt(repo, headSha, 'package.json'),
      dependencies,
    );
  }

  // The checkout began at the authenticated Dependabot head. The downloaded
  // patch may add only deterministic release files, plus the narrowly scoped
  // CodeMirror output for Bun updates.
  const preparedPaths = changedPaths(repo, headSha);
  const allowedPrepared = new Set(GENERATED_RELEASE_PATHS);
  if (ecosystem === 'bun') {
    for (const path of CODEMIRROR_VENDOR_PATHS) allowedPrepared.add(path);
  }
  for (const path of preparedPaths) {
    if (!allowedPrepared.has(path)) fail(`untrusted generation changed disallowed path ${path}`);
  }
  for (const requiredPath of GENERATED_RELEASE_PATHS) {
    if (!preparedPaths.includes(requiredPath)) fail(`untrusted generation did not update ${requiredPath}`);
  }

  const deleted = git(repo, ['diff', '--diff-filter=D', '--name-only', headSha, '--']).trim();
  if (deleted) fail(`untrusted generation deleted a file: ${deleted.split('\n')[0]}`);
  for (const path of preparedPaths) {
    const stage = git(repo, ['ls-files', '--stage', '--', path]).trim();
    if (!stage.startsWith('100644 ')) fail(`prepared path is not a regular non-executable file: ${path}`);
  }

  const headPackage = JSON.parse(readAt(repo, headSha, 'package.json')) as Record<string, unknown>;
  const preparedPackage = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as Record<string, unknown>;
  const currentVersion = headPackage.version;
  if (typeof currentVersion !== 'string') fail('authenticated head package.json has no string version');
  const version = nextPatchVersion(currentVersion as string);
  const expectedPackage = structuredClone(headPackage);
  expectedPackage.version = version;
  if (!isDeepStrictEqual(preparedPackage, expectedPackage)) {
    fail('prepared package.json differs from the authenticated head beyond the patch version');
  }

  const expectedChangelog = addSecurityChangelog(
    readAt(repo, headSha, 'CHANGELOG.md'),
    version,
    date,
    dependencies,
    pr,
  );
  if (readFileSync(resolve(repo, 'CHANGELOG.md'), 'utf8') !== expectedChangelog) {
    fail('prepared CHANGELOG.md is not the exact trusted security release entry');
  }

  const headManifest = JSON.parse(readAt(repo, headSha, 'extension/manifest.json')) as Record<string, unknown>;
  headManifest.version = version;
  const expectedManifest = `${JSON.stringify(headManifest, null, 2)}\n`;
  if (readFileSync(resolve(repo, 'extension/manifest.json'), 'utf8') !== expectedManifest) {
    fail('prepared extension manifest differs from the authenticated head beyond the patch version');
  }

  // The untrusted generator may alter only the two CodeMirror outputs and the
  // corresponding lock entries. It cannot use the lock rewrite to bless any
  // unrelated vendored byte.
  const headLock = JSON.parse(readAt(repo, headSha, VENDOR_LOCK_PATH)) as {
    files?: Record<string, string>;
  };
  if (!headLock.files || typeof headLock.files !== 'object') fail('authenticated vendor lock is malformed');
  const expectedLock = structuredClone(headLock);
  for (const relative of ['codemirror/cm.js', 'codemirror/SOURCE.txt']) {
    const path = `extension/vendor/${relative}`;
    expectedLock.files![relative] = sha256(readFileSync(resolve(repo, path)));
  }
  const expectedLockText = `${JSON.stringify(expectedLock, null, 2)}\n`;
  if (readFileSync(resolve(repo, VENDOR_LOCK_PATH), 'utf8') !== expectedLockText) {
    fail('prepared vendor lock changed beyond the exact CodeMirror output hashes');
  }

  execFileSync('git', ['-C', repo, 'diff', '--check', headSha, '--'], { stdio: 'inherit' });
  writeOutput('version', version);
  writeOutput('tag', `v${version}`);
  writeOutput('vendored-codemirror', String(
    preparedPaths.some((path) => CODEMIRROR_VENDOR_PATHS.has(path)),
  ));
  console.log(JSON.stringify({ version, dependencies, preparedPaths }, null, 2));
};

if (import.meta.main) {
  try {
    const { command, values } = parseArgs(process.argv.slice(2));
    if (command === 'verify') await verify(values);
    else if (command === 'observe-bun') await observeBun(values);
    else if (command === 'verify-observations') await verifyObservationWindow(values);
    else if (command === 'prepare') prepare(values);
    else if (command === 'validate-prepared') validatePrepared(values);
    else fail('expected verify, observe-bun, verify-observations, prepare, or validate-prepared command');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
