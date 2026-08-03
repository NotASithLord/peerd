// Architectural security invariants — the peerd-specific gate no generic
// scanner knows about. CodeQL/OSV find KNOWN vulnerability shapes; this finds
// changes to the things that make peerd's isolation claims true in the first
// place, and turns each into a review event rather than a silent drift.
//
//   bun run check:invariants                verify against the blessed baseline
//   bun packaging/check-invariants.ts --write   re-bless (same commit as the change)
//
// Three surfaces, all in one baseline (packaging/security-baseline.json):
//
//   manifest      per channel x browser: permissions, host_permissions, CSP,
//                 web_accessible_resources — and a HARD refusal (never blessable)
//                 of content_scripts / externally_connectable, which would make
//                 the privileged RPC surface reachable from a web page. The
//                 sender-trust guard is written to fail closed if that ever
//                 happens; this makes sure it also never happens by accident.
//   dynamic code  every `new Function(` / `eval(` site. Both are legitimate in a
//                 harness that runs agent-authored code — in EXACTLY two places.
//                 A third is a design change worth seeing in a diff.
//   message hosts every raw `runtime.onMessage.addListener` site. The SW's
//                 privileged fan-out goes through makeDispatcher (which enforces
//                 sender provenance); the others are narrow per-page handlers.
//                 A NEW listener is the shape that historically re-opens a
//                 surface, so adding one requires blessing it here.
//
// why a baseline and not hard-coded rules: the counts and paths are exactly the
// operational state the repo's doc convention says not to freeze in prose. The
// baseline IS the machine-readable record, reviewed as a diff.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, EXTENSION_DIR, CHANNELS, BROWSERS, readVersion, type Channel, type Browser } from './lib.ts';
import { generateManifest } from './gen-manifest.ts';

const BASELINE_PATH = join(REPO_ROOT, 'packaging', 'security-baseline.json');

/** Source files to scan: every .js under extension/, minus vendored code and tests. */
const sourceFiles = (): string[] =>
  (readdirSync(EXTENSION_DIR, { recursive: true }) as string[])
    .map((p) => p.split('\\').join('/'))
    .filter((rel) => rel.endsWith('.js'))
    .filter((rel) => !rel.startsWith('vendor/') && !rel.startsWith('tests/'))
    .filter((rel) => !rel.endsWith('.test.js'))
    .sort();

/** Count non-comment matches of a pattern, per file, dropping files with none. */
const sitesMatching = (pattern: RegExp): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const rel of sourceFiles()) {
    const lines = readFileSync(join(EXTENSION_DIR, rel), 'utf8').split('\n');
    // Skip line comments so a mention in a `// why:` note isn't counted as a
    // site — this file's whole job is to be precise about where code lives.
    const n = lines.filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .filter((l) => pattern.test(l)).length;
    if (n > 0) out[rel] = n;
  }
  return out;
};

const DYNAMIC_CODE = /new Function\s*\(|(^|[^.\w$])eval\s*\(/;
const MESSAGE_HOST = /runtime\.onMessage\.addListener/;

type ManifestSurface = {
  permissions: string[];
  optional_permissions: string[];
  host_permissions: string[];
  content_security_policy: Record<string, string>;
  web_accessible_resources: unknown;
};

const manifestSurface = (channel: Channel, browser: Browser, version: string): ManifestSurface => {
  const m = generateManifest({ channel, browser, version }) as Record<string, any>;
  return {
    permissions: [...(m.permissions ?? [])].sort(),
    optional_permissions: [...(m.optional_permissions ?? [])].sort(),
    host_permissions: [...(m.host_permissions ?? [])].sort(),
    content_security_policy: m.content_security_policy ?? {},
    web_accessible_resources: m.web_accessible_resources ?? [],
  };
};

/**
 * Surfaces that must NEVER exist, in any channel or browser: either one turns
 * the ~100-route privileged dispatcher into something a web page can address.
 * Not blessable — a baseline entry cannot wave these through.
 */
const forbiddenManifestKeys = (channel: Channel, browser: Browser, version: string): string[] => {
  const m = generateManifest({ channel, browser, version }) as Record<string, any>;
  return ['content_scripts', 'externally_connectable'].filter((k) => m[k] !== undefined);
};

const collect = () => {
  const version = readVersion();
  const manifests: Record<string, ManifestSurface> = {};
  const forbidden: string[] = [];
  for (const channel of CHANNELS) {
    for (const browser of BROWSERS) {
      manifests[`${channel}/${browser}`] = manifestSurface(channel, browser, version);
      for (const key of forbiddenManifestKeys(channel, browser, version)) {
        forbidden.push(`${channel}/${browser}: ${key}`);
      }
    }
  }
  return {
    manifests,
    dynamicCodeSites: sitesMatching(DYNAMIC_CODE),
    messageHostSites: sitesMatching(MESSAGE_HOST),
    forbidden,
  };
};

const write = () => {
  const { manifests, dynamicCodeSites, messageHostSites, forbidden } = collect();
  if (forbidden.length > 0) {
    console.error(`check-invariants: refusing to bless a forbidden manifest key:\n  ${forbidden.join('\n  ')}`);
    process.exit(1);
  }
  const baseline = {
    '//': 'Blessed security surface — generated by `bun packaging/check-invariants.ts --write`. '
      + 'Verified by `bun run check:invariants` in CI. A diff here is a deliberate change to '
      + "peerd's attack surface and should be reviewed as one.",
    manifests, dynamicCodeSites, messageHostSites,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  console.log(
    `wrote ${relative(REPO_ROOT, BASELINE_PATH)}: ${Object.keys(manifests).length} manifest surfaces, `
    + `${Object.keys(dynamicCodeSites).length} dynamic-code file(s), ${Object.keys(messageHostSites).length} message-host file(s)`,
  );
};

const check = () => {
  const actual = collect();
  const problems: string[] = [];

  // Never blessable, checked first and independently of the baseline.
  for (const f of actual.forbidden) {
    problems.push(`FORBIDDEN manifest key — makes the privileged RPC surface web-reachable: ${f}`);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    console.error(`check-invariants FAILED: ${relative(REPO_ROOT, BASELINE_PATH)} missing or unreadable — run with --write and commit it.`);
    process.exit(1);
  }

  const compare = (label: string, was: unknown, now: unknown) => {
    const a = JSON.stringify(was, null, 2);
    const b = JSON.stringify(now, null, 2);
    if (a !== b) problems.push(`${label} changed:\n    blessed: ${a}\n    actual:  ${b}`);
  };

  for (const key of new Set([...Object.keys(baseline.manifests ?? {}), ...Object.keys(actual.manifests)])) {
    compare(`manifest surface [${key}]`, baseline.manifests?.[key], actual.manifests[key]);
  }
  compare('dynamic-code sites (new Function / eval)', baseline.dynamicCodeSites, actual.dynamicCodeSites);
  compare('runtime.onMessage listener sites', baseline.messageHostSites, actual.messageHostSites);

  if (problems.length > 0) {
    console.error(
      'check-invariants FAILED — the security surface moved:\n\n'
      + problems.map((p) => `  - ${p}`).join('\n\n')
      + '\n\nEach of these is a real widening unless you meant it. A new host permission, a\n'
      + 'relaxed CSP, a new web_accessible_resource, a new dynamic-code site, or a new\n'
      + 'message listener all deserve a look before they ship. If the change IS intended:\n'
      + 'run `bun packaging/check-invariants.ts --write` and commit the baseline alongside it.',
    );
    process.exit(1);
  }
  console.log(
    `check-invariants OK — ${Object.keys(actual.manifests).length} manifest surfaces, `
    + `${Object.keys(actual.dynamicCodeSites).length} dynamic-code file(s), `
    + `${Object.keys(actual.messageHostSites).length} message-host file(s) match the blessed baseline`,
  );
};

if (import.meta.main) {
  if (process.argv.includes('--write')) write();
  else check();
}
