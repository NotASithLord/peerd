// @ts-check
// The webvm arm of sandbox_create — spin up a fresh WebVM instance.
// (Was the standalone vm_create tool; merged into sandbox_create({kind:'webvm'})
// 2026-07-05: one kind-discriminated create tool.)
//
// Creates a new VM record + spawns a browser tab that takes focus, so
// the user immediately sees the terminal appear (DECISIONS #20). The new
// VM is set as the current chat's default, so the next vm_boot routes
// there. The tab is grouped under "peerd".

/**
 * Create a WebVM record + its background tab; returns { id, name, kind, isCurrent }.
 * @param {any} args @param {import('/shared/tool-types.js').ToolContext} ctx
 * @returns {Promise<import('/shared/tool-types.js').ToolResult>}
 */
export const createWebVmSandbox = async (args, ctx) => {
    const authority = /** @type {any} */ (ctx).executionAuthority;
    if (!authority?.createWebVm) return { ok: false, error: 'vm_registry_unavailable' };
    const created = await authority.createWebVm(args);
    if (!created?.ok) return created;
    const { record, isCurrent } = created;
    return {
      ok: true,
      content: JSON.stringify({
        id: record.id,
        name: record.name,
        // why kind: the merged sandbox_create result is the durable-handle
        // carrier — instance-handle.js reads it to label the harvested id.
        kind: 'webvm',
        isCurrent,
      }, null, 2),
    };
  };
