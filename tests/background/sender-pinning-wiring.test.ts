import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

describe('exact sender pins are wired at privileged runtime edges', () => {
  const sw = readFileSync(join(EXTENSION_DIR, 'background', 'service-worker.js'), 'utf8');
  const offscreen = readFileSync(join(EXTENSION_DIR, 'offscreen', 'offscreen.js'), 'utf8');
  const featureKeepalive = readFileSync(
    join(EXTENSION_DIR, 'background', 'feature-lease-keepalive.js'), 'utf8',
  );

  test('state-bearing UI names are checked before a port enters the registry', () => {
    const branch = sw.indexOf("if (port.name === 'sidepanel' || port.name === 'home' || port.name === 'eval')");
    const guard = sw.indexOf('if (!isAuthorizedUiPortSender(port.name, port.sender', branch);
    const admission = sw.indexOf('uiPorts.add(port)', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(branch);
    expect(admission).toBeGreaterThan(guard);
  });

  test('the feature-host keepalive is sender-pinned and token-bound before disconnect recovery', () => {
    const branch = sw.indexOf('if (port.name === FEATURE_LEASE_KEEPALIVE_PORT)');
    const guard = sw.indexOf('if (!isOffscreenSender(port.sender))', branch);
    const attach = sw.indexOf('attachFeatureLeaseKeepalive({', guard);
    const exact = featureKeepalive.indexOf('const current = message.leases.some');
    const refusal = featureKeepalive.indexOf('if (!current) return;', exact);
    const admission = featureKeepalive.indexOf(
      'authenticatedHostEpoch = message.hostEpoch;', refusal,
    );
    const recovery = featureKeepalive.indexOf(
      'featureLeases.handleHostLoss(lostHostEpoch)', admission,
    );
    expect(branch).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(branch);
    expect(attach).toBeGreaterThan(guard);
    expect(exact).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(exact);
    expect(admission).toBeGreaterThan(refusal);
    expect(recovery).toBeGreaterThan(admission);
  });

  test('local-model pushes are offscreen-only and commands are worker-only', () => {
    const pushTypes = sw.indexOf("msg?.type === 'local-model/delta' || msg?.type === 'local-model/done'");
    const pushGuard = sw.indexOf('if (!isOffscreenSender(sender)) return undefined;', pushTypes);
    const deltaMutation = sw.indexOf("if (msg?.type === 'local-model/delta')", pushTypes + 1);
    expect(pushTypes).toBeGreaterThan(-1);
    expect(pushGuard).toBeGreaterThan(pushTypes);
    expect(deltaMutation).toBeGreaterThan(pushGuard);

    const commandHandler = offscreen.indexOf('const onLocalModelMessage =');
    const commandGuard = offscreen.indexOf('if (!isServiceWorkerSender(sender))', commandHandler);
    const commandSwitch = offscreen.indexOf('switch (msg.type)', commandHandler);
    expect(commandHandler).toBeGreaterThan(-1);
    expect(commandGuard).toBeGreaterThan(commandHandler);
    expect(commandSwitch).toBeGreaterThan(commandGuard);
  });

  test('toolbox parser commands are service-worker-only', () => {
    const branch = offscreen.indexOf("msg?.type !== 'toolbox/parse-check'");
    const guard = offscreen.indexOf('if (!isServiceWorkerSender(sender))', branch);
    const load = offscreen.indexOf("import('./toolbox-parse.js')", guard);
    const parse = offscreen.indexOf('handleToolboxParseCheck(msg)', load);
    expect(branch).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(branch);
    expect(load).toBeGreaterThan(guard);
    expect(parse).toBeGreaterThan(load);
  });
});
