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
 * egress denylist — VM network is its own gate, off by default per
 * DECISIONS.md §6. Sandboxed-VM V1 always throws this from inside the
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

// --- Remote module imports (module-resolver.js — the audited import path) --

/** Stable cross-realm code for the package-level remote import refusal. */
export const REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE = 'remote_module_imports_unavailable';
export const REMOTE_MODULE_IMPORTS_UNAVAILABLE_MESSAGE =
  'This version of peerd does not allow remote module imports. '
  + 'No request was made for this module. '
  + 'Use peerd:std, peerd:wasi, a reviewed local module, or peerd:toolbox/<name> instead.';

/** Stable cross-realm code for native import syntax the resolver cannot audit. */
export const UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE = 'unsupported_native_module_import';
export const UNSUPPORTED_NATIVE_MODULE_IMPORT_MESSAGE =
  'This version of peerd cannot run this import form. '
  + "Use a literal static local import such as import { value } from './local.js'. "
  + 'For JSON, read a local file with peerd.self.readFile(path) and parse it with JSON.parse(...).';

/** Stable cross-realm code for parser failures before worker creation. */
export const MODULE_SYNTAX_ERROR_CODE = 'module_syntax_error';

/** @type {Readonly<Record<string, string>>} */
export const MODULE_IMPORT_POLICY_MESSAGES = Object.freeze({
  [REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE]: REMOTE_MODULE_IMPORTS_UNAVAILABLE_MESSAGE,
  [UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE]: UNSUPPORTED_NATIVE_MODULE_IMPORT_MESSAGE,
});

/** @param {string | undefined} code */
export const moduleImportPolicyMessage = (code) => code && Object.hasOwn(MODULE_IMPORT_POLICY_MESSAGES, code)
  ? MODULE_IMPORT_POLICY_MESSAGES[code]
  : null;

/**
 * The packaged channel does not permit URL-loaded JavaScript. This is separate
 * from a run that merely lacks egress: Store and web builds refuse before a
 * fetch function is available, and the code survives worker/host relays so the
 * tool layer can render a policy failure instead of a successful code error.
 */
export class RemoteModuleImportsUnavailableError extends TypedError {
  /** @param {string} specifier */
  constructor(specifier) {
    super(REMOTE_MODULE_IMPORTS_UNAVAILABLE_MESSAGE);
    this.specifier = specifier;
    this.code = REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE;
  }
}

/**
 * Code used native syntax the resolver cannot safely run. Dynamic imports are
 * blocked because packaged MV3 workers cannot complete their blob-import hop.
 * Import options are not supported by the resolver transform.
 */
export class UnsupportedNativeModuleImportError extends TypedError {
  constructor() {
    super(UNSUPPORTED_NATIVE_MODULE_IMPORT_MESSAGE);
    this.code = UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE;
  }
}

/** Invalid JavaScript found by the resolver's grammar-correct preflight. */
export class ModuleSyntaxError extends TypedError {
  /** @param {string} detail */
  constructor(detail) {
    super(`JavaScript syntax error: ${detail}`);
    this.code = MODULE_SYNTAX_ERROR_CODE;
  }
}

/**
 * A remote import refused BEFORE any fetch. The default reason is the
 * no-network lane (no `fetchRemote` injected — page_code / a2a / site-client);
 * callers pass a reason for the other fail-closed forms (a malformed near-miss
 * integrity pin, a protocol-relative specifier). why the WHY in the message:
 * the agent reads this verbatim and must learn the refusal is policy, not a
 * typo it should retry.
 */
export class RemoteImportBlockedError extends TypedError {
  /**
   * @param {string} specifier
   * @param {string} [reason]
   */
  constructor(specifier, reason = 'this run has no network (egress capability is off for this lane)') {
    super(`remote import '${specifier}' refused: ${reason}`);
    this.specifier = specifier;
    this.reason = reason;
  }
}

/**
 * A remote module graph hit a hostile-input rail — the per-module source
 * size or the per-run remote-fetch count (fan-out module graphs are an
 * amplification vector). The rails live in module-resolver.js.
 */
export class RemoteModuleCapError extends TypedError {
  /**
   * @param {string} specifier
   * @param {string} reason
   */
  constructor(specifier, reason) {
    super(`remote import '${specifier}' refused: ${reason}`);
    this.specifier = specifier;
    this.reason = reason;
  }
}

/**
 * The fetched remote source doesn't match the specifier's #sha256-<base64>
 * integrity pin. Fails closed — the module never reaches the worker.
 */
export class RemoteModuleIntegrityError extends TypedError {
  /**
   * @param {string} url
   * @param {string} expected  the pinned hash (normalized base64)
   * @param {string} actual    what the fetched source hashes to
   */
  constructor(url, expected, actual) {
    super(`remote module '${url}' failed its #sha256 pin: expected ${expected}, `
      + `fetched source hashes to ${actual}`);
    this.url = url;
    this.expected = expected;
    this.actual = actual;
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
