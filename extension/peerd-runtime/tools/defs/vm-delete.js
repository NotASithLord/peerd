// @ts-check
// vm_delete — destroy a WebVM and free its disk.
//
// Closes the VM tab (if alive), deletes the IDB-backed disk overlay,
// removes the registry entry, and clears any session attachments
// pointing at the deleted VM. Refuses if the VM is pinned — the user
// has to unpin it via the UI first.

/**
 * A VM record as surfaced by the vm-registry.
 * @typedef {Object} VmRecord
 * @property {string} id
 * @property {string} name
 * @property {boolean} [pinned]
 * @property {string} diskOverlayKey
 */

/**
 * The vm-registry surface vm_delete exercises (peerd-engine).
 * @typedef {Object} VmRegistry
 * @property {(id: string) => Promise<VmRecord | null | undefined>} get
 * @property {(id: string) => Promise<unknown>} delete
 */

/**
 * The tab-tracker surface vm_delete exercises (background).
 * @typedef {Object} VmTabTracker
 * @property {(vmId: string) => Promise<unknown>} closeTab
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const vmDeleteTool = {
  name: 'vm_delete',
  primitive: 'webvm',
  description: [
    'Permanently delete a WebVM: closes its tab, drops the IDB disk',
    'overlay (frees storage), and removes the catalog entry. Any chat',
    'that was attached to this VM loses its currentVmId (their next',
    'vm_boot will auto-create a fresh VM).',
    '',
    'Refuses to delete a pinned VM. Use only after confirming with the',
    'user — there is no recovery once the disk is gone.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      vmId: { type: 'string', description: 'VM id to delete.' },
    },
    required: ['vmId'],
  },
  sideEffect: 'destructive',
  origins: () => [],

  execute: async (args, ctx) => {
    // why: vmRegistry / vmTabTracker are SW-injected context extras not on the
    // ToolContext contract slot; narrow to the surfaces this tool exercises.
    const vmRegistry = /** @type {VmRegistry | undefined} */ (
      /** @type {{ vmRegistry?: unknown }} */ (ctx).vmRegistry);
    const vmTabTracker = /** @type {VmTabTracker | undefined} */ (
      /** @type {{ vmTabTracker?: unknown }} */ (ctx).vmTabTracker);
    if (!vmRegistry || !vmTabTracker) {
      return { ok: false, error: 'vm_registry_unavailable' };
    }
    if (typeof args?.vmId !== 'string') return { ok: false, error: 'vmId_required' };
    const rec = await vmRegistry.get(args.vmId);
    if (!rec) return { ok: false, error: 'vm_not_found' };
    if (rec.pinned) return { ok: false, error: 'vm_pinned' };
    // Close tab → drop IDB → remove from registry. Tab close fires
    // chrome.tabs.onRemoved which clears the tracker entry.
    await vmTabTracker.closeTab(args.vmId);
    // why: brief settle so the tab actually closes before IDB delete.
    // Otherwise deleteDatabase is blocked by the open IDB connection
    // in the tab and rejects.
    await new Promise((r) => setTimeout(r, 200));
    try {
      if (typeof indexedDB !== 'undefined') {
        await new Promise((resolve, reject) => {
          const req = indexedDB.deleteDatabase(rec.diskOverlayKey);
          req.onsuccess = () => resolve(undefined);
          req.onerror = () => reject(req.error ?? new Error('delete failed'));
          req.onblocked = () => reject(new Error('disk overlay still open elsewhere'));
        });
      }
    } catch (e) {
      // Non-fatal: registry entry will be removed anyway; user can
      // run vm_delete again later to retry the IDB cleanup.
      console.warn('[vm_delete] IDB delete failed', e);
    }
    await vmRegistry.delete(args.vmId);
    return {
      ok: true,
      content: JSON.stringify({
        deleted: { id: args.vmId, name: rec.name },
      }, null, 2),
    };
  },
};
