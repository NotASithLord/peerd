// @ts-check
// vm_boot — execute a shell command in a WebVM.
//
// WebVMs are discrete browser tabs. By default vm_boot routes to the
// chat's "current" VM (the last one it touched, or a freshly-spawned
// one if there isn't one yet). Pass `vm` to target a specific VM by
// name or id; that VM then becomes the chat's current for the next
// implicit-default call.

import { clamp } from '/shared/util.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * The result of a single shell run, as returned by ctx.vm.run().
 * @typedef {Object} VmRunResult
 * @property {number} exitCode
 * @property {number} durationMs
 * @property {string} [stdout]
 * @property {string} [stderr]
 */

/**
 * The vm run() surface vm_boot exercises (offscreen VM client).
 * @typedef {Object} VmRunner
 * @property {(cmd: string, opts: { timeoutMs: number, sessionId?: string, vmId?: string, toolUseId?: string }) => Promise<VmRunResult>} run
 */

/**
 * The vm-registry surface vm_boot exercises (peerd-engine).
 * @typedef {Object} VmRecord
 * @property {string} id
 * @property {string} name
 * @typedef {Object} VmRegistry
 * @property {(id: string) => Promise<VmRecord | null | undefined>} get
 * @property {() => Promise<VmRecord[]>} list
 * @property {(sessionId: string, vmId: string) => Promise<unknown>} setDefaultForSession
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const vmBootTool = {
  name: 'vm_boot',
  primitive: 'webvm',
  description: [
    'Run a shell command in a WebVM (stock Debian: python3, pip, git, jq,',
    'bash, POSIX). Persistent bash — cd, exported vars, and history persist',
    'across calls; pipes/redirects/&&/|| work. No `vm` arg → the chat\'s',
    'current VM (auto-created if none); pass `vm` to target another.',
    'NO NETWORK in the kernel: curl / wget / git clone / peerd-fetch are bash',
    'wrappers routed through peerd-egress — use THEM for fetching. apt and',
    'ONLINE pip do NOT work — and even `pip install local.whl` HANGS, because',
    'pip reaches PyPI for dependency resolution. To install a Python package:',
    'vm_import its wheel, then `pip install --no-index --no-deps <whl>` (fully',
    'offline), or just unzip the wheel (it is a zip) onto PYTHONPATH. Raw Python',
    'sockets do not work. Use `bash -c` (not `sh -c`) for subshells. Slow',
    'commands (builds, large installs) — raise timeoutMs. Returns stdout,',
    'stderr, exit code, duration. Default 60s (timeoutMs, max 300s).',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      cmd: {
        type: 'string',
        description: 'Shell command to run (interpreted by /bin/sh -c).',
      },
      vm: {
        type: 'string',
        description: 'Optional. VM id or name to target. Without this, '
          + 'uses the chat\'s current VM (auto-created if absent).',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Wall-clock cap in ms (default 60000, max 300000).',
      },
    },
    required: ['cmd'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.cmd !== 'string' || args.cmd.length === 0) {
      return { ok: false, error: 'cmd_required' };
    }
    // why: ctx.vm is the opaque `Object` contract slot; narrow it to the
    // run() surface this tool exercises (offscreen VM client).
    const vm = /** @type {VmRunner | undefined} */ (ctx.vm);
    if (!vm || typeof vm.run !== 'function') {
      return { ok: false, error: 'vm_not_available' };
    }
    // why: toolUseId is an SW-injected context extra not on the ToolContext
    // contract slot.
    const toolUseId = /** @type {{ toolUseId?: string }} */ (ctx).toolUseId;
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    // Resolve `vm` -- accept either id (vm-...) or name. Name lookup
    // is case-insensitive against the registry.
    /** @type {string | undefined} */
    let targetVmId;
    if (typeof args.vm === 'string' && args.vm.trim().length > 0) {
      const want = args.vm.trim();
      // why: vmRegistry is an SW-injected context extra not on the
      // ToolContext contract slot; narrow to the surface this tool uses.
      const vmRegistry = /** @type {VmRegistry | undefined} */ (
        /** @type {{ vmRegistry?: unknown }} */ (ctx).vmRegistry);
      if (!vmRegistry) return { ok: false, error: 'vm_registry_unavailable' };
      if (want.startsWith('vm-')) {
        const rec = await vmRegistry.get(want);
        if (!rec) return { ok: false, error: `vm_not_found: ${want}` };
        targetVmId = want;
      } else {
        const all = await vmRegistry.list();
        const lower = want.toLowerCase();
        const found = all.find((rec) => rec.name.toLowerCase() === lower);
        if (!found) return { ok: false, error: `vm_not_found: ${want}` };
        targetVmId = found.id;
      }
      // why: bump the chat's current VM so subsequent implicit-default
      // calls route to the same VM. No "attach" concept; just remember
      // what we touched. (targetVmId is always set on this branch — the
      // explicit check also satisfies the type narrower.)
      if (ctx.session?.sessionId && targetVmId) {
        try { await vmRegistry.setDefaultForSession(ctx.session.sessionId, targetVmId); }
        catch (e) { console.debug('[vm_boot] MRU bump failed', e); }
      }
    }
    try {
      const result = await vm.run(args.cmd, {
        timeoutMs,
        sessionId: ctx.session?.sessionId,
        vmId: targetVmId,
        toolUseId,
      });
      return { ok: true, content: formatRunResult(args.cmd, result) };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `vm_boot_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    }
  },
};

/** @param {string} cmd @param {VmRunResult} r @returns {string} */
const formatRunResult = (cmd, r) => {
  const lines = [
    `$ ${cmd}`,
    `[exit ${r.exitCode} in ${r.durationMs}ms]`,
  ];
  if (r.stdout) { lines.push('[STDOUT]', r.stdout); }
  if (r.stderr) { lines.push('[STDERR]', r.stderr); }
  return lines.join('\n');
};
