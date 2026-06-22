// @ts-check
// SW-side VM client.
//
// Each WebVM is a discrete browser tab. This client resolves a target
// VM (either explicit vmId or the session's current default), ensures
// a tab is alive for it, and dispatches vm/* messages to that tab via
// chrome.tabs.sendMessage. The tab runs CheerpX + bash + xterm and
// responds with the structured result.
//
// Lifecycle:
//   - The session's default VM is created lazily on the first vm.run
//     call (so trivial vm_boot uses "just work" for any chat).
//   - A VM tab takes focus when it's first CREATED (the user sees the
//     terminal appear); ensureTab early-returns for a live tab, so later
//     commands to an existing VM never steal focus (DECISIONS #20, 2026-06-14).
//   - Multiple VMs run concurrently; each gets its own tab.
//   - Commands to ONE VM are serialized through a per-VM FIFO lane
//     (createKeyedQueue): the tab's persistent bash has a single output
//     capture, so concurrent vm/run RPCs would clobber each other's
//     stdout/exit markers. Different VMs' lanes stay concurrent.
//   - When a VM's tab closes mid-flight, the SW's tabs.onRemoved wiring
//     calls onTabClosed(vmId) and every pending RPC for that VM rejects
//     promptly with VMTabClosedError instead of stalling out the 90s
//     message timeout.

import browser from '/vendor/browser-polyfill.js';
import { bytesToBase64 } from '/shared/util.js';
import {
  VMNotReadyError,
  VMBootFailedError,
  VMRunTimeoutError,
  VMNetworkDeniedError,
  VMTabClosedError,
  createKeyedQueue,
} from '/peerd-engine/index.js';

// why ...any[]: these classes have genuinely different constructor arities
// (VMRunTimeoutError(cmd, timeoutMs) vs VMNotReadyError(reason)); reviveError
// always calls with one string and then overrides .message, so the variadic
// shape is the honest common supertype here.
/** @type {Record<string, new (...args: any[]) => Error>} */
const KNOWN_VM_ERRORS = {
  VMNotReadyError, VMBootFailedError, VMRunTimeoutError, VMNetworkDeniedError,
  VMTabClosedError,
};

/** @param {unknown} error @returns {Error} */
const reviveError = (error) => {
  if (typeof error !== 'string') return new Error(String(error));
  const m = /^(\w+Error):\s*(.*)$/s.exec(error);
  if (m && KNOWN_VM_ERRORS[m[1]]) {
    const revived = new KNOWN_VM_ERRORS[m[1]](m[2]);
    // why override: some typed errors take (cmd, timeoutMs)-style args, not a
    // message — reconstructing from the string would re-wrap it ("VM run timed
    // out after undefinedms: …"). Keep the real tab-side message verbatim.
    revived.message = m[2];
    return revived;
  }
  return new Error(error);
};

// 90s round-trip timeout. The tab itself enforces per-run timeouts;
// this is the belt-and-suspenders against a hung message channel.
const MESSAGE_TIMEOUT_MS = 90_000;

/** Group title used when auto-grouping VM tabs in the tab strip. */
export const VM_TAB_GROUP_TITLE = 'peerd';

/**
 * Reply shape from the VM tab's vm/* handlers. Dynamic over the message
 * channel — typed to the fields the client reads back.
 * @typedef {{ ok?: boolean, error?: string, result?: { stdout: string, stderr: string, exitCode: number, durationMs: number }, ready?: boolean }} VmTabReply
 */

/**
 * @param {Object} deps
 * @param {ReturnType<typeof import('/peerd-engine/index.js').createVmRegistry>} deps.registry
 * @param {ReturnType<typeof import('./vm-tab-tracker.js').createVmTabTracker>} deps.tracker
 * @param {(tabId: number, message: object) => Promise<any>} [deps.sendTabMessage]
 *   Injected message IO (defaults to browser.tabs.sendMessage) so the
 *   queue/interrupt behavior is testable without live VM tabs.
 * @returns {{
 *   run(cmd: string, opts?: { sessionId?: string, vmId?: string, toolUseId?: string, timeoutMs?: number }):
 *     Promise<{ stdout: string, stderr: string, exitCode: number, durationMs: number }>,
 *   writeFile(path: string, bytes: Uint8Array, opts?: { sessionId?: string, vmId?: string }): Promise<void>,
 *   isReady(opts?: { sessionId?: string, vmId?: string }): Promise<boolean>,
 *   reset(opts?: { sessionId?: string, vmId?: string }): Promise<void>,
 *   resolveVmId(opts: { sessionId?: string, vmId?: string }): Promise<string>,
 *   onTabClosed(vmId: string): void,
 * }}
 */
export const createVmClient = ({
  registry,
  tracker,
  sendTabMessage = (tabId, message) => browser.tabs.sendMessage(tabId, message),
}) => {
  // One keyed queue, two key namespaces:
  //   cmd:<vmId>          — the per-VM command lane (run/writeFile).
  //   resolve:<sessionId> — serializes lazy default-VM resolution, so
  //     two concurrent first-commands in a chat don't BOTH see "no
  //     default yet" and race to create two different VMs (they'd then
  //     land on different lanes and the serialization above would be
  //     moot for the very calls it exists for).
  const queue = createKeyedQueue();
  /** @param {string} vmId */
  const commandKey = (vmId) => `cmd:${vmId}`;

  /**
   * Resolve which VM this call targets. Precedence:
   *   1. Explicit opts.vmId.
   *   2. The session's currentVmId from the registry.
   *   3. Create a fresh VM owned by this session and set it as current.
   * @param {{ sessionId?: string, vmId?: string }} [opts]
   * @returns {Promise<string>}
   */
  const resolveVmId = async ({ sessionId, vmId } = {}) => {
    if (vmId) {
      const rec = await registry.get(vmId);
      if (!rec) throw new VMNotReadyError(`vm not found: ${vmId}`);
      return vmId;
    }
    if (!sessionId) {
      throw new VMNotReadyError('sessionId or vmId required to resolve a VM');
    }
    const defaultId = await registry.getDefaultForSession(sessionId);
    if (defaultId) return defaultId;
    const shortChat = sessionId.length > 6 ? sessionId.slice(-6) : sessionId;
    const created = await registry.create({
      name: `chat-${shortChat}`,
      ownerSessionId: sessionId,
      pinned: false,
    });
    await registry.setDefaultForSession(sessionId, created.id);
    return created.id;
  };

  /**
   * resolveVmId behind the session lane when the target is implicit
   * (see the queue header comment). Explicit vmId lookups are pure
   * reads — no creation race — so they skip the lane.
   * @param {{ sessionId?: string, vmId?: string }} [opts]
   */
  const resolveVmIdQueued = (opts = {}) => {
    if (opts.vmId || !opts.sessionId) return resolveVmId(opts);
    return queue.enqueue(`resolve:${opts.sessionId}`, () => resolveVmId(opts));
  };

  /**
   * Ensure a tab exists + ready for vmId. Sends the message. Wraps the
   * round-trip with a hard timeout.
   * @param {string} vmId @param {{ type: string, [k: string]: unknown }} message
   * @returns {Promise<VmTabReply>}
   */
  const callTab = async (vmId, message) => {
    // background: agent-driven VM tabs never steal focus (DESIGN-12, 2026-06-18).
    // vm_create already dropped a "go there" card; an auto-create here (run before
    // create) opens quietly too. ensureTab early-returns for a live tab.
    await tracker.ensureTab(vmId, { active: false, groupTitle: VM_TAB_GROUP_TITLE });
    const tabId = tracker.getTabId(vmId);
    if (tabId == null) throw new VMNotReadyError(`no live tab for ${vmId} after ensureTab`);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutId;
    /** @type {Promise<never>} */
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(
          `vm ${message.type} timed out after ${MESSAGE_TIMEOUT_MS / 1000}s `
          + `(tab ${tabId} unresponsive). Reload or reset the VM.`,
        ));
      }, MESSAGE_TIMEOUT_MS);
    });
    /** @type {VmTabReply} */
    let response;
    try {
      response = /** @type {VmTabReply} */ (await Promise.race([
        sendTabMessage(tabId, { ...message, vmId }),
        timeoutPromise,
      ]));
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response || response.ok !== true) {
      throw reviveError(response?.error ?? 'vm call returned no response');
    }
    return response;
  };

  return {
    resolveVmId,

    run: async (cmd, opts = {}) => {
      const targetVmId = await resolveVmIdQueued(opts);
      // why enqueue the whole callTab (ensureTab included): a respawn
      // after tab close belongs inside the lane too, so a queued command
      // never races the respawn the command ahead of it triggered.
      const response = await queue.enqueue(commandKey(targetVmId), () => callTab(targetVmId, {
        type: 'vm/run',
        cmd,
        sessionId: opts.sessionId,
        toolUseId: opts.toolUseId,
        timeoutMs: opts.timeoutMs,
      }));
      // why the guard: callTab already threw unless ok, and a successful
      // vm/run always carries result — this expresses that invariant to tsc
      // (result is optional on the shared reply shape) without changing flow.
      if (!response.result) throw new VMNotReadyError('vm/run returned no result');
      return response.result;
    },

    writeFile: async (path, bytes, opts = {}) => {
      if (!(bytes instanceof Uint8Array)) {
        throw new VMNotReadyError('vm.writeFile: bytes must be a Uint8Array');
      }
      const targetVmId = await resolveVmIdQueued(opts);
      // why the lane: writeFile stages bytes then runs `cp` through the
      // SAME persistent bash as vm/run — it conflicts like any command.
      await queue.enqueue(commandKey(targetVmId), () => callTab(targetVmId, {
        type: 'vm/write-file',
        path,
        b64: bytesToBase64(bytes),
      }));
    },

    // why isReady bypasses the command lane: it's a liveness probe — it
    // must answer while a long command holds the lane, and vm/is-ready
    // never touches the persistent shell, so it can't clobber anything.
    isReady: async (opts = {}) => {
      try {
        const targetVmId = await resolveVmId(opts);
        const tabId = tracker.getTabId(targetVmId);
        if (tabId == null) return false;
        const response = await callTab(targetVmId, { type: 'vm/is-ready' });
        return response.ready === true;
      } catch {
        return false;
      }
    },

    /**
     * Called from the SW's tabs.onRemoved wiring (after the tracker
     * drops the tabId↔vmId entry). Rejects the in-flight RPC and drains
     * the queued ones so callers get a prompt, named tool error instead
     * of a ~90s stall against a tab that no longer exists.
     */
    onTabClosed: (vmId) => {
      queue.interrupt(commandKey(vmId), new VMTabClosedError(vmId));
    },

    reset: async (opts = {}) => {
      // Resolve without auto-creating; "reset" against a non-existent
      // VM is meaningless. If no current VM, treat as no-op success.
      const sessionId = opts.sessionId;
      const explicitVmId = opts.vmId;
      /** @type {string | null | undefined} */
      let targetVmId = explicitVmId;
      if (!targetVmId && sessionId) {
        targetVmId = await registry.getDefaultForSession(sessionId);
      }
      if (!targetVmId) return;
      // Reset = tab reload. Tab reload re-mounts the same IDB overlay
      // so disk state is preserved; only the bash session is recycled.
      const tabId = tracker.getTabId(targetVmId);
      if (tabId == null) return;       // already cold; next call will boot fresh
      try {
        await browser.tabs.reload(tabId);
      } catch (e) {
        throw reviveError(/** @type {{ message?: string }} */ (e)?.message ?? String(e));
      }
      // why: the reload recycles the page — the in-flight RPC's response
      // is never coming (old document is gone) and queued commands were
      // aimed at the pre-reset shell. Same prompt-rejection treatment as
      // a closed tab, but with a not-ready error: the tab still exists
      // and is mid-(re)boot.
      queue.interrupt(
        commandKey(targetVmId),
        new VMNotReadyError(`vm ${targetVmId} was reset while commands were pending`),
      );
    },
  };
};
