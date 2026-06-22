// @ts-check
// vm_list — enumerate WebVMs available to this chat.
//
// Each WebVM is a discrete instance (its own disk, its own bash, its
// own browser tab). This tool returns the catalog so the agent can
// decide whether to attach to an existing VM (continue a project) or
// create a fresh one. The result also includes which VM the current
// chat is currently attached to.

import { serializeListResult } from './columnar.js';

/**
 * A VM record as surfaced by the vm-registry snapshot/list.
 * @typedef {Object} VmRecord
 * @property {string} id
 * @property {string} name
 * @property {boolean} [pinned]
 * @property {number} [createdAt]
 * @property {number} [lastUsedAt]
 */

/**
 * The vm-registry surface vm_list exercises (peerd-engine).
 * @typedef {Object} VmRegistry
 * @property {(opts: { sessionId?: string }) => Promise<{ vms: VmRecord[], currentVmId?: string }>} snapshot
 */

/**
 * The tab-tracker surface vm_list exercises (background).
 * @typedef {Object} VmTabTracker
 * @property {(vmId: string) => number | null | undefined} getTabId
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const vmListTool = {
  name: 'vm_list',
  primitive: 'webvm',
  description: [
    'List all WebVMs in the user\'s peerd install. Returns: id, name,',
    'pinned, createdAt, lastUsedAt, and whether the VM is currently',
    'live (has an open tab) vs dormant (no tab). Also returns this',
    'chat\'s currentVmId -- the VM vm_boot defaults to if you don\'t',
    'pass an explicit `vm`. Use this when the user mentions a previous',
    'project or you need to decide whether to reuse vs spawn fresh.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: vmRegistry / vmTabTracker are SW-injected context extras not on the
    // ToolContext contract slot; narrow to the surfaces this tool exercises.
    const vmRegistry = /** @type {VmRegistry | undefined} */ (
      /** @type {{ vmRegistry?: unknown }} */ (ctx).vmRegistry);
    const vmTabTracker = /** @type {VmTabTracker | undefined} */ (
      /** @type {{ vmTabTracker?: unknown }} */ (ctx).vmTabTracker);
    if (!vmRegistry) return { ok: false, error: 'vm_registry_unavailable' };
    const sessionId = ctx.session?.sessionId;
    const snap = await vmRegistry.snapshot({ sessionId });
    const vms = snap.vms.map((vm) => ({
      id: vm.id,
      name: vm.name,
      pinned: vm.pinned,
      createdAt: vm.createdAt,
      lastUsedAt: vm.lastUsedAt,
      live: vmTabTracker?.getTabId(vm.id) != null,
      isCurrent: vm.id === snap.currentVmId,
    }));
    return {
      ok: true,
      content: serializeListResult({
        currentVmId: snap.currentVmId,
        count: vms.length,
        vms,
      }, 'vms'),
    };
  },
};
