// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
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
export const vmDeleteTool = composeTool("vm_delete", {

  execute: async (args, ctx) => {
    const authority = /** @type {{ readVm?: (id:string)=>Promise<VmRecord|null|undefined>, destroyVm?: (id:string)=>Promise<unknown> }} */ (
      /** @type {any} */ (ctx).vmAuthority);
    if (!authority?.readVm || !authority.destroyVm) {
      return { ok: false, error: 'vm_registry_unavailable' };
    }
    if (typeof args?.vmId !== 'string') return { ok: false, error: 'vmId_required' };
    const rec = await authority.readVm(args.vmId);
    if (!rec) return { ok: false, error: 'vm_not_found' };
    if (rec.pinned) return { ok: false, error: 'vm_pinned' };
    try {
      await authority.destroyVm(args.vmId);
    } catch (e) {
      return { ok: false, error: `vm_delete_failed: ${/** @type {{message?:string}} */ (e)?.message ?? String(e)}` };
    }
    return {
      ok: true,
      content: JSON.stringify({
        deleted: { id: args.vmId, name: rec.name },
      }, null, 2),
    };
  },
});
