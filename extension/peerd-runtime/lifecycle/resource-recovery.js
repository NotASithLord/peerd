// @ts-check
// Engine-resource recovery (contract §9) — what a fresh service-worker
// generation may REUSE from the engine resources the previous one left
// behind, and what it must re-derive, re-verify, or refuse outright.
//
// The four resources each recover differently, and the difference is the
// point: a tab is a live thing an attacker can have moved under us, a
// notebook cell is a claim about a result we may no longer be able to
// substantiate, a WebVM is a filesystem that may be half-written, and an App
// is a sandbox whose whole authority was transient. So this file answers four
// separate questions with four separate verdicts rather than one "restore".
//
// The invariant they share (contract guarantees 3 and 7): recovery never
// EXPANDS authority. Nothing transient — a grant, a network tier, a
// credentialed binding — survives a restart by assumption; it is either
// re-derived from durable policy by the caller, or the resource is released.
//
// Functional core: values in, verdicts out. No IO, no clock, no `chrome.*`.
// Collaborators (the origin-sensitivity classifier, the re-derived grant) are
// passed in as plain values/functions, so this module stays self-contained
// inside lifecycle/ and testable without a browser.

import { authorityValid } from './generation.js';
import { decideRecovery } from './retry-class.js';

// --- §9.4 driven tabs ------------------------------------------------------

/** @typedef {'adopt' | 'release' | 'refuse-actor'} TabDisposition */

/**
 * What the shell does with a tab the previous generation was driving.
 *
 *   adopt         re-bind the actor to this tab; it is provably the same page
 *   release       drop the ownership record (the tab itself is left alone —
 *                 the user's tab is not ours to close on a doubt)
 *   refuse-actor  the tab is intact but now shows an origin where the user has
 *                 an identity: the ACTOR is refused rather than the tab
 *                 silently adopted, so a credentialed page is never inherited
 *                 by a run that never asked for it
 */
export const TAB_DISPOSITIONS = Object.freeze({
  ADOPT: /** @type {const} */ ('adopt'),
  RELEASE: /** @type {const} */ ('release'),
  REFUSE_ACTOR: /** @type {const} */ ('refuse-actor'),
});

/**
 * The durable record of a tab the previous generation owned.
 * @typedef {Object} TabOwnership
 * @property {number} tabId
 * @property {string} [sessionId]
 * @property {string} [generationId]  the generation that minted the binding
 * @property {string} [boundOrigin]   set when the actor was BOUND to one
 *   credentialed origin; absent for a roaming actor
 */

/**
 * @typedef {Object} TabRevalidation
 * @property {boolean} adopt
 * @property {string} reason
 * @property {TabDisposition} disposition
 */

/**
 * why frozen: a verdict is passed to the shell and rendered into audit;
 * nothing downstream should edit it after the decision was made.
 * @param {TabDisposition} disposition @param {string} reason
 * @returns {TabRevalidation}
 */
const tabVerdict = (disposition, reason) => Object.freeze({
  adopt: disposition === TAB_DISPOSITIONS.ADOPT,
  reason,
  disposition,
});

/**
 * A URL's origin, or null when there isn't a usable one.
 *
 * why the local parse instead of the actor module's normalizer: this module
 * is self-contained inside lifecycle/ by design, and the comparison it needs
 * is exactly `new URL(x).origin` (lowercased host, default ports dropped).
 * An opaque origin (`about:blank`, `data:`) parses to the STRING 'null',
 * which would happily compare equal to another opaque origin — so it is
 * rejected here rather than allowed to match.
 *
 * @param {unknown} url @returns {string | null}
 */
const originOf = (url) => {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const { origin } = new URL(url);
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
};

/**
 * §9.4 — revalidate a tab that survived the service worker.
 *
 * A tab outliving the SW is NOT evidence that the binding still holds: the
 * page could have navigated, been replaced, or landed somewhere the user is
 * signed in, all while nothing was watching. So the surviving tab is treated
 * as an untrusted claim and re-checked from scratch. Every refusal releases
 * the OWNERSHIP, never the user's tab.
 *
 * Checks, in order — the grant check is deliberately LAST so a stale-generation
 * re-adoption can only happen once identity, origin, and sensitivity have all
 * already passed:
 *   1. the tab is gone, or its id no longer matches → release
 *   2. the live URL has no usable origin → release
 *   3. a bound actor's page has navigated off its origin → release
 *   4. the live origin is one the user has an identity on → refuse-actor
 *   5. the ownership was stamped by a PRIOR generation → adopt only if the
 *      caller re-derived the grant (`allowedByGrant === true`); absent or
 *      false fails closed to release
 *
 * @param {Object} input
 * @param {TabOwnership} input.ownership
 * @param {{ id?: number, url?: string } | null} [input.liveTab]  the tab as the
 *   browser reports it NOW (null when it no longer exists)
 * @param {import('./generation.js').Generation} input.generation  current
 * @param {(origin: string) => boolean} [input.isSensitiveOrigin]  injected
 *   classifier (the actor module's classifyOriginSensitivity, wrapped by the
 *   shell) — a signal, not a hard dependency
 * @param {boolean} [input.allowedByGrant]  did the caller RE-DERIVE a grant
 *   for this binding from durable policy? Absent = no, and no is a release.
 * @param {number} [input.now]  epoch ms; defaults to the generation's mint time
 * @returns {TabRevalidation}
 */
export const revalidateDrivenTab = (input) => {
  const ownership = input?.ownership;
  const liveTab = input?.liveTab;
  const generation = input?.generation;

  if (!ownership || typeof ownership.tabId !== 'number') {
    // why: with no durable ownership record there is nothing to re-adopt —
    // an unowned tab is the user's, not ours.
    return tabVerdict(TAB_DISPOSITIONS.RELEASE,
      'no usable ownership record; nothing to revalidate');
  }

  // 1. Identity. A tab id is reused by the browser after a close, so "a tab
  // with this id exists" is not the same claim as "our tab survived".
  if (!liveTab || liveTab.id !== ownership.tabId) {
    return tabVerdict(TAB_DISPOSITIONS.RELEASE,
      'the tab is gone or identity changed');
  }

  // 2. A tab we cannot name an origin for cannot be checked against policy,
  // and an unnameable page is never adopted on trust.
  const liveOrigin = originOf(liveTab.url);
  if (liveOrigin === null) {
    return tabVerdict(TAB_DISPOSITIONS.RELEASE,
      'the live tab URL has no usable origin; cannot revalidate the binding');
  }

  // 3. A BOUND actor owns exactly one credentialed origin. If the page moved,
  // the binding is void: re-adopting would silently point an actor holding
  // one origin's authority at a different site.
  if (ownership.boundOrigin !== undefined) {
    const boundOrigin = originOf(ownership.boundOrigin);
    if (boundOrigin === null || boundOrigin !== liveOrigin) {
      return tabVerdict(TAB_DISPOSITIONS.RELEASE,
        `the page navigated away from the actor's bound origin `
        + `(${String(ownership.boundOrigin)} -> ${liveOrigin})`);
    }
  }

  // 4. Sensitivity. why a distinct disposition rather than a release: the tab
  // is fine and the user may well want it — what must not happen is an ACTOR
  // inheriting a signed-in page across a restart it never consented to. The
  // shell refuses the actor and hands the decision back up.
  if (input?.isSensitiveOrigin?.(liveOrigin) === true) {
    return tabVerdict(TAB_DISPOSITIONS.REFUSE_ACTOR,
      `the tab now shows a sensitive origin (${liveOrigin}); `
      + 'the actor is refused rather than silently adopting a credentialed page');
  }

  // 5. Generation + grant. Everything above passed, so the only question left
  // is authority — and transient authority never survives a restart by
  // assumption (contract guarantees 3 and 7).
  const currentGenerationId = typeof generation?.id === 'string' ? generation.id : null;
  const stamp = currentGenerationId === null
    ? { valid: false, reason: 'no current generation to validate the stamp against' }
    : authorityValid(
      typeof ownership.generationId === 'string'
        ? { generationId: ownership.generationId }
        : null,
      { generation, now: typeof input?.now === 'number' ? input.now : generation.mintedAt },
    );

  if (stamp.valid) {
    return tabVerdict(TAB_DISPOSITIONS.ADOPT,
      'current-generation ownership; identity, origin and sensitivity all re-checked');
  }
  if (input?.allowedByGrant !== true) {
    // why fail closed on absent: "the caller didn't say" and "the caller said
    // no" must land in the same place, or a forgotten argument silently
    // extends a capability past the restart that was supposed to end it.
    return tabVerdict(TAB_DISPOSITIONS.RELEASE,
      `${stamp.reason}; no re-derived grant was supplied`);
  }
  return tabVerdict(TAB_DISPOSITIONS.ADOPT,
    `${stamp.reason}; re-adopted under a freshly re-derived grant after all checks passed`);
};

// --- §9.2 notebook cells ---------------------------------------------------

/**
 * @typedef {'persisted-source' | 'completed-result' | 'interrupted'
 *   | 'stale-output'} NotebookCellState
 */

/**
 * The four things a notebook cell can honestly claim after a restart. The UI
 * must render them DIFFERENTLY: showing an interrupted run or an output from
 * a dead heap as a current result is exactly the false-certainty the
 * lifecycle contract exists to prevent.
 */
export const NOTEBOOK_CELL_STATES = Object.freeze({
  PERSISTED_SOURCE: /** @type {const} */ ('persisted-source'),
  COMPLETED_RESULT: /** @type {const} */ ('completed-result'),
  INTERRUPTED: /** @type {const} */ ('interrupted'),
  STALE_OUTPUT: /** @type {const} */ ('stale-output'),
});

/**
 * §9.2 — label one notebook cell for the UI.
 *
 * Precedence, and why each rank sits where it does:
 *   running       → 'interrupted'. The worker heap died mid-run. Nothing that
 *                   cell was computing survived, so whatever output is also
 *                   sitting there describes an earlier, unrelated run.
 *   output + same generation → 'completed-result'. The result was produced by
 *                   the heap that is still the current one; it can be shown as
 *                   a live result.
 *   output + any other/missing generation → 'stale-output'. The bytes are
 *                   real, but the heap that produced them is gone, so the
 *                   variables the output refers to no longer exist. Shown, and
 *                   marked stale — never silently promoted.
 *   otherwise     → 'persisted-source'. The only claim needing no evidence:
 *                   the source text is on disk. Garbage input lands here too.
 *
 * @param {Object} input
 * @param {{ source?: unknown, running?: unknown, completedGeneration?: unknown,
 *   output?: unknown }} [input.cell]
 * @param {unknown} [input.currentGeneration]  the notebook's live worker
 *   generation number
 * @returns {NotebookCellState}
 */
export const notebookCellState = (input) => {
  const cell = input?.cell;
  if (!cell || typeof cell !== 'object') return NOTEBOOK_CELL_STATES.PERSISTED_SOURCE;

  if (cell.running === true) return NOTEBOOK_CELL_STATES.INTERRUPTED;

  // why null/undefined only: an empty-string output is a REAL result (a cell
  // that ran and printed nothing), and collapsing it into "no output" would
  // relabel a completed run as unrun source.
  const hasOutput = cell.output !== undefined && cell.output !== null;
  if (!hasOutput) return NOTEBOOK_CELL_STATES.PERSISTED_SOURCE;

  const current = input?.currentGeneration;
  const matches = typeof current === 'number' && Number.isFinite(current)
    && typeof cell.completedGeneration === 'number'
    && cell.completedGeneration === current;
  return matches
    ? NOTEBOOK_CELL_STATES.COMPLETED_RESULT
    : NOTEBOOK_CELL_STATES.STALE_OUTPUT;
};

// --- §9.1 WebVMs -----------------------------------------------------------

/**
 * @typedef {Object} InterruptedCommand
 * @property {string} commandId
 * @property {unknown} [retryClass]
 * @property {boolean} [dispatched]
 * @property {boolean} [cancelRequested]
 * @property {{ kind?: string }} [evidence]
 */

/**
 * @typedef {Object} VmRecoveryPlan
 * @property {boolean} verifyFilesystem
 * @property {true} processStateLost
 * @property {true} revalidateImports
 * @property {false} credentialsResident
 * @property {ReadonlyArray<{ commandId: string,
 *   verdict: import('./retry-class.js').RecoveryVerdict }>} commands
 */

/**
 * §9.1 — what recreating a WebVM restores, and what it must NOT assume.
 *
 * A WebVM's disk is persisted but its process state is not, so recovery is
 * asymmetric by construction:
 *   verifyFilesystem     a PERSISTED filesystem is the dangerous case, not the
 *                        safe one — it may be PARTIALLY committed (a write
 *                        that started before the eviction), so it is verified
 *                        rather than trusted. A non-persisted VM has nothing
 *                        to verify: it comes back empty.
 *   processStateLost     always. Shells, env, background processes, mounts,
 *                        and anything else living only in the heap are gone;
 *                        a command is never "continued".
 *   revalidateImports    always. Modules/packages resolved by the dead run are
 *                        re-resolved, never inherited from a cache the new
 *                        generation cannot vouch for.
 *   credentialsResident  always false. Nothing credentialed is resident in a
 *                        recreated VM; anything it needs is re-derived at the
 *                        egress boundary.
 *
 * Each interrupted command is settled by `decideRecovery`, which fails an
 * UNCLASSIFIED command closed to Class E. why that matters here specifically:
 * a shell command is opaque — `curl`, `git push`, a script that mails
 * something — so "we don't know what it was" and "it may have changed the
 * outside world" are the same statement, and outcome_unknown is the only
 * honest verdict.
 *
 * @param {Object} input
 * @param {{ instanceId?: string, filesystemPersisted?: boolean }} [input.vmRecord]
 * @param {InterruptedCommand[]} [input.interruptedCommands]
 * @returns {VmRecoveryPlan}
 */
export const vmRecoveryPlan = (input) => {
  const commandList = Array.isArray(input?.interruptedCommands)
    ? input.interruptedCommands
    : [];
  const commands = commandList
    .filter((command) => typeof command?.commandId === 'string')
    .map((command) => Object.freeze({
      commandId: command.commandId,
      verdict: decideRecovery({
        retryClass: command.retryClass,
        dispatched: command.dispatched,
        cancelRequested: command.cancelRequested,
        evidence: command.evidence,
      }),
    }));

  return Object.freeze({
    verifyFilesystem: input?.vmRecord?.filesystemPersisted === true,
    processStateLost: /** @type {true} */ (true),
    revalidateImports: /** @type {true} */ (true),
    credentialsResident: /** @type {false} */ (false),
    commands: Object.freeze(commands),
  });
};

// --- §9.3 App sandboxes ----------------------------------------------------

/** OPFS root every App's files live under: `peerd-apps/<appId>/…`. */
const APP_FILE_ROOT = 'peerd-apps/';

/**
 * Does this path belong to THIS app? Recreation restores an app's own files
 * and nothing else — a rebuild is not an opportunity to widen what a sandbox
 * can read, so a traversal, an absolute path, or another app's namespace is
 * dropped rather than repaired.
 *
 * @param {unknown} file @param {string} appId
 */
const isOwnFile = (file, appId) => {
  if (typeof file !== 'string' || file === '') return false;
  if (file.includes('..')) return false;
  if (file.startsWith('/')) return false;
  if (!file.startsWith(APP_FILE_ROOT)) return true; // app-relative name
  return file.startsWith(`${APP_FILE_ROOT}${appId}/`);
};

/**
 * @typedef {Object} AppSandboxRebuild
 * @property {ReadonlyArray<string>} restoredFiles
 * @property {'re-derive'} networkTier
 * @property {'regenerate'} blobUrls
 * @property {'not-restored'} popups
 * @property {'not-restored'} downloads
 * @property {'not-replayed'} inFlightActions
 */

/**
 * §9.3 — a declarative statement of what recreating an App sandbox restores,
 * re-derives, and refuses. Deliberately a flat value rather than an
 * imperative rebuild, so the policy is readable and testable on its own.
 *
 *   restoredFiles   the app's OWN durable files, and only those
 *   networkTier     RE-DERIVED from policy. why never carried over: the tier
 *                   is transient authority, and reading it back off a stored
 *                   record is precisely "a capability survived a restart
 *                   because it was written down" (contract guarantee 3)
 *   blobUrls        regenerated — a blob URL is bound to a dead document and
 *                   is meaningless in the new one
 *   popups          NOT restored; a window is a user-visible act
 *   downloads       NOT restored; a re-issued download is a duplicate side
 *                   effect with no proof the first one failed
 *   inFlightActions NOT replayed — the app's interrupted calls settle through
 *                   the same retry-class path as anything else, never by
 *                   optimistic replay
 *
 * The `tier` input is accepted for call-site symmetry and DELIBERATELY
 * dropped: honoring it would defeat the re-derivation above.
 *
 * @param {Object} input
 * @param {{ appId?: string, files?: unknown }} [input.appRecord]
 * @param {string} [input.tier]
 * @returns {AppSandboxRebuild}
 */
export const appSandboxRebuild = (input) => {
  const appId = input?.appRecord?.appId;
  const files = input?.appRecord?.files;
  // why an unnamed app restores nothing: ownership of a file cannot be proven
  // without an app id, and an unprovable file is not restored.
  const restoredFiles = typeof appId === 'string' && appId !== '' && Array.isArray(files)
    ? files.filter((file) => isOwnFile(file, appId))
    : [];

  return Object.freeze({
    restoredFiles: Object.freeze(restoredFiles),
    networkTier: /** @type {const} */ ('re-derive'),
    blobUrls: /** @type {const} */ ('regenerate'),
    popups: /** @type {const} */ ('not-restored'),
    downloads: /** @type {const} */ ('not-restored'),
    inFlightActions: /** @type {const} */ ('not-replayed'),
  });
};
