// Update-feed generator: writes the two release assets that preview
// installs poll for auto-updates:
//
//   artifacts/chrome-preview.xml    Chrome Update Manifest (gupdate)
//   artifacts/firefox-preview.json  Firefox addon update manifest
//
// Both point at the GitHub Release assets for the given version
// (https://github.com/<repo>/releases/download/v<version>/…). The release
// workflow regenerates and attaches them on every tag. The peerd-site
// repository downloads those assets and serves them at:
//
//   https://peerd.ai/updates/chrome-preview.xml
//   https://peerd.ai/updates/firefox-preview.json
//
// (the preview manifests hard-code those URLs — see
// manifests/preview.patch.json). Serve with a SHORT TTL (~5 min): Chrome
// polls every ~5h, Firefox daily-ish; a stale feed means preview users
// silently fall behind. The update-feed-monitor workflow alerts when the
// served feed disagrees with the latest GitHub Release.
//
// CLI: bun run feeds [--version=X.Y.Z] [--repo=owner/name]

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR, MANIFESTS_DIR, readJson, readVersion, parseArgs } from './lib.ts';
const DEFAULT_REPO = 'NotASithLord/peerd';

export const genUpdateFeeds = ({
  version, repo, outDir = ARTIFACTS_DIR,
}: { version: string; repo: string; outDir?: string }): void => {
  const releaseBase = `https://github.com/${repo}/releases/download/v${version}`;
  const chromeAppId = readFileSync(join(MANIFESTS_DIR, 'preview-chrome-extension-id.txt'), 'utf8').trim();
  const previewPatch = readJson(join(MANIFESTS_DIR, 'preview.patch.json'));
  const geckoId = previewPatch.browser_specific_settings.gecko.id;
  const geckoMin = previewPatch.browser_specific_settings.gecko.strict_min_version;

  mkdirSync(outDir, { recursive: true });

  const chromeXml = `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${chromeAppId}">
    <updatecheck codebase="${releaseBase}/peerd-preview-chrome.crx" version="${version}"/>
  </app>
</gupdate>
`;
  writeFileSync(join(outDir, 'chrome-preview.xml'), chromeXml);

  const firefoxJson = {
    addons: {
      [geckoId]: {
        updates: [
          {
            version,
            update_link: `${releaseBase}/peerd-preview-firefox.xpi`,
            applications: { gecko: { strict_min_version: geckoMin } },
          },
        ],
      },
    },
  };
  writeFileSync(
    join(outDir, 'firefox-preview.json'),
    JSON.stringify(firefoxJson, null, 2) + '\n',
  );

  console.log(`wrote update feed release assets for v${version} → ${releaseBase}`);
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  genUpdateFeeds({
    version: args.version ? String(args.version) : readVersion(),
    repo: args.repo ? String(args.repo) : (process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO),
  });
}
