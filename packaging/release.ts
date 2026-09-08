// Local release pipeline — mirrors the release job in
// .github/workflows/package-and-release.yml so releases don't depend on
// GitHub-hosted runners (Actions billing outages, offline work).
// GitHub RELEASES are plain API calls through `gh` and keep working even
// when Actions can't start a single runner.
//
//   bun run release              release package.json's version
//   bun run release -- --dry-run package + sign-if-possible + feeds, then
//                                stop: no tag, no push, no release
//
// Steps (release mode):
//   1. preconditions — on main, clean tree, synced with origin, tag free
//   2. preflight (drift + lint + boundary + tests)
//   3. packaged Chrome + Firefox cold-start release lane (secretless)
//   4. signing credentials present (key.pem + AMO_JWT_*); a release
//      never ships unsigned preview artifacts (anti-rec §15)
//   5. package:all WITH signing; store artifacts verify themselves
//   6. generate the update-feed release assets
//   7. tag vX.Y.Z; push main + tag
//   8. gh release create peerd-preview-vX.Y.Z with .crx/.xpi/feeds
//   9. dispatch peerd-site, whose workflow downloads and deploys the feeds
//
// Keep in sync with the workflow's release job — when Actions billing is
// healthy, a tag push runs the same flow in CI; this script exists so
// the tag can also be cut entirely from a dev machine.
//
// One DELIBERATE divergence: CI splits packaging in two so that provenance
// attestation runs before the AMO upload — the one irreversible act in a
// release (web-ext burns the version on addons.mozilla.org; a later failure
// cannot take it back). There is no attestation on this path, so there is
// nothing here that has to precede AMO, and package:all stays one call.
// If a future step is added here that CAN fail, put it before step 4.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, ARTIFACTS_DIR, readVersion, parseArgs } from './lib.ts';
import { buildReleaseNotes } from './release-notes.ts';

const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit' });
const capture = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const step = (label: string) => console.log(`\n━━ release: ${label} ━━`);
const die = (msg: string): never => {
  console.error(`\nrelease ABORTED: ${msg}`);
  process.exit(1);
};

// Notes come from CHANGELOG.md (packaging/release-notes.ts). Throws when the
// version has no changelog section, which aborts the release before the tag
// step: a release is never cut with boilerplate notes.
const releaseNotes = (version: string) =>
  buildReleaseNotes(readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8'), version);

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const version = readVersion();
  const tag = `v${version}`;

  step(`preconditions for ${tag}${dryRun ? ' (dry run)' : ''}`);
  // Notes must exist BEFORE anything irreversible: a missing changelog
  // section aborts here, not after the tag is pushed.
  try { releaseNotes(version); } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  if (capture('git', ['branch', '--show-current']) !== 'main') die('not on main');
  // A dry run is what you run BEFORE committing — allow a dirty tree
  // there (with a note); a real release must start clean.
  const treeDirty = capture('git', ['status', '--porcelain']) !== '';
  if (treeDirty && !dryRun) die('working tree not clean — commit or stash first');
  if (treeDirty) console.warn('note: dirty working tree (fine for a dry run)');
  run('git', ['fetch', 'origin', '--tags']);
  const [behind, ahead] = capture('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD']).split('\t');
  if (behind !== '0') die(`main is ${behind} commit(s) behind origin — pull first`);
  if (ahead !== '0') console.warn(`note: main is ${ahead} commit(s) ahead of origin; they will be pushed with the release`);
  // Re-entry after a partial failure: a tag that already points at HEAD
  // means a prior run got past tagging — continue (the post-tag steps are
  // idempotent) rather than dead-ending. A tag on a DIFFERENT commit is a
  // real conflict (version not bumped, or stale tag) — stop.
  let resuming = false;
  if (!dryRun) {
    const localTag = capture('git', ['tag', '-l', tag]);
    if (localTag !== '') {
      const tagSha = capture('git', ['rev-list', '-n', '1', tag]);
      const headSha = capture('git', ['rev-parse', 'HEAD']);
      if (tagSha !== headSha) die(`tag ${tag} exists on a different commit — bump the version or delete the stale tag`);
      resuming = true;
      console.warn(`note: ${tag} already exists at HEAD — resuming; post-tag steps are idempotent`);
    }
  }

  const repo = capture('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const isPrivate = capture('gh', ['repo', 'view', '--json', 'isPrivate', '--jq', '.isPrivate']) === 'true';
  if (isPrivate) {
    console.warn(
      '\n!! REPO IS PRIVATE: GitHub Release asset URLs require auth on private\n'
      + '!! repos, so the auto-update feeds and the README install links will\n'
      + '!! NOT work for users until the repo is public (or assets are hosted\n'
      + '!! on peerd.ai). Fine for a test release; not fine for distribution.',
    );
  }

  step('preflight');
  run('bun', ['packaging/preflight.ts']);

  // Installed-artifact acceptance is part of the release transaction, not a
  // CI-only courtesy. Each lane packages its exact target and requires the
  // live kernel assembly ledger to be complete before human credentials or
  // any irreversible release action is reached.
  step('installed Chrome Store first-install/controller/recycle');
  run('bun', ['scripts/cdp/run-passkey-signup.mjs']);
  step('installed Chrome Store document extraction/paging isolation');
  run('bun', ['scripts/cdp/read-doc-store-lane.mjs']);
  step('installed Chrome Store site-client/capture fallback');
  run('bun', ['run', 'test:e2e:site-client-store:staged']);
  step('installed Chrome Preview dweb/SW/renderer continuity');
  run('bun', ['scripts/cdp/feature-lease-dweb-lifecycle.mjs']);
  step('installed Firefox Store first-install/controller/Git/discard');
  run('bun', ['scripts/firefox/production-cutover-lane.mjs']);

  // This runs before any signing credential is read or AMO version is burned.
  // It measures both unsigned channel artifacts with pinned real browsers and
  // fails on graph growth, missing raw phases, or any timed-out launch/wake.
  step('packaged cold start (Chrome + Firefox)');
  const coldLane = dryRun ? 'local' : 'release';
  run('bun', ['scripts/bench/cold-service-worker.mjs', `--lane=${coldLane}`]);

  step('signing credentials');
  const keyPath = process.env.PEERD_CRX_KEY ?? join(REPO_ROOT, 'key.pem');
  const missing: string[] = [];
  if (!existsSync(keyPath)) missing.push(`${keyPath} (CRX signing key)`);
  if (!process.env.AMO_JWT_ISSUER) missing.push('AMO_JWT_ISSUER env');
  if (!process.env.AMO_JWT_SECRET) missing.push('AMO_JWT_SECRET env');
  if (missing.length > 0 && !dryRun) {
    die(`releases never ship unsigned preview artifacts; missing:\n  - ${missing.join('\n  - ')}`);
  }
  if (missing.length > 0) console.warn(`dry run: continuing UNSIGNED (missing: ${missing.join(', ')})`);
  else console.log('signing credentials present');

  step('package all four artifacts');
  run('bun', ['packaging/package.ts', '--all']);
  // Positive signing proof, matching the CI release job's gate: the .crx must
  // carry the CRX3 magic and the .xpi must contain AMO's signature block.
  // File-exists alone let a run that died before sign.ts pass this step.
  if (!dryRun) {
    const crx = join(ARTIFACTS_DIR, 'peerd-preview-chrome.crx');
    const xpi = join(ARTIFACTS_DIR, 'peerd-preview-firefox.xpi');
    if (!existsSync(crx)) die('peerd-preview-chrome.crx was not produced — signing failed?');
    const magic = readFileSync(crx).subarray(0, 4).toString('latin1');
    if (magic !== 'Cr24') die('peerd-preview-chrome.crx lacks the Cr24 CRX3 magic — not a signed CRX');
    if (!existsSync(xpi)) die('peerd-preview-firefox.xpi was not produced — AMO signing failed?');
    try {
      execFileSync('unzip', ['-l', xpi, 'META-INF/mozilla.rsa'], { cwd: REPO_ROOT, stdio: 'ignore' });
    } catch {
      die('peerd-preview-firefox.xpi has no META-INF/mozilla.rsa — AMO signing did not run');
    }
    console.log('signing proof OK (CRX3 magic + AMO signature block)');
  }

  step('regenerate update feeds');
  run('bun', ['packaging/gen-update-feeds.ts', `--version=${version}`, `--repo=${repo}`]);

  if (dryRun) {
    step('dry run complete');
    console.log(
      'Built + verified everything. A real release would now:\n'
      + `  tag ${tag}, push main+tag,\n`
      + `  gh release view-or-create ${tag} (title peerd-preview-${tag}),\n`
      + '  attach the feeds, and dispatch the site deployment.',
    );
    return;
  }

  step('tag + push');
  if (!resuming) {
    run('git', ['tag', tag]);
    // --atomic: main + tag push together or not at all, so a rejected push
    // can't leave the tag on origin without its commit (or vice versa).
    // --no-verify: preflight already ran above (step 2); skip the pre-push
    // hook so it doesn't re-run twice more here.
    run('git', ['push', '--atomic', '--no-verify', 'origin', 'main', `refs/tags/${tag}`]);
    console.log(
      'note: if GitHub Actions billing has recovered, the tag also triggers\n'
      + 'the CI release job. Both it and this script create the release\n'
      + 'idempotently (view-or-create + upload --clobber), so whichever runs\n'
      + 'second is a harmless no-op rather than a duplicate-release error.',
    );
  } else {
    console.log('resuming: tag + push already done, skipping');
  }

  step('create GitHub release (idempotent)');
  // Digest manifest, matching the CI release job: sha256sum-format lines so
  // `sha256sum -c` / `shasum -a 256 -c` verify downloads directly. Store zips
  // are included because their store upload is manual — the digest is how a
  // human confirms the submitted file is the one that was verified.
  // Split exactly as the CI job does: SHA256SUMS covers the PUBLISHED assets, so
  // `sha256sum -c SHA256SUMS` over a full download succeeds. The store packages are
  // uploaded by hand and get their own file — listing them in the main manifest
  // would make the canonical verification command fail on an authentic release.
  const digest = (f: string) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${basename(f)}`;
  const writeSums = (name: string, files: string[]) => {
    const present = files.filter((f) => existsSync(f));
    const p = join(ARTIFACTS_DIR, name);
    writeFileSync(p, present.map(digest).join('\n') + '\n');
    console.log(`wrote ${relative(REPO_ROOT, p)} (${present.length} files)`);
    return p;
  };
  const sumsPath = writeSums('SHA256SUMS', [
    join(ARTIFACTS_DIR, 'peerd-preview-chrome.crx'),
    join(ARTIFACTS_DIR, 'peerd-preview-firefox.xpi'),
    join(ARTIFACTS_DIR, 'chrome-preview.xml'),
    join(ARTIFACTS_DIR, 'firefox-preview.json'),
  ]);
  const storeSumsPath = writeSums('SHA256SUMS.store', [
    join(ARTIFACTS_DIR, 'peerd-store-chrome.zip'),
    join(ARTIFACTS_DIR, 'peerd-store-firefox.xpi'),
  ]);
  const assets = [
    join(ARTIFACTS_DIR, 'peerd-preview-chrome.crx'),
    join(ARTIFACTS_DIR, 'peerd-preview-firefox.xpi'),
    sumsPath,
    storeSumsPath,
    join(ARTIFACTS_DIR, 'chrome-preview.xml'),
    join(ARTIFACTS_DIR, 'firefox-preview.json'),
  ];
  const releaseExists = (() => {
    try { execFileSync('gh', ['release', 'view', tag], { cwd: REPO_ROOT, stdio: 'ignore' }); return true; }
    catch { return false; }
  })();
  if (releaseExists) {
    console.log(`release ${tag} already exists — re-uploading assets (--clobber)`);
    run('gh', ['release', 'upload', tag, '--clobber', ...assets]);
  } else {
    run('gh', [
      'release', 'create', tag,
      '--title', `peerd-preview-${tag}`,
      '--notes', releaseNotes(version),
      ...assets,
    ]);
  }

  step('trigger peerd.ai feed deployment');
  try {
    run('gh', [
      'api', '--method', 'POST', 'repos/NotASithLord/peerd-site/dispatches',
      '-f', 'event_type=peerd-release', '-F', `client_payload[tag]=${tag}`,
    ]);
    console.log('peerd-site feed sync dispatched');
  } catch {
    console.warn(
      'could not dispatch peerd-site; its scheduled feed sync remains the fallback.\n'
      + 'Confirm later with `bun run feeds:check`.',
    );
  }

  step(`released peerd-preview-${tag}`);
  console.log(`store artifacts ready for manual submission:\n  ${join(ARTIFACTS_DIR, 'peerd-store-chrome.zip')}\n  ${join(ARTIFACTS_DIR, 'peerd-store-firefox.xpi')}`);
};

try {
  await main();
} catch (e) {
  // A step threw (its own stderr already printed above via inherited stdio).
  // Add the recovery hint instead of dumping a raw stack: every post-tag
  // step is idempotent, so re-running `bun run release` resumes from where
  // it stopped (a tag already at HEAD is detected and the done steps skip).
  const msg = e instanceof Error ? e.message : String(e);
  console.error(
    `\nrelease step failed: ${msg.split('\n')[0]}\n`
    + 'Nothing here is half-applied destructively — fix the cause (gh auth, '
    + 'network, signing creds) and re-run `bun run release`; it resumes from '
    + 'the failed step. `gh release view v<version>` shows current state.',
  );
  process.exit(1);
}
