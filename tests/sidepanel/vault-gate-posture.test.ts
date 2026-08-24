import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const source = readFileSync(
  join(EXTENSION_DIR, 'sidepanel', 'components', 'vault-gate.js'),
  'utf8',
);
describe('first-run passkey completion posture', () => {
  test('warms the worker before enabling the biometric ceremony', () => {
    expect(source).toContain('const backendReady = state.hydrated === true');
    expect(source).toContain('disabled: ui.busy || !backendReady');
    expect(source).toContain('Preparing secure setup…');
    expect(source).toContain('setInterval(() => {');
    expect(source).toContain('if (ui.busy || !backendReady) return;');
    expect(source).toContain("disabled: ui.busy || !backendReady");
    expect(source).toContain('Preparing secure unlock…');
  });

  test('distinguishes the biometric ceremony from post-credential setup', () => {
    expect(source).toContain("ui.passkeyStage = 'ceremony'");
    expect(source).toMatch(
      /await enrollWithPrf\(\{ flavor \}\);[\s\S]*ui\.passkeyStage = 'finishing';[\s\S]*m\.redraw\.sync\(\);[\s\S]*type: 'vault\/initializeWithPasskey'/,
    );
  });

  test('announces that the passkey succeeded while vault setup finishes', () => {
    expect(source).toContain('Passkey verified. Finishing secure vault setup…');
    expect(source).toContain("role: 'status'");
    expect(source).toContain("'aria-live': 'polite'");
  });

  test('renders bounded outcome-unknown copy without replaying credential commits', () => {
    expect(source).toContain('authorityUncertainMessage');
    expect(source).toContain('did not confirm whether that finished');
    expect(source).not.toMatch(/vault-authority-timeout[\s\S]{0,300}initializeWithPasskey/);
    expect(source).toContain('let commitDispatched = false');
    expect(source).toContain('let unlockDispatched = false');
    expect(source).toContain('authorityUncertainMessage({ outcomeKnown: false })');
    expect(source).not.toContain('secure vault service stopped responding. Try again.');
    expect(source).not.toMatch(/ERROR_MESSAGES\[reply\?\.error\] \?\? reply\?\.error/);
  });
});
