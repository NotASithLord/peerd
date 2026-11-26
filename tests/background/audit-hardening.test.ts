import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEarlyAbortBuffer } from '../../extension/offscreen/early-aborts.js';
import { isRedirect } from '../../extension/peerd-egress/background.js';

const ROOT = join(import.meta.dir, '../..');

describe('audit P0 hardening regressions', () => {
  test('actor-runner table forwards grantedToolNames on sync and async spawn relays', () => {
    const source = readFileSync(join(ROOT, 'extension/offscreen/actor-runner.js'), 'utf8');
    expect(source).toContain(
      "'actor-spawn-sync-request': Object.freeze(['actor/spawn-sync', 'turn.actor.spawn-sync', ['task', 'allowRecursion', 'grantedToolNames', 'grantedOperations'], ['tools', 'maxSteps', 'maxDepth']])",
    );
    expect(source).toContain(
      "'actor-spawn-async-request': Object.freeze(['actor/spawn-async', 'turn.actor.spawn-async', ['task', 'allowRecursion', 'grantedToolNames', 'grantedOperations'], ['tools', 'maxSteps', 'maxDepth']])",
    );
  });

  test('offscreen-actor-client releases claimed entries on validation refusals', () => {
    const source = readFileSync(
      join(ROOT, 'extension/background/offscreen-actor-client.js'), 'utf8',
    );
    expect(source).toContain('refuseClaimedEntry(entry, {\n        ok: false, error: `${routeName}: authority mismatch`');
    expect(source).toContain("refuseClaimedEntry(entry, {\n          ok: false, error: 'actor/tasks-read: authority mismatch'");
    expect(source).toContain("refuseClaimedEntry(entry, {\n          ok: false, error: 'actor/task-cancel: authority mismatch'");
    expect(source).toContain("refuseClaimedEntry(entry, {\n          ok: false, error: 'actor/message-deliver: authority mismatch'");
    expect(source).toContain("refuseClaimedEntry(entry, {\n          ok: false, error: 'app/run-code: authority mismatch'");
    expect(source).toContain("refuseClaimedEntry(entry, {\n          ok: false, error: 'page/run-program: authority mismatch'");
  });

  test('repositoryWebFetch enforces https and rejects opaqueredirect via isRedirect', () => {
    const source = readFileSync(
      join(ROOT, 'extension/background/kernel-demand-plane.js'), 'utf8',
    );
    expect(source).toContain("if (target.protocol !== 'https:')");
    expect(source).toContain('if (isRedirect(response) || (response.status >= 300 && response.status < 400))');
    expect(isRedirect({ type: 'opaqueredirect', status: 0 } as unknown as Response)).toBe(true);
    expect(isRedirect({ type: 'basic', status: 200 } as unknown as Response)).toBe(false);
  });

  test('early-abort ring buffer enforces FIFO cap, TTL expiry, and owner scoping', () => {
    let clock = 1000;
    const buf = createEarlyAbortBuffer({ max: 2, ttlMs: 500, now: () => clock });
    buf.remember('run-1', 'owner-a');
    buf.remember('run-2', 'owner-b');
    expect(buf.consume('run-1', 'owner-wrong')).toBe(false);
    expect(buf.consume('run-1', 'owner-a')).toBe(true);
    expect(buf.consume('run-1', 'owner-a')).toBe(false);

    buf.remember('run-3');
    buf.remember('run-4');
    // run-2 evicted by max:2
    expect(buf.consume('run-2', 'owner-b')).toBe(false);
    clock += 600;
    // run-3 and run-4 expired by ttlMs:500
    expect(buf.consume('run-3')).toBe(false);
    expect(buf.consume('run-4')).toBe(false);
  });
});
