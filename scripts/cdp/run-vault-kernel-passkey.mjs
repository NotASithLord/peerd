// Physical Chrome floor for the test-only vault authority kernel. This proves
// packaged first-install custody only; rich-app/controller readiness and worker
// recycle are intentionally outside this artifact's claimed boundary.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR } from '../../packaging/lib.ts';
import {
  actionableCta, installPageTrace, installVirtualPasskey, readChromeIdentity,
} from './passkey-signup-lane.mjs';
import {
  evalIn, hostMonotonicMs, launchPeerd, rpc, waitFor,
} from './e2e-harness.mjs';
import { buildVaultKernelArtifact } from './vault-kernel-artifact.mjs';
import { assertLiveKernelAssembly } from '../acceptance/live-kernel-assembly.mjs';

const roundMs = (value) => Math.round(Number(value) * 10) / 10;
const STARTUP_BUDGET_MS = 60_000;
const COMMIT_BUDGET_MS = 30_000;
const REPORT_PATH = join(ARTIFACTS_DIR, 'e2e', 'vault-kernel-passkey-report.json');

const readDurableRecords = (page) => evalIn(page, `(async () => {
  const open = await new Promise((resolve, reject) => {
    const request = indexedDB.open('peerd');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const read = (storeName) => new Promise((resolve, reject) => {
      const transaction = open.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [vault, audit] = await Promise.all([read('vault'), read('audit_log')]);
    return {
      vaultRecords: vault.length,
      auditTypes: audit.map((entry) => entry.type),
    };
  } finally { open.close(); }
})()`, true);
const readOffscreenContexts = (page) => evalIn(page, `(async () =>
  globalThis.chrome?.runtime?.getContexts
    ? chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [])()`, true);

export async function runVaultKernelPasskeyFloor({
  artifact: providedArtifact = null,
  writeReport = true,
} = {}) {
  const [artifact, browserIdentity] = await Promise.all([
    providedArtifact ?? buildVaultKernelArtifact({ browser: 'chrome' }),
    readChromeIdentity(),
  ]);
  let ctx;
  let removePageListener = () => {};
  try {
    ctx = await launchPeerd({
      extensionDir: artifact.staging,
      interceptModel: false,
      captureBootTimeline: true,
      beforePanelNavigate: installVirtualPasskey,
      // Home is the production tab-hosted human authority surface. Opening
      // sidepanel.html as a tab must not broaden its one-shot vault authority.
      panelPath: 'home/home.html',
    });
    const launchStartedAt = ctx.bootTimeline.launchStartedAt;
    const sinceLaunch = () => roundMs(hostMonotonicMs() - launchStartedAt);
    let authenticatorReturnMs = null;
    removePageListener = await installPageTrace(ctx, () => {
      authenticatorReturnMs ??= sinceLaunch();
    });

    const center = await waitFor(() => actionableCta(ctx.page), {
      budgetMs: STARTUP_BUDGET_MS, pollMs: 25,
    });
    if (!center) {
      const [body, state] = await Promise.all([
        evalIn(ctx.page, `document.body?.innerText?.slice(0, 1200) || ''`).catch(String),
        rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5_000 }).catch(String),
      ]);
      throw new Error(`kernel passkey CTA did not become actionable: ${JSON.stringify({
        body, state, pageEvents: ctx.page.events.slice(-12),
      })}`);
    }
    const ctaEnabledMs = sinceLaunch();
    const coldOffscreenContexts = await readOffscreenContexts(ctx.page);
    if (!Array.isArray(coldOffscreenContexts) || coldOffscreenContexts.length !== 0) {
      throw new Error(`kernel created an offscreen document before feature demand: ${JSON.stringify(
        coldOffscreenContexts,
      )}`);
    }
    const clickMs = sinceLaunch();
    await ctx.page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', ...center, button: 'left', clickCount: 1,
    });
    await ctx.page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...center, button: 'left', clickCount: 1,
    });

    const durable = await waitFor(async () => {
      const [reply, records] = await Promise.all([
        rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5_000 }).catch(() => null),
        readDurableRecords(ctx.page).catch(() => null),
      ]);
      const vault = reply?.state?.vault;
      const audit = records?.auditTypes ?? [];
      return vault?.initialized === true && vault?.locked === false
        && vault?.prfEnrolled === true && records?.vaultRecords === 1
        && audit.includes('vault_initialized') && audit.includes('vault_prf_enrolled')
        ? { vault, records } : null;
    }, { budgetMs: COMMIT_BUDGET_MS, pollMs: 50 });
    if (!durable) {
      const [state, records, body, contexts] = await Promise.all([
        rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5_000 }).catch(String),
        readDurableRecords(ctx.page).catch(String),
        evalIn(ctx.page, `document.body?.innerText?.slice(0, 1600) || ''`).catch(String),
        evalIn(ctx.page, `(async () => globalThis.chrome?.runtime?.getContexts
          ? chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [])()`, true)
          .catch(String),
      ]);
      throw new Error(`kernel vault/audit records did not durably commit: ${JSON.stringify({
        state, records, body, contexts, pageEvents: ctx.page.events.slice(-20),
      })}`);
    }
    const durableVaultCommitMs = sinceLaunch();
    if (authenticatorReturnMs === null) {
      throw new Error('durable commit completed without an observed authenticator-return milestone');
    }
    const initializedOffscreenContexts = await readOffscreenContexts(ctx.page);
    if (!Array.isArray(initializedOffscreenContexts)
        || initializedOffscreenContexts.length !== 1) {
      throw new Error(`unlocked vault authority host cardinality invalid: ${JSON.stringify(
        initializedOffscreenContexts,
      )}`);
    }
    const bootstrap = await rpc(ctx.page, { type: 'bootstrap/ready' }, { timeoutMs: 5_000 });
    if (bootstrap?.ok !== true || bootstrap?.kernel !== true) {
      throw new Error(`kernel bootstrap did not identify the native kernel: ${JSON.stringify(
        bootstrap,
      )}`);
    }
    let assembly;
    try {
      assembly = assertLiveKernelAssembly(bootstrap.assembly, 'store-chrome');
    } catch (cause) {
      throw new Error(`kernel bootstrap did not prove the complete live assembly: ${
        cause instanceof Error ? cause.message : String(cause)
      }; ${JSON.stringify(bootstrap)}`);
    }
    if (assembly.identity.schema !== bootstrap.schema
        || assembly.identity.buildId !== bootstrap.buildId
        || assembly.identity.bootId !== bootstrap.bootId
        || assembly.identity.kernelEpoch !== bootstrap.kernelEpoch) {
      throw new Error(`kernel bootstrap identity is not bound to its assembly: ${JSON.stringify(
        bootstrap,
      )}`);
    }

    const report = Object.freeze({
      schema: 1,
      ok: true,
      claim: 'test-only-packaged-vault-kernel-floor',
      bindings: { artifact, browserIdentity },
      timings: {
        clock: 'host-monotonic-ms',
        staticShellPaintedMs: roundMs(ctx.bootTimeline.staticShellReadyMs),
        bootModuleEvaluatedMs: roundMs(ctx.bootTimeline.bootModuleReadyMs),
        ctaEnabledMs,
        clickMs,
        authenticatorReturnMs,
        durableVaultCommitMs,
      },
      observations: {
        durableVaultCommitted: true,
        auditTypes: durable.records.auditTypes,
        vaultRecords: durable.records.vaultRecords,
        offscreenContextsAtCta: coldOffscreenContexts.length,
        offscreenContextsAfterInitialize: initializedOffscreenContexts.length,
        vaultAuthorityResidentWhileUnlocked: true,
        assembly,
        workerTimingDiagnostic: bootstrap.timing ?? null,
        controllerReadyClaimed: false,
        recycleClaimed: false,
      },
    });
    if (writeReport) {
      mkdirSync(join(ARTIFACTS_DIR, 'e2e'), { recursive: true });
      writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    }
    return report;
  } finally {
    removePageListener();
    try { await ctx?.close(); } catch { /* best-effort physical cleanup */ }
  }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runVaultKernelPasskeyFloor(), null, 2)); }
  catch (error) { console.error(error?.stack ?? error); process.exitCode = 1; }
}
