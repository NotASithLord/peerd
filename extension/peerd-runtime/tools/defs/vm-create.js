// @ts-check
// vm_create — spin up a fresh WebVM instance.
//
// Creates a new VM record + spawns a browser tab that takes focus, so
// the user immediately sees the terminal appear (DECISIONS #20). The new
// VM is set as the current chat's default, so the next vm_boot routes
// there. The tab is grouped under "peerd".

import { VM_TAB_GROUP_TITLE } from '/background/vm-client.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const vmCreateTool = {
  name: 'vm_create',
  primitive: 'webvm',
  description: [
    'Create a fresh, isolated WebVM with its own disk and bash shell.',
    'Returns the new vmId and name. The new VM becomes the chat\'s',
    'current -- subsequent vm_boot calls (without an explicit `vm`',
    'arg) route here. Use this when starting a new project that',
    'shouldn\'t share state with the chat\'s prior VM.',
    '',
    'Optional: pass a name to label the VM (visible in the tab strip',
    'and in vm_list output). Defaults to a generated name.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-friendly name (≤40 chars).' },
    },
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    // why: the VM registry + tab tracker ride the opaque ctx contract
    // (not on the ToolContext typedef); narrow to the surface this tool uses.
    const vmRegistry = /** @type {{ create: (opts: { name?: string, ownerSessionId: string | null }) => Promise<{ id: string, name: string }>, setDefaultForSession: (sessionId: string, id: string) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).vmRegistry);
    const vmTabTracker = /** @type {{ ensureTab: (id: string, opts: { active?: boolean, groupTitle?: string }) => Promise<unknown>, getTabId?: (id: string) => number | null | undefined } | undefined} */ (
      /** @type {any} */ (ctx).vmTabTracker);
    if (!vmRegistry || !vmTabTracker) {
      return { ok: false, error: 'vm_registry_unavailable' };
    }
    const sessionId = ctx.session?.sessionId;
    let name = typeof args?.name === 'string' ? args.name.trim().slice(0, 40) : '';
    if (!name) name = undefined;
    const record = await vmRegistry.create({
      name,
      ownerSessionId: sessionId ?? null,
    });
    // why background: a VM tab no longer steals focus (DESIGN-12, owner
    // 2026-06-18) — it opens quietly and the tab tracker drops a "go there" card
    // in the chat; the user clicks to watch the terminal. A background tab can
    // miss the readiness timeout but it WAS created + announced — only fail if it
    // truly didn't open.
    try {
      await vmTabTracker.ensureTab(record.id, {
        active: false,
        groupTitle: VM_TAB_GROUP_TITLE,
      });
    } catch (e) {
      if (vmTabTracker.getTabId?.(record.id) == null) {
        return { ok: false, error: `vm_spawn_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
      }
    }
    // Mark as the chat's current VM if we have a session.
    if (sessionId) {
      await vmRegistry.setDefaultForSession(sessionId, record.id);
    }
    return {
      ok: true,
      content: JSON.stringify({
        id: record.id,
        name: record.name,
        isCurrent: !!sessionId,
      }, null, 2),
    };
  },
};