// Update-feed freshness check — compares the LIVE feeds at
// peerd.ai/updates/ against the latest GitHub Release tag. A stale feed
// silently strands every preview install, so this is the check to run
// (from anywhere: laptop, cron, a CF worker) whenever the Actions
// monitor (update-feed-monitor.yml) isn't running.
//
//   bun run feeds:check
//
// Exit codes: 0 = in sync (or genuinely no releases yet),
//             1 = stale/unreachable feeds, or gh itself failed (we can't
//                 know the latest release, so we refuse to report "ok").

import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './lib.ts';

const CHROME_FEED = 'https://peerd.ai/updates/chrome-preview.xml';
const FIREFOX_FEED = 'https://peerd.ai/updates/firefox-preview.json';

/** gh failed for a reason OTHER than "no releases exist" — the caller
 *  must not treat this as the benign no-releases case. */
export class GhQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhQueryError';
  }
}

export const latestReleaseVersion = (): string | null => {
  let tag: string;
  try {
    tag = execFileSync('gh', [
      'api', 'repos/{owner}/{repo}/releases/latest', '--jq', '.tag_name',
    ], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e: any) {
    // why distinguish: only a real 404 on releases/latest means "no
    // releases yet". Every OTHER gh failure (not installed, logged out,
    // no network) used to also return null, and main() would print
    // "nothing to monitor" and exit 0 — a false PASS from the one check
    // whose job is catching stranded preview installs.
    const stderr = String(e?.stderr ?? '');
    if (/HTTP 404/i.test(stderr)) return null; // genuinely no releases yet
    if (e?.code === 'ENOENT') throw new GhQueryError('gh CLI not found on PATH');
    throw new GhQueryError(stderr.trim() || e?.message || String(e));
  }
  return tag.replace(/^v/, '');
};

export const fetchFeedVersions = async (): Promise<{ chrome: string | null; firefox: string | null }> => {
  let chrome: string | null = null;
  let firefox: string | null = null;
  try {
    const xml = await (await fetch(CHROME_FEED)).text();
    // why anchor to <updatecheck>: a bare /version="([0-9.]+)"/ matches the
    // FIRST version= in the doc — which is `<?xml version="1.0"?>`, not the
    // release version. That false "1.0" can never equal an X.Y.Z tag, so the
    // monitor would report "stale" forever and the release poll would never
    // pass. Match the version attr ON the updatecheck element specifically.
    chrome = xml.match(/<updatecheck\b[^>]*\bversion="([0-9.]+)"/)?.[1] ?? null;
  } catch { /* unreachable → null */ }
  try {
    const json: any = await (await fetch(FIREFOX_FEED)).json();
    const addon: any = Object.values(json.addons ?? {})[0];
    firefox = addon?.updates?.at(-1)?.version ?? null;
  } catch { /* unreachable → null */ }
  return { chrome, firefox };
};

const main = async () => {
  let expected: string | null;
  try {
    expected = latestReleaseVersion();
  } catch (e) {
    console.error(`WARN feeds:check — could not query GitHub releases: ${(e as Error).message}`);
    console.error('cannot verify feed freshness without knowing the latest release — failing, not skipping.');
    process.exit(1);
  }
  if (!expected) {
    console.log('no GitHub releases yet — nothing to monitor');
    return;
  }
  const live = await fetchFeedVersions();
  console.log(`latest release: ${expected}`);
  console.log(`chrome feed:    ${live.chrome ?? 'UNREACHABLE'}  (${CHROME_FEED})`);
  console.log(`firefox feed:   ${live.firefox ?? 'UNREACHABLE'}  (${FIREFOX_FEED})`);
  const stale = live.chrome !== expected || live.firefox !== expected;
  if (stale) {
    console.error(
      '\nFEEDS OUT OF SYNC — preview installs are not seeing the latest '
      + 'release. Re-run the site deploy (scripts/deploy-site.sh) or check '
      + 'peerd.ai hosting.',
    );
    process.exit(1);
  }
  console.log('feeds in sync');
};

if (import.meta.main) await main();
