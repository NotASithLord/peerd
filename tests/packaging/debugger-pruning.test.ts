import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEBUGGER_UNAVAILABLE_TEMPLATE,
  REPO_ROOT,
} from '../../packaging/lib.ts';
import { generateManifest } from '../../packaging/gen-manifest.ts';
import { createDebuggerPool } from '../../packaging/templates/debugger-pool.unavailable.js';

describe('package-time debugger graph pruning', () => {
  test('unavailable targets retain the operational pool interface and fail closed', async () => {
    const pool = createDebuggerPool();
    expect(Object.keys(pool).sort()).toEqual([
      'attach', 'captureScreenshot', 'clickBackendNode', 'detach',
      'discardNetworkCapture', 'dispatchKeys', 'evaluate', 'getAxTree',
      'isAttached', 'readFrameworkState', 'releaseNetworkCapture',
      'setValueBackendNode', 'startNetworkCapture', 'stopNetworkCapture',
    ].sort());
    expect(pool.isAttached()).toBe(false);
    expect(await pool.stopNetworkCapture()).toEqual([]);
    await expect(pool.evaluate()).rejects.toThrow('debugger_unavailable');
  });

  test('unavailable targets receive no debugger custody lifecycle events', () => {
    const pool = createDebuggerPool();
    expect('onTabUpdated' in pool).toBe(false);
    expect('onTabRemoved' in pool).toBe(false);
    const source = readFileSync(
      join(REPO_ROOT, 'extension', 'background', 'kernel-turn-live-factories.js'),
      'utf8',
    );
    expect(source).toContain(
      'if (debuggerApiAvailable()) debuggerPool.onTabUpdated(tabId, change);',
    );
    expect(source).toContain(
      'if (debuggerApiAvailable()) debuggerPool.onTabRemoved(tabId);',
    );
  });

  test('packaging swaps a committed whole-file template only where permission is absent', () => {
    const source = readFileSync(join(REPO_ROOT, 'packaging', 'package.ts'), 'utf8');
    expect(source).toContain("channel === 'store' || browser === 'firefox'");
    expect(source).toContain('DEBUGGER_UNAVAILABLE_TEMPLATE');
    expect(readFileSync(DEBUGGER_UNAVAILABLE_TEMPLATE, 'utf8'))
      .toContain("throw new Error('debugger_unavailable')");

    const targets = [
      { channel: 'store', browser: 'chrome', pruned: true },
      { channel: 'store', browser: 'firefox', pruned: true },
      { channel: 'preview', browser: 'firefox', pruned: true },
      { channel: 'preview', browser: 'chrome', pruned: false },
    ] as const;
    for (const target of targets) {
      const manifest = generateManifest({ ...target, version: '0.0.0' });
      expect(manifest.permissions?.includes('debugger'), `${target.channel}/${target.browser}`)
        .toBe(!target.pruned);
    }
  });
});
