// @ts-check

// Exact WebVM authority for one admitted semantic tool call. The call and
// SW-owned session/actor context are closed over, so the controller cannot
// select another VM, URL, file, timeout, or destructive target after admission.

const mismatch = () => Object.assign(new Error('VM authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {{call:any,ctx:any}} input */
export const createVmToolAuthority = ({ call, ctx }) => {
  const args = call?.args ?? {};
  const sessionId = ctx?.session?.sessionId;
  /** @type {any} */ let inspected = null;
  /** @type {string|undefined} */ let resolvedVmId;

  const requireTool = (/** @type {string} */ name) => {
    if (call?.name !== name) throw mismatch();
  };

  return Object.freeze({
    readVm: async (/** @type {string} */ vmId) => {
      if (!['vm_boot', 'vm_delete'].includes(call?.name)
          || typeof vmId !== 'string' || typeof ctx?.vmRegistry?.get !== 'function') {
        throw mismatch();
      }
      if (call.name === 'vm_boot') {
        const wanted = typeof args.vm === 'string' ? args.vm.trim() : '';
        if (!wanted.startsWith('vm-') || vmId !== wanted) throw mismatch();
      } else if (vmId !== args.vmId) throw mismatch();
      const record = await ctx.vmRegistry.get(vmId);
      if (record && call.name === 'vm_boot') resolvedVmId = vmId;
      if (call.name === 'vm_delete') inspected = record ?? null;
      return record ? { id: record.id, name: record.name, pinned: record.pinned === true } : null;
    },
    listVms: async () => {
      requireTool('vm_boot');
      const wanted = typeof args.vm === 'string' ? args.vm.trim() : '';
      if (!wanted || wanted.startsWith('vm-') || typeof ctx?.vmRegistry?.list !== 'function') {
        throw mismatch();
      }
      const records = await ctx.vmRegistry.list();
      return records.map((/** @type {any} */ record) => ({ id: record.id, name: record.name }));
    },
    setDefaultVm: async (/** @type {string} */ vmId) => {
      requireTool('vm_boot');
      if (typeof vmId !== 'string' || typeof ctx?.vmRegistry?.get !== 'function') throw mismatch();
      const wanted = typeof args.vm === 'string' ? args.vm.trim() : '';
      if (!wanted) throw mismatch();
      const record = await ctx.vmRegistry.get(vmId);
      if (!record || (wanted.startsWith('vm-') ? vmId !== wanted
        : String(record.name).toLowerCase() !== wanted.toLowerCase())) throw mismatch();
      resolvedVmId = vmId;
      if (!sessionId) return undefined;
      if (typeof ctx?.vmRegistry?.setDefaultForSession !== 'function') throw mismatch();
      return ctx.vmRegistry.setDefaultForSession(sessionId, vmId);
    },
    runVm: (/** @type {string} */ command, /** @type {number} */ timeoutMs,
      /** @type {string|undefined} */ vmId) => {
      requireTool('vm_boot');
      const expectedTimeout = Math.min(300_000, Math.max(1000, Number(args.timeoutMs ?? 60_000)));
      const explicit = typeof args.vm === 'string' && args.vm.trim();
      if (command !== args.cmd || timeoutMs !== expectedTimeout
          || (explicit && vmId !== resolvedVmId)
          || (!explicit && vmId !== undefined)
          || typeof ctx?.vm?.run !== 'function') throw mismatch();
      return ctx.vm.run(command, { timeoutMs, sessionId, vmId });
    },
    importFile: async (/** @type {string} */ url, /** @type {string} */ path,
      /** @type {number} */ maxBytes) => {
      requireTool('vm_import');
      if (url !== args.url || path !== args.path || maxBytes !== 50 * 1024 * 1024
          || typeof ctx?.webFetch !== 'function' || typeof ctx?.vm?.writeFile !== 'function') {
        throw mismatch();
      }
      let response;
      let buffer;
      try {
        response = await ctx.webFetch(url);
        if (!response.ok) throw Object.assign(new Error(`fetch_failed: HTTP ${response.status}`), {
          outcomeKnown: true, expectedFetchFailure: true,
        });
        buffer = await response.arrayBuffer();
      }
      catch (cause) {
        const detail = /** @type {{name?:string,message?:string,expectedFetchFailure?:boolean}} */ (cause);
        if (detail?.expectedFetchFailure) throw cause;
        throw Object.assign(new Error(`fetch_threw: ${detail?.name ?? 'Error'}: ${detail?.message ?? String(cause)}`), {
          outcomeKnown: true,
        });
      }
      if (buffer.byteLength > maxBytes) throw Object.assign(
        new Error(`payload_too_large: ${buffer.byteLength}B > ${maxBytes}B`),
        { outcomeKnown: true },
      );
      try { await ctx.vm.writeFile(path, new Uint8Array(buffer), { sessionId }); }
      catch (cause) {
        const detail = /** @type {{name?:string,message?:string}} */ (cause);
        throw new Error(`write_threw: ${detail?.name ?? 'Error'}: ${detail?.message ?? String(cause)}`);
      }
      return {
        bytes: buffer.byteLength, status: response.status,
        contentType: response.headers.get('content-type') ?? '',
      };
    },
    writeTextFile: (/** @type {string} */ path, /** @type {string} */ content) => {
      requireTool('vm_write_file');
      if (path !== args.path || content !== args.content
          || typeof ctx?.vm?.writeFile !== 'function') throw mismatch();
      return ctx.vm.writeFile(path, new TextEncoder().encode(content), { sessionId });
    },
    destroyVm: async (/** @type {string} */ vmId) => {
      requireTool('vm_delete');
      if (vmId !== args.vmId || inspected?.id !== vmId || inspected?.pinned
          || typeof ctx?.vmRegistry?.get !== 'function'
          || typeof ctx?.vmRegistry?.delete !== 'function'
          || typeof ctx?.vmTabTracker?.closeTab !== 'function') throw mismatch();
      const fresh = await ctx.vmRegistry.get(vmId);
      if (!fresh || fresh.pinned === true) throw mismatch();
      await ctx.vmTabTracker.closeTab(vmId);
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        if (typeof indexedDB !== 'undefined' && typeof fresh.diskOverlayKey === 'string') {
          await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(fresh.diskOverlayKey);
            request.onsuccess = () => resolve(undefined);
            request.onerror = () => reject(request.error ?? new Error('delete failed'));
            request.onblocked = () => reject(new Error('disk overlay still open elsewhere'));
          });
        }
      } catch (cause) {
        // Disk cleanup was historically best effort; catalog deletion remains the
        // authoritative lifecycle mutation and preserves retry behavior.
        console.warn('[vm_delete] IDB delete failed', cause);
      }
      return ctx.vmRegistry.delete(vmId);
    },
  });
};
