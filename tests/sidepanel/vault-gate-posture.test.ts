import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const source = readFileSync(
  join(EXTENSION_DIR, 'sidepanel', 'components', 'vault-gate.js'),
  'utf8',
);
const sidepanelSource = readFileSync(
  join(EXTENSION_DIR, 'sidepanel', 'sidepanel.js'),
  'utf8',
);
const serviceWorkerSource = readFileSync(
  join(EXTENSION_DIR, 'background', 'service-worker.js'),
  'utf8',
);

describe('first-run passkey completion posture', () => {
  test('retries an explicit initial-state handshake across cold worker startup', () => {
    expect(sidepanelSource).toContain('void requestInitialState(connectedPort)');
    expect(sidepanelSource).toContain("waitForReply('bootstrap/ready')");
    expect(sidepanelSource).toContain("waitForReply('state/get')");
    expect(sidepanelSource).toContain('await Promise.race([');
    expect(sidepanelSource).toContain('while (port === connectedPort && !currentState.hydrated)');
    expect(serviceWorkerSource).toContain("msg?.type === 'bootstrap/ready'");
    expect(serviceWorkerSource).toMatch(
      /messageDispatcherReady\.then\([\s\S]*markMessageDispatcherReady\(\)/,
    );
  });

  test('warms the worker before enabling the biometric ceremony', () => {
    expect(source).toContain('const backendReady = state.hydrated === true');
    expect(source).toContain('disabled: ui.busy || !backendReady');
    expect(source).toContain('Preparing secure setup…');
    expect(source).toContain('setInterval(() => {');
  });

  test('distinguishes the biometric ceremony from post-credential setup', () => {
    expect(source).toContain("ui.passkeyStage = 'ceremony'");
    expect(source).toMatch(
      /await enrollWithPrf\(\{ flavor \}\);[\s\S]*ui\.passkeyStage = 'finishing';[\s\S]*type: 'vault\/initializeWithPasskey'/,
    );
  });

  test('announces that the passkey succeeded while vault setup finishes', () => {
    expect(source).toContain('Passkey verified. Finishing secure vault setup…');
    expect(source).toContain("role: 'status'");
    expect(source).toContain("'aria-live': 'polite'");
  });
});
