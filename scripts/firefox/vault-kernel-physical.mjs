#!/usr/bin/env bun
// Installed Firefox passphrase/route floor for the test-only vault kernel.
// Builds only in a throwaway temp tree; shared artifacts/staging and live
// manifests are never read as mutable package output.

import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  FIREFOX_BACKGROUND_ENTRY,
  generateManifest,
} from '../../packaging/gen-manifest.ts';
import { startGeckodriver } from './webdriver.mjs';
import { assertLiveKernelAssembly } from '../acceptance/live-kernel-assembly.mjs';

const ROOT = resolve(import.meta.dir, '..', '..');
const VERSION = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
const ADDON_ID = 'peerd@peerd.ai';
const FIREFOX_UUID = '7d12f198-31fc-4e95-9184-e954123981b6';
const HOME_URL = `moz-extension://${FIREFOX_UUID}/home/home.html#vault-kernel-physical`;
const EVENT_PAGE_IDLE_MS = 45_000;
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((directory) => join(directory, name))
  .find((path) => { try { return statSync(path).isFile(); } catch { return false; } });
const firefoxBinary = () => process.env.FIREFOX_PATH || process.env.FIREFOX_BIN
  || '/private/tmp/Firefox153-installed-copy.app/Contents/MacOS/firefox';
const geckodriverBinary = () => process.env.GECKODRIVER_PATH || onPath('geckodriver');

const call = async (driver, message) => JSON.parse(await driver.executeAsync(`
  const message = arguments[0];
  const done = arguments[arguments.length - 1];
  // WebDriver treats an object-valued result with an \`error\` field as a
  // protocol failure. Encode the extension reply across that boundary.
  browser.runtime.sendMessage(message).then(
    (reply) => done(JSON.stringify(reply)),
    (error) => done(JSON.stringify({
      ok: false, transportError: error?.message || String(error),
    })),
  );
`, [message]));

export async function runVaultKernelFirefoxPhysical() {
  const firefox = firefoxBinary();
  const geckodriver = geckodriverBinary();
  if (!firefox || !existsSync(firefox) || !geckodriver || !existsSync(geckodriver)) {
    throw new Error('pinned Firefox/geckodriver unavailable; set FIREFOX_PATH and GECKODRIVER_PATH');
  }
  const tree = mkdtempSync(join(tmpdir(), 'peerd-vault-kernel-firefox-'));
  const xpi = join(tmpdir(), `peerd-vault-kernel-firefox-${crypto.randomUUID()}.xpi`);
  let driver;
  try {
    cpSync(join(ROOT, 'extension'), tree, { recursive: true });
    const manifest = generateManifest({ channel: 'store', browser: 'firefox', version: VERSION });
    manifest.name = `${manifest.name} vault kernel floor`;
    manifest.background = { scripts: [FIREFOX_BACKGROUND_ENTRY], type: 'module' };
    writeFileSync(join(tree, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync('zip', ['-q', '-X', '-r', xpi, '.'], {
      cwd: tree, env: { ...process.env, TZ: 'UTC' },
    });

    driver = await startGeckodriver({
      binary: geckodriver,
      firefoxBinary: firefox,
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: FIREFOX_UUID }),
        'app.update.auto': false,
        'app.update.enabled': false,
      },
    });
    const installed = await driver.installAddon(xpi);
    if (installed !== ADDON_ID) throw new Error(`unexpected Firefox add-on id: ${installed}`);
    await driver.navigate(HOME_URL);

    const initialBoot = await call(driver, { type: 'bootstrap/ready' });
    const initial = await call(driver, { type: 'state/get' });
    const semanticRefusal = await call(driver, {
      type: 'settings/update', patch: { vaultAutoLockMs: 60_000, providerName: 'ollama' },
    });
    const policy = await call(driver, {
      type: 'settings/update', patch: { vaultAutoLockMs: 1_000 },
    });
    const initialized = await call(driver, {
      type: 'vault/initialize', passphrase: 'firefox-vault-kernel-passphrase',
    });
    const unlockedState = await call(driver, { type: 'state/get' });
    const locked = await call(driver, { type: 'vault/lock' });
    const lockedState = await call(driver, { type: 'state/get' });
    const unlocked = await call(driver, {
      type: 'vault/unlock', passphrase: 'firefox-vault-kernel-passphrase',
    });
    const resumedState = await call(driver, { type: 'state/get' });

    // Close the only extension document so Firefox may discard its event page,
    // then wake it from a plain surviving browser tab after the pinned 45s
    // lifecycle window. A fresh boot must claim a fresh epoch while preserving
    // the durable vault and session-mirror behavior.
    const extensionHandle = await driver.windowHandle();
    const survivor = await driver.newWindow('tab');
    await driver.switchToWindow(survivor.handle);
    await driver.navigate('about:blank');
    await driver.switchToWindow(extensionHandle);
    await driver.closeWindow();
    await driver.switchToWindow(survivor.handle);
    await sleep(EVENT_PAGE_IDLE_MS);
    await driver.navigate(HOME_URL);
    const afterIdleBoot = await call(driver, { type: 'bootstrap/ready' });
    const afterIdleState = await call(driver, { type: 'state/get' });

    const report = {
      schema: 1,
      runtimeIdentity: driver.runtimeIdentity,
      initialBoot, initial, semanticRefusal, policy, initialized, unlockedState,
      locked, lockedState, unlocked, resumedState, afterIdleBoot, afterIdleState,
    };
    const identityBound = (value) => value?.schema === 1
      && typeof value?.buildId === 'string' && value.buildId.startsWith(`${VERSION}:`)
      && typeof value?.bootId === 'string' && typeof value?.kernelEpoch === 'string';
    let initialAssembly;
    let afterIdleAssembly;
    try {
      initialAssembly = assertLiveKernelAssembly(initialBoot?.assembly, 'store-firefox');
      afterIdleAssembly = assertLiveKernelAssembly(afterIdleBoot?.assembly, 'store-firefox');
    } catch (cause) {
      throw new Error(`Firefox bootstrap did not prove the complete live assembly: ${
        cause instanceof Error ? cause.message : String(cause)
      }; ${JSON.stringify(report)}`);
    }
    const bootBound = (value, assembly) => identityBound(value)
      && value?.ok === true && value?.kernel === true
      && assembly === value?.assembly
      && assembly.identity.schema === value.schema
      && assembly.identity.buildId === value.buildId
      && assembly.identity.bootId === value.bootId
      && assembly.identity.kernelEpoch === value.kernelEpoch;
    const stateBound = (value) => identityBound(value)
      && value.state?.kernel?.schema === value.schema
      && value.state?.kernel?.buildId === value.buildId
      && value.state?.kernel?.bootId === value.bootId
      && value.state?.kernel?.kernelEpoch === value.kernelEpoch;
    if (!bootBound(initialBoot, initialAssembly) || !stateBound(initial)
        || initial?.ok !== true || initial.state?.vault?.initialized !== false
        || semanticRefusal?.error !== 'vault-policy-only'
        || policy?.settings?.vaultAutoLockMs !== 60_000
        || initialized?.ok !== true
        || unlockedState?.state?.vault?.initialized !== true
        || unlockedState?.state?.vault?.locked !== false
        || locked?.ok !== true || lockedState?.state?.vault?.locked !== true
        || unlocked?.ok !== true || resumedState?.state?.vault?.locked !== false
        || !bootBound(afterIdleBoot, afterIdleAssembly) || !stateBound(afterIdleState)
        || afterIdleBoot.bootId === initialBoot.bootId
        || afterIdleBoot.kernelEpoch === initialBoot.kernelEpoch
        || afterIdleState.state?.vault?.initialized !== true
        || afterIdleState.state?.vault?.locked !== false) {
      throw new Error(`Firefox vault kernel floor failed: ${JSON.stringify(report)}`);
    }
    return report;
  } finally {
    await driver?.close();
    rmSync(tree, { recursive: true, force: true });
    rmSync(xpi, { force: true });
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runVaultKernelFirefoxPhysical(), null, 2));
}
