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

import { readFileSync, rmSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, EXTENSION_DIR } from './lib.ts';
import { STORE_STRIPPED_PERMISSIONS } from './gen-manifest.ts';

const DWEB_DIR = join(EXTENSION_DIR, 'peerd-distributed');
const STORE_LOADER_TEMPLATE = join(REPO_ROOT, 'packaging', 'templates', 'dweb-loader.store.js');

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

    // d. manifest sanity for the store channel
    const manifest = JSON.parse(readFileSync(join(tmp, 'manifest.json'), 'utf8'));
    if (manifest.name !== 'peerd') failures.push(`store manifest name is "${manifest.name}", expected "peerd"`);
    if ('update_url' in manifest) failures.push('store manifest must not carry update_url');
    if ('key' in manifest) failures.push('store manifest must not carry key');

    // d2. the store package must not ship the permissions held out of initial
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
    throw new Error(`store artifact contains dweb traces (${failures.length} findings)`);
  }
  console.log(`verified ${relative(REPO_ROOT, artifactPath)} — zero dweb traces`);
};

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) throw new Error('usage: bun packaging/verify-store-artifact.ts <artifact.zip>');
  await verifyStoreArtifact(target);
}
