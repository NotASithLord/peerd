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

import browser from '/shared/browser-api.js';
import { bytesToBase64 } from '/shared/util.js';
import {
  VMNotReadyError,
  VMBootFailedError,
  VMRunTimeoutError,
  VMNetworkDeniedError,
  VMTabClosedError,
  createKeyedQueue,
} from '/peerd-engine/background.js';
import { createEngineInstanceResolver, raceTabReply, shortSessionSuffix } from './engine-process.js';

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

// A reused VM tab idle longer than this may have been frozen by the browser's
// background-tab throttling (CheerpX execution stops while the tab still half-
// answers). On reuse past this window, probe it before sending the real command.
const IDLE_REUSE_PROBE_MS = 60_000;
// The cheap liveness probe's CEILING — not a fixed wait: an alive tab answers
// vm/is-ready in milliseconds (the probe resolves the instant it replies), so a short
// ceiling never false-fails a healthy idle tab — it just needs margin over the
// round-trip for a momentarily-busy SW. Kept aggressive on purpose: a frozen CheerpX
// shell often stays wedged even after the tab resumes, so a fresh reload is MORE
// reliable than waiting to resurrect it — and a needless reload of a slow-to-wake tab
// costs only the idle in-memory bash session (disk persists via the IDB overlay).
// recreateTab then does the real up-to-30s boot wait.
const READY_PROBE_TIMEOUT_MS = 700;

/** Group title used when auto-grouping VM tabs in the tab strip. */
export const VM_TAB_GROUP_TITLE = 'peerd';

/**
 * Reply shape from the VM tab's vm/* handlers. Dynamic over the message
 * channel — typed to the fields the client reads back.
 * @typedef {{ ok?: boolean, error?: string, result?: { stdout: string, stderr: string, exitCode: number, durationMs: number, timing?: { totalMs: number, tailMs: number } }, ready?: boolean, shellExited?: boolean }} VmTabReply
 */

/**
 * @param {Object} deps
 * @param {ReturnType<typeof import('/peerd-engine/background.js').createVmRegistry>} deps.registry
 * @param {ReturnType<typeof import('./tab-tracker.js').createVmTabTracker>} deps.tracker
 * @param {(tabId: number, message: object) => Promise<any>} [deps.sendTabMessage]
 *   Injected message IO (defaults to browser.tabs.sendMessage) so the
 *   queue/interrupt behavior is testable without live VM tabs.
 * @param {number} [deps.messageTimeoutMs]
 *   Round-trip timeout before a tab is declared wedged (default 90s). Injected
 *   short in tests so the self-heal path runs without a real 90s wait.
 * @param {number} [deps.idleProbeMs]
 *   Idle window past which a REUSED tab is liveness-probed before use (default 60s).
 * @param {number} [deps.readyProbeMs]
 *   Timeout for that cheap liveness probe (default 4s).
 * @param {() => number} [deps.now]
 *   Clock for idle tracking (default Date.now); injected in tests.
 * @returns {{
 *   run(cmd: string, opts?: { sessionId?: string, vmId?: string, timeoutMs?: number }):
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
  messageTimeoutMs = MESSAGE_TIMEOUT_MS,
  idleProbeMs = IDLE_REUSE_PROBE_MS,
  readyProbeMs = READY_PROBE_TIMEOUT_MS,
  now = () => Date.now(),
}) => {
  // One keyed queue, two key namespaces:
  //   cmd:<vmId>          — the per-VM command lane (run/writeFile).
  //   resolve:<sessionId> — serializes lazy default-VM resolution, so
  //     two concurrent first-commands in a chat don't BOTH see "no
  //     default yet" and race to create two different VMs (they'd then
  //     land on different lanes and the serialization above would be
  //     moot for the very calls it exists for).
  const queue = createKeyedQueue();
  /** @type {Map<string, number>} last successful round-trip per vmId, for the idle-reuse freeze probe. */
  const lastUsed = new Map();
  /** @param {string} vmId */
  const commandKey = (vmId) => `cmd:${vmId}`;

  // why the shared resolver: explicit vmId, then the session's currentVmId,
  // then a fresh VM owned by this session (set as current) is the precedence
  // every engine kind uses. Implicit resolution runs on this client's
  // resolve:<sessionId> lane (see the queue note above).
  const instances = createEngineInstanceResolver({
    registry,
    queue,
    notFound: (id) => new VMNotReadyError(`vm not found: ${id}`),
    missingTarget: () => new VMNotReadyError('sessionId or vmId required to resolve a VM'),
    createOptions: (sessionId) => ({
      name: `chat-${shortSessionSuffix(sessionId)}`,
      ownerSessionId: sessionId,
      pinned: false,
    }),
  });
  /** @param {{ sessionId?: string, vmId?: string }} [opts] @returns {Promise<string>} */
  const resolveVmId = ({ sessionId, vmId } = {}) => instances.resolve({ sessionId, id: vmId });
  /** @param {{ sessionId?: string, vmId?: string }} [opts] @returns {Promise<string>} */
  const resolveVmIdQueued = ({ sessionId, vmId } = {}) =>
    instances.resolveQueued({ sessionId, id: vmId });

  /**
   * One round-trip to the tab, raced against a hard timeout. A timeout here means
   * the PAGE stopped answering (distinct from the tab's own per-run timeout, which
   * comes back as a normal error reply) — tag it so callers can tell a wedged tab
   * from a slow command. timeoutMs defaults to the full channel timeout; the cheap
   * liveness probe passes a short one.
   * @param {number} tabId @param {string} vmId
   * @param {{ type: string, [k: string]: unknown }} message
   * @param {number} [timeoutMs]
   * @returns {Promise<VmTabReply>}
   */
  const sendRaced = (tabId, vmId, message, timeoutMs = messageTimeoutMs) =>
    /** @type {Promise<VmTabReply>} */ (raceTabReply(() => sendTabMessage(tabId, { ...message, vmId }), {
      timeoutMs,
      timeoutError: () => Object.assign(new Error(
        `vm ${message.type} timed out after ${timeoutMs / 1000}s (tab ${tabId} unresponsive).`,
      ), { vmUnresponsive: true }),
    }));

  /**
   * Reload a wedged/frozen tab in place and wait for the fresh boot. why reload,
   * not close: a tab removal fires onTabClosed → queue.interrupt on the command
   * lane, which would reject the very call we're recovering; reload recycles the
   * page (same tabId, the IDB overlay re-mounts so disk persists) and never touches
   * the lane. markReloading first so ensureTab waits for the re-boot's tab-ready
   * instead of early-returning on the stale ready flag.
   * @param {string} vmId @returns {Promise<number>} the (same) tabId, now re-ready
   */
  const recreateTab = async (vmId) => {
    tracker.markReloading(vmId);
    await tracker.reloadTab(vmId).catch(() => {});
    await tracker.ensureTab(vmId, { active: false, groupTitle: VM_TAB_GROUP_TITLE });
    const tabId = tracker.getTabId(vmId);
    if (tabId == null) throw new VMNotReadyError(`no live tab for ${vmId} after reload`);
    return tabId;
  };

  /**
   * Check shell readiness without running a command. A busy live shell still passes;
   * a dead shell or frozen tab fails. Any probe error reads as "not ready".
   * @param {number} tabId @param {string} vmId @returns {Promise<boolean>}
   */
  const probeAlive = async (tabId, vmId) => {
    try {
      const r = await sendRaced(tabId, vmId, { type: 'vm/is-ready' }, readyProbeMs);
      if (r?.shellExited === true) throw Object.assign(new VMNotReadyError('VM shell exited. The command was not sent.'), {
        outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
      });
      return r?.ready === true;
    } catch (cause) {
      if (/** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown === true) throw cause;
      return false;
    }
  };

  /**
   * @param {string} vmId
   * @param {{ type: string, [k: string]: unknown }} message
   * @param {{ reboot?: boolean }} [opts] reboot:false for the liveness probe itself,
   *   so a probe never recreates a tab (it just answers "not ready").
   */
  const callTab = async (vmId, message, { reboot = true } = {}) => {
    // background: agent-driven VM tabs never steal focus (DESIGN-12, 2026-06-18).
    // sandbox_create already dropped a "go there" card; an auto-create here (run before
    // create) opens quietly too. ensureTab early-returns for a live tab.
    const reusedExisting = tracker.getTabId(vmId) != null;
    const idleMs = now() - (lastUsed.get(vmId) ?? 0);
    await tracker.ensureTab(vmId, { active: false, groupTitle: VM_TAB_GROUP_TITLE });
    let tabId = tracker.getTabId(vmId);
    if (tabId == null) throw new VMNotReadyError(`no live tab for ${vmId} after ensureTab`);

    // Idle-reuse freeze gate (mechanical, no agent involvement): a REUSED tab idle
    // past the browser's freeze window may be frozen — it half-answers but CheerpX
    // execution has stopped. Probe it cheaply and recreate it BEFORE the real command
    // face-plants on a dead shell, turning a ~90s stall into a ~4s probe. Skipped for
    // a freshly created tab (not reused → not frozen), for recently-active VMs (no
    // freeze risk → no probe overhead), and for the probe message itself.
    if (reboot && message.type !== 'vm/is-ready' && reusedExisting && idleMs > idleProbeMs) {
      if (!(await probeAlive(tabId, vmId))) {
        tabId = await recreateTab(vmId);
      }
    }

    // why: reload can lose completed guest writes. A dead shell must fail closed.
    // A timeout or active shell exit can follow a disk change. Never replay it.
    const response = await sendRaced(tabId, vmId, message);
    if (!response || response.ok !== true) {
      const error = reviveError(response?.error ?? 'VM did not reply');
      if (response?.shellExited === true) Object.assign(error, {
        outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
      });
      throw error;
    }
    lastUsed.set(vmId, now());
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
        // reboot:false — a liveness probe must never recreate a tab; a wedged
        // probe just answers "not ready".
        const response = await callTab(targetVmId, { type: 'vm/is-ready' }, { reboot: false });
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
