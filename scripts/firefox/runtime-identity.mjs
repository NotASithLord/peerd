// Exact installed Firefox/geckodriver identity for browser gates.
// Pins name complete releases, never channels or moving major/minor aliases.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const readPin = (name) => readFileSync(join(HERE, name), 'utf8').trim();

export const PINNED_FIREFOX_VERSION = readPin('firefox-version.txt');
export const PINNED_GECKODRIVER_VERSION = readPin('geckodriver-version.txt');

/** @param {string} value */
export const parseGeckodriverVersion = (value) =>
  value.match(/^geckodriver\s+([^\s]+)/m)?.[1] ?? null;

const hashCache = new Map();
/** @param {string} path */
const sha256File = (path) => {
  const stat = statSync(path);
  const key = `${path}\0${stat.size}\0${stat.mtimeMs}`;
  const cached = hashCache.get(key);
  if (cached) return cached;
  const pending = new Promise((resolveDigest, rejectDigest) => {
    const digest = createHash('sha256');
    const input = createReadStream(path);
    input.on('data', (chunk) => digest.update(chunk));
    input.on('error', rejectDigest);
    input.on('end', () => resolveDigest(digest.digest('hex')));
  });
  hashCache.set(key, pending);
  return pending;
};

/**
 * Verify the actual WebDriver session before installing an add-on. The
 * capability is authoritative for the launched Firefox binary; user-agent
 * parsing after installation is deliberately not part of this trust gate.
 *
 * @param {Object} input
 * @param {{ capabilities?: { browserVersion?: unknown } }} input.driver
 * @param {string} input.firefoxBinary
 * @param {string} input.geckodriverBinary
 */
export const verifyPinnedFirefoxRuntime = async ({
  driver,
  firefoxBinary,
  geckodriverBinary,
}) => {
  const firefoxPath = realpathSync(firefoxBinary);
  const geckodriverPath = realpathSync(geckodriverBinary);
  const firefoxVersion = typeof driver?.capabilities?.browserVersion === 'string'
    ? driver.capabilities.browserVersion
    : null;
  const geckodriverOutput = execFileSync(geckodriverPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const geckodriverVersion = parseGeckodriverVersion(geckodriverOutput);
  const mismatches = [];
  if (firefoxVersion !== PINNED_FIREFOX_VERSION) {
    mismatches.push(`Firefox ${String(firefoxVersion)} != ${PINNED_FIREFOX_VERSION}`);
  }
  if (geckodriverVersion !== PINNED_GECKODRIVER_VERSION) {
    mismatches.push(`geckodriver ${String(geckodriverVersion)} != ${PINNED_GECKODRIVER_VERSION}`);
  }
  const [firefoxSha256, geckodriverSha256] = await Promise.all([
    sha256File(firefoxPath),
    sha256File(geckodriverPath),
  ]);
  const identity = Object.freeze({
    pinned: mismatches.length === 0,
    expected: {
      firefox: PINNED_FIREFOX_VERSION,
      geckodriver: PINNED_GECKODRIVER_VERSION,
    },
    actual: { firefox: firefoxVersion, geckodriver: geckodriverVersion },
    binaries: {
      firefox: { path: firefoxPath, sha256: firefoxSha256 },
      geckodriver: { path: geckodriverPath, sha256: geckodriverSha256 },
    },
    mismatches,
  });
  if (mismatches.length > 0) {
    throw new Error(`unpinned Firefox runtime: ${mismatches.join('; ')}`);
  }
  return identity;
};
