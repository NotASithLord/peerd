// Store-artifact verification (spec §3) — the safety net that catches
// every mistake where the dweb boundary leaked into a store package.
//
// Layering (each layer catches what the previous can't):
//   1. packaging/check-dweb-boundary.ts — SOURCE level, pre-package:
//      no file outside peerd-distributed/ references the module.
//   2. package.ts pruning + loader swap — STRUCTURAL: the module isn't in
//      the store tree at all.
//   3. THIS CHECK — ARTIFACT level, post-package: even if 1–2 regress
//      (filter typo, refactored prune list, missed loader swap), the
//      artifact itself is inspected before it can reach a store reviewer.
//
// Checks, in order:
//   a. no path in the zip is under peerd-distributed/
//   b. shared/dweb-loader.js and both cold dweb route factories are
//      byte-identical to their committed disabled templates
//   c. NO file in the artifact contains the string "peerd-distributed"
//   d. manifest sanity: name "peerd", no update_url, no key
//   e. identifier sweep: identifiers that appear ONLY in dweb
//      sources (never in the rest of extension/) must not appear in any
//      artifact file — catches whole-file leaks under renamed paths
//
// Run: bun packaging/verify-store-artifact.ts artifacts/peerd-store-chrome.zip
// (package.ts runs it automatically for every store artifact)

import { existsSync, readFileSync, rmSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { plugin } from 'bun';
import {
  REPO_ROOT, STORE_LOADER_TEMPLATE,
  DWEB_ROUTES_DISABLED_TEMPLATE, DWEB_SELF_ROUTES_DISABLED_TEMPLATE,
} from './lib.ts';
import { STORE_STRIPPED_PERMISSIONS } from './gen-manifest.ts';

const DWEB_DISABLED_TEMPLATE_TARGETS = Object.freeze([
  ['shared/dweb-loader.js', STORE_LOADER_TEMPLATE],
  ['background/routes/dweb.js', DWEB_ROUTES_DISABLED_TEMPLATE],
  ['background/routes/dweb-self.js', DWEB_SELF_ROUTES_DISABLED_TEMPLATE],
] as const);
const DWEB_ABSENT_TARGETS = Object.freeze([
  'background/kernel-preview-addon.js', 'background/vault-kernel-preview.js',
  'background/kernel-contributor-owner.js',
  'background/kernel-firefox-contributor-addon.js',
  'background/vault-kernel-firefox-preview.js',
  'offscreen/dweb-base.js', 'offscreen/dweb-custody-host.js',
  'offscreen/dweb-self.js', 'offscreen/dweb-transfer-host.js',
]);

/** Byte-for-byte package boundary shared by the verifier and focused tests. */
export const dwebDisabledTemplateFailures = (artifactRoot: string): string[] => {
  const failures: string[] = [];
  for (const [relativePath, templatePath] of DWEB_DISABLED_TEMPLATE_TARGETS) {
    try {
      const shipped = readFileSync(join(artifactRoot, relativePath));
      const template = readFileSync(templatePath);
      if (!shipped.equals(template)) failures.push(`${relativePath} is NOT the committed disabled template`);
    } catch {
      failures.push(`${relativePath} missing from artifact`);
    }
  }
  for (const relativePath of DWEB_ABSENT_TARGETS) {
    if (existsSync(join(artifactRoot, relativePath))) {
      failures.push(`${relativePath} present in dweb-disabled artifact`);
    }
  }
  return failures;
};

let stagedImportRoot = '';
plugin({
  name: 'peerd-staged-artifact-imports',
  setup(build) {
    build.onResolve({ filter: /^\// }, (args) => {
      const candidate = join(stagedImportRoot, args.path.slice(1));
      return stagedImportRoot && existsSync(candidate) ? { path: candidate } : undefined;
    });
  },
});

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]{5,}/g;
const identifiersOf = (text: string): Set<string> => new Set(text.match(IDENT_RE) ?? []);

/** Identifiers that occur in dweb source and NOWHERE else in
 *  extension/ — if any shows up in a store artifact, dweb content
 *  leaked. Derived fresh per run so the set tracks the code. */
const dwebOnlyIdentifiers = (extensionDir: string): Set<string> => {
  const dwebDir = join(extensionDir, 'peerd-distributed');
  const fed = new Set<string>();
  for (const f of walk(dwebDir)) {
    if (/\.(js|mjs|html)$/.test(f)) for (const id of identifiersOf(readFileSync(f, 'utf8'))) fed.add(id);
  }
  for (const f of walk(extensionDir)) {
    if (f.startsWith(dwebDir)) continue;
    if (!/\.(js|mjs|html|json|css|txt)$/.test(f)) continue;
    for (const id of identifiersOf(readFileSync(f, 'utf8'))) fed.delete(id);
  }
  return fed;
};

export const verifyStoreArtifact = async (
  artifactPath: string,
  { sourceRoot = REPO_ROOT }: { sourceRoot?: string } = {},
): Promise<void> => {
  const failures: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), 'peerd-verify-'));
  try {
    execFileSync('unzip', ['-q', artifactPath, '-d', tmp]);
    const files = walk(tmp);

    // a. structural: the module directory must not exist
    for (const f of files) {
      if (relative(tmp, f).includes('peerd-distributed')) {
        failures.push(`dweb module path present in artifact: ${relative(tmp, f)}`);
      }
    }

    // b. every dweb-disabled runtime entry is a committed reviewed template,
    // byte for byte. Route keys remain present so stale callers fail typed.
    failures.push(...dwebDisabledTemplateFailures(tmp));

    // c. no file may contain the module's name at all
    for (const f of files) {
      const body = readFileSync(f);
      if (body.includes('peerd-distributed')) {
        failures.push(`string "peerd-distributed" found in ${relative(tmp, f)}`);
      }
    }

    // d. manifest sanity for the store channel
    const manifest = JSON.parse(readFileSync(join(tmp, 'manifest.json'), 'utf8'));
    if (manifest.name !== 'peerd') failures.push(`store manifest name is "${manifest.name}", expected "peerd"`);
    if ('update_url' in manifest) failures.push('store manifest must not carry update_url');
    if ('key' in manifest) failures.push('store manifest must not carry key');

    // d2. Remote JavaScript imports are preview-only. Check the bytes that
    // ship, not only the generator tests, and require both execution hosts to
    // consume the package policy at their resolver boundary.
    try {
      const channelConfig = readFileSync(join(tmp, 'shared', 'channel-config.js'), 'utf8');
      if (!channelConfig.includes('export const REMOTE_MODULE_IMPORTS_ENABLED = false')) {
        failures.push('shared/channel-config.js does not disable remote module imports');
      }
      for (const host of [
        'offscreen/job-runner.js',
        'engine-tabs/notebook-tab/notebook-tab.js',
      ]) {
        const source = readFileSync(join(tmp, host), 'utf8');
        const compact = source.replace(/\s+/g, '');
        if (!compact.includes('remoteModulesEnabled:REMOTE_MODULE_IMPORTS_ENABLED')) {
          failures.push(`${host} does not pass the remote module import policy into the resolver`);
        }
        const hasFetchGate = host === 'offscreen/job-runner.js'
          ? compact.includes('REMOTE_MODULE_IMPORTS_ENABLED&&!a2a&&profile.egress')
          : compact.includes('...(REMOTE_MODULE_IMPORTS_ENABLED?{');
        if (!hasFetchGate) {
          failures.push(`${host} does not gate remote module fetch injection on package policy`);
        }
      }

      stagedImportRoot = tmp;
      const stagedConfig = await import(pathToFileURL(join(tmp, 'shared', 'channel-config.js')).href);
      const stagedResolver = await import(pathToFileURL(join(tmp, 'peerd-engine', 'module-resolver.js')).href);
      let moduleRequests = 0;
      const resolverDeps = {
        remoteModulesEnabled: stagedConfig.REMOTE_MODULE_IMPORTS_ENABLED,
        fetchRemote: async () => {
          moduleRequests += 1;
          return 'globalThis.__storeRemoteModuleCanary = true; export const value = 1;';
        },
        readFile: async (path: string) => {
          if (path === 'nested.js') return "import/* split */'https://reachable.test/nested.js';";
          throw new Error(`missing verifier fixture: ${path}`);
        },
        makeBlobUrl: (source: string) => `blob:store-verifier/${source.length}`,
      };
      const remoteCases: Array<[string, string, () => Promise<unknown>]> = [
        ['static', 'remote_module_imports_unavailable', () => stagedResolver.buildEntry(
          "import 'https://reachable.test/static.js';", 'entry.js', resolverDeps)],
        ['nested', 'remote_module_imports_unavailable', () => stagedResolver.buildEntry(
          "import './nested.js';", 'entry.js', resolverDeps)],
        ['literal dynamic', 'unsupported_native_module_import', () => stagedResolver.buildEntry(
          "await import('https://reachable.test/dynamic.js');", 'entry.js', resolverDeps)],
        ['computed dynamic', 'unsupported_native_module_import', () => stagedResolver.buildEntry(
          "const url = 'https://reachable.test/computed.js'; await import(url);",
          'entry.js', resolverDeps)],
        ['postfix dynamic', 'unsupported_native_module_import', () => stagedResolver.buildEntry(
          "let n = 1; const url = 'https://reachable.test/postfix.js'; n++ / import(url) / 2;",
          'entry.js', resolverDeps)],
        ['ASI dynamic', 'unsupported_native_module_import', () => stagedResolver.buildEntry(
          "const url = 'https://reachable.test/asi.js'; { import(url)\n{} }",
          'entry.js', resolverDeps)],
        ['escaped static', 'remote_module_imports_unavailable', () => stagedResolver.buildEntry(
          "import 'https:\\x2f\\x2freachable.test/escaped.js';", 'entry.js', resolverDeps)],
        ['normalized static', 'remote_module_imports_unavailable', () => stagedResolver.buildEntry(
          "import ' https:\\\\reachable.test/normalized.js';", 'entry.js', resolverDeps)],
        ['direct module build', 'remote_module_imports_unavailable', () => stagedResolver.buildModule(
          'https://reachable.test/compose.js', resolverDeps)],
      ];
      for (const [label, expectedCode, run] of remoteCases) {
        try {
          await run();
          failures.push(`staged resolver allowed the ${label} remote module case`);
        } catch (error) {
          if ((error as { code?: string })?.code !== expectedCode) {
            failures.push(`staged resolver returned the wrong ${label} refusal`);
          }
        }
      }
      if (moduleRequests !== 0) {
        failures.push(`staged resolver requested ${moduleRequests} prohibited remote module(s)`);
      }
    } catch (error) {
      failures.push(`remote module import policy verification could not run: ${
        (error as { message?: string })?.message ?? String(error)}`);
    }

    // d3. the store package must not ship the permissions held out of initial
    // submission (debugger / the CDP path — STORE_STRIPPED_PERMISSIONS). The
    // generator strips them (gen-manifest.ts) and store-posture.test.ts pins
    // it there; this is the ARTIFACT-level backstop, so a packaging-pipeline
    // regression can't slip the highest-risk permission past review.
    const perms: string[] = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    for (const p of STORE_STRIPPED_PERMISSIONS) {
      if (perms.includes(p)) {
        failures.push(`store manifest must not ship "${p}" — held out until post-approval re-add`);
      }
    }

    // e. identifier sweep against dweb-unique tokens
    const fedIds = dwebOnlyIdentifiers(join(sourceRoot, 'extension'));
    for (const f of files) {
      if (!/\.(js|mjs|html|json)$/.test(f)) continue;
      const ids = identifiersOf(readFileSync(f, 'utf8'));
      for (const id of ids) {
        if (fedIds.has(id)) failures.push(`dweb-only identifier "${id}" found in ${relative(tmp, f)}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`STORE ARTIFACT VERIFICATION FAILED — ${artifactPath}:`);
    for (const f of failures.slice(0, 50)) console.error('  ' + f);
    if (failures.length > 50) console.error(`  …and ${failures.length - 50} more`);
    throw new Error(`store artifact verification failed (${failures.length} findings)`);
  }
  console.log(`verified ${relative(REPO_ROOT, artifactPath)}: store posture passed`);
};

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) throw new Error('usage: bun packaging/verify-store-artifact.ts <artifact.zip>');
  await verifyStoreArtifact(target);
}
