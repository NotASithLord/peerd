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
//   3. signing credentials present (key.pem + AMO_JWT_*) — a release
//      never ships unsigned preview artifacts (anti-rec §15)
//   4. package:all WITH signing; store artifacts verify themselves
//   5. regenerate update-feeds/ for this version; commit if changed
//   6. tag vX.Y.Z; push main + tag
//   7. gh release create peerd-preview-vX.Y.Z with .crx/.xpi/feeds
//   8. web demo deploy (web/deploy.sh → demo.peerd.ai) when CLOUDFLARE_*
//      env is set. NOTE: peerd.ai itself + the update feeds deploy MANUALLY
//      from the separate peerd-site repo (copy update-feeds/ there, run its
//      deploy.sh) — the old in-repo scripts/deploy-site.sh is GONE; this
//      script prints the reminder instead of calling a deleted path.
//
// Keep in sync with the workflow's release job — when Actions billing is
// healthy, a tag push runs the same flow in CI; this script exists so
// the tag can also be cut entirely from a dev machine.

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
  if (!dryRun && !existsSync(join(ARTIFACTS_DIR, 'peerd-preview-chrome.crx'))) {
    die('peerd-preview-chrome.crx was not produced — signing failed?');
  }

  step('regenerate update feeds');
  // A dry run must be byte-for-byte side-effect-free, but gen-update-feeds
  // unconditionally overwrites the feed files. Snapshot their EXACT current
  // bytes first (works for tracked-dirty AND untracked files, which `git
  // checkout --` would miss/destroy) and restore them after.
  const feedFiles = ['update-feeds/chrome-preview.xml', 'update-feeds/firefox-preview.json']
    .map((p) => join(REPO_ROOT, p));
  const feedSnapshot: Record<string, Buffer | null> = {};
  if (dryRun) {
    for (const f of feedFiles) feedSnapshot[f] = existsSync(f) ? readFileSync(f) : null;
  }
  run('bun', ['packaging/gen-update-feeds.ts', `--version=${version}`, `--repo=${repo}`]);

  if (dryRun) {
    // Restore the pre-run bytes exactly (or delete a file that didn't exist
    // before). The tree is now identical to how the dry run found it.
    for (const f of feedFiles) {
      const before = feedSnapshot[f];
      if (before === null) rmSync(f, { force: true });
      else writeFileSync(f, before);
    }
    step('dry run complete');
    console.log(
      'Built + verified everything; update-feeds/ restored to its pre-run\n'
      + 'state. A real release would now:\n'
      + `  commit update-feeds/, tag ${tag}, push main+tag,\n`
      + `  gh release view-or-create ${tag} (title peerd-preview-${tag}),\n`
      + '  deploy demo.peerd.ai (web/deploy.sh), and print the peerd-site\n'
      + '  feed-deploy reminder.',
    );
    return;
  }

  step('commit feeds + tag + push');
  if (!resuming) {
    run('git', ['add', 'update-feeds/']);
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: REPO_ROOT });
      console.log('feeds unchanged');
    } catch {
      run('git', ['commit', '-m', `chore(release): update feeds for ${tag}`]);
    }
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
  const assets = [
    join(ARTIFACTS_DIR, 'peerd-preview-chrome.crx'),
    join(ARTIFACTS_DIR, 'peerd-preview-firefox.xpi'),
    join(REPO_ROOT, 'update-feeds', 'chrome-preview.xml'),
    join(REPO_ROOT, 'update-feeds', 'firefox-preview.json'),
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

  step('deploy demo.peerd.ai (web target, fresh from this release)');
  // The release is ALREADY COMPLETE at this point (tag pushed, GitHub release
  // created) — everything below is post-release housekeeping and must warn,
  // never abort. why web/deploy.sh here: the demo tracks main via CI, but
  // off-CI releases (Actions billing outages — the reason this script exists)
  // would otherwise leave demo.peerd.ai a release behind.
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    try { run('bash', [join(REPO_ROOT, 'web', 'deploy.sh')]); }
    catch { console.warn('web demo deploy FAILED (release itself succeeded) — re-run web/deploy.sh when convenient.'); }
  } else {
    console.warn(
      'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — demo.peerd.ai\n'
      + 'NOT deployed (CI\'s deploy-web job covers it on the next main push).',
    );
  }

  step(`released peerd-preview-${tag}`);
  console.log(`store artifacts ready for manual submission:\n  ${join(ARTIFACTS_DIR, 'peerd-store-chrome.zip')}\n  ${join(ARTIFACTS_DIR, 'peerd-store-firefox.xpi')}`);
  console.log(
    'REMINDER: peerd.ai + the update feeds deploy MANUALLY from the peerd-site\n'
    + 'repo — copy update-feeds/ there, run its deploy.sh, then `bun run\n'
    + 'feeds:check` to confirm the live feeds advertise the new version.',
  );
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
