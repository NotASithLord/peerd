// The service worker cannot be imported under Bun because it registers browser
// listeners at module load. Pin the confirmation-ownership wiring statically so
// the pure protocol and reducer tests cannot pass while the live shell regresses
// to global prompt replay.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const serviceWorker = readFileSync(join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8');

describe('confirmation ownership wiring', () => {
  test('actor execution sessions resolve to a root-chat display owner', () => {
    expect(serviceWorker).toContain(
      'const ownerSessionId = sid ? await resolveLifecycleRootSession(sid) : null;',
    );
    expect(serviceWorker).toContain('const ownedPrompt = { ...prompt, ownerSessionId };');
  });

  test('state snapshots select pending prompts by their viewed chat', () => {
    expect(serviceWorker).toContain('pendingConfirm: confirmCoordinator.getPendingForOwner(');
    expect(serviceWorker).not.toContain('confirmCoordinator.getPending()');
  });

  test('state delivery refreshes and replays the destination chat prompt without an await gap', () => {
    const start = serviceWorker.indexOf('const pushState = makeCoalescedStatePush({');
    const end = serviceWorker.indexOf('// Keepalive ports', start);
    const pushState = serviceWorker.slice(start, end);
    const refresh = pushState.indexOf(
      'const pendingConfirm = confirmCoordinator.getPendingForOwner(ownerSessionId);',
    );
    const stateDelivery = pushState.indexOf("uiPorts.broadcast({ type: 'state'");
    const promptReplay = pushState.indexOf("uiPorts.broadcast({ type: 'confirm/request'");

    expect(refresh).toBeGreaterThan(-1);
    expect(stateDelivery).toBeGreaterThan(refresh);
    expect(promptReplay).toBeGreaterThan(stateDelivery);
    expect(pushState.slice(refresh, promptReplay)).not.toContain('await ');
  });
});
