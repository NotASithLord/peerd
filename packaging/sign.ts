// Preview-artifact signing (spec §7). Store artifacts are NEVER signed
// here — Chrome Web Store and AMO sign on their end after review. Only
// the two preview artifacts need signatures so self-installed extensions
// don't degrade into "developer mode" scare-territory:
//
//   chrome  → CRX3 .crx signed with the developer key (key.pem). The
//             manifest's "key" field (manifests/preview-chrome-key.pub)
//             is the matching PUBLIC key — it locks the extension ID
//             (manifests/preview-chrome-extension-id.txt) so installs
//             survive releases and the update feed can address them.
//   firefox → AMO "unlisted" signing via web-ext sign. AMO validates and
//             signs the .xpi; the signed file replaces the unsigned one.
//
// Credentials are environment-only (CI secrets; never in the repo):
//   PEERD_CRX_KEY    path to key.pem        (default: <repo>/key.pem)
//   AMO_JWT_ISSUER / AMO_JWT_SECRET         (addons.mozilla.org API)
//
// Missing credentials SKIP signing with a loud warning instead of
// failing — local matrix packages must work on a fresh clone. CI's release
// job treats unsigned preview artifacts as an error (it greps for the
// "UNSIGNED" marker lines this module prints).

import { existsSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, ARTIFACTS_DIR, type Browser } from './lib.ts';

const keyPath = () => process.env.PEERD_CRX_KEY ?? join(REPO_ROOT, 'key.pem');

const signChromeCrx = async (zipArtifact: string): Promise<void> => {
  if (!existsSync(keyPath())) {
    console.warn(`WARN sign: UNSIGNED chrome preview — ${keyPath()} not found; .crx not produced.`);
    return;
  }
  const crxPath = zipArtifact.replace(/\.zip$/, '.crx');
  // crx3 reads the zip stream and emits the signed CRX3 container.
  const { default: crx3 } = await import('crx3');
  const { createReadStream } = await import('node:fs');
  await crx3(createReadStream(zipArtifact), { keyPath: keyPath(), crxPath });
  console.log(`signed ${relative(REPO_ROOT, crxPath)}`);
};

const signFirefoxXpi = async (xpiArtifact: string, stagingDir: string): Promise<void> => {
  const issuer = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;
  if (!issuer || !secret) {
    console.warn('WARN sign: UNSIGNED firefox preview — AMO_JWT_ISSUER/AMO_JWT_SECRET not set.');
    return;
  }
  const amoOut = join(ARTIFACTS_DIR, 'amo');
  rmSync(amoOut, { recursive: true, force: true });
  // web-ext signs from the source dir (the staged preview-firefox tree),
  // polls AMO until validation+signing completes, downloads the signed
  // xpi into amoOut. Channel "unlisted" = self-distribution (spec §7).
  // why the local binary: `npx --yes web-ext` fetched an UNPINNED latest
  // at release time — a supply-chain risk on the release-critical path.
  // web-ext is a pinned devDependency now; bun install provides the bin.
  const webExt = join(REPO_ROOT, 'node_modules', '.bin', 'web-ext');
  if (!existsSync(webExt)) throw new Error('node_modules/.bin/web-ext missing — run `bun install`');
  execFileSync(webExt, [
    'sign',
    `--source-dir=${stagingDir}`,
    `--artifacts-dir=${amoOut}`,
    '--channel=unlisted',
    `--api-key=${issuer}`,
    `--api-secret=${secret}`,
  ], { stdio: 'inherit', timeout: 15 * 60 * 1000 });

  const signed = readdirSync(amoOut).find((f) => f.endsWith('.xpi'));
  if (!signed) throw new Error('web-ext sign reported success but produced no .xpi');
  renameSync(join(amoOut, signed), xpiArtifact);
  console.log(`signed ${relative(REPO_ROOT, xpiArtifact)} (AMO)`);
};

export const signPreviewArtifact = async (
  { browser, artifact }: { browser: Browser; artifact: string; version: string },
): Promise<void> => {
  if (browser === 'chrome') {
    await signChromeCrx(artifact);
  } else {
    const stagingDir = join(ARTIFACTS_DIR, 'staging', 'preview-firefox');
    await signFirefoxXpi(artifact, stagingDir);
  }
};
