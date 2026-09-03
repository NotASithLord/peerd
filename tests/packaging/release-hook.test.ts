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
      'needs: [test, checks, inbrowser, e2e, packaged-pages, cold-start, firefox-runtime, twopeer, netproc, package]',
    );
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

  test('release requires packaged Chrome repository custody and Firefox Smart HTTP acceptance', () => {
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
      join(import.meta.dir, '..', '..', 'scripts', 'cdp', 'check-packaged-pages.mjs'),
      'utf8',
    );
    const firefoxSource = readFileSync(
      join(import.meta.dir, '..', '..', 'scripts', 'firefox', 'production-cutover-lane.mjs'),
      'utf8',
    );
    expect(chromeSource).toContain("type: 'apps/repository/status'");
    expect(chromeSource).toContain("type: 'apps/repository/branch'");
    expect(chromeSource).toContain("type: 'import/apply'");
    expect(firefoxSource).toContain('startGitSmartHttpFixture()');
    expect(firefoxSource).toContain('assertExactGitFixtureRequests');
    expect(firefoxSource).toContain('assertSecretlessGitReport');
    expect(workflow).toContain('needs: [test, checks, inbrowser, e2e, packaged-pages, cold-start, firefox-runtime');
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

  test('the physical Store document lane gates CI and the local release before credentials', () => {
    const chrome = workflow.slice(
      workflow.indexOf('\n  e2e:'),
      workflow.indexOf('\n  visual:'),
    );
    expect(chrome).toContain('bun run test:e2e:read-doc');
    const localRelease = readFileSync(
      join(import.meta.dir, '..', '..', 'packaging', 'release.ts'),
      'utf8',
    );
    const documentGate = localRelease.indexOf('scripts/cdp/read-doc-store-lane.mjs');
    expect(documentGate).toBeGreaterThan(0);
    expect(documentGate).toBeLessThan(localRelease.indexOf("step('signing credentials')"));
  });

  test('CI exercises site capture through the packaged Store tap fallback', () => {
    const chrome = workflow.slice(
      workflow.indexOf('\n  e2e:'),
      workflow.indexOf('\n  visual:'),
    );
    const pkg = JSON.parse(readFileSync(
      join(import.meta.dir, '..', '..', 'package.json'),
      'utf8',
    ));
    expect(chrome).toContain('bun run test:e2e:site-client-store:staged');
    expect(pkg.scripts['test:e2e:site-client-store']).toContain('--channel=store --browser=chrome');
    expect(pkg.scripts['test:e2e:site-client-store']).toContain('test:e2e:site-client-store:staged');
    expect(pkg.scripts['test:e2e:site-client-store:staged']).toContain('PEERD_REQUIRE_SITE_CAPTURE_TAP=1');
    expect(pkg.scripts['test:e2e:site-client-store:staged']).toContain('--only=site-client-vertical');
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
