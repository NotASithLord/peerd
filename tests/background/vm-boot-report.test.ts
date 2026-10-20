import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

// why: the boot page starts a VM at import. Exercise its actual failure bodies
// here; the registered live state covers the rendered page and route.
describe('WebVM boot failure reports', () => {
  test('both real failure bodies report the exact instance, including a failed metadata lookup', async () => {
    const source = await Bun.file('./extension/engine-tabs/vm-tab/vm-tab.js').text();
    const bodies = source.slice(source.indexOf('const failBoot ='), source.indexOf('const mountTerminal ='));
    for (const [firefox, vmId] of [[false, 'vm-live'], [false, null], [true, 'vm-live']] as const) {
      const messages: unknown[] = [];
      const context = {
        vmId, location: { hash: '#vm-from-url' },
        browser: { runtime: { sendMessage: async (message: unknown) => { messages.push(message); } } },
        setStatus() {}, setStage() {}, trace() {}, buildFirefoxWebVmNote: () => ({}),
        DOM: { bootCard: { classList: { add() {} }, querySelector: () => null, appendChild() {} } },
      };
      const functions = runInNewContext(`${bodies}; ({ failBoot, failBootFirefoxWebVM })`, context);
      if (firefox) functions.failBootFirefoxWebVM();
      else functions.failBoot('metadata', { message: 'The real lookup failed' });
      expect(messages).toEqual([{ type: 'vm/tab-failed', vmId: vmId ?? 'vm-from-url' }]);
    }
  });
});
