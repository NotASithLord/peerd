// @ts-check

// Exact WebVM authority for one admitted semantic tool call. The call and
// SW-owned session/actor context are closed over, so the controller cannot
// select another VM, URL, file, timeout, or destructive target after admission.

const mismatch = () => Object.assign(new Error('VM authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {{binding:any,ctx:any,signal?:AbortSignal,shared?:any}} input */
export const createVmToolAuthority = ({ binding, ctx, signal = ctx?.abortSignal, shared = {} }) => {
  const args = binding.args;
  const sessionId = ctx?.session?.sessionId;
  const boundVmId = ctx?.actorType === 'webvm' ? ctx.actorInstanceId : null;
  const requireBoundVm = (/** @type {unknown} */ vmId) => {
    if (boundVmId && vmId !== boundVmId) throw mismatch();
  };

  const requireOperation = (/** @type {string} */ name) => {
    if (binding.operation !== name) throw mismatch();
  };
  const requireLive = () => {
    if (!signal?.aborted) return;
    throw Object.assign(new Error('VM operation stopped before mutation'), {
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    });
  };

  return Object.freeze({
    readVm: async (/** @type {string} */ vmId) => {
      if (binding.operation !== 'turn.vm.read'
          || typeof vmId !== 'string' || typeof ctx?.vmRegistry?.get !== 'function') {
        throw mismatch();
      }
      if (vmId !== args.vmId) throw mismatch();
      requireBoundVm(vmId);
      const record = await ctx.vmRegistry.get(vmId);
      if (record) shared.resolvedVmId = vmId;
      shared.inspected = record ?? null;
      return record ? { id: record.id, name: record.name, pinned: record.pinned === true } : null;
    },
    listVms: async () => {
      requireOperation('turn.vm.list');
      if (typeof ctx?.vmRegistry?.list !== 'function') {
        throw mismatch();
      }
      const records = await ctx.vmRegistry.list();
      return records.filter((/** @type {any} */ record) => !boundVmId || record.id === boundVmId)
        .map((/** @type {any} */ record) => ({ id: record.id, name: record.name }));
    },
    setDefaultVm: async (/** @type {string} */ vmId) => {
      requireOperation('turn.vm.set-default');
      if (typeof vmId !== 'string' || typeof ctx?.vmRegistry?.get !== 'function') throw mismatch();
      const record = await ctx.vmRegistry.get(vmId);
      if (!record || vmId !== args.vmId) throw mismatch();
      requireBoundVm(vmId);
      shared.resolvedVmId = vmId;
      if (!sessionId) return false;
      if (typeof ctx?.vmRegistry?.setDefaultForSession !== 'function') throw mismatch();
      requireLive();
      await ctx.vmRegistry.setDefaultForSession(sessionId, vmId);
      return true;
    },
    runVm: (/** @type {string} */ command, /** @type {number} */ timeoutMs,
      /** @type {string|undefined} */ vmId) => {
      requireOperation('turn.vm.run');
      if (command !== args.command || timeoutMs !== args.timeoutMs
          || vmId !== args.vmId || boundVmId && vmId !== undefined && vmId !== boundVmId
          || typeof ctx?.vm?.run !== 'function') throw mismatch();
      return ctx.vm.run(command, { timeoutMs, sessionId, vmId: boundVmId ?? vmId });
    },
    importFile: async (/** @type {string} */ url, /** @type {string} */ path,
      /** @type {number} */ maxBytes) => {
      requireOperation('turn.vm.import-file');
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
      try {
        requireLive();
        await ctx.vm.writeFile(path, new Uint8Array(buffer), {
          sessionId, ...(boundVmId ? { vmId: boundVmId } : {}),
        });
      }
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
      requireOperation('turn.vm.write-text-file');
      if (path !== args.path || content !== args.content
          || typeof ctx?.vm?.writeFile !== 'function') throw mismatch();
      return ctx.vm.writeFile(path, new TextEncoder().encode(content), {
        sessionId, ...(boundVmId ? { vmId: boundVmId } : {}),
      });
    },
    destroyVm: async (/** @type {string} */ vmId) => {
      requireOperation('turn.vm.destroy');
      requireBoundVm(vmId);
      if (vmId !== args.vmId || shared.inspected?.id !== vmId || shared.inspected?.pinned
          || typeof ctx?.vmRegistry?.get !== 'function'
          || typeof ctx?.vmRegistry?.delete !== 'function'
          || typeof ctx?.vmTabTracker?.closeTab !== 'function') throw mismatch();
      const fresh = await ctx.vmRegistry.get(vmId);
      if (!fresh || fresh.pinned === true) throw mismatch();
      requireLive();
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

export const bindVmToolAuthority = (/** @type {any} */ state, /** @type {any} */ input) => {
  const binding = Object.freeze({ operation: input.operation, args: structuredClone(input.args) });
  return createVmToolAuthority({ ...input, binding, shared: state });
};
