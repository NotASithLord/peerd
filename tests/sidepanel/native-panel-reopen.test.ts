import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Exercise the actual closure without launching Chrome: these failures happen
// between a successful state and the next state, when its old tab is retiring.
const source = readFileSync('scripts/cdp/e2e-harness.mjs', 'utf8');
const start = source.indexOf('    let lastActionTargetId = null;');
const end = source.indexOf('    const target = await openNativePanelTarget(', start);
const makeOpen = (send: (method: string, params: any) => Promise<any>) => new Function(
  'browserConn', 'sw', 'waitFor', 'findNativePanelTarget',
  `${source.slice(start, end)}; return openNativePanelTarget;`,
)({ send }, { id: 'peerd' }, async (read: () => unknown) => read(), async () => ({ targetId: 'panel' }));

test('native panel skips a retired toolbar host and reuses the proven live target', async () => {
  const clicks: string[] = [];
  const open = makeOpen(async (method, params) => {
    if (method === 'Target.getTargets') return { targetInfos: [
      { type: 'tab', url: 'about:blank', targetId: 'stale' },
      { type: 'tab', url: 'about:blank', targetId: 'live' },
    ] };
    if (method === 'Extensions.triggerAction') {
      clicks.push(params.targetId);
      if (params.targetId === 'stale') throw new Error('Extensions.triggerAction: cannot retrieve host for the provided id');
    }
    return {};
  });
  expect(await open(100)).toEqual({ targetId: 'panel' });
  expect(await open(100)).toEqual({ targetId: 'panel' });
  expect(clicks).toEqual(['stale', 'live', 'live']);
});

test('native panel retains unrelated protocol errors and cannot invent a live host', async () => {
  let error = 'Extensions.triggerAction: permission denied';
  const open = makeOpen(async (method) => {
    if (method === 'Target.getTargets') return { targetInfos: [
      { type: 'tab', url: 'about:blank', targetId: 'stale' },
    ] };
    if (method === 'Extensions.triggerAction') throw new Error(error);
    return {};
  });
  await expect(open(100)).rejects.toThrow('permission denied');
  error = 'Extensions.triggerAction: cannot retrieve host for the provided id';
  expect(await open(100)).toBeNull();
});
