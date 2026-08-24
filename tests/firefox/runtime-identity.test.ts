import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseGeckodriverVersion,
  PINNED_FIREFOX_VERSION,
  PINNED_GECKODRIVER_VERSION,
  verifyPinnedFirefoxRuntime,
} from '../../scripts/firefox/runtime-identity.mjs';

describe('Firefox installed runtime identity', () => {
  test('pins exact complete Firefox and geckodriver releases', () => {
    expect(PINNED_FIREFOX_VERSION).toBe('153.0.3');
    expect(PINNED_GECKODRIVER_VERSION).toBe('0.37.1');
    expect(parseGeckodriverVersion('geckodriver 0.37.1 (abc 2026-01-01)\n'))
      .toBe('0.37.1');
  });

  test('records executable identity and rejects a mismatched session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'peerd-firefox-identity-'));
    const firefox = join(directory, 'firefox');
    const geckodriver = join(directory, 'geckodriver');
    writeFileSync(firefox, 'fake-firefox');
    writeFileSync(
      geckodriver,
      `#!/bin/sh\nprintf 'geckodriver ${PINNED_GECKODRIVER_VERSION} (test)\\n'\n`,
      { mode: 0o755 },
    );
    try {
      const input = {
        driver: { capabilities: { browserVersion: PINNED_FIREFOX_VERSION } },
        firefoxBinary: firefox,
        geckodriverBinary: geckodriver,
      };
      const identity = await verifyPinnedFirefoxRuntime(input);
      expect(identity).toMatchObject({
        pinned: true,
        actual: {
          firefox: PINNED_FIREFOX_VERSION,
          geckodriver: PINNED_GECKODRIVER_VERSION,
        },
      });
      expect(identity.binaries.firefox.sha256).toHaveLength(64);
      expect(identity.binaries.geckodriver.sha256).toHaveLength(64);
      await expect(verifyPinnedFirefoxRuntime({
        ...input,
        driver: { capabilities: { browserVersion: '999.0.0' } },
      })).rejects.toThrow('unpinned Firefox runtime');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the cold benchmark verifies identity before install and uses host-monotonic timing', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', '..', 'scripts', 'bench', 'cold-service-worker.mjs'),
      'utf8',
    );
    const firefoxProcess = source.slice(
      source.indexOf('const runFirefoxProcess'),
      source.indexOf('const benchmarkFirefox'),
    );
    expect(firefoxProcess.indexOf('const runtimeIdentity = driver.runtimeIdentity'))
      .toBeLessThan(firefoxProcess.indexOf('driver.installAddon'));
    const webdriver = readFileSync(
      join(import.meta.dir, '..', '..', 'scripts', 'firefox', 'webdriver.mjs'),
      'utf8',
    );
    expect(webdriver.indexOf('verifyPinnedFirefoxRuntime'))
      .toBeLessThan(webdriver.indexOf('return {\n      sessionId'));
    expect(source).toContain(
      'const hostNowMs = () => Number(process.hrtime.bigint()) / 1_000_000',
    );
    expect(source).toContain('hostRoundTripMs: hostNowMs() - hostStarted');
    expect(firefoxProcess).not.toContain('const sessionStarted = performance.now()');
  });
});
