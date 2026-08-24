import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflow = readFileSync(
  join(import.meta.dir, '..', '..', '.github', 'workflows', 'package-and-release.yml'),
  'utf8',
);

describe('release feed publication hook', () => {
  test('release signing depends on every release-critical browser and dweb gate', () => {
    const release = workflow.slice(
      workflow.indexOf('\n  release:'),
      workflow.indexOf('\n  notify-site:'),
    );
    expect(release).toContain(
      'needs: [test, checks, inbrowser, e2e, packaged-pages, cold-start, firefox-runtime, twopeer, charon-dwapp, netproc, package]',
    );
  });

  test('Charon package acceptance is pinned, physical, and precedes release credentials', () => {
    const pin = JSON.parse(readFileSync(
      join(import.meta.dir, '..', '..', 'scripts', 'cdp', 'charon-source.json'),
      'utf8',
    ));
    const lane = workflow.slice(
      workflow.indexOf('\n  charon-dwapp:'),
      workflow.indexOf('\n  netproc:'),
    );
    expect(lane).toContain('name: Charon packaged two-profile dwapp');
    expect(lane).toContain(`ref: ${pin.commit}`);
    expect(lane).toContain('CHARON_ROOT: ${{ github.workspace }}/charon');
    expect(lane).toContain('bun run test:e2e:charon');
    expect(lane).toContain('charon-dwapp-two-profile.json');
    expect(lane).toContain('if-no-files-found: error');

    const localRelease = readFileSync(
      join(import.meta.dir, '..', '..', 'packaging', 'release.ts'),
      'utf8',
    );
    const charon = localRelease.indexOf("step('installed Chrome Preview Charon two-profile");
    const credentials = localRelease.indexOf("step('signing credentials')");
    expect(charon).toBeGreaterThan(0);
    expect(charon).toBeLessThan(credentials);
    expect(localRelease).toContain("die('CHARON_ROOT must point to the pinned clean Charon checkout");
  });

  test('cold-start is a secretless packaged-browser gate and local release runs it before signing', () => {
    const cold = workflow.slice(
      workflow.indexOf('\n  cold-start:'),
      workflow.indexOf('\n  package:'),
    );
    expect(cold).toContain('name: packaged cold start (Chrome + Firefox)');
    expect(cold).toContain('runs-on: ubuntu-24.04');
    expect(cold).toContain('bun run bench:cold-sw -- --lane="$COLD_START_LANE"');
    expect(cold).not.toContain('AMO_JWT_');
    expect(cold).not.toContain('CRX_PRIVATE_KEY');

    const localRelease = readFileSync(
      join(import.meta.dir, '..', '..', 'packaging', 'release.ts'),
      'utf8',
    );
    expect(localRelease.indexOf("dryRun ? 'local' : 'release'")).toBeGreaterThan(0);
    expect(localRelease.indexOf("dryRun ? 'local' : 'release'"))
      .toBeLessThan(localRelease.indexOf("step('signing credentials')"));
  });

  test('release requires installed Chrome and Firefox secretless Smart HTTP Git acceptance', () => {
    const chrome = workflow.slice(
      workflow.indexOf('\n  e2e:'),
      workflow.indexOf('\n  visual:'),
    );
    const firefox = workflow.slice(
      workflow.indexOf('\n  firefox-runtime:'),
      workflow.indexOf('\n  twopeer:'),
    );
    expect(chrome).toContain('bun run test:e2e:passkey');
    expect(firefox).toContain('bun run test:firefox:cutover');
    for (const lane of [chrome, firefox]) {
      expect(lane).not.toContain('GITHUB_TOKEN:');
      expect(lane).not.toContain('GH_TOKEN:');
      expect(lane).not.toContain('CRX_PRIVATE_KEY');
      expect(lane).not.toContain('AMO_JWT_');
    }
    const chromeSource = readFileSync(
      join(import.meta.dir, '..', '..', 'scripts', 'cdp', 'passkey-signup-lane.mjs'),
      'utf8',
    );
    const firefoxSource = readFileSync(
      join(import.meta.dir, '..', '..', 'scripts', 'firefox', 'production-cutover-lane.mjs'),
      'utf8',
    );
    for (const source of [chromeSource, firefoxSource]) {
      expect(source).toContain('startGitSmartHttpFixture()');
      expect(source).toContain('assertExactGitFixtureRequests');
      expect(source).toContain('assertSecretlessGitReport');
    }
    const localRelease = readFileSync(
      join(import.meta.dir, '..', '..', 'packaging', 'release.ts'),
      'utf8',
    );
    const chromeGate = localRelease.indexOf("scripts/cdp/run-passkey-signup.mjs");
    const firefoxGate = localRelease.indexOf("scripts/firefox/production-cutover-lane.mjs");
    const credentials = localRelease.indexOf("step('signing credentials')");
    expect(chromeGate).toBeGreaterThan(0);
    expect(firefoxGate).toBeGreaterThan(chromeGate);
    expect(firefoxGate).toBeLessThan(credentials);
  });

  test('dispatches the exact released tag from an isolated post-release job', () => {
    const notify = workflow.slice(workflow.indexOf('\n  notify-site:'));
    expect(notify).toContain('needs: release');
    expect(notify).toContain('environment: release-notify');
    expect(notify).not.toContain('environment: release\n');
    expect(notify).toContain('secrets.PEERD_SITE_DISPATCH_TOKEN');
    expect(notify).toContain('repos/NotASithLord/peerd-site/dispatches');
    expect(notify).toContain('-f event_type=peerd-release');
    expect(notify).toContain('-F "client_payload[tag]=$GITHUB_REF_NAME"');
    expect(notify).toContain('for attempt in 1 2 3');
    expect(notify).toContain('sleep "$delay"');
    expect(notify).toContain('dispatch failed after 3 attempts');
  });

  test('a missing hook credential is visible and retryable, never a green skip', () => {
    const notify = workflow.slice(workflow.indexOf('\n  notify-site:'));
    expect(notify).toContain('if [ -z "$GH_TOKEN" ]');
    expect(notify).toContain('exit 1');
    expect(notify).not.toContain('exit 0');
    expect(notify).not.toContain('scheduled sync remains the fallback');
  });
});
