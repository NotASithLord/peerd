// @ts-check
// peerd-engine errors.
//
// Module-local errors inherit from TypedError so `.name` survives
// structured-clone across the SW/offscreen and SW/sidepanel boundaries.
// The dispatcher and side panel branch on `.name`, not `instanceof`.

import { TypedError } from '/shared/errors.js';

/**
 * The VM hasn't booted yet (or is mid-boot) and a tool call asked it
 * to do something. Surfaces in the UI as a "VM is still starting"
 * indicator with the boot progress card pinned alongside.
 */
export class VMNotReadyError extends TypedError {
  /** @param {string} reason */
  constructor(reason) {
    super(`VM not ready: ${reason}`);
    this.reason = reason;
  }
}

/**
 * The VM tried to reach a network endpoint that's not on the
 * per-session allowlist (or network is fully off). Distinct from the
 * egress denylist — VM network is its own gate, off by default.
 * Sandboxed-VM V1 always throws this from inside the
 * VM's socket layer; agent must use vm_write_file to seed artifacts.
 */
export class VMNetworkDeniedError extends TypedError {
  /** @param {string} host */
  constructor(host) {
    super(`VM network denied: ${host}`);
    this.host = host;
  }
}

/**
 * CheerpX boot failed. Could be image fetch failure, SRI mismatch,
 * IDB quota, OPFS lock, or the CheerpX runtime itself throwing.
 * The `cause` field carries the original throw for debugging.
 */
export class VMBootFailedError extends TypedError {
  /**
   * @param {string} stage
   * @param {unknown} cause  the original throw (may be a DOMException)
   */
  constructor(stage, cause) {
    super(`VM boot failed at stage '${stage}': `
      + `${/** @type {{ message?: string }} */ (cause)?.message ?? String(cause)}`);
    this.stage = stage;
    this.cause = cause;
  }
}

/**
 * The vm_boot command exceeded its per-call wall-clock cap. Tools cap
 * runs at a sensible upper bound (default 60s) so a runaway loop
 * inside the VM doesn't pin the offscreen doc indefinitely.
 */
export class VMRunTimeoutError extends TypedError {
  /**
   * @param {string} cmd
   * @param {number} timeoutMs
   */
  constructor(cmd, timeoutMs) {
    super(`VM run timed out after ${timeoutMs}ms: ${cmd.slice(0, 80)}`);
    this.cmd = cmd;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The VM's tab was closed (by the user, or by the browser) while RPCs
 * against it were pending. why a dedicated error: without it, a
 * command against a closed tab stalls for the full message-channel
 * timeout (~90s) before surfacing a generic timeout — the tabs.onRemoved
 * wiring rejects every in-flight + queued RPC with this immediately,
 * so the agent gets a prompt, actionable tool error instead of a stall.
 * Re-running the command will respawn the tab (ensureTab).
 */
export class VMTabClosedError extends TypedError {
  /** @param {string} vmId */
  constructor(vmId) {
    super(`VM tab closed: the tab hosting ${vmId} was closed while a command was pending. `
      + 'Re-run the command to respawn the VM tab (disk state persists).');
    this.vmId = vmId;
  }
}

// --- Artifact export/import (.peerd envelopes — DESIGN-10) ----------------

/**
 * The artifact's packed payload exceeds the export size rail. why a
 * rail at all: the v1 envelope is in-memory base64 end to end —
 * apps/notebooks are KBs–MBs in practice, so the limit only exists for
 * the pathological case, with the limit named in the message.
 */
export class ArtifactTooLargeError extends TypedError {
  /**
   * @param {number} size
   * @param {number} limit
   */
  constructor(size, limit) {
    super(`artifact is ${size} bytes packed — over the ${limit}-byte (64 MB) export limit`);
    this.size = size;
    this.limit = limit;
  }
}

/**
 * The envelope is not a structurally valid .peerd file (wrong format
 * tag/version, missing manifest, non-base64 chunks, unknown kind).
 */
export class EnvelopeFormatError extends TypedError {
  /** @param {string} reason */
  constructor(reason) {
    super(`not a valid .peerd envelope: ${reason}`);
    this.reason = reason;
  }
}

/**
 * The envelope parsed but its bytes don't match the manifest's hash
 * commitments (tampered or corrupted in transit). Import fails closed.
 */
export class EnvelopeIntegrityError extends TypedError {
  /** @param {string} reason */
  constructor(reason) {
    super(`envelope failed verification: ${reason}`);
    this.reason = reason;
  }
}
