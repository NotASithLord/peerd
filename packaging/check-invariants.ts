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

/**
 * Strip comments so a mention in a `// why:` note isn't counted as a site, while
 * keeping the file's byte length (replace with spaces) so nothing shifts.
 *
 * why not a line-prefix filter: the earlier version skipped lines *starting* with
 * `//` or `*`, which both under- and over-counted — a trailing `// …` comment on a
 * code line was scanned, a `/* … *\/` block was not stripped at all, and matching
 * per LINE meant two sites on one line counted as one. This is still not a parser
 * (a `//` inside a string literal is treated as a comment), but it errs toward
 * counting MORE, and a false positive fails loudly and is cheap to re-bless — the
 * failure mode a security gate should have.
 */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

/** Count matches of a pattern across each whole file, dropping files with none. */
const sitesMatching = (pattern: RegExp): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const rel of sourceFiles()) {
    const src = stripComments(readFileSync(join(EXTENSION_DIR, rel), 'utf8'));
    const n = src.match(pattern)?.length ?? 0;
    if (n > 0) out[rel] = n;
  }
  return out;
};

// Whole-file, global, and deliberately wide. Each alternative closes a way the
// narrow versions were evaded: `new AsyncFunction(` (the ctor obtained off an async
// function's prototype — hooks/compile.js does exactly this, and it was invisible),
// a bare `Function(...)` call, indirect eval (`(0, eval)`, `globalThis.eval`), and
// the string forms of setTimeout/setInterval. Line breaks between the callee and
// `(` are tolerated so a formatter can't hide a site.
const DYNAMIC_CODE = /new\s+\w*Function\s*\(|(^|[^.\w$])Function\s*\(|(^|[^.\w$])eval\s*\(|\.\s*eval\s*\(|set(?:Timeout|Interval)\s*\(\s*['"`]/g;
// `?.` and whitespace/newlines between every part, and onMessageExternal too — the
// external surface would be strictly worse than onMessage if it ever appeared.
const MESSAGE_HOST = /runtime\s*\??\.\s*onMessage(?:External)?\s*\??\.\s*addListener/g;

// The whole generated manifest is the surface, minus the keys that legitimately
// move on their own. why a denylist instead of the hand-picked allowlist this
// started as: an allowlist silently ignores every key nobody thought of, and the
// ones missed were not obscure — `sandbox` (which places a page under the
// permissive sandbox CSP), `optional_host_permissions`, and `devtools_page` all
// passed the gate untouched. A denylist means a NEW manifest key shows up as a
// diff by default, which is the posture a surface gate wants.
const VOLATILE_MANIFEST_KEYS = new Set(['version', 'version_name', 'key']);

const manifestSurface = (channel: Channel, browser: Browser, version: string): Record<string, unknown> => {
  const m = generateManifest({ channel, browser, version }) as Record<string, any>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(m).sort()) {
    if (VOLATILE_MANIFEST_KEYS.has(k)) continue;
    // Sort permission-ish arrays so a reorder isn't noise; everything else rides verbatim.
    out[k] = Array.isArray(m[k]) && m[k].every((v: unknown) => typeof v === 'string')
      ? [...m[k]].sort()
      : m[k];
  }
  return out;
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

// Every channel a manifest is generated for — INCLUDING dev, which CHANNELS omits.
// why dev belongs here: it is the manifest every contributor load-unpacks, against a
// real unlocked vault and a real API key, and it already exposes tests/runner.html to
// <all_urls>. An `externally_connectable` added to manifests/dev.patch.json would make
// the ~100-route privileged dispatcher reachable from a web page, and nothing else
// would catch it — the generated-file drift check only asserts extension/manifest.json
// matches `gen:dev` output, so patching the source and regenerating is drift-clean.
const GATED_CHANNELS = /** @type {Channel[]} */ ([...CHANNELS, 'dev' as Channel]);

const collect = () => {
  const version = readVersion();
  const manifests: Record<string, Record<string, unknown>> = {};
  const forbidden: string[] = [];
  for (const channel of GATED_CHANNELS) {
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
