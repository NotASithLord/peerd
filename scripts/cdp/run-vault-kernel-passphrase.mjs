// Physical Chrome proof for the demand-owned sealed vault authority. The
// packaged native kernel starts with no offscreen context, creates exactly one
// authority host for the operation, retains it only while unlocked, and drops
// it synchronously on lock.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR } from '../../packaging/lib.ts';
import { evalIn, hostMonotonicMs, launchPeerd, rpc, waitFor } from './e2e-harness.mjs';
import { buildVaultKernelArtifact } from './vault-kernel-artifact.mjs';
import { assertLiveKernelAssembly } from '../acceptance/live-kernel-assembly.mjs';

const PASSPHRASE = 'native-kernel-physical-passphrase';
const REPORT_PATH = join(ARTIFACTS_DIR, 'e2e', 'vault-kernel-passphrase-report.json');
const roundMs = (value) => Math.round(Number(value) * 10) / 10;
const contexts = (page) => evalIn(page, `(async () =>
  globalThis.chrome?.runtime?.getContexts
    ? chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [])()`, true);

const deriveWithObservedHost = async (page, message, timeoutMs = 60_000) => {
  let settled = false;
  const startedAt = hostMonotonicMs();
  const call = rpc(page, message, { timeoutMs }).finally(() => { settled = true; });
  let maxContexts = 0;
  while (!settled && hostMonotonicMs() - startedAt < timeoutMs) {
    const current = await contexts(page).catch(() => []);
    if (Array.isArray(current)) maxContexts = Math.max(maxContexts, current.length);
    if (!settled) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const reply = await call;
  const retained = await waitFor(async () => {
    const current = await contexts(page).catch(() => null);
    return Array.isArray(current) && current.length === 1 ? true : null;
  }, { budgetMs: 10_000, pollMs: 25 });
  return Object.freeze({
    reply,
    elapsedMs: roundMs(hostMonotonicMs() - startedAt),
    maxOffscreenContexts: maxContexts,
    retainedWhileUnlocked: retained === true,
  });
};

export async function runVaultKernelPassphraseFloor() {
  const artifact = await buildVaultKernelArtifact({ browser: 'chrome' });
  let ctx;
  try {
    ctx = await launchPeerd({
      extensionDir: artifact.staging,
      // This lane performs no model request. Leaving debugger Fetch
      // interception off keeps the sealed authority Worker on the same
      // scheduling path users exercise.
      interceptModel: false,
      captureBootTimeline: true,
      panelPath: 'home/home.html',
    });
    const bootstrap = await rpc(ctx.page, { type: 'bootstrap/ready' }, { timeoutMs: 60_000 });
    const before = await contexts(ctx.page);
    if (bootstrap?.ok !== true || bootstrap?.kernel !== true
        || !Array.isArray(before) || before.length !== 0) {
      throw new Error(`vault authority floor was not cold before demand: ${JSON.stringify({
        bootstrap, before,
      })}`);
    }
    let assembly;
    try {
      assembly = assertLiveKernelAssembly(bootstrap.assembly, 'store-chrome');
    } catch (cause) {
      throw new Error(`vault authority floor did not prove the complete live assembly: ${
        cause instanceof Error ? cause.message : String(cause)
      }; ${JSON.stringify(bootstrap)}`);
    }
    if (assembly.identity.schema !== bootstrap.schema
        || assembly.identity.buildId !== bootstrap.buildId
        || assembly.identity.bootId !== bootstrap.bootId
        || assembly.identity.kernelEpoch !== bootstrap.kernelEpoch) {
      throw new Error(`vault authority floor identity is not bound to its assembly: ${JSON.stringify(
        bootstrap,
      )}`);
    }

    const initialized = await deriveWithObservedHost(ctx.page, {
      type: 'vault/initialize', passphrase: PASSPHRASE,
    });
    if (initialized.reply?.ok !== true || initialized.maxOffscreenContexts !== 1
        || initialized.retainedWhileUnlocked !== true) {
      throw new Error(`vault authority initialize lifecycle failed: ${JSON.stringify({
        initialized,
        targetEvents: ctx.extensionTargetEvents?.(),
      })}`);
    }
    const afterInitialize = await rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 10_000 });
    if (afterInitialize?.state?.vault?.initialized !== true
        || afterInitialize?.state?.vault?.locked !== false
        || afterInitialize?.state?.vault?.hasRecovery !== true) {
      throw new Error(`vault authority initialize state invalid: ${JSON.stringify(afterInitialize)}`);
    }

    const locked = await rpc(ctx.page, { type: 'vault/lock' }, { timeoutMs: 10_000 });
    if (locked?.ok !== true) throw new Error(`vault lock failed: ${JSON.stringify(locked)}`);
    const coldAfterLock = await waitFor(async () => {
      const current = await contexts(ctx.page).catch(() => null);
      return Array.isArray(current) && current.length === 0 ? true : null;
    }, { budgetMs: 10_000, pollMs: 25 });
    if (coldAfterLock !== true) throw new Error('vault authority host survived lock');
    const unlocked = await deriveWithObservedHost(ctx.page, {
      type: 'vault/unlock', passphrase: PASSPHRASE,
    });
    if (unlocked.reply?.ok !== true || unlocked.maxOffscreenContexts !== 1
        || unlocked.retainedWhileUnlocked !== true) {
      throw new Error(`vault authority unlock lifecycle failed: ${JSON.stringify({
        initialized,
        unlocked,
        pageEvents: ctx.page.events.slice(-24),
        targetEvents: ctx.extensionTargetEvents?.(),
      })}`);
    }
    const finalState = await rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 10_000 });
    if (finalState?.state?.vault?.locked !== false) {
      throw new Error(`vault authority unlock state invalid: ${JSON.stringify(finalState)}`);
    }

    const report = Object.freeze({
      schema: 1,
      ok: true,
      claim: 'test-only-packaged-vault-authority-demand-floor',
      artifact,
      observations: {
        assembly,
        offscreenContextsBeforeDemand: before.length,
        initialize: initialized,
        offscreenContextsAfterLock: 0,
        unlock: unlocked,
        initialized: true,
        unlocked: true,
      },
    });
    mkdirSync(join(ARTIFACTS_DIR, 'e2e'), { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    try { ctx?.close(); } catch { /* best-effort physical cleanup */ }
  }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runVaultKernelPassphraseFloor(), null, 2)); }
  catch (error) { console.error(error?.stack ?? error); process.exitCode = 1; }
}
