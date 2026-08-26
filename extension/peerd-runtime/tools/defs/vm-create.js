// @ts-check
// The webvm arm of sandbox_create — spin up a fresh WebVM instance.
// (Was the standalone vm_create tool; merged into sandbox_create({kind:'webvm'})
// 2026-07-05: one kind-discriminated create tool.)
//
// Creates a new VM record + spawns a browser tab that takes focus, so
// the user immediately sees the terminal appear (DECISIONS #20). The new
// VM is set as the current chat's default, so the next vm_boot routes
// there. The tab is grouped under "peerd".

import { ENGINE_TAB_GROUP_TITLE } from '/shared/engine-tab-group.js';

/**
 * Create a WebVM record + its background tab; returns { id, name, kind, isCurrent }.
 * @param {any} args @param {import('/shared/tool-types.js').ToolContext} ctx
 * @returns {Promise<import('/shared/tool-types.js').ToolResult>}
 */
export const createWebVmSandbox = async (args, ctx) => {
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
        groupTitle: ENGINE_TAB_GROUP_TITLE,
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
        // why kind: the merged sandbox_create result is the durable-handle
        // carrier — instance-handle.js reads it to label the harvested id.
        kind: 'webvm',
        isCurrent: !!sessionId,
      }, null, 2),
    };
  };
