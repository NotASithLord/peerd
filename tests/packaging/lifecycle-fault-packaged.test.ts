import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import {
  assertLifecycleFaultExecutionSeam,
  injectLifecycleFaultKernel,
} from '../../scripts/cdp/run-lifecycle-faults.mjs';

describe('packaged Chrome lifecycle fault lane', () => {
  const kernelSource = readFileSync(
    join(REPO_ROOT, 'extension/background/vault-kernel.js'), 'utf8',
  );
  const trackingSource = readFileSync(
    join(REPO_ROOT, 'extension/peerd-runtime/lifecycle/dispatch-tracking.js'), 'utf8',
  );

  test('injects production lifecycle recovery before Store packaging', () => {
    const worker = injectLifecycleFaultKernel(kernelSource);
    expect(assertLifecycleFaultExecutionSeam(trackingSource)).toBeUndefined();
    expect(worker).toContain("'lifecycle-fault/dispatch': async (message)");
    expect(worker).toContain('await getControllerRelays()');
    expect(worker).toContain('message?.recoverOnly === true');
    expect(worker).toContain('context.lifecycle.beginTracking({');
    expect(worker).toContain("['script', 'E', callId]");
    expect(worker).toContain("{ toolName: 'script', at: Date.now() }");

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
  });

  test('fails closed when a pre-package source seam drifts', () => {
    expect(() => injectLifecycleFaultKernel(
      kernelSource.replace(
        '  ...systemReadRoutes,\n  ...sessionSupportRoutes,\n  ...demandRoutes,', '',
      ),
    )).toThrow('source fault route seam changed');
    expect(() => assertLifecycleFaultExecutionSeam(
      trackingSource.replace(
        'await operationLog.markDispatched(operationId);',
        '',
      ),
    )).toThrow('source lifecycle dispatch seam changed');
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
