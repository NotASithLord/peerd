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
//   b. shared/dweb-loader.js is byte-identical to the committed
//      store template (stub-only, no module path string)
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
import { REPO_ROOT, EXTENSION_DIR } from './lib.ts';
import { STORE_STRIPPED_PERMISSIONS } from './gen-manifest.ts';

const DWEB_DIR = join(EXTENSION_DIR, 'peerd-distributed');
const STORE_LOADER_TEMPLATE = join(REPO_ROOT, 'packaging', 'templates', 'dweb-loader.store.js');

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
const dwebOnlyIdentifiers = (): Set<string> => {
  const fed = new Set<string>();
  for (const f of walk(DWEB_DIR)) {
    if (/\.(js|mjs|html)$/.test(f)) for (const id of identifiersOf(readFileSync(f, 'utf8'))) fed.add(id);
  }
  for (const f of walk(EXTENSION_DIR)) {
    if (f.startsWith(DWEB_DIR)) continue;
    if (!/\.(js|mjs|html|json|css|txt)$/.test(f)) continue;
    for (const id of identifiersOf(readFileSync(f, 'utf8'))) fed.delete(id);
  }
  return fed;
};

export const verifyStoreArtifact = async (artifactPath: string): Promise<void> => {
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

    // b. the loader must be the stub-only store template, byte for byte
    const loaderPath = join(tmp, 'shared', 'dweb-loader.js');
    try {
      const shipped = readFileSync(loaderPath, 'utf8');
      const template = readFileSync(STORE_LOADER_TEMPLATE, 'utf8');
      if (shipped !== template) failures.push('shared/dweb-loader.js is NOT the store template');
    } catch {
      failures.push('shared/dweb-loader.js missing from artifact');
    }

    // c. no file may contain the module's name at all
    for (const f of files) {
      const body = readFileSync(f);
      if (body.includes('peerd-distributed')) {
        failures.push(`string "peerd-distributed" found in ${relative(tmp, f)}`);
      }
    }

    // c2. Contributor upload remains preview-only. The store may keep the
    // local aggregate/consent feature, but it must ship neither the dormant
    // uploader island nor any route/path/config token that could activate it.
    if (existsSync(join(tmp, 'peerd-egress', 'contributor-upload'))) {
      failures.push('preview-only peerd-egress/contributor-upload/ is present in store artifact');
    }
    const uploadOnlyTokens = [
      '/v1/contributions',
      'CONTRIBUTION_UPLOAD_CONFIG',
      'peerd-egress/contributor-upload',
      'contribution-upload-attempt',
      'contributor_upload.sealed',
    ];
    for (const f of files) {
      const body = readFileSync(f);
      for (const token of uploadOnlyTokens) {
        if (body.includes(token)) {
          failures.push(`preview-only contribution token "${token}" found in ${relative(tmp, f)}`);
        }
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
        if (!source.includes('remoteModulesEnabled: REMOTE_MODULE_IMPORTS_ENABLED')) {
          failures.push(`${host} does not pass the remote module import policy into the resolver`);
        }
        const hasFetchGate = host === 'offscreen/job-runner.js'
          ? source.includes('REMOTE_MODULE_IMPORTS_ENABLED && !a2a && profile.egress')
          : source.includes('...(REMOTE_MODULE_IMPORTS_ENABLED ? {');
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
    const fedIds = dwebOnlyIdentifiers();
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
