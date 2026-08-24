import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import {
  injectLifecycleFaultDispatcher,
  injectLifecycleFaultServiceWorker,
} from '../../scripts/cdp/run-lifecycle-faults.mjs';

describe('packaged Chrome lifecycle fault lane', () => {
  const serviceWorkerSource = readFileSync(
    join(REPO_ROOT, 'extension/background/service-worker.js'), 'utf8',
  );
  const dispatcherSource = readFileSync(
    join(REPO_ROOT, 'extension/peerd-runtime/tools/dispatcher.js'), 'utf8',
  );

  test('injects production lifecycle recovery before Store packaging', () => {
    const worker = injectLifecycleFaultServiceWorker(serviceWorkerSource);
    const dispatcher = injectLifecycleFaultDispatcher(dispatcherSource);
    expect(worker).toContain("import './lifecycle-fault-probe.js'");
    expect(worker).toContain("'lifecycle-fault/dispatch': async (msg)");
    expect(worker).toContain('await lifecycleArmed');
    expect(worker).toContain('lifecycleBoot.operationLog.markDispatched(operationId)');
    expect(dispatcher).toContain('peerdLifecycleFaultProbe?.beforeExecute(call.name)');

    const harness = readFileSync(
      join(REPO_ROOT, 'scripts/cdp/run-lifecycle-faults.mjs'), 'utf8',
    );
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

  test('fails closed when either pre-package source seam drifts', () => {
    expect(() => injectLifecycleFaultServiceWorker(
      serviceWorkerSource.replace(
        "  'a2a/call': (/** @type {any} */ msg, /** @type {any} */ sender) => a2aCallRoute(msg, sender),",
        '',
      ),
    )).toThrow('source fault route seam changed');
    expect(() => injectLifecycleFaultDispatcher(
      dispatcherSource.replace('    let result = await tool.execute(args, execCtx);', ''),
    )).toThrow('source dispatcher fault seam changed');
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
