import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Regression guard. The VM disk lock (disk-lock.js) protects the disk only
// when vm-tab.js takes it after the record is known and BEFORE the IDB overlay
// mounts. A refused tab must also drop the vmId from its URL, or the tab
// tracker adopts it after a service-worker restart and the last tab wins.
describe('vm-tab disk lock', () => {
  test('is taken after the record loads and before the disk mounts, and a refused tab leaves the URL', () => {
    const src = readFileSync('extension/engine-tabs/vm-tab/vm-tab.js', 'utf8');
    const boot = src.slice(src.indexOf('const boot = async () => {'));
    const recordAt = boot.indexOf('record = await loadVmRecord()');
    const lockAt = boot.indexOf('await holdDiskLock(diskOverlayKey)');
    const refuseAt = boot.indexOf("history.replaceState(null, '', location.pathname)");
    const mountAt = boot.indexOf('IDBDevice.create(diskOverlayKey)');
    expect(recordAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeGreaterThan(recordAt);
    expect(refuseAt).toBeGreaterThan(lockAt);
    expect(mountAt).toBeGreaterThan(refuseAt);
  });
});
