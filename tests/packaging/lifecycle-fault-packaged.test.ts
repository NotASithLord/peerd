import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import {
  assertLifecycleFaultExecutionSeam,
  injectLifecycleFaultEffect,
  injectLifecycleFaultJob,
  injectLifecycleFaultKernel,
  injectLifecycleFaultTurnBudget,
} from '../../scripts/cdp/run-lifecycle-faults.mjs';

describe('packaged Chrome lifecycle fault lane', () => {
  const kernelSource = readFileSync(
    join(REPO_ROOT, 'extension/background/vault-kernel.js'), 'utf8',
  );
  const source = (path: string) => readFileSync(join(REPO_ROOT, 'extension', path), 'utf8');
  const executionSources = {
    tracking: source('peerd-runtime/lifecycle/dispatch-tracking.js'),
    controller: source('offscreen/controller-turn-runtime.js'),
    bridge: source('background/controller-turn-bridge.js'),
    authority: source('background/execution-tool-authority.js'),
  };

  test('injects production lifecycle recovery before Store packaging', () => {
    const worker = injectLifecycleFaultKernel(kernelSource);
    const authority = injectLifecycleFaultEffect(executionSources.authority);
    const job = injectLifecycleFaultJob(source('offscreen/job-runner.js'));
    expect(assertLifecycleFaultExecutionSeam(executionSources)).toBeUndefined();
    expect(worker).toContain("'lifecycle-fault/dispatch': async (message, sender)");
    expect(worker).toContain('scriptRuns.ownerFor(message.runId) !== message.ownerSessionId');
    expect(worker).toContain('await getControllerRelays()');
    expect(injectLifecycleFaultTurnBudget(source('background/kernel-turn-owner.js')))
      .toContain('const TURN_RUNTIME_LOAD_TIMEOUT_MS = 120_000;');
    expect(worker).toContain('message?.recoverOnly === true');
    expect(worker).toContain("demandRoutes['agent/send']");
    expect(worker).toContain('await featureHost.vaultInitialized()');
    expect(worker).toContain("void demandRoutes['agent/send']");
    expect(worker).toContain("relays.sessions.create({");
    expect(worker).toContain("provider: 'ollama', model: 'qwen3:8b'");
    expect(authority).toContain('lifecycle fault execution target changed');
    expect(worker).toContain("phase: 'offscreen.runJob'");
    expect(job).toContain("sendToSW('lifecycle-fault/dispatch'");
    expect(authority).toContain("return 'peerd-lifecycle-fault';");
    expect(job).toContain('await new Promise(() => {});');

    const harness = readFileSync(
      join(REPO_ROOT, 'scripts/cdp/run-lifecycle-faults.mjs'), 'utf8',
    );
    const sourceLane = harness.slice(
      harness.indexOf('const makeSourceFaultExtension ='),
      harness.indexOf('const makePackagedFaultExtension ='),
    );
    expect(sourceLane.indexOf('injectLifecycleFaultTree(extension);'))
      .toBeLessThan(sourceLane.indexOf('await bundleChromeNativeKernel(extension, backgroundEntry);'));
    const storeLane = harness.slice(
      harness.indexOf('const makePackagedFaultExtension ='),
      harness.indexOf('const waitFor =', harness.indexOf('const makePackagedFaultExtension =')),
    );
    expect(storeLane.indexOf('injectLifecycleFaultTree(extension);'))
      .toBeLessThan(storeLane.indexOf('await packageArtifact({'));
    expect(storeLane).toContain("channel: 'store', browser: 'chrome'");
    expect(storeLane).toContain('verify: true, minify: true');
    expect(storeLane).toContain("join(artifactRoot, 'staging', 'store-chrome')");
    expect(harness).toContain('chrome-extension://${extensionId}/${FAULT_PAGE}');
  });

  test('fails closed when a pre-package source seam drifts', () => {
    expect(() => injectLifecycleFaultKernel(
      kernelSource.replace(
        '  ...systemReadRoutes,\n  ...sessionSupportRoutes,\n  ...demandRoutes,', '',
      ),
    )).toThrow('source fault route seam changed');
    expect(() => assertLifecycleFaultExecutionSeam({
      ...executionSources,
      tracking: executionSources.tracking.replace(
        'await operationLog.markDispatched(operationId);', '',
      ),
    })).toThrow('source lifecycle controller execution seam changed');
    expect(() => injectLifecycleFaultEffect(
      executionSources.authority.replace(
        '        const result = await client.execHeadless(code, opts);', '',
      ),
    )).toThrow('source exact script effect seam changed');
    expect(() => injectLifecycleFaultJob(
      source('offscreen/job-runner.js').replace('const _runJob = async ', 'const runJobInner = async '),
    )).toThrow('source exact offscreen job effect seam changed');
  });

  test('keeps source and Store lanes independently gated in CI', () => {
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const workflow = readFileSync(
      join(REPO_ROOT, '.github/workflows/package-and-release.yml'), 'utf8',
    );
    expect(packageJson.scripts['test:e2e:lifecycle'])
      .toBe('bun scripts/cdp/run-lifecycle-faults.mjs');
    expect(packageJson.scripts['test:e2e:lifecycle:store'])
      .toBe('bun scripts/cdp/run-lifecycle-faults.mjs --target=store');
    expect(workflow).toContain('bun run test:e2e:lifecycle\n');
    expect(workflow).toContain('bun run test:e2e:lifecycle:store');
  });
});
