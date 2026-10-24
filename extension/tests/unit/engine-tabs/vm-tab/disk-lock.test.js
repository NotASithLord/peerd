// @ts-check
// The VM disk lock: one tab per disk.
//
// why in-browser (not Bun): it drives the real Web Locks API. why a test at
// all: CI never boots a VM, so this is the only automated guard that a second
// tab of the same VM is refused before it can mount the disk, while a free disk
// and a different disk are not.

import { describe, it, expect } from '../../../framework.js';
import { diskLockName, holdDiskLock } from '/engine-tabs/vm-tab/disk-lock.js';

describe('holdDiskLock', () => {
  it('holds a free disk, refuses a second holder after the wait, and leaves other disks alone', async () => {
    const key = `test-${Math.random().toString(36).slice(2)}`;
    expect(await holdDiskLock(key, { waitMs: 100 })).toBe('held');
    expect(await holdDiskLock(key, { waitMs: 100 })).toBe('busy');
    expect(await holdDiskLock(`${key}-other`, { waitMs: 100 })).toBe('held');
  });

  it('names the lock after the disk overlay key', () => {
    expect(diskLockName('peerd-vm-vm-1-abc')).toBe('peerd-vm-disk:peerd-vm-vm-1-abc');
  });

  it('reports a broken lock manager instead of refusing the boot', async () => {
    const throwing = /** @type {LockManager} */ (/** @type {unknown} */ ({
      request: () => { throw new Error('no locks'); },
    }));
    expect(await holdDiskLock('x', { waitMs: 100, locks: throwing })).toBe('unavailable');
    const rejecting = /** @type {LockManager} */ (/** @type {unknown} */ ({
      request: () => Promise.reject(new Error('quota')),
    }));
    expect(await holdDiskLock('x', { waitMs: 100, locks: rejecting })).toBe('unavailable');
  });
});
