#!/usr/bin/env bun
// Provision Chrome for Testing into ~/.cache/peerd-cft for the side-panel E2E
// verify loop (scripts/cdp/run-e2e-verify.mjs).
//
// why a dedicated binary: branded "Google Chrome" IGNORES --load-extension /
// --disable-extensions-except (a security restriction), so the unpacked
// extension never loads under it. Chrome for Testing is the supported
// automation build and honors those flags. This is a dev/CI tool only — it
// downloads to a cache dir (never committed) and adds no runtime dependency.
//
// Prints the resolved binary path as the LAST line of stdout, so CI can do:
//   CHROME_PATH=$(bun scripts/cdp/ensure-chrome-for-testing.mjs | tail -1)
// The harness also auto-discovers this cache dir, so locally `bun run e2e:chrome`
// once is enough.

import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CACHE = join(homedir(), '.cache', 'peerd-cft');

// CfT platform key + the binary path inside the unzipped tree.
function platform() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin' && a === 'arm64') return { key: 'mac-arm64', bin: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' };
  if (p === 'darwin') return { key: 'mac-x64', bin: 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' };
  if (p === 'linux') return { key: 'linux64', bin: 'chrome-linux64/chrome' };
  if (p === 'win32') return { key: 'win64', bin: 'chrome-win64/chrome.exe' };
  throw new Error(`unsupported platform ${p}/${a}`);
}

const { key, bin } = platform();
const binPath = join(CACHE, bin);
if (existsSync(binPath)) { console.log(binPath); process.exit(0); }

mkdirSync(CACHE, { recursive: true });
const meta = await (await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json')).json();
const stable = meta.channels.Stable;
const dl = stable.downloads.chrome.find((d) => d.platform === key);
if (!dl) throw new Error(`no Chrome for Testing download for ${key}`);
console.error(`[cft] Stable ${stable.version} (${key}) -> ${dl.url}`);

const zipPath = join(CACHE, `chrome-${key}.zip`);
const buf = Buffer.from(await (await fetch(dl.url)).arrayBuffer());
writeFileSync(zipPath, buf);
console.error(`[cft] downloaded ${(buf.length / 1e6).toFixed(1)} MB; unzipping...`);
const r = spawnSync('unzip', ['-q', '-o', zipPath, '-d', CACHE], { stdio: ['ignore', 'ignore', 'inherit'] });
if (r.status !== 0) throw new Error('unzip failed (is `unzip` installed?)');
if (!existsSync(binPath)) throw new Error(`binary not found after unzip: ${binPath}`);
try { chmodSync(binPath, 0o755); } catch { /* mac .app already executable */ }
console.log(binPath);
