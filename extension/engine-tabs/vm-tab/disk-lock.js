// @ts-check
// vm-tab/disk-lock.js: one tab per VM disk.
//
// why: the per-VM IndexedDB overlay IS the VM's disk. Two tabs that mount it at
// once each write their own blocks, and the next boot finds a corrupt
// filesystem (a directory came back as an empty file, with every file gone).
// The service worker's tab tracker cannot guard this on its own: after a worker
// restart it adopts every open tab of the VM and the last one wins. A Web Lock
// is scoped like the disk (per origin), and the browser releases it when the
// holding tab closes, crashes or reloads, so the guard needs no bookkeeping.
//
// why a short wait instead of ifAvailable: Cmd-R and the vm-client self-heal
// reload create the new document while the old one is still releasing the lock.
//
// why a module (not inline in vm-tab.js): vm-tab.js is a page script, and CI
// never boots a VM, so this is the only automated guard on the lock.

export const DISK_LOCK_WAIT_MS = 3000;

/** @param {string} diskOverlayKey */
export const diskLockName = (diskOverlayKey) => `peerd-vm-disk:${diskOverlayKey}`;

/**
 * Hold the disk lock for the rest of this document's life.
 * @param {string} diskOverlayKey
 * @param {{ waitMs?: number, locks?: LockManager }} [opts]
 * @returns {Promise<'held' | 'busy' | 'unavailable'>}
 */
export const holdDiskLock = (diskOverlayKey, { waitMs = DISK_LOCK_WAIT_MS, locks = navigator.locks } = {}) => new Promise((resolve) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), waitMs);
  /** @type {Promise<unknown>} */
  let request;
  try {
    request = locks.request(diskLockName(diskOverlayKey), { signal: abort.signal }, () => {
      clearTimeout(timer);
      resolve('held');
      // why never settle: the lock lives exactly as long as this document.
      return new Promise(() => {});
    });
  } catch {
    clearTimeout(timer);
    resolve('unavailable');
    return;
  }
  request.catch((/** @type {{ name?: string }} */ error) => {
    clearTimeout(timer);
    resolve(error?.name === 'AbortError' ? 'busy' : 'unavailable');
  });
});
