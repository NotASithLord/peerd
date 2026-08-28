// @ts-check
// background/offscreen-actor-client.js: the privileged-host client for EVERY isolated
// agent loop (the heap split): ephemeral spawned reasoners (spawn.js) AND bound
// actors (the actor turn). Provider semantics stay in the isolated Worker; this
// client exposes exact inference and named domain-authority routes. The worker
// receives no generic tool, browser, storage, credential, or fetch authority.
//
// Pure shell — every IO injected — so it is unit-testable without a browser.

import { normalizeExactEffectOutcome } from '/shared/exact-effect-outcome.js';
import {
  authorityReceiptsForCall,
  HOST_CONFIRMATION_DECLINED,
  HOST_EFFECT_OUTCOME,
  hostEffectValueIsRefusal,
  safeHostEffectFailure,
  safeHostPolicyAttribution,
  stampAuthorityToolResult,
  stampAuthorityToolResultBlock,
} from './host-effect-verdict.js';
import { semanticCallAuditEntry } from './semantic-call-audit.js';
import {
  ORCHESTRATOR_OPERATION_GRANT,
  controllerDomainOperationPayloadCap,
  controllerDomainOperationPolicy,
  controllerOperationAllowedInPermissionMode,
  controllerOperationRequiresConfirmation,
} from '/shared/controller-kernel-quota.js';
import { canonicalCloneDigest } from '/shared/canonical-clone-digest.js';
import { structuredClonePayloadBytes } from '/shared/structured-clone-size.js';
import { ACTOR_LOOP_EVENT_BYTES } from '/shared/actor-channel-protocol.js';
import { normalizeApiOrigin } from '/shared/api-origin.js';
import { parsePodShell, podGitRemoteIntents } from '/peerd-engine/authority.js';
import { bindRepositoryToolAuthority } from './repository-tool-authority.js';
import { bindVmToolAuthority } from './vm-tool-authority.js';
import { bindNotebookToolAuthority } from './notebook-tool-authority.js';
import { bindAppToolAuthority } from './app-tool-authority.js';
import { bindPersistenceToolAuthority } from './persistence-tool-authority.js';
import { bindPageToolAuthority } from './page-tool-authority.js';
import { bindResourceToolAuthority } from './resource-tool-authority.js';
import { bindSiteClientToolAuthority } from './site-client-tool-authority.js';
import { bindExecutionToolAuthority } from './execution-tool-authority.js';
import { bindEditingToolAuthority } from './editing-tool-authority.js';
import { bindIntrospectionToolAuthority } from './introspection-tool-authority.js';
import { bindScheduleToolAuthority } from './schedule-tool-authority.js';
import { bindDwebToolAuthority } from './dweb-tool-authority.js';
import { createAuthorityEffectScheduler } from './authority-effect-scheduler.js';
import { authorityEffectResourceKey } from './authority-effect-resource.js';
import {
  APP_PROGRAM_EXACT_OPERATIONS,
  PAGE_PROGRAM_EXACT_OPERATIONS,
} from '/shared/page-program-authority.js';
import { authorityEffectConfirmationPresentation } from '/shared/authority-confirmation-presentation.js';
import { createReadOnlyOperationGrant } from './controller-turn-authority-scope.js';

const PAGE_PROGRAM_EXACT_OPERATION_SET = new Set(PAGE_PROGRAM_EXACT_OPERATIONS);
const APP_PROGRAM_EXACT_OPERATION_SET = new Set(APP_PROGRAM_EXACT_OPERATIONS);

const ACTOR_OPERATION_GRANTS = Object.freeze({
  webvm: Object.freeze([
    'turn.vm.read', 'turn.vm.list', 'turn.vm.set-default', 'turn.vm.run',
    'turn.vm.import-file', 'turn.vm.write-text-file', 'turn.vm.destroy',
  ]),
  notebook: Object.freeze([
    'turn.notebook.read', 'turn.notebook.list', 'turn.notebook.set-default',
    'turn.notebook.run', 'turn.notebook.write-file', 'turn.notebook.read-file',
    'turn.notebook.destroy', 'turn.repository.read-status',
    'turn.repository.read-history', 'turn.repository.read-remote',
    'turn.repository.read-diff', 'turn.repository.confirm-restore',
    'turn.repository.checkpoint', 'turn.repository.branch',
    'turn.repository.checkout', 'turn.repository.restore',
    'turn.repository.confirm-remote', 'turn.repository.link',
    'turn.repository.fetch', 'turn.repository.push',
    'turn.editing.read-target', 'turn.editing.write-target',
  ]),
  pod: Object.freeze([
    'turn.pod.resolve', 'turn.pod.read-remote', 'turn.pod.confirm-git',
    'turn.pod.exec', 'turn.pod.status', 'turn.pod.cancel', 'turn.pod.read-file',
    'turn.pod.write-file', 'turn.repository.read-pod',
    'turn.repository.destroy-pod', 'turn.repository.read-status',
    'turn.repository.read-history', 'turn.repository.read-remote',
    'turn.repository.read-diff', 'turn.repository.confirm-restore',
    'turn.repository.checkpoint', 'turn.repository.branch',
    'turn.repository.checkout', 'turn.repository.restore',
    'turn.repository.confirm-remote', 'turn.repository.link',
    'turn.repository.fetch', 'turn.repository.push',
  ]),
  app: Object.freeze([
    'turn.app.update', 'turn.app.read', 'turn.app.delete', 'turn.app.write-file',
    'turn.app.read-file', 'turn.app.list-files', 'turn.app.delete-file',
    'turn.app.observe', 'turn.app.act', 'turn.app.run-code',
    'turn.repository.read-status', 'turn.repository.read-history',
    'turn.repository.read-remote', 'turn.repository.read-diff',
    'turn.repository.confirm-restore', 'turn.repository.checkpoint',
    'turn.repository.branch', 'turn.repository.checkout',
    'turn.repository.restore', 'turn.repository.confirm-remote',
    'turn.repository.link', 'turn.repository.fetch', 'turn.repository.push',
    'turn.editing.read-target', 'turn.editing.write-target',
  ]),
  web: Object.freeze([
    'turn.page.read', 'turn.page.snapshot', 'turn.page.read-state',
    'turn.page.watch-changes', 'turn.page.query-dom', 'turn.page.navigate',
    'turn.page.fill', 'turn.page.click', 'turn.page.login',
    'turn.page.run-program', 'turn.page.capture-owned',
    'turn.resource.confirm-web-write', 'turn.resource.request-web-text',
    'turn.resource.extract-markdown', 'turn.resource.extract-document',
    'turn.resource.spill-result', 'turn.resource.read-result',
    'turn.site-client.read', 'turn.site-client.run', 'turn.site-client.commit',
    'turn.site-client.capture-start', 'turn.site-client.capture-stop',
  ]),
  api: Object.freeze([
    'turn.resource.confirm-web-write', 'turn.resource.request-web-text',
    'turn.resource.extract-markdown',
    'turn.resource.spill-result', 'turn.resource.read-result',
    'turn.site-client.read', 'turn.site-client.run', 'turn.site-client.commit',
  ]),
  dweb: Object.freeze([
    'turn.dweb.discover-apps', 'turn.dweb.publish-confirmed-app',
    'turn.dweb.install-confirmed-app', 'turn.dweb.read-peers',
    'turn.dweb.set-peer-blocked', 'turn.dweb.set-discovery-enabled',
    'turn.dweb.run-mesh-program',
  ]),
  inboundDweb: Object.freeze([
    'turn.dweb.discover-apps', 'turn.dweb.read-peers',
  ]),
});

const canonicalActorBacking = (/** @type {any} */ record) =>
  record?.kind === 'actor' && record.actorType === 'web' && record.backing == null
    ? 'tab' : record?.backing;

const knownBoundActorIdentity = (/** @type {any} */ record) => {
  if (record?.kind !== 'actor' || typeof record.instanceId !== 'string' || !record.instanceId) {
    return false;
  }
  if (record.actorType === 'web') {
    const backing = canonicalActorBacking(record);
    if (backing === 'api') return normalizeApiOrigin(record.instanceId) === record.instanceId;
    return backing === 'tab';
  }
  return ['webvm', 'notebook', 'pod', 'app', 'dweb'].includes(record.actorType)
    && record.backing == null;
};

export const actorOperationGrant = (
  /** @type {any} */ record,
  /** @type {boolean} */ inbound,
) => inbound
  ? record?.kind === 'actor' && record.actorType === 'dweb'
    ? ACTOR_OPERATION_GRANTS.inboundDweb : Object.freeze([])
  : record?.kind === 'spawned'
    ? Array.isArray(record.grantedOperations)
      ? Object.freeze(record.grantedOperations.filter((/** @type {unknown} */ operation) =>
        typeof operation === 'string' && controllerDomainOperationPolicy(operation)))
      : Object.freeze([])
    : record?.kind === 'actor' && record.actorType === 'web'
      ? canonicalActorBacking(record) === 'api' ? ACTOR_OPERATION_GRANTS.api
        : canonicalActorBacking(record) === 'tab' ? ACTOR_OPERATION_GRANTS.web : Object.freeze([])
      : record?.kind === 'actor'
        ? ACTOR_OPERATION_GRANTS[/** @type {keyof typeof ACTOR_OPERATION_GRANTS} */ (record.actorType)]
          ?? Object.freeze([])
        : Object.freeze([]);

const canonicalExactOperations = (/** @type {unknown} */ value) => {
  if (!Array.isArray(value) || value.length > 256) return null;
  const operations = value.filter((operation) =>
    typeof operation === 'string' && controllerDomainOperationPolicy(operation));
  return operations.length === value.length && new Set(operations).size === operations.length
    ? Object.freeze(operations) : null;
};

const exactKeys = (
  /** @type {unknown} */ value, /** @type {readonly string[]} */ required,
  /** @type {readonly string[]} */ optional = ['relayToken'],
) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = /** @type {Record<string,unknown>} */ (value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
};

const ACTOR_AUTHORITY_RESULT_CAP = 20 * 1024 * 1024;
const ACTOR_SEMANTIC_TOOL_RESULT_CAP = 2 * 1024 * 1024;

/** @returns {boolean} */
const sameClone = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && sameClone(Reflect.get(left, key), Reflect.get(right, key)));
  }
  if (left instanceof ArrayBuffer || right instanceof ArrayBuffer) {
    if (!(left instanceof ArrayBuffer) || !(right instanceof ArrayBuffer)
        || left.byteLength !== right.byteLength) return false;
    const leftBytes = new Uint8Array(left);
    const rightBytes = new Uint8Array(right);
    return leftBytes.every((byte, index) => byte === rightBytes[index]);
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)
        || left.constructor !== right.constructor || left.byteLength !== right.byteLength) return false;
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return leftBytes.every((byte, index) => byte === rightBytes[index]);
  }
  const leftRecord = /** @type {Record<string,unknown>} */ (left);
  const rightRecord = /** @type {Record<string,unknown>} */ (right);
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameClone(leftRecord[key], rightRecord[key]));
};

// An inbound dweb wake is reasoning over bytes chosen by a remote peer. Keep its
// useful read/moderation surface, but do not advertise any operation that can
// delegate, spend, sign/publish, install peer code, or change standing network
// policy. This is a POSITIVE set so a future dweb capability lands unavailable to
// inbound turns until somebody deliberately classifies it here.
/**
 * @param {Object} deps
 * @param {() => Promise<void>} [deps.ensureHost]
 * @param {() => Promise<void>} [deps.ensureOffscreen] legacy Chrome host alias
 * @param {(msg: object) => Promise<any>} deps.sendMessage
 * @param {(job: object, options: { signal?: AbortSignal, relay: (type: string, payload: any) => any|Promise<any> }) => Promise<any>} [deps.runOnChannel]
 * @param {{
 *   openInference:(input:unknown,grant:object)=>Promise<any>,
 *   readInferenceChunk:(input:unknown,grant:object)=>Promise<any>,
 *   cancelInference:(input:unknown,grant:object)=>Promise<any>,
 *   readModelContext:(input:unknown,grant:object)=>Promise<any>,
 *   openLocalGeneration:(input:unknown,grant:object)=>Promise<any>,
 *   readLocalGeneration:(input:unknown,grant:object)=>Promise<any>,
 *   cancelLocalGeneration:(input:unknown,grant:object)=>Promise<any>,
 *   closeOwner:(owner:object)=>Promise<void>,
 * }} deps.providerEgress
 * @param {{ get: (id: string) => Promise<any> }} deps.sessions
 * @param {(opts: object) => Promise<object>} deps.buildToolContext
 * @param {(ctx: any, allowedNames: Set<string>) => any} [deps.restrictCtxCapabilities]  phase 4:
 *   strip an actor ctx down to the capabilities its GRANTED tools need (capability-by-need),
 *   the analog of the actor's kind-scoped strip. Required to run tool-bearing spawned offscreen.
 * @param {(actorSessionId: string) => (number | undefined)} [deps.ownedTabFor]  a
 *   tab-backed WEB actor's currently-owned tab id (phase 3) — read per dispatch so a
 *   mid-turn navigate that adopts a tab (0→1) is seen by the NEXT tool call. undefined
 *   for engine/API actors (no tab) and the 0-tab web state.
 * @param {string} [deps.EXPOSURE_ACTOR]
 * @param {() => number} [deps.now]
 * @param {(call: Record<string, any>) => void} [deps.recordModelCall]  the context
 *   inspector's capture hook — fed every delegated model call with the runMeta-derived
 *   identity (never the worker's own claim). Optional; defaults to a no-op.
 * @param {(msg: Record<string, any>) => void} [deps.broadcastOp]  announce each settled
 *   ACTOR tool dispatch on the UI ports ('actor/op' — bounded name/ok only).
 *   The isolated heap emits no turn/tool-use, so this is how the eval harness's OM2W
 *   recorder (and any activity view) sees what an actor did. Optional; defaults to a no-op.
 * @param {(entry:Record<string,unknown>)=>Promise<void>|void} [deps.appendAudit]
 *   append-only host audit. Actor semantic events are reduced to a closed schema
 *   and stamped with the live run/session identity before this is called.
 * @param {(sender: unknown) => boolean} [deps.isRelaySender]  is this message from the
 *   exact actor host? The three relay routes below refuse anything else. REQUIRED in
 *   production and fail-CLOSED by omission (an unwired client refuses every relay), because
 *   this is the boundary, not a hint — see the grants-map note for why the token alone is
 *   not sufficient.
 * @param {(sender: unknown) => boolean} [deps.isOffscreenSender] legacy Chrome sender alias
 * @param {() => string} [deps.mintRelayToken]  mints the per-run relay grant (below).
 *   Injected so the grant is testable without a browser; defaults to crypto.randomUUID.
 * @param {(sessionId: string) => Promise<string | null>} [deps.spendRefusalFor]  spend-limit
 *   preflight for a relayed model call: resolves a refusal MESSAGE when the run's owning
 *   chat session is past the user's hard cap, or null to proceed. Optional and
 *   fail-OPEN by omission (an unwired client behaves as before) — the cap is a coarse
 *   safety lever, and refusing every actor call because a dep is missing would break
 *   the lane outright.
 * @param {number} [deps.maxModelRelaysPerRun]
 * @param {number} [deps.maxToolRelaysPerRun]
 * @param {number} [deps.maxLoopEventsPerRun]
 * @param {number} [deps.settlementCleanupMs]
 * @param {ReturnType<typeof createAuthorityEffectScheduler>} [deps.authorityScheduler]
 */
export const makeOffscreenActorClient = ({
  ensureHost, ensureOffscreen, sendMessage, runOnChannel, providerEgress,
  sessions, buildToolContext, ownedTabFor, EXPOSURE_ACTOR = 'actor',
  now = Date.now,
  recordModelCall = () => {},
  broadcastOp = (/** @type {any} */ _msg) => {},
  appendAudit = async () => {},
  mintRelayToken = () => globalThis.crypto.randomUUID(),
  spendRefusalFor = undefined,
  isRelaySender, isOffscreenSender,
  maxModelRelaysPerRun = Number.POSITIVE_INFINITY,
  maxToolRelaysPerRun = Number.POSITIVE_INFINITY,
  maxLoopEventsPerRun = 256,
  settlementCleanupMs = 250,
  authorityScheduler = createAuthorityEffectScheduler(),
}) => {
  const ensureActorHost = ensureHost ?? ensureOffscreen ?? (async () => {});
  const relaySenderAllowed = isRelaySender ?? isOffscreenSender ?? (() => false);
  const modelRelayLimit = Number.isFinite(maxModelRelaysPerRun) && maxModelRelaysPerRun > 0
    ? Math.floor(maxModelRelaysPerRun) : Number.POSITIVE_INFINITY;
  const toolRelayLimit = Number.isFinite(maxToolRelaysPerRun) && maxToolRelaysPerRun > 0
    ? Math.floor(maxToolRelaysPerRun) : Number.POSITIVE_INFINITY;
  const loopEventLimit = Number.isFinite(maxLoopEventsPerRun) && maxLoopEventsPerRun > 0
    ? Math.floor(maxLoopEventsPerRun) : 256;
  const cleanupFuseMs = Number.isFinite(settlementCleanupMs) && settlementCleanupMs > 0
    ? Math.floor(settlementCleanupMs) : 250;
  const boundedCleanup = (/** @type {Promise<unknown>} */ pending) =>
    new Promise((resolve) => {
      let finished = false;
      const finish = (/** @type {unknown} */ value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), cleanupFuseMs);
      pending.then(finish, () => finish(undefined));
    });
  let seq = 0;
  /**
   * @type {Map<string, any>} Firefox relay grants:
   * token → the identity of the run it was minted for.
   *
   * why a grant and not the message's own `actorSessionId`/`runId`: Firefox binds
   * these routes to its private in-process actor host, but the relay still needs a
   * run identity and liveness check that does not trust worker-controlled payloads.
   *
   * The token is minted SW-side per run, travels in the job to the offscreen runner, and
   * comes back on every relay call; identity is DERIVED from it, so the payload's claim
   * buys nothing. It is deleted when the run settles, which makes it a liveness check
   * too — a late or replayed relay from a finished run is refused, the same posture
   * an inference stream gets from its owner check.
   *
   * The Worker never receives the token (the runner holds it and stamps it on outbound
   * relays), so it stays a host-side binding, not a secret the untrusted heap can leak.
   *
   * Chrome does not serialize this token. Its service worker transfers a standard
   * MessageChannel endpoint to the exact offscreen WindowClient and closes the live
   * grant over that private channel. The offscreen job and its relays are never
   * registered on extension-wide runtime messaging.
   */
  const grants = new Map();
  /** @type {Set<string>} run ids a Stop/cancel already fired for. why: the actor card
   * appears before its first inference open. This closes the gap in which Stop can
   * win before a stream exists: a later open is refused, and an admitted stream is
   * closed through the provider authority's owner token. */
  const abortedRuns = new Set();
  /** @type {Map<string, (ev: object) => void>} runId → onEvent */
  const runOnEvent = new Map();
  /** @type {Map<string, { sessionId: string, label: string }>} runId → identity for the
   * context inspector: inference routes carry no session identity, so the
   * session (and a human label for WHOSE call this is) is stashed at run() time. */
  const runMeta = new Map();
  /**
   * @param {{ actorSessionId: string, message: string, systemPrompt: string, provider: string, model: string, probeOnly?: boolean, depth?: number, maxSteps?: number, maxOutputTokens?: number, tools?: any[], allowedOperations?: string[], programTools?: any[], programOperations?: string[], priorMessages?: any[], reasoningEnabled?: boolean, reasoningEffort?: string, contextWindowOverrides?:Record<string,number>, budgetMs?: number, oneShot?: boolean, actorType?: string, backing?: string, actorSurface?: 'tools'|'code', tabOrigin?: string, origin?: string, inbound?: boolean }} job
   * @param {{ signal?: AbortSignal, onEvent?: (ev: object) => void }} [opts]
   */
  const run = async (job, { signal, onEvent } = {}) => {
    // A cancelled turn must not create a host, mint authority, or start a Worker.
    // why: Stop can win before an async actor reaches this client; sending abort
    // before actor/run exists cannot cancel the Worker that actor/run then creates.
    if (signal?.aborted) {
      return { ok: false, started: true, phase: 'startup', code: 'actor_run_aborted', error: 'actor run aborted', aborted: true };
    }
    const actorRecord = await sessions.get(job.actorSessionId).catch(() => null);
    if (!actorRecord || actorRecord.kind !== 'actor' && actorRecord.kind !== 'spawned') {
      return {
        ok: false, started: false, phase: 'admission', code: 'actor_identity_invalid',
        error: 'actor run has no authoritative session binding', outcomeKnown: true,
      };
    }
    if (actorRecord.kind === 'actor'
        && (job.actorType !== actorRecord.actorType
          || (job.backing ?? canonicalActorBacking(actorRecord))
            !== canonicalActorBacking(actorRecord))) {
      return {
        ok: false, started: false, phase: 'admission', code: 'actor_identity_mismatch',
        error: 'actor run identity does not match its session binding', outcomeKnown: true,
      };
    }
    const validateSpawnedGrant = async (/** @type {any} */ child) => {
      const childOperations = canonicalExactOperations(child.grantedOperations);
      if (!childOperations || !child.parentSessionId) return [];
      const seen = new Set([child.sessionId]);
      let current = child;
      let ceiling = new Set(childOperations);
      let delegationTrusted = child.spawnedTrusted === true;
      for (let hop = 0; hop < 32; hop += 1) {
        const parentId = current.parentSessionId;
        if (typeof parentId !== 'string' || !parentId || seen.has(parentId)) return [];
        seen.add(parentId);
        const parent = await sessions.get(parentId).catch(() => null);
        if (!parent) return [];
        const parentOperations = parent.kind === 'spawned'
          ? canonicalExactOperations(parent.grantedOperations)
          : parent.kind === 'chat' ? ORCHESTRATOR_OPERATION_GRANT : null;
        if (!parentOperations || [...ceiling].some((operation) =>
          !parentOperations.includes(operation))) return [];
        if (parent.kind !== 'spawned') {
          return Object.freeze([...ceiling].filter((operation) => delegationTrusted
            || !['turn.actor.spawn-sync', 'turn.actor.spawn-async', 'turn.actor.message']
              .includes(operation)));
        }
        delegationTrusted = delegationTrusted && parent.spawnedTrusted === true;
        ceiling = new Set([...ceiling].filter((operation) => parentOperations.includes(operation)));
        current = parent;
      }
      return [];
    };
    const authorityCeiling = actorRecord.kind === 'spawned'
      ? await validateSpawnedGrant(actorRecord)
      : actorOperationGrant(actorRecord, job.inbound === true);
    const projectedOperations = Array.isArray(job.allowedOperations)
      ? job.allowedOperations : [];
    const grantedOperations = [...new Set(projectedOperations)].filter((operation) =>
      typeof operation === 'string' && authorityCeiling.includes(operation));
    const programOperations = job.actorSurface === 'code'
      ? [...new Set(Array.isArray(job.programOperations) ? job.programOperations : [])]
        .filter((operation) => typeof operation === 'string'
          && authorityCeiling.includes(operation))
      : [];
    if (actorRecord.kind === 'actor' && !knownBoundActorIdentity(actorRecord)) {
      return {
        ok: false, started: false, phase: 'admission', code: 'actor_identity_invalid',
        error: 'actor run has an unknown authority identity', outcomeKnown: true,
      };
    }
    try {
      await ensureActorHost();
    } catch (error) {
      return {
        ok: false, started: false, phase: 'startup', code: 'actor_host_unavailable',
        error: `actor host unavailable: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`,
      };
    }
    if (signal?.aborted) {
      return { ok: false, started: true, phase: 'startup', code: 'actor_run_aborted', error: 'actor run aborted', aborted: true };
    }
    const runId = `aw-${now().toString(36)}-${++seq}`;
    const relayToken = mintRelayToken();
    // This controller is the authoritative relay lifetime. Put it in the grant
    // itself so a route that already resolved the token can re-check authority
    // after every await, even after run() retires the Map entry.
    const relayController = new AbortController();
    // Only the SW caller can stamp `inbound:true`. From here onward the bit is
    // monotonic: the runner/Worker may echo it but can never widen its tool grant
    // or rebuild a trusted ctx. Unknown inbound actor kinds get no tools.
    const inbound = job.inbound === true;
    const tools = job.tools;
    const turnGeneration = `${runId}:1`;
    const initialOwnedTabId = actorRecord.kind === 'actor'
      && actorRecord.actorType === 'web'
      && canonicalActorBacking(actorRecord) === 'tab'
      && typeof ownedTabFor === 'function'
      ? ownedTabFor(job.actorSessionId) : undefined;
    const authorityPageResourceKey = actorRecord.kind === 'actor'
      && actorRecord.actorType === 'web'
      && canonicalActorBacking(actorRecord) === 'tab'
      ? Number.isInteger(initialOwnedTabId)
        ? `page:tab:${initialOwnedTabId}` : `page:actor:${job.actorSessionId}`
      : null;
    const semanticStepCap = Number.isSafeInteger(job.maxSteps)
      ? Math.min(64, Math.max(1, Number(job.maxSteps))) : 20;
    const requestedMaxOutputTokens = job.maxOutputTokens;
    const grant = {
      runId, actorSessionId: job.actorSessionId,
      provider: job.provider, model: job.model,
      maxOutputTokens: typeof requestedMaxOutputTokens === 'number'
        && Number.isFinite(requestedMaxOutputTokens) && requestedMaxOutputTokens > 0
        ? Math.floor(requestedMaxOutputTokens) : undefined,
      providerOwner: Object.freeze({ runId }),
      inbound, relaySignal: relayController.signal, turnGeneration,
      actorRecord, allowedOperations: new Set(grantedOperations),
      authorityPageResourceKey,
      effectRelayLimit: Math.min(toolRelayLimit, 256 * semanticStepCap),
      modelRelayLimit: Math.min(modelRelayLimit, 32 * semanticStepCap),
      modelRelays: 0, toolRelays: 0, loopEvents: 0,
      programOperations: new Set(
        programOperations,
      ),
      modelActive: false, modelStreamId: null, contextRead: false,
      semanticEffectIds: new Set(), semanticEffectSequences: new Map(),
      semanticCallState: new Map(), effectReceipts: new Map(),
      claimedEffectsByCall: new Map(),
      closingCalls: new Set(), completedCalls: new Set(),
      finalizing: false,
      pendingClaimsByCall: new Map(),
      nestedCallIds: new Set(),
      openEffects: new Map(),
      activeSafeDispatches: new Set(), activeDispatches: new Set(),
      dispatchesByCall: new Map(),
      ...(job.actorSurface === 'code' || job.actorSurface === 'tools'
        ? { actorSurface: job.actorSurface }
        : {}),
    };
    // Firefox's direct in-process host uses the private token map. Chrome
    // binds the grant directly to one transferred MessageChannel closure.
    if (!runOnChannel) grants.set(relayToken, grant);
    if (onEvent) runOnEvent.set(runId, onEvent);
    runMeta.set(runId, {
      sessionId: job.actorSessionId,
      label: job.actorType ? `actor:${job.actorType}` : `actor d${job.depth ?? 1}`,
    });
    const abortRelays = () => {
      // Stop/host loss closes new exact effects synchronously. Settlement may
      // still join or retry its frozen result, but no effect can enter behind it.
      abortedRuns.add(runId);   // cover an inference open that has not reached the route yet
      relayController.abort();
      void providerEgress?.closeOwner(grant.providerOwner).catch(() => {});
    };
    const abortRun = () => {
      abortRelays();
      if (!runOnChannel) sendMessage({ type: 'actor/abort', runId }).catch(() => {});
    };
    if (signal && !signal.aborted) signal.addEventListener('abort', abortRun, { once: true });
    else if (signal?.aborted) abortRun();
    try {
      const result = runOnChannel
        ? await runOnChannel(
          { ...job, inbound, tools, runId, turnGeneration, recordKind: actorRecord.kind },
          {
            signal,
            relay: (type, payload) => {
              const route = /** @type {Record<string, Function>} */ (routes)[type];
              if (!route) return { ok: false, error: `unknown actor relay: ${type}` };
              return route(payload, undefined, grant);
            },
          },
        )
        : await sendMessage({
          type: 'actor/run', job: {
            ...job, inbound, tools, runId, turnGeneration,
            recordKind: actorRecord.kind, relayToken,
          },
        });
      // why: Worker completion is not semantic-call completion. Close new
      // claims first, then drain every claim/effect the host already admitted
      // before trusting or persisting Worker-authored transcript blocks.
      grant.finalizing = true;
      let custodyDrained = false;
      const drainCustody = (async () => {
        while (true) {
          const claims = [...grant.pendingClaimsByCall.values()]
            .flatMap((pending) => [...pending]);
          if (claims.length === 0) break;
          await Promise.allSettled(claims);
        }
        while (grant.activeDispatches.size > 0) {
          await Promise.allSettled([...grant.activeDispatches]);
        }
        custodyDrained = true;
      })();
      await boundedCleanup(drainCustody);
      const openSemanticCustody = !custodyDrained
        || grant.pendingClaimsByCall.size > 0 || grant.activeDispatches.size > 0
        || grant.openEffects.size > 0 || grant.semanticCallState.size > 0;
      if (openSemanticCustody) {
        return {
          ok: false,
          code: 'actor_semantic_completion_missing',
          error: 'actor authority work ended without a completed semantic result',
          outcomeKnown: false, retryable: false,
          authorityPerformed: [...grant.effectReceipts.values()]
            .some((receipt) => receipt.performed === true),
          finalText: '', newMessages: [],
        };
      }
      const receiptCallIds = new Set([...grant.effectReceipts.values()]
        .map((receipt) => receipt.callId)
        .filter((callId) => typeof callId === 'string' && !grant.nestedCallIds.has(callId)));
      const issuedCalls = new Map();
      const durableResultCounts = new Map();
      let invalidCallLedger = false;
      for (const message of Array.isArray(result?.newMessages) ? result.newMessages : []) {
        for (const call of Array.isArray(message?.toolUses) ? message.toolUses : []) {
          if (typeof call?.id !== 'string' || !call.id
              || typeof call?.name !== 'string' || !call.name
              || issuedCalls.has(call.id)) {
            invalidCallLedger = true;
            continue;
          }
          issuedCalls.set(call.id, call.name);
        }
        for (const block of Array.isArray(message?.toolResults) ? message.toolResults : []) {
          if (typeof block?.tool_use_id !== 'string' || !block.tool_use_id) {
            invalidCallLedger = true;
            continue;
          }
          durableResultCounts.set(
            block.tool_use_id, (durableResultCounts.get(block.tool_use_id) ?? 0) + 1,
          );
        }
      }
      if (invalidCallLedger
          || [...durableResultCounts].some(([callId, count]) =>
            count !== 1 || !issuedCalls.has(callId))
          || [...receiptCallIds].some((callId) =>
            durableResultCounts.get(callId) !== 1 || !issuedCalls.has(callId))) {
        return {
          ok: false,
          code: 'actor_semantic_result_ledger_invalid',
          error: 'actor semantic results do not uniquely match model-issued calls',
          outcomeKnown: false, retryable: false,
          authorityPerformed: [...grant.effectReceipts.values()]
            .some((receipt) => receipt.performed === true),
          finalText: '', newMessages: [],
        };
      }
      // Stop / cancel cascade: `signal.aborted` HERE is the authoritative proof a Stop
      // hit THIS run — and the one place it's reliably observable. The worker unwinds an
      // abort several ways (a rejected relay, a stream error, or the
      // 'abort' message) and can even finish CLEANLY (no error event, empty reply) that
      // looks like a natural end at the result shape. Stamp only known no-reply
      // cancellations; unknown custody stays terminal. The caller then renders the actor
      // card 'cancelled' (not a blank 'ok'/'failed') and spawn.js records stopReason
      // 'aborted'. A run that produced text just before Stop (raced) keeps its result.
      if (result && Array.isArray(result.newMessages)) {
        // why: the isolated heap owns semantic transcript shaping, but authority
        // receipts are host facts. Strip any worker claim and re-stamp every
        // persisted tool block from this run's exact receipt ledger before the
        // session store ever sees it.
        result.newMessages = result.newMessages.map((/** @type {any} */ message) => {
          if (!message || typeof message !== 'object' || Array.isArray(message)
              || !Array.isArray(message.toolResults)) return message;
          return {
            ...message,
            toolResults: message.toolResults.map((/** @type {any} */ block) => {
              if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
              const receipts = authorityReceiptsForCall(
                grant.effectReceipts, block.tool_use_id,
              );
              return stampAuthorityToolResultBlock(receipts, block);
            }),
          };
        });
        for (const message of result.newMessages) {
          for (const block of Array.isArray(message?.toolResults) ? message.toolResults : []) {
            const callId = block?.tool_use_id;
            if (typeof callId !== 'string') continue;
            await Promise.resolve(appendAudit(semanticCallAuditEntry({
              sessionId: grant.actorSessionId,
              callId,
              label: issuedCalls.get(callId),
              result: block,
            }))).catch(() => {});
          }
        }
      }
      if ([...grant.effectReceipts.values()].some((receipt) => receipt.outcomeKnown === false)) {
        result.ok = false;
        result.code = 'actor_authority_outcome_unknown';
        result.error = 'An accepted authority operation ended without a known host outcome.';
        result.outcomeKnown = false;
        result.retryable = false;
        result.authorityPerformed = [...grant.effectReceipts.values()]
          .some((receipt) => receipt.performed === true);
        result.finalText = '';
      }
      if (signal?.aborted && result && !result.finalText && result.outcomeKnown !== false) {
        result.aborted = true;
      }
      return result;
    } finally {
      // Settlement is a cancellation boundary for every host relay, including a
      // runner-owned timeout/crash that never aborts the caller's turn signal.
      // Abort BEFORE retiring the grant so a route that already resolved it sees
      // the terminal signal and exits rather than continuing without a grant.
      try {
        abortRelays();
        // Drop the abort listener a completed-without-Stop run left attached (a no-op if
        // it already fired under {once:true}); keeps nothing dangling on the turn signal.
        signal?.removeEventListener('abort', abortRun);
        relayController.abort();
        if (providerEgress?.closeOwner) {
          await boundedCleanup(Promise.resolve().then(() =>
            providerEgress.closeOwner(grant.providerOwner)));
        }
        const custodySettled = Promise.allSettled([...grant.activeDispatches]).finally(() => {
          grant.semanticEffectIds.clear();
          grant.semanticCallState.clear();
          grant.effectReceipts.clear();
          grant.claimedEffectsByCall.clear();
          grant.closingCalls.clear();
          grant.completedCalls.clear();
          grant.pendingClaimsByCall.clear();
          grant.nestedCallIds.clear();
          grant.dispatchesByCall.clear();
        });
        // why: the caller must not be held forever by an unabortable host API,
        // but its custody remains live until the API settles. Retiring relay
        // admission now and clearing only in this promise keeps a late
        // irreversible result auditable instead of forgetting it at 250 ms.
        await boundedCleanup(custodySettled);
      } finally {
        // Retiring the grant is what makes it a liveness check: every relay for
        // this run is refused from here on, so a late/replayed one can't dispatch.
        if (!runOnChannel) grants.delete(relayToken);
        runOnEvent.delete(runId);
        runMeta.delete(runId);
        abortedRuns.delete(runId);
      }
    }
  };

  /**
   * Resolve a relay's identity. Chrome passes the grant through a private channel
   * closure. Firefox requires its private host sender identity and a live grant
   * token. Every route treats a missing or retired grant as a hard refusal.
   * @param {{ relayToken?: unknown }} [msg]
   * @param {unknown} [sender]  the second argument makeDispatcher hands a handler
   * @returns {any}
   */
  const grantFor = (msg, sender, boundGrant = null) => {
    if (boundGrant) return boundGrant;
    if (!relaySenderAllowed(sender)) return null;
    const token = msg?.relayToken;
    if (typeof token !== 'string' || token.length === 0) return null;
    return grants.get(token) ?? null;
  };

  const runIsLive = (/** @type {any} */ grant) => !!grant
    && !grant.relaySignal.aborted && !abortedRuns.has(grant.runId);
  const fixedOperation = (/** @type {string} */ routeOperation) =>
    routeOperation.startsWith('turn.')
      ? routeOperation : `turn.${routeOperation.replace('/', '.')}`;
  const durableAuthorityTarget = async (
    /** @type {any} */ grant,
    /** @type {string} */ operation,
    /** @type {unknown} */ args,
  ) => {
    const record = grant.actorRecord;
    const backing = record.kind === 'actor' ? canonicalActorBacking(record) : null;
    const ownedTabId = record.kind === 'actor' && record.actorType === 'web'
      && backing === 'tab' && typeof ownedTabFor === 'function'
      ? ownedTabFor(grant.actorSessionId) : undefined;
    const identity = record.kind === 'actor'
      ? `${record.actorType}:${grant.actorSessionId}:${record.instanceId ?? 'missing'}:${backing ?? 'missing'}`
      : `spawned:${record.sessionId ?? grant.actorSessionId}`;
    const hostTarget = ownedTabId === undefined ? identity : `${identity}:tab:${ownedTabId}`;
    return `${operation}:${hostTarget}:${await canonicalCloneDigest(args ?? {}, {
      maxBytes: controllerDomainOperationPayloadCap(operation),
    })}`;
  };
  const contextForOperation = async (
    /** @type {any} */ grant,
    /** @type {string} */ operation,
  ) => {
    const record = await sessions.get(grant.actorSessionId).catch(() => null);
    if (!runIsLive(grant) || !record || record.kind !== grant.actorRecord.kind) return null;
    if (record.kind === 'actor') {
      if (record.actorType !== grant.actorRecord.actorType
          || canonicalActorBacking(record) !== canonicalActorBacking(grant.actorRecord)
          || record.instanceId !== grant.actorRecord.instanceId) return null;
    } else if (!sameClone(record.grantedOperations, grant.actorRecord.grantedOperations)) return null;
    if (!actorOperationGrant(record, grant.inbound).includes(operation)) return null;
    const activeTabId = record.kind === 'actor' && record.actorType === 'web'
      && canonicalActorBacking(record) === 'tab' && ownedTabFor
      ? ownedTabFor(grant.actorSessionId) : undefined;
    const base = await buildToolContext(record.kind === 'actor' ? {
      exposure: EXPOSURE_ACTOR, sessionId: grant.actorSessionId, activeTabId,
      actorInstanceId: record.instanceId, actorType: record.actorType,
      actorBacking: canonicalActorBacking(record), lifecycleTurnId: grant.runId,
      lifecycleUserInitiated: !grant.inbound,
      ...(grant.actorSurface ? { actorSurface: grant.actorSurface } : {}),
      ...(grant.inbound ? { synthetic: true, trusted: false } : {}),
    } : {
      sessionId: grant.actorSessionId, lifecycleTurnId: grant.runId,
      lifecycleUserInitiated: !grant.inbound,
      ...(grant.inbound ? { synthetic: true, trusted: false } : {}),
    });
    return runIsLive(grant) ? {
      ...base, abortSignal: grant.relaySignal,
      ...(grant.authorityPageResourceKey
        ? { authorityPageResourceKey: grant.authorityPageResourceKey } : {}),
      // why: nested script capabilities must derive from the same immutable
      // run grant as their outer exact operation. Absence is never permission.
      operationGrant: createReadOnlyOperationGrant(grant.allowedOperations),
      ...(grant.inbound ? { synthetic: true, trusted: false, inbound: true } : {}),
    } : null;
  };
  const claimSemanticEffect = async (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string} */ domain,
    /** @type {string[]} */ fields,
    /** @type {string[]} */ optionalFields = [],
    /** @type {string[]} */ transportFields = [],
  ) => {
    const payloadBytes = structuredClonePayloadBytes(msg, {
      maxDepth: 32, maxNodes: 250_000,
    });
    const operation = msg?.operation;
    const policy = typeof operation === 'string'
      ? controllerDomainOperationPolicy(operation) : null;
    if (!grant || !policy || !Number.isFinite(payloadBytes)
        || payloadBytes > controllerDomainOperationPayloadCap(operation)
        || policy.authorityClass !== domain
        || !exactKeys(msg, [
          'operation', 'callId', 'effectId', 'effectSequence', 'turnGeneration', ...fields,
        ], ['relayToken', 'parentCallId', ...optionalFields, ...transportFields])
        || typeof msg.callId !== 'string' || typeof msg.effectId !== 'string'
        || !Number.isSafeInteger(msg.effectSequence)
        || msg.effectSequence < 1 || msg.effectSequence > 256
        || msg.effectId !== `${msg.callId}:${msg.effectSequence}`
        || msg.turnGeneration !== grant.turnGeneration
        || grant.closingCalls.has(msg.callId) || grant.completedCalls.has(msg.callId)
        || grant.finalizing === true
        || grant.semanticEffectIds.has(msg.effectId)
        || msg.effectSequence !== (grant.semanticEffectSequences.get(msg.callId) ?? 0) + 1
        || grant.toolRelays >= grant.effectRelayLimit || !runIsLive(grant)) return null;
    const nestedOperation = grant.programOperations.has(operation);
    const hasParent = typeof msg.parentCallId === 'string';
    if (nestedOperation !== hasParent
        || !nestedOperation && !grant.allowedOperations.has(operation)) return null;
    const parentEffect = typeof msg.parentCallId === 'string'
      ? grant.openEffects.get(msg.parentCallId) ?? null : null;
    const expectedParentOperation = PAGE_PROGRAM_EXACT_OPERATION_SET.has(operation)
      ? 'turn.page.run-program'
      : APP_PROGRAM_EXACT_OPERATION_SET.has(operation)
        ? 'turn.app.run-code' : null;
    if (typeof msg.parentCallId === 'string'
        && (!expectedParentOperation || !parentEffect
          || parentEffect.operation !== expectedParentOperation)) return null;
    if (typeof msg.parentCallId === 'string') grant.nestedCallIds.add(msg.callId);
    // why: reserve the exact sequence before the first asynchronous authority
    // lookup. Two MessageChannel requests can carry different transport IDs but
    // the same semantic effect ID; delaying this reservation let both pass and
    // execute an irreversible operation twice.
    grant.semanticEffectIds.add(msg.effectId);
    grant.semanticEffectSequences.set(msg.callId, msg.effectSequence);
    const claimed = grant.claimedEffectsByCall.get(msg.callId) ?? new Map();
    claimed.set(msg.effectId, operation);
    grant.claimedEffectsByCall.set(msg.callId, claimed);
    let state = grant.semanticCallState.get(msg.callId);
    if (!state) {
      state = { domainState: {} };
      grant.semanticCallState.set(msg.callId, state);
    }
    /** @type {(value?: unknown) => void} */
    let resolveClaim = () => {};
    const claimDrain = new Promise((resolve) => { resolveClaim = resolve; });
    const pendingClaims = grant.pendingClaimsByCall.get(msg.callId) ?? new Set();
    pendingClaims.add(claimDrain);
    grant.pendingClaimsByCall.set(msg.callId, pendingClaims);
    let handedToDispatch = false;
    const releaseClaim = () => {
      pendingClaims.delete(claimDrain);
      if (pendingClaims.size === 0) grant.pendingClaimsByCall.delete(msg.callId);
      resolveClaim();
    };
    const refuseReservedClaim = () => {
      if (grant.effectReceipts.has(msg.effectId)) return;
      grant.effectReceipts.set(msg.effectId, Object.freeze({
        callId: msg.callId, effectId: msg.effectId, operation,
        outcome: 'not-performed', outcomeKnown: true, performed: false,
        retryable: false, code: 'authority_claim_refused',
        error: 'exact authority claim was refused before host dispatch',
      }));
    };
    try {
      const ctx = await contextForOperation(grant, operation);
      if (!ctx || !runIsLive(grant) || grant.finalizing === true
          || grant.closingCalls.has(msg.callId) || grant.completedCalls.has(msg.callId)) return null;
      const args = /** @type {Readonly<Record<string, any>>} */ (Object.freeze(
        Object.fromEntries([...fields, ...optionalFields]
          .filter((key) => Object.hasOwn(msg, key)).map((key) => [key, msg[key]])),
      ));
      let authority;
      const input = {
        operation, args, ctx, signal: grant.relaySignal,
        ...(domain === 'page' && transportFields.includes('pageProgramSemanticToken')
          ? { pageProgramSemanticToken: msg.pageProgramSemanticToken }
          : {}),
        ...(domain === 'app' && transportFields.includes('appProgramSemanticToken')
          ? { appProgramSemanticToken: msg.appProgramSemanticToken }
          : {}),
      };
      if (domain === 'repository') authority = bindRepositoryToolAuthority(state.domainState, input);
      else if (domain === 'vm') authority = bindVmToolAuthority(state.domainState, input);
      else if (domain === 'notebook') authority = bindNotebookToolAuthority(state.domainState, input);
      else if (domain === 'app') authority = bindAppToolAuthority(state.domainState, input);
      else if (domain === 'persistence') authority = bindPersistenceToolAuthority(state.domainState, input);
      else if (domain === 'page') authority = bindPageToolAuthority(state.domainState, input);
      else if (domain === 'resource') authority = bindResourceToolAuthority(state.domainState, input);
      else if (domain === 'siteclient') authority = bindSiteClientToolAuthority(state.domainState, input);
      else if (domain === 'execution') authority = bindExecutionToolAuthority(state.domainState, input);
      else if (domain === 'editing') authority = bindEditingToolAuthority(state.domainState, input);
      else if (domain === 'introspection') authority = bindIntrospectionToolAuthority(state.domainState, input);
      else if (domain === 'schedule') authority = bindScheduleToolAuthority(state.domainState, input);
      else if (domain === 'dweb') authority = bindDwebToolAuthority(state.domainState, input);
      else if (domain === 'pod' || domain === 'actor') authority = Object.freeze({});
      else return null;
      if (grant.closingCalls.has(msg.callId) || grant.completedCalls.has(msg.callId)
          || !runIsLive(grant)) return null;
      grant.toolRelays += 1;
      handedToDispatch = true;
      return /** @type {any} */ ({
        grant, ctx, operation, args, authority, domainState: state.domainState, releaseClaim,
        effect: { callId: msg.callId, effectId: msg.effectId, parentEffect },
      });
    } finally {
      if (!handedToDispatch) {
        refuseReservedClaim();
        releaseClaim();
      }
    }
  };
  const domainEntry = (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string} */ domain,
    /** @type {string[]} */ fields,
    /** @type {string[]} */ optionalFields = [],
    /** @type {string[]} */ transportFields = [],
  ) => claimSemanticEffect(grant, msg, domain, fields, optionalFields, transportFields);
  const entryForDomain = (/** @type {string} */ domain) => (
    /** @type {any} */ grant,
    /** @type {any} */ msg,
    /** @type {string[]} */ fields = [],
    /** @type {string[]} */ optional = [],
    /** @type {string[]} */ transport = [],
  ) => domainEntry(grant, msg, domain, fields, optional, transport);
  const repositoryEntry = entryForDomain('repository');
  const vmEntry = entryForDomain('vm');
  const notebookEntry = entryForDomain('notebook');
  const appEntry = entryForDomain('app');
  const persistenceEntry = entryForDomain('persistence');
  const pageEntry = entryForDomain('page');
  const resourceEntry = entryForDomain('resource');
  const siteClientEntry = entryForDomain('siteclient');
  const executionEntry = entryForDomain('execution');
  const editingEntry = entryForDomain('editing');
  const introspectionEntry = entryForDomain('introspection');
  const scheduleEntry = entryForDomain('schedule');
  const dwebEntry = entryForDomain('dweb');
  const receiptFor = (
    /** @type {any} */ entry,
    /** @type {string} */ outcome,
    /** @type {boolean} */ outcomeKnown,
    /** @type {boolean} */ performed,
    /** @type {boolean} */ retryable,
    /** @type {string|null} */ target,
  ) => Object.freeze({
    effectId: entry.effect.effectId, operation: entry.operation,
    outcome, outcomeKnown, performed, retryable,
    ...(target ? { target } : {}),
  });
  const appendAuthorityAudit = async (
    /** @type {any} */ entry,
    /** @type {any} */ receipt,
    /** @type {boolean} */ failed,
  ) => {
    const append = entry.ctx?.appendAudit ?? entry.ctx?.audit;
    if (typeof append !== 'function') return;
    await append({
      type: failed || receipt.outcomeKnown !== true
        ? 'authority_effect_failed' : 'authority_effect',
      sessionId: entry.grant.actorSessionId,
      details: {
        operation: entry.operation, outcome: receipt.outcome,
        outcomeKnown: receipt.outcomeKnown === true,
        performed: receipt.performed === true,
        refused: receipt.refused === true,
        retryable: receipt.retryable === true,
        ...(typeof receipt.code === 'string' ? { code: receipt.code } : {}),
        ...(typeof receipt.ugcZone === 'string' ? { ugcZone: receipt.ugcZone } : {}),
        target: receipt.target, runId: entry.grant.runId,
        actorSessionId: entry.grant.actorSessionId,
      },
    }).catch(() => {});
  };
  const recordAuthorityReceipt = (
    /** @type {any} */ entry,
    /** @type {any} */ receipt,
  ) => {
    entry.grant.effectReceipts.set(entry.effect.effectId, {
      ...receipt, callId: entry.effect.callId,
    });
    if (entry.effect.parentEffect) {
      entry.grant.effectReceipts.set(
        `${entry.effect.effectId}@${entry.effect.parentEffect.callId}`,
        { ...receipt, callId: entry.effect.parentEffect.callId },
      );
    }
  };
  const performSemanticEffect = async (
    /** @type {any} */ entry,
    /** @type {string|null} */ target,
    /** @type {()=>Promise<any>|any} */ execute,
    /** @type {{fulfilled?:(value:any)=>unknown,rejected?:(cause:unknown)=>unknown}|null} */ effectOutcome,
    /** @type {any} */ tracking = null,
    /** @type {string|null} */ schedulerTarget = target,
    /** @type {{confirmed:boolean,confirmedIntentRequired:boolean}|null} */ dispatchAdmission = null,
  ) => {
    const policy = controllerDomainOperationPolicy(entry.operation);
    const replayable = policy?.riskClass === 'read';
    if (!replayable && (typeof effectOutcome?.fulfilled !== 'function'
        || typeof effectOutcome?.rejected !== 'function')) {
      return {
        ok: false, error: 'domain effect verdict contract is unavailable',
        outcomeKnown: true, retryable: false,
      };
    }
    try {
      const parentLease = entry.effect.parentEffect?.lease ?? null;
      const value = await authorityScheduler.run({
        read: policy?.riskClass === 'read',
        target: schedulerTarget ?? entry.operation, parentLease,
        // why: the outer page program is a semantic host/drain scope, not the
        // page mutation itself. Each nested exact op acquires its own SW-derived
        // resource lane, preventing A→B/B→A lock cycles while still serializing
        // same-resource mutations.
        scopeOnly: entry.operation === 'turn.page.run-program',
        signal: entry.grant.relaySignal,
      }, async (lease) => {
        if (!runIsLive(entry.grant) || entry.grant.closingCalls.has(entry.effect.callId)
            || entry.grant.completedCalls.has(entry.effect.callId)) {
          throw Object.assign(new Error('actor authority stopped before host dispatch'), {
            outcomeKnown: true, retryable: false,
          });
        }
        if (dispatchAdmission) {
          const livePermission = typeof entry.ctx?.readAuthorityPermission === 'function'
            ? await entry.ctx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
            : entry.ctx?.permission;
          if (!controllerOperationAllowedInPermissionMode(
            entry.operation, livePermission?.mode, entry.args,
          )) throw Object.assign(
            new Error('permission changed while the authority effect was queued'),
            { code: 'plan_mode_refused', outcomeKnown: true, retryable: false },
          );
          const confirmationRequired = controllerOperationRequiresConfirmation(
            entry.operation, livePermission, entry.args,
            dispatchAdmission.confirmedIntentRequired,
          );
          if (confirmationRequired && dispatchAdmission.confirmed !== true) {
            throw Object.assign(
              new Error('confirmation policy changed while the authority effect was queued'),
              { code: 'confirmation_required', outcomeKnown: true, retryable: true },
            );
          }
          if (!runIsLive(entry.grant) || entry.grant.closingCalls.has(entry.effect.callId)
              || entry.grant.completedCalls.has(entry.effect.callId)) {
            throw Object.assign(new Error('actor authority stopped before host dispatch'), {
              outcomeKnown: true, retryable: false,
            });
          }
        }
        entry.grant.openEffects.set(entry.effect.effectId, {
          callId: entry.effect.callId, operation: entry.operation, lease,
        });
        try { return await execute(); }
        finally { entry.grant.openEffects.delete(entry.effect.effectId); }
      });
      const verdict = typeof effectOutcome?.fulfilled === 'function'
        ? normalizeExactEffectOutcome(effectOutcome.fulfilled(value)) : 'not-performed';
      const confirmationStage = effectOutcome === HOST_EFFECT_OUTCOME.confirmation;
      const policyAttribution = safeHostPolicyAttribution(value);
      const confirmationDeclined = confirmationStage && verdict === 'not-performed';
      const refusal = confirmationDeclined
        || verdict === 'not-performed' && hostEffectValueIsRefusal(value);
      const refusalFailure = confirmationDeclined
        ? HOST_CONFIRMATION_DECLINED : safeHostEffectFailure(value);
      const performed = !confirmationStage && (verdict === 'performed'
        || verdict === 'unknown' && value?.performed === true);
      const receiptOutcome = confirmationStage && verdict === 'performed'
        ? 'observed' : replayable && effectOutcome === null ? 'observed' : verdict;
      const receipt = receiptFor(
        entry, receiptOutcome, verdict !== 'unknown',
        performed,
        refusal && safeHostEffectFailure(value).retryable, target,
      );
      const stampedReceipt = Object.freeze({
        ...receipt,
        ...(refusal ? { refused: true, ...refusalFailure } : {}),
        ...policyAttribution,
      });
      recordAuthorityReceipt(entry, stampedReceipt);
      if (tracking && typeof entry.ctx?.lifecycle?.settleTracking === 'function') {
        await entry.ctx.lifecycle.settleTracking(tracking, {
          ok: verdict === 'performed' || verdict === 'not-performed' && !refusal,
          outcomeKind: verdict === 'performed' ? 'effect-completed'
            : verdict === 'unknown' ? 'host-lost'
              : refusal ? 'pre-effect-failure' : undefined,
        }).catch(() => null);
      }
      await appendAuthorityAudit(entry, stampedReceipt, false);
      const resultBytes = structuredClonePayloadBytes(value, {
        maxDepth: 32, maxNodes: 250_000,
      });
      if (!Number.isFinite(resultBytes) || resultBytes > ACTOR_AUTHORITY_RESULT_CAP) {
        return {
          ok: false, error: 'authority result exceeds its fixed byte cap',
          outcomeKnown: true, retryable: false, authorityReceipt: stampedReceipt,
        };
      }
      return verdict === 'unknown'
        ? { ok: false, error: 'authority effect outcome is unknown', outcomeKnown: false, retryable: false, authorityReceipt: stampedReceipt }
        : { ok: true, value: { authorityValue: value, authorityReceipt: stampedReceipt }, outcomeKnown: true };
    } catch (cause) {
      const verdict = typeof effectOutcome?.rejected === 'function'
        ? normalizeExactEffectOutcome(effectOutcome.rejected(cause)) : 'not-performed';
      const outcomeKnown = replayable || verdict !== 'unknown';
      const detail = /** @type {{retryable?:boolean}} */ (cause);
      const failure = safeHostEffectFailure(cause);
      const performed = verdict === 'performed'
        || verdict === 'unknown'
          && /** @type {{performed?:unknown}} */ (cause)?.performed === true;
      const safeError = verdict === 'not-performed'
        ? failure.error ?? failure.code ?? 'Authority operation was refused before execution.'
        : verdict === 'performed'
          ? 'Authority operation failed after an effect was performed.'
          : 'Authority operation outcome is unknown.';
      const receiptOutcome = replayable && effectOutcome === null && verdict !== 'unknown'
        ? 'observed' : verdict;
      const receipt = receiptFor(
        entry, receiptOutcome, outcomeKnown, performed,
        verdict === 'not-performed' && detail?.retryable !== false, target,
      );
      const stampedReceipt = verdict === 'not-performed'
        ? Object.freeze({ ...receipt, refused: true, ...failure }) : receipt;
      recordAuthorityReceipt(entry, stampedReceipt);
      if (tracking && typeof entry.ctx?.lifecycle?.settleTracking === 'function') {
        await entry.ctx.lifecycle.settleTracking(tracking, {
          ok: verdict === 'performed', error: safeError,
          outcomeKind: verdict === 'performed' ? 'effect-completed'
            : verdict === 'unknown' ? 'host-lost' : 'pre-effect-failure',
        }).catch(() => null);
      }
      await appendAuthorityAudit(entry, stampedReceipt, true);
      return {
        ok: false, error: safeError,
        outcomeKnown, retryable: stampedReceipt.retryable, authorityReceipt: stampedReceipt,
      };
    }
  };
  const beginAuthorityTracking = async (
    /** @type {any} */ entry,
    /** @type {string} */ target,
    /** @type {boolean} */ confirmed,
    /** @type {any} */ confirmedIntent,
  ) => {
    const policy = controllerDomainOperationPolicy(entry.operation);
    if (typeof entry.ctx?.lifecycle?.beginTracking !== 'function') return {
      refuse: { error: 'authority lifecycle is unavailable' },
    };
    const tool = Object.freeze({
      name: entry.operation, primitive: 'authority', retryClass: policy?.retryClass ?? 'E',
      sideEffect: policy?.riskClass === 'resource' ? 'mutate_external' : 'write',
    });
    const begun = await entry.ctx.lifecycle.beginTracking({
      callId: entry.effect.effectId, tool,
      sessionId: entry.grant.actorSessionId,
      ownerSessionId: entry.ctx.lifecycleOwnerSessionId ?? entry.grant.actorSessionId,
      target, args: entry.args, confirmed, confirmedIntent,
      turnId: entry.grant.runId, userInitiated: !entry.grant.inbound,
    });
    return begun?.refuse ? { refuse: begun.refuse } : { tracking: begun?.handle ?? null };
  };
  const prepareAuthorityEffect = async (
    /** @type {any} */ entry,
    /** @type {string} */ target,
  ) => {
    const policy = controllerDomainOperationPolicy(entry.operation);
    const livePermission = typeof entry.ctx?.readAuthorityPermission === 'function'
      ? await entry.ctx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
      : entry.ctx?.permission;
    if (!controllerOperationAllowedInPermissionMode(
      entry.operation, livePermission?.mode, entry.args,
    )) {
      return { refuse: await performSemanticEffect(
        entry, target,
        () => ({
          ok: false, code: 'plan_mode_refused',
          error: 'plan mode is read-only for this authority operation', retryable: false,
        }),
        HOST_EFFECT_OUTCOME.okResult,
      ) };
    }
    const tool = Object.freeze({
      name: entry.operation, primitive: 'authority', retryClass: policy?.retryClass ?? 'E',
      sideEffect: policy?.riskClass === 'resource' ? 'mutate_external' : 'write',
    });
    const confirmedIntent = await Promise.resolve(
      entry.ctx.lifecycle?.requiresIntentConfirmation?.({
        tool, sessionId: entry.grant.actorSessionId,
        ownerSessionId: entry.ctx.lifecycleOwnerSessionId ?? entry.grant.actorSessionId,
        target, args: entry.args, userInitiated: !entry.grant.inbound,
      }),
    ).catch(() => false);
    const mustConfirm = controllerOperationRequiresConfirmation(
      entry.operation, livePermission, entry.args, confirmedIntent?.required === true,
    );
    let confirmed = false;
    if (mustConfirm) {
      if (typeof entry.ctx.confirm !== 'function') return { refuse: await performSemanticEffect(
        entry, target, () => ({ ok: false, error: 'confirmation_unavailable', retryable: false }),
        HOST_EFFECT_OUTCOME.okResult,
      ) };
      const presentation = authorityEffectConfirmationPresentation(
        entry.operation, entry.args, target,
      );
      if (!presentation) return { refuse: await performSemanticEffect(
        entry, target, () => ({
          ok: false, code: 'confirmation_presentation_unavailable',
          error: 'authority confirmation target cannot be presented safely', retryable: false,
        }), HOST_EFFECT_OUTCOME.okResult,
      ) };
      const answer = await entry.ctx.confirm({
        tool: entry.operation,
        sideEffect: policy?.riskClass === 'resource' ? 'mutate_external' : 'write',
        origins: [...presentation.origins], sessionId: entry.grant.actorSessionId,
        ...(confirmedIntent?.required === true ? { lifecycleTarget: target } : {}),
        oneShot: confirmedIntent?.required === true ? true : undefined,
        summary: presentation.summary,
      }, entry.grant.relaySignal).catch(() => false);
      if (!runIsLive(entry.grant)) return { refuse: await performSemanticEffect(
        entry, target, () => ({ ok: false, error: 'authority_effect_aborted' }),
        HOST_EFFECT_OUTCOME.okResult,
      ) };
      confirmed = answer === true || answer === 'yes_once' || answer === 'yes_session';
      if (!confirmed) return { refuse: await performSemanticEffect(
        entry, target, () => ({ ok: false, error: 'declined', retryable: false }), HOST_EFFECT_OUTCOME.okResult,
      ) };
    }
    const dispatchPermission = typeof entry.ctx?.readAuthorityPermission === 'function'
      ? await entry.ctx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
      : entry.ctx?.permission;
    if (!controllerOperationAllowedInPermissionMode(
      entry.operation, dispatchPermission?.mode, entry.args,
    )) return { refuse: await performSemanticEffect(
      entry, target, () => ({
        ok: false, code: 'plan_mode_refused',
        error: 'permission changed before authority dispatch', retryable: false,
      }), HOST_EFFECT_OUTCOME.okResult,
    ) };
    const begun = await beginAuthorityTracking(entry, target, confirmed, confirmedIntent);
    if (begun?.refuse) return { refuse: await performSemanticEffect(
      entry, target, () => ({ ok: false, error: begun.refuse.error ?? 'lifecycle_refused' }),
      HOST_EFFECT_OUTCOME.okResult,
    ) };
    if (!runIsLive(entry.grant)) return { refuse: await performSemanticEffect(
      entry, target, () => ({ ok: false, error: 'authority_effect_aborted' }),
      HOST_EFFECT_OUTCOME.okResult, begun?.tracking,
    ) };
    return {
      tracking: begun?.tracking ?? null,
      dispatchAdmission: {
        confirmed, confirmedIntentRequired: confirmedIntent?.required === true,
      },
    };
  };
  const runDomainEffect = async (
    /** @type {any} */ entry,
    /** @type {string} */ routeOperation,
    /** @type {'read'|'control'|'commit'|'resource'} */ _riskClass,
    /** @type {()=>Promise<any>|any} */ execute,
    /** @type {boolean} */ _recordEffectVerdict = false,
    /** @type {{fulfilled?:(value:any)=>unknown,rejected?:(cause:unknown)=>unknown}|null} */ effectOutcome = null,
  ) => {
    const operation = fixedOperation(routeOperation);
    if (!entry || entry.operation !== operation) {
      entry?.releaseClaim?.();
      return { ok: false, error: `${operation}: authority mismatch`, outcomeKnown: true };
    }
    const policy = controllerDomainOperationPolicy(operation);
    const pending = (async () => {
      if (!runIsLive(entry.grant)) return {
        ok: false, error: `${operation}: authority retired`, outcomeKnown: true,
      };
      let target;
      try { target = await durableAuthorityTarget(entry.grant, operation, entry.args); }
      catch {
        return {
          ok: false, error: `${operation}: authority arguments are invalid`,
          outcomeKnown: true, retryable: true,
        };
      }
      const schedulerTarget = authorityEffectResourceKey(operation, entry.args, entry.ctx);
      if (policy?.riskClass === 'read') {
        return performSemanticEffect(entry, target, execute, effectOutcome, null, schedulerTarget);
      }
      const prepared = await prepareAuthorityEffect(entry, target);
      if (prepared.refuse) return prepared.refuse;
      if (!runIsLive(entry.grant)) return performSemanticEffect(
        entry, target, () => ({ ok: false, error: 'authority_effect_aborted' }),
        HOST_EFFECT_OUTCOME.okResult, prepared.tracking,
      );
      return performSemanticEffect(
        entry, target, execute, effectOutcome, prepared.tracking, schedulerTarget,
        prepared.dispatchAdmission,
      );
    })();
    entry.grant.activeDispatches.add(pending);
    const callDispatches = entry.grant.dispatchesByCall.get(entry.effect.callId) ?? new Set();
    callDispatches.add(pending);
    entry.grant.dispatchesByCall.set(entry.effect.callId, callDispatches);
    if (policy?.riskClass === 'read') entry.grant.activeSafeDispatches.add(pending);
    // The route is now represented in the per-call dispatch drain; release the
    // earlier claim reservation only after that hand-off is complete.
    entry.releaseClaim?.();
    try { return await pending; }
    finally {
      entry.grant.activeDispatches.delete(pending);
      entry.grant.activeSafeDispatches.delete(pending);
      callDispatches.delete(pending);
      if (callDispatches.size === 0) entry.grant.dispatchesByCall.delete(entry.effect.callId);
    }
  };
  const runDirectActorEffect = async (
    /** @type {any} */ entry,
    /** @type {string} */ operation,
    /** @type {'read'|'control'|'commit'|'resource'} */ riskClass,
    /** @type {()=>Promise<any>|any} */ execute,
    /** @type {{fulfilled?:(value:any)=>unknown,rejected?:(cause:unknown)=>unknown}|null} */ effectOutcome = null,
  ) => runDomainEffect(entry, operation, riskClass, execute, false, effectOutcome);
  const stampActorCallResult = (
    /** @type {any} */ grant,
    /** @type {string} */ callId,
    /** @type {unknown} */ value,
  ) => {
    const base = value && typeof value === 'object' && !Array.isArray(value)
      ? /** @type {Record<string,any>} */ (value) : { ok: true, value };
    const receipts = authorityReceiptsForCall(grant.effectReceipts, callId);
    return stampAuthorityToolResult(receipts, base);
  };

  const routes = /** @type {Record<string, (...args: any[]) => any>} */ ({
    /**
     * @param {{relayToken?:string,providerId?:string,modelId?:string,nativeBody?:object}} [msg]
     * @param {unknown} [sender]
     * @param {any} [boundGrant]
     */
    'actor/model-open-inference': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant) return { ok: false, error: 'actor/model-open-inference: unauthorized relay' };
      const { runId } = grant;
      const key = runId;
      if (grant.relaySignal.aborted || abortedRuns.has(key)) return { ok: false, error: 'aborted' };
      if (grant.modelActive) return {
        ok: false, error: 'actor/model-open-inference: another inference is active',
        code: 'actor_model_relay_busy', outcomeKnown: true, performed: false,
      };
      if (grant.modelRelays >= grant.modelRelayLimit) return {
        ok: false, error: 'actor/model-open-inference: relay budget exhausted',
        code: 'actor_model_relay_limit', outcomeKnown: true, performed: false,
      };
      if (!providerEgress || !Number.isSafeInteger(grant.maxOutputTokens)
          || /** @type {number} */ (grant.maxOutputTokens) < 1) {
        return {
          ok: false, error: 'actor/model-open-inference: authority or output limit unavailable',
          code: 'actor_model_authority_unavailable', outcomeKnown: true, performed: false,
        };
      }
      grant.modelRelays += 1;
      grant.modelActive = true;
      try {
        // Spend-limit preflight, script/model-call's posture applied to the actor lane:
        // an actor's model calls spend the user's money on the OWNING chat session, so a
        // session past the hard cap must not be pushed further by its own actors. Without
        // this the cap bounded the orchestrator's turns only, and any actor fan-out
        // walked straight past it.
        if (spendRefusalFor) {
          const refusal = await spendRefusalFor(grant.actorSessionId).catch(() => null);
          if (refusal) {
            grant.modelActive = false;
            return { ok: false, error: refusal };
          }
        }
        if (grant.relaySignal.aborted || abortedRuns.has(key)) {
          grant.modelActive = false;
          return { ok: false, error: 'aborted' };
        }
        const meta = runMeta.get(key);
        if (meta) recordModelCall({
          provider: grant.provider,
          model: grant.model,
          maxTokens: grant.maxOutputTokens,
          sessionId: meta.sessionId,
          label: meta.label,
        });
        const result = await providerEgress.openInference({
          providerId: msg.providerId,
          modelId: msg.modelId,
          nativeBody: msg.nativeBody,
        }, {
          owner: grant.providerOwner,
          signal: grant.relaySignal,
          maxOutputTokens: grant.maxOutputTokens,
          permits: (/** @type {string} */ providerId, /** @type {string} */ modelId) => providerId === grant.provider
            && modelId === grant.model,
        });
        if (grant.relaySignal.aborted || abortedRuns.has(key)) {
          grant.modelActive = false;
          grant.modelStreamId = null;
          await boundedCleanup(Promise.resolve().then(() =>
            providerEgress.closeOwner(grant.providerOwner)));
          return { ok: false, error: 'aborted' };
        }
        if (result?.ok !== true) grant.modelActive = false;
        else if (typeof result?.value?.streamId !== 'string'
            || result.value.streamId.length === 0) {
          grant.modelActive = false;
          return {
            ok: false, error: 'actor/model-open-inference: authority returned no stream',
            code: 'actor_model_stream_invalid', outcomeKnown: true,
          };
        }
        else {
          grant.modelStreamId = result.value.streamId;
          if (result.value.hasBody !== true) {
            await providerEgress.cancelInference({ streamId: grant.modelStreamId }, {
              owner: grant.providerOwner,
            }).catch(() => {});
            grant.modelActive = false;
            grant.modelStreamId = null;
          }
        }
        return result;
      } catch (error) {
        grant.modelActive = false;
        const failure = /** @type {{message?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (error);
        return {
          ok: false, error: failure?.message ?? String(error),
          outcomeKnown: failure?.outcomeKnown === true,
          ...(failure?.retryable === false || failure?.outcomeKnown !== true
            ? { retryable: false } : {}),
        };
      }
    },
    /**
     * @param {{relayToken?:string,streamId?:string}} [msg]
     * @param {unknown} [sender]
     * @param {any} [boundGrant]
     */
    'actor/model-read-inference-chunk': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant) return { ok: false, error: 'actor/model-read-inference-chunk: unauthorized relay' };
      if (!providerEgress || grant.relaySignal.aborted || abortedRuns.has(grant.runId)) {
        return { ok: false, error: 'aborted' };
      }
      if (typeof msg.streamId !== 'string' || msg.streamId !== grant.modelStreamId) {
        return {
          ok: false, error: 'actor/model-read-inference-chunk: stream is not active',
          code: 'actor_model_stream_invalid', outcomeKnown: true,
        };
      }
      const result = await providerEgress.readInferenceChunk({ streamId: msg.streamId }, {
        owner: grant.providerOwner, signal: grant.relaySignal,
      });
      if (result?.ok !== true || result?.value?.done === true) {
        grant.modelActive = false;
        grant.modelStreamId = null;
      }
      return result;
    },
    /**
     * @param {{relayToken?:string,streamId?:string}} [msg]
     * @param {unknown} [sender]
     * @param {any} [boundGrant]
     */
    'actor/model-cancel-inference': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant) return { ok: false, error: 'actor/model-cancel-inference: unauthorized relay' };
      if (!providerEgress) return {
        ok: false, error: 'actor/model-cancel-inference: authority unavailable',
        outcomeKnown: true,
      };
      if (typeof msg.streamId !== 'string' || msg.streamId !== grant.modelStreamId) {
        return {
          ok: false, error: 'actor/model-cancel-inference: stream is not active',
          code: 'actor_model_stream_invalid', outcomeKnown: true,
        };
      }
      const result = await providerEgress.cancelInference({ streamId: msg.streamId }, {
        owner: grant.providerOwner,
      });
      grant.modelActive = false;
      grant.modelStreamId = null;
      return result;
    },
    /** Exact resident-engine generation; it shares the model-call quota but not network fetch.
     * @param {any} msg @param {unknown} sender @param {any} boundGrant */
    'actor/model-open-local': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant || !providerEgress || grant.relaySignal.aborted
          || abortedRuns.has(grant?.runId)) {
        return { ok: false, error: 'actor/model-open-local: unauthorized relay' };
      }
      if (grant.modelActive || grant.modelRelays >= grant.modelRelayLimit
          || !Number.isSafeInteger(grant.maxOutputTokens)
          || /** @type {number} */ (grant.maxOutputTokens) < 1) {
        return {
          ok: false, error: 'actor/model-open-local: relay unavailable',
          code: grant.modelActive ? 'actor_model_relay_busy' : 'actor_model_relay_limit',
          outcomeKnown: true, performed: false,
        };
      }
      grant.modelRelays += 1;
      grant.modelActive = true;
      const result = await providerEgress.openLocalGeneration({
        providerId: msg.providerId,
        modelId: msg.modelId,
        messages: msg.messages,
        system: msg.system,
        tools: msg.tools,
        maxTokens: msg.maxTokens,
      }, {
        owner: grant.providerOwner,
        signal: grant.relaySignal,
        maxOutputTokens: grant.maxOutputTokens,
        permits: (/** @type {string} */ providerId, /** @type {string} */ modelId) =>
          providerId === grant.provider && modelId === grant.model,
      });
      if (grant.relaySignal.aborted || abortedRuns.has(grant.runId)) {
        grant.modelActive = false;
        grant.modelStreamId = null;
        await boundedCleanup(Promise.resolve().then(() =>
          providerEgress.closeOwner(grant.providerOwner)));
        return { ok: false, error: 'aborted' };
      }
      if (result?.ok !== true || typeof result?.value?.streamId !== 'string') {
        grant.modelActive = false;
        return result;
      }
      grant.modelStreamId = result.value.streamId;
      return result;
    },
    /** @param {any} msg @param {unknown} sender @param {any} boundGrant */
    'actor/model-read-local': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant || !providerEgress || grant.relaySignal.aborted
          || msg.streamId !== grant.modelStreamId) {
        return {
          ok: false, error: 'actor/model-read-local: stream is not active',
          code: 'actor_model_stream_invalid', outcomeKnown: true,
        };
      }
      const result = await providerEgress.readLocalGeneration({ streamId: msg.streamId }, {
        owner: grant.providerOwner,
      });
      if (result?.ok !== true || result?.value?.done === true) {
        grant.modelActive = false;
        grant.modelStreamId = null;
      }
      return result;
    },
    /** @param {any} msg @param {unknown} sender @param {any} boundGrant */
    'actor/model-cancel-local': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant || !providerEgress || msg.streamId !== grant.modelStreamId) {
        return {
          ok: false, error: 'actor/model-cancel-local: stream is not active',
          code: 'actor_model_stream_invalid', outcomeKnown: true,
        };
      }
      const result = await providerEgress.cancelLocalGeneration({ streamId: msg.streamId }, {
        owner: grant.providerOwner,
      });
      grant.modelActive = false;
      grant.modelStreamId = null;
      return result;
    },
    /**
     * @param {{relayToken?:string,providerId?:string,modelId?:string}} [msg]
     * @param {unknown} [sender]
     * @param {any} [boundGrant]
     */
    'actor/model-read-context': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant || !providerEgress || grant.contextRead
          || grant.relaySignal.aborted || abortedRuns.has(grant.runId)
          || msg.providerId !== grant.provider || msg.modelId !== grant.model) {
        return {
          ok: false, error: 'actor/model-read-context: authority refused',
          code: 'actor_model_context_denied', outcomeKnown: true,
        };
      }
      grant.contextRead = true;
      return providerEgress.readModelContext({
        providerId: msg.providerId, modelId: msg.modelId,
      }, {
        owner: grant.providerOwner,
        signal: grant.relaySignal,
        permitsProvider: (/** @type {string} */ providerId) => providerId === grant.provider,
      });
    },
    'actor/spawn-sync': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      const fields = ['task', 'allowRecursion',
        'grantedOperations',
        ...['tools', 'maxSteps', 'maxDepth'].filter((key) => Object.hasOwn(msg, key))];
      const entry = await domainEntry(grant, msg, 'actor', fields);
      if (!entry || entry.operation !== 'turn.actor.spawn-sync'
          || typeof msg.task !== 'string' || !msg.task
          || typeof msg.allowRecursion !== 'boolean'
          || msg.tools !== undefined && (!Array.isArray(msg.tools)
            || msg.tools.some((/** @type {unknown} */ name) => typeof name !== 'string'))
          || !Array.isArray(msg.grantedOperations)
          || msg.grantedOperations.length > 256
          || msg.grantedOperations.some((/** @type {unknown} */ operation) => typeof operation !== 'string'
            || !grant.allowedOperations.has(operation))
          || msg.maxSteps !== undefined && !Number.isFinite(msg.maxSteps)
          || msg.maxDepth !== undefined && !Number.isFinite(msg.maxDepth)) {
        return { ok: false, error: 'actor/spawn-sync: authority mismatch', outcomeKnown: true };
      }
      const spawn = entry.ctx?.actorAuthority?.spawnSync;
      return runDirectActorEffect(entry, 'turn.actor.spawn-sync', 'resource', () =>
        typeof spawn === 'function' ? spawn({
          task: msg.task,
          ...(msg.tools === undefined ? {} : { tools: msg.tools }),
          ...(msg.maxSteps === undefined ? {} : { maxSteps: msg.maxSteps }),
          ...(msg.maxDepth === undefined ? {} : { maxDepth: msg.maxDepth }),
          allowRecursion: msg.allowRecursion,
          grantedOperations: [...new Set(msg.grantedOperations)],
          parentSessionId: entry.ctx.session?.sessionId,
          parentDepth: entry.ctx.session?.depth ?? 0,
          parentInbound: entry.ctx.inbound === false ? false : true,
          parentToolUseId: entry.effect.callId,
        }) : { refused: true, result: 'actor_orchestrator_unavailable' },
      HOST_EFFECT_OUTCOME.actorSpawn);
    },
    'actor/spawn-async': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      const fields = ['task', 'allowRecursion',
        'grantedOperations',
        ...['tools', 'maxSteps', 'maxDepth'].filter((key) => Object.hasOwn(msg, key))];
      const entry = await domainEntry(grant, msg, 'actor', fields);
      if (!entry || entry.operation !== 'turn.actor.spawn-async'
          || typeof msg.task !== 'string' || !msg.task
          || typeof msg.allowRecursion !== 'boolean'
          || msg.tools !== undefined && (!Array.isArray(msg.tools)
            || msg.tools.some((/** @type {unknown} */ name) => typeof name !== 'string'))
          || !Array.isArray(msg.grantedOperations)
          || msg.grantedOperations.length > 256
          || msg.grantedOperations.some((/** @type {unknown} */ operation) => typeof operation !== 'string'
            || !grant.allowedOperations.has(operation))
          || msg.maxSteps !== undefined && !Number.isFinite(msg.maxSteps)
          || msg.maxDepth !== undefined && !Number.isFinite(msg.maxDepth)) {
        return { ok: false, error: 'actor/spawn-async: authority mismatch', outcomeKnown: true };
      }
      const spawn = entry.ctx?.actorAuthority?.spawnAsync;
      return runDirectActorEffect(entry, 'turn.actor.spawn-async', 'resource', () =>
        typeof spawn === 'function' ? spawn({
          task: msg.task,
          ...(msg.tools === undefined ? {} : { tools: msg.tools }),
          ...(msg.maxSteps === undefined ? {} : { maxSteps: msg.maxSteps }),
          ...(msg.maxDepth === undefined ? {} : { maxDepth: msg.maxDepth }),
          allowRecursion: msg.allowRecursion,
          grantedOperations: [...new Set(msg.grantedOperations)],
          parentSessionId: entry.ctx.session?.sessionId,
          parentDepth: entry.ctx.session?.depth ?? 0,
          parentInbound: entry.ctx.inbound === false ? false : true,
          parentToolUseId: entry.effect.callId,
        }) : { ok: false, error: 'async_actor_unavailable' },
      HOST_EFFECT_OUTCOME.actorSpawn);
    },
    'actor/tasks-read': async (msg = {}, sender = undefined, boundGrant = null) => {
      const entry = await domainEntry(
        grantFor(msg, sender, boundGrant), msg, 'actor', [],
      );
      if (!entry || entry.operation !== 'turn.actor.tasks') {
        return { ok: false, error: 'actor/tasks-read: authority mismatch', outcomeKnown: true };
      }
      const read = entry.ctx?.actorAuthority?.listTasks;
      return runDirectActorEffect(entry, 'turn.actor.tasks', 'read', () =>
        typeof read === 'function' ? read() : []);
    },
    'actor/task-cancel': async (msg = {}, sender = undefined, boundGrant = null) => {
      const entry = await domainEntry(
        grantFor(msg, sender, boundGrant), msg, 'actor', ['taskId'],
      );
      if (!entry || entry.operation !== 'turn.actor.cancel'
          || typeof msg.taskId !== 'string' || !msg.taskId) {
        return { ok: false, error: 'actor/task-cancel: authority mismatch', outcomeKnown: true };
      }
      const cancel = entry.ctx?.actorAuthority?.cancelTask;
      return runDirectActorEffect(entry, 'turn.actor.cancel', 'control', () =>
        typeof cancel === 'function'
          ? cancel(msg.taskId) : { ok: false, error: 'async_actor_unavailable' },
      HOST_EFFECT_OUTCOME.actorCancel);
    },
    'actor/message-deliver': async (msg = {}, sender = undefined, boundGrant = null) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await domainEntry(grant, msg, 'actor', [
        'to', 'message', 'oneShot', 'awaitReply', 'degradeToAsync', 'awaitCapMs',
      ]);
      if (!entry || entry.operation !== 'turn.actor.message'
          || typeof msg.to !== 'string' || !msg.to
          || typeof msg.message !== 'string' || typeof msg.oneShot !== 'boolean'
          || typeof msg.awaitReply !== 'boolean' || typeof msg.degradeToAsync !== 'boolean'
          || !Number.isSafeInteger(msg.awaitCapMs) || msg.awaitCapMs < 1
          || msg.awaitCapMs > 3 * 60_000) {
        return { ok: false, error: 'actor/message-deliver: authority mismatch', outcomeKnown: true };
      }
      const deliver = entry.ctx?.actorAuthority?.deliverMessage;
      return runDirectActorEffect(entry, 'turn.actor.message', 'resource', () =>
        typeof deliver === 'function' ? deliver({
          to: msg.to, message: msg.message, oneShot: msg.oneShot,
          senderSessionId: entry.ctx.session?.sessionId,
          inbound: entry.ctx.inbound === true,
          toolUseId: entry.effect.callId,
          awaitReply: msg.awaitReply, awaitSignal: grant.relaySignal,
          degradeToAsync: msg.degradeToAsync, awaitCapMs: msg.awaitCapMs,
        }) : { ok: false, error: 'message_actor is not enabled' },
      HOST_EFFECT_OUTCOME.actorMessage);
    },
    'pod/resolve': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await domainEntry(grant, msg, 'pod', [
        'podId', ...(typeof msg.command === 'string' ? ['command'] : []),
      ]);
      const boundPodId = entry?.ctx?.actorType === 'pod'
        ? entry.ctx.actorInstanceId : null;
      if (!entry || boundPodId && msg.podId !== undefined && msg.podId !== boundPodId
          || !boundPodId && msg.podId !== entry.args?.podId) {
        return { ok: false, error: 'pod/resolve: authority mismatch', outcomeKnown: true };
      }
      const resolve = entry.ctx?.podClient?.resolveId;
      if (typeof resolve !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      const result = /** @type {any} */ (await runDomainEffect(entry, 'pod/resolve', 'read', () => resolve({
        sessionId: entry.ctx.session?.sessionId, podId: boundPodId ?? msg.podId,
      })));
      if (result.ok === true && typeof result.value === 'string') {
        entry.domainState.podId = result.value;
        if (typeof msg.command === 'string') entry.domainState.command = msg.command;
      }
      return result;
    },
    'pod/read-remote': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await domainEntry(grant, msg, 'pod', ['podId']);
      const intent = entry ? podGitRemoteIntents(entry.domainState.command ?? '')[0] : null;
      if (!entry || typeof msg.podId !== 'string' || msg.podId !== entry.domainState.podId
          || !intent || intent.url) {
        return { ok: false, error: 'pod/read-remote: authority mismatch', outcomeKnown: true };
      }
      const readRemote = entry.ctx?.repositories?.getRemote;
      const result = /** @type {any} */ (await runDomainEffect(entry, 'pod/read-remote', 'read', () =>
        typeof readRemote === 'function'
          ? readRemote({ kind: 'pod', id: msg.podId }) : null));
      if (result.ok === true) entry.domainState.remote = result.value;
      return result;
    },
    'pod/confirm-git': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await domainEntry(grant, msg, 'pod', ['op']);
      const intents = entry ? podGitRemoteIntents(entry.domainState.command ?? '') : [];
      const intent = intents.length === 1 ? intents[0] : null;
      const target = intent?.url ?? entry?.domainState?.remote?.url;
      if (!entry || typeof entry.domainState.podId !== 'string'
          || !intent || msg.op !== intent.op || typeof target !== 'string') {
        return { ok: false, error: 'pod/confirm-git: authority mismatch', outcomeKnown: true };
      }
      let origin;
      try { origin = new URL(target).origin; }
      catch { return { ok: false, error: 'pod/confirm-git: invalid remote', outcomeKnown: true }; }
      const confirm = entry.ctx?.confirm;
      if (typeof confirm !== 'function') {
        return { ok: true, value: false, outcomeKnown: true };
      }
      const result = /** @type {any} */ (await runDomainEffect(entry, 'pod/confirm-git', 'control', () => confirm({
        tool: 'pod_exec', kind: `git_${intent.op}`,
        sideEffect: intent.op === 'push' ? 'mutate_external' : 'write',
        origins: [origin],
        summary: intent.op === 'push'
          ? `Allow this one Pod job to push code and commit history to ${target}?`
          : `Allow this one Pod job to ${intent.op} ${target} through peerd's audited Git transport?`,
      }, entry.grant.relaySignal), false, HOST_EFFECT_OUTCOME.confirmation));
      if (result.ok === true && runIsLive(entry.grant)
          && [true, 'yes_once', 'yes_session'].includes(result.value)) {
        entry.domainState.remoteGitGrant = { op: intent.op, url: target };
      }
      return result;
    },
    'pod/exec': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await domainEntry(grant, msg, 'pod', [
        'command', 'podId', 'timeoutMs', 'background', 'remoteGitGrant',
      ]);
      const args = entry?.args;
      let program;
      let intents;
      try {
        program = parsePodShell(args?.command ?? '');
        intents = podGitRemoteIntents(args?.command ?? '');
      } catch {
        return { ok: false, error: 'pod/exec: invalid admitted command', outcomeKnown: true };
      }
      const expectedTimeout = Math.min(300_000, Math.max(1, Number(args?.timeoutMs) || 30_000));
      const expectedBackground = args?.background === true || program.background;
      const expectedGrant = intents.length === 1
        ? entry?.domainState?.remoteGitGrant ?? null : null;
      if (!entry || intents.length > 1 || typeof entry.domainState.podId !== 'string'
          || msg.command !== args?.command || msg.podId !== entry.domainState.podId
          || msg.timeoutMs !== expectedTimeout || msg.background !== expectedBackground
          || !sameClone(msg.remoteGitGrant, expectedGrant)) {
        return { ok: false, error: 'pod/exec: authority mismatch', outcomeKnown: true };
      }
      if (expectedGrant) entry.domainState.remoteGitGrant = null;
      const execute = entry.ctx?.podClient?.exec;
      if (typeof execute !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'pod/exec', 'resource', () => execute(msg.command, {
        podId: msg.podId,
        timeoutMs: expectedTimeout,
        background: expectedBackground,
        remoteGitGrant: expectedGrant,
        signal: expectedBackground ? undefined : /** @type {any} */ (grant).relaySignal,
      }), false, HOST_EFFECT_OUTCOME.podExecution);
    },
    'pod/status': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await domainEntry(grant, msg, 'pod', [
        'podId', 'jobId', 'stream', 'offset', 'limit',
      ]);
      const args = entry?.args;
      const boundPodId = entry?.ctx?.actorType === 'pod'
        ? entry.ctx.actorInstanceId : null;
      if (!entry || msg.podId !== args?.podId || msg.jobId !== args?.jobId
          || msg.stream !== args?.stream || msg.offset !== args?.offset
          || msg.limit !== args?.limit
          || boundPodId && msg.podId !== boundPodId) {
        return { ok: false, error: 'pod/status: authority mismatch', outcomeKnown: true };
      }
      const status = entry.ctx?.podClient?.status;
      if (typeof status !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'pod/status', 'read', () => status({
        sessionId: entry.ctx.session?.sessionId,
        podId: msg.podId, jobId: msg.jobId, stream: msg.stream,
        offset: msg.offset, limit: msg.limit,
      }));
    },
    'pod/cancel': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await domainEntry(grant, msg, 'pod', ['podId', 'jobId']);
      const args = entry?.args;
      const boundPodId = entry?.ctx?.actorType === 'pod'
        ? entry.ctx.actorInstanceId : null;
      if (!entry || typeof msg.jobId !== 'string' || msg.jobId !== args?.jobId
          || msg.podId !== args?.podId || boundPodId && msg.podId !== boundPodId) {
        return { ok: false, error: 'pod/cancel: authority mismatch', outcomeKnown: true };
      }
      const cancel = entry.ctx?.podClient?.cancel;
      if (typeof cancel !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'pod/cancel', 'control', () => cancel(msg.jobId, {
        sessionId: entry.ctx.session?.sessionId, podId: msg.podId,
      }), false, HOST_EFFECT_OUTCOME.podCancel);
    },
    'pod/read-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await domainEntry(grant, msg, 'pod', ['podId', 'path']);
      const args = entry?.args;
      const boundPodId = entry?.ctx?.actorType === 'pod'
        ? entry.ctx.actorInstanceId : null;
      if (!entry || typeof msg.path !== 'string' || msg.path !== args?.path
          || msg.podId !== args?.podId || boundPodId && msg.podId !== boundPodId) {
        return { ok: false, error: 'pod/read-file: authority mismatch', outcomeKnown: true };
      }
      const readFile = entry.ctx?.podClient?.readFile;
      if (typeof readFile !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'pod/read-file', 'read', () => readFile(msg.path, {
        sessionId: entry.ctx.session?.sessionId, podId: msg.podId,
      }));
    },
    'pod/write-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await domainEntry(grant, msg, 'pod', [
        'podId', 'path', 'content',
      ]);
      const args = entry?.args;
      const boundPodId = entry?.ctx?.actorType === 'pod'
        ? entry.ctx.actorInstanceId : null;
      if (!entry || typeof msg.path !== 'string' || typeof msg.content !== 'string'
          || msg.path !== args?.path || msg.content !== args?.content
          || msg.podId !== args?.podId || boundPodId && msg.podId !== boundPodId) {
        return { ok: false, error: 'pod/write-file: authority mismatch', outcomeKnown: true };
      }
      const writeFile = entry.ctx?.podClient?.writeFile;
      if (typeof writeFile !== 'function') {
        return { ok: false, error: 'pod_unavailable', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'pod/write-file', 'commit', () => writeFile(
        msg.path, msg.content, {
          sessionId: entry.ctx.session?.sessionId, podId: msg.podId,
        },
      ), false, HOST_EFFECT_OUTCOME.podMutation);
    },
    'repository/read-pod': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['podId']);
      if (!entry) return { ok: false, error: 'repository/read-pod: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/read-pod', 'read', () =>
        entry.authority.readPod(msg.podId));
    },
    'repository/destroy-pod': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['podId']);
      if (!entry) return { ok: false, error: 'repository/destroy-pod: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/destroy-pod', 'commit', () =>
        entry.authority.destroyPod(msg.podId), false, HOST_EFFECT_OUTCOME.podMutation);
    },
    'repository/read-status': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, []);
      if (!entry) return { ok: false, error: 'repository/read-status: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/read-status', 'read', () =>
        entry.authority.readStatus());
    },
    'repository/read-history': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['depth']);
      if (!entry) return { ok: false, error: 'repository/read-history: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/read-history', 'read', () =>
        entry.authority.readHistory(msg.depth));
    },
    'repository/read-remote': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, []);
      if (!entry) return { ok: false, error: 'repository/read-remote: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/read-remote', 'read', () =>
        entry.authority.readRemote());
    },
    'repository/read-diff': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['from', 'to']);
      if (!entry) return { ok: false, error: 'repository/read-diff: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/read-diff', 'read', () =>
        entry.authority.readDiff(msg.from, msg.to));
    },
    'repository/confirm-restore': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['to']);
      if (!entry) return { ok: false, error: 'repository/confirm-restore: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/confirm-restore', 'control', () =>
        entry.authority.confirmRestore(msg.to), false, HOST_EFFECT_OUTCOME.confirmation);
    },
    'repository/checkpoint': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['message']);
      if (!entry) return { ok: false, error: 'repository/checkpoint: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/checkpoint', 'commit', () =>
        entry.authority.checkpoint(msg.message), false,
        HOST_EFFECT_OUTCOME.repositoryCheckpoint);
    },
    'repository/branch': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['name']);
      if (!entry) return { ok: false, error: 'repository/branch: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/branch', 'commit', () =>
        entry.authority.branch(msg.name), false, HOST_EFFECT_OUTCOME.repositoryMutation);
    },
    'repository/checkout': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['name']);
      if (!entry) return { ok: false, error: 'repository/checkout: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/checkout', 'commit', () =>
        entry.authority.checkout(msg.name), false, HOST_EFFECT_OUTCOME.repositoryMutation);
    },
    'repository/restore': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['to']);
      if (!entry) return { ok: false, error: 'repository/restore: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/restore', 'commit', () =>
        entry.authority.restore(msg.to), false, HOST_EFFECT_OUTCOME.repositoryRestore);
    },
    'repository/confirm-remote': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(
        grant, msg, ['op', 'target', 'branch'], ['url'],
      );
      if (!entry) return { ok: false, error: 'repository/confirm-remote: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/confirm-remote', 'control', () =>
        entry.authority.confirmRemote(msg.op, msg.target, msg.branch), false,
      HOST_EFFECT_OUTCOME.confirmation);
    },
    'repository/link': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['url']);
      if (!entry) return { ok: false, error: 'repository/link: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/link', 'commit', () =>
        entry.authority.link(msg.url), false, HOST_EFFECT_OUTCOME.repositoryMutation);
    },
    'repository/fetch': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['target']);
      if (!entry) return { ok: false, error: 'repository/fetch: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/fetch', 'commit', () =>
        entry.authority.fetch(msg.target), false, HOST_EFFECT_OUTCOME.repositoryMutation);
    },
    'repository/push': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await repositoryEntry(grant, msg, ['target', 'branch']);
      if (!entry) return { ok: false, error: 'repository/push: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'repository/push', 'resource', () =>
        entry.authority.push(msg.target, msg.branch), false, HOST_EFFECT_OUTCOME.partialMutation);
    },
    'vm/read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await vmEntry(grant, msg, ['vmId']);
      if (!entry) return { ok: false, error: 'vm/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/read', 'read', () =>
        entry.authority.readVm(msg.vmId));
    },
    'vm/list': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await vmEntry(grant, msg, []);
      if (!entry) return { ok: false, error: 'vm/list: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/list', 'read', () =>
        entry.authority.listVms());
    },
    'vm/set-default': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await vmEntry(grant, msg, ['vmId']);
      if (!entry) return { ok: false, error: 'vm/set-default: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/set-default', 'control', () =>
        entry.authority.setDefaultVm(msg.vmId), false, HOST_EFFECT_OUTCOME.defaultSelection);
    },
    'vm/run': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await vmEntry(grant, msg, ['command', 'timeoutMs', 'vmId']);
      if (!entry) return { ok: false, error: 'vm/run: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/run', 'resource', () =>
        entry.authority.runVm(msg.command, msg.timeoutMs, msg.vmId), false, HOST_EFFECT_OUTCOME.vmExecution);
    },
    'vm/import-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await vmEntry(grant, msg, ['url', 'path', 'maxBytes']);
      if (!entry) return { ok: false, error: 'vm/import-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/import-file', 'resource', () =>
        entry.authority.importFile(msg.url, msg.path, msg.maxBytes), false, HOST_EFFECT_OUTCOME.vmMutation);
    },
    'vm/write-text-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await vmEntry(grant, msg, ['path', 'content']);
      if (!entry) return { ok: false, error: 'vm/write-text-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/write-text-file', 'commit', () =>
        entry.authority.writeTextFile(msg.path, msg.content), false, HOST_EFFECT_OUTCOME.vmMutation);
    },
    'vm/destroy': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await vmEntry(grant, msg, ['vmId']);
      if (!entry) return { ok: false, error: 'vm/destroy: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'vm/destroy', 'commit', () =>
        entry.authority.destroyVm(msg.vmId), false, HOST_EFFECT_OUTCOME.vmMutation);
    },
    'notebook/read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await notebookEntry(
        grant, msg, ['notebookId'],
      );
      if (!entry) return { ok: false, error: 'notebook/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/read', 'read', () =>
        entry.authority.readNotebook(msg.notebookId));
    },
    'notebook/list': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await notebookEntry(grant, msg, []);
      if (!entry) return { ok: false, error: 'notebook/list: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/list', 'read', () =>
        entry.authority.listNotebooks());
    },
    'notebook/set-default': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await notebookEntry(grant, msg, ['notebookId']);
      if (!entry) return { ok: false, error: 'notebook/set-default: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/set-default', 'control', () =>
        entry.authority.setDefaultNotebook(msg.notebookId), false,
        HOST_EFFECT_OUTCOME.defaultSelection);
    },
    'notebook/run': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await notebookEntry(
        grant, msg, ['code', 'timeoutMs', 'notebookId'],
      );
      if (!entry) return { ok: false, error: 'notebook/run: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/run', 'resource', () =>
        entry.authority.runNotebook(msg.code, msg.timeoutMs, msg.notebookId), false, HOST_EFFECT_OUTCOME.notebookRun);
    },
    'notebook/write-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await notebookEntry(
        grant, msg, ['path', 'content', 'notebookId'],
      );
      if (!entry) return { ok: false, error: 'notebook/write-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/write-file', 'commit', () =>
        entry.authority.writeFile(msg.path, msg.content, msg.notebookId), false, HOST_EFFECT_OUTCOME.notebookMutation);
    },
    'notebook/read-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await notebookEntry(
        grant, msg, ['path', 'notebookId'],
      );
      if (!entry) return { ok: false, error: 'notebook/read-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/read-file', 'read', () =>
        entry.authority.readFile(msg.path, msg.notebookId));
    },
    'notebook/destroy': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await notebookEntry(grant, msg, ['notebookId']);
      if (!entry) return { ok: false, error: 'notebook/destroy: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'notebook/destroy', 'commit', () =>
        entry.authority.destroyNotebook(msg.notebookId), false, HOST_EFFECT_OUTCOME.notebookMutation);
    },
    'app/update': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(grant, msg, [
        'appId', 'name', 'html', 'tags', 'entryFile',
      ]);
      if (!entry) return { ok: false, error: 'app/update: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/update', 'commit', () =>
        entry.authority.updateApp(
          msg.appId, msg.name, msg.html, msg.tags, msg.entryFile,
        ), false, HOST_EFFECT_OUTCOME.appUpdate);
    },
    'app/open': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(grant, msg, ['appId']);
      if (!entry) return { ok: false, error: 'app/open: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/open', 'resource', () =>
        entry.authority.openApp(msg.appId), false, HOST_EFFECT_OUTCOME.appOpen);
    },
    'app/search': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(grant, msg, ['query']);
      if (!entry) return { ok: false, error: 'app/search: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/search', 'read', () =>
        entry.authority.searchApps(msg.query));
    },
    'app/read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(grant, msg, ['appId']);
      if (!entry) return { ok: false, error: 'app/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/read', 'read', () =>
        entry.authority.readApp(msg.appId));
    },
    'app/delete': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(grant, msg, ['appId']);
      if (!entry) return { ok: false, error: 'app/delete: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/delete', 'commit', () =>
        entry.authority.deleteApp(msg.appId), false, HOST_EFFECT_OUTCOME.appDelete);
    },
    'app/write-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(
        grant, msg, ['appId', 'path', 'content'],
      );
      if (!entry) return { ok: false, error: 'app/write-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/write-file', 'commit', () =>
        entry.authority.writeFile(msg.appId, msg.path, msg.content), false, HOST_EFFECT_OUTCOME.appMutation);
    },
    'app/read-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(grant, msg, ['appId', 'path']);
      if (!entry) return { ok: false, error: 'app/read-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/read-file', 'read', () =>
        entry.authority.readFile(msg.appId, msg.path));
    },
    'app/list-files': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(grant, msg, ['appId']);
      if (!entry) return { ok: false, error: 'app/list-files: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/list-files', 'read', () =>
        entry.authority.listFiles(msg.appId));
    },
    'app/delete-file': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(grant, msg, ['appId', 'path']);
      if (!entry) return { ok: false, error: 'app/delete-file: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/delete-file', 'commit', () =>
        entry.authority.deleteFile(msg.appId, msg.path), false, HOST_EFFECT_OUTCOME.appMutation);
    },
    'app/observe': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(grant, msg, []);
      if (!entry) return { ok: false, error: 'app/observe: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/observe', 'read', () =>
        entry.authority.observeRuntime());
    },
    'app/act': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(grant, msg, ['action', 'params']);
      if (!entry) return { ok: false, error: 'app/act: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'app/act', 'resource', () =>
        entry.authority.actRuntime(msg.action, msg.params), false, HOST_EFFECT_OUTCOME.appAction);
    },
    'app/run-code': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await appEntry(
        grant, msg, ['code', 'timeoutMs'], [], ['appProgramSemanticToken'],
      );
      if (!entry || typeof msg.appProgramSemanticToken !== 'string'
          || msg.appProgramSemanticToken.length < 8
          || msg.appProgramSemanticToken.length > 128) {
        return { ok: false, error: 'app/run-code: authority mismatch', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'app/run-code', 'resource', () =>
        entry.authority.runCode(msg.code, msg.timeoutMs), false, HOST_EFFECT_OUTCOME.programRun);
    },
    'memory/read-scope': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await persistenceEntry(grant, msg, ['scope']);
      if (!entry) return { ok: false, error: 'memory/read-scope: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'memory/read-scope', 'read', () =>
        entry.authority.readMemoryScope(msg.scope));
    },
    'memory/read-subtree': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await persistenceEntry(
        grant, msg, ['workspace', 'subpath'],
      );
      if (!entry) return { ok: false, error: 'memory/read-subtree: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'memory/read-subtree', 'read', () =>
        entry.authority.readMemorySubtree(msg.workspace, msg.subpath));
    },
    'memory/write': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await persistenceEntry(grant, msg, ['scope', 'body']);
      if (!entry) return { ok: false, error: 'memory/write: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'memory/write', 'commit', () =>
        entry.authority.writeMemory(msg.scope, msg.body), false, HOST_EFFECT_OUTCOME.memoryResult);
    },
    'todo/read': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await persistenceEntry(
        grant, msg, [],
      );
      if (!entry) return { ok: false, error: 'todo/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'todo/read', 'read', () =>
        entry.authority.readTodos());
    },
    'todo/replace': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      const entry = await persistenceEntry(
        grant, msg, ['version', 'todos'],
      );
      if (!entry) return { ok: false, error: 'todo/replace: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'todo/replace', 'commit', () =>
        entry.authority.replaceTodos(msg.version, msg.todos), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'page/open-tab': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/open-tab: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/open-tab', 'resource', () =>
        entry.authority.openProtectedBackgroundTab(), false, HOST_EFFECT_OUTCOME.pageMutation);
    },
    'page/read': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/read', 'read', () =>
        entry.authority.readOwnedPage());
    },
    'page/snapshot': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/snapshot: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/snapshot', 'read', () =>
        entry.authority.captureOwnedAccessibilityTree());
    },
    'page/read-state': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/read-state: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/read-state', 'read', () =>
        entry.authority.readOwnedFrameworkState());
    },
    'page/watch-changes': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/watch-changes: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/watch-changes', 'read', () =>
        entry.authority.drainOwnedDomChanges());
    },
    'page/query-dom': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/query-dom: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/query-dom', 'read', () =>
        entry.authority.queryOwnedDom());
    },
    'page/navigate': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/navigate: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/navigate', 'resource', () =>
        entry.authority.navigateOwnedTab(), false, HOST_EFFECT_OUTCOME.pageMutation);
    },
    'page/fill': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/fill: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/fill', 'resource', () =>
        entry.authority.fillOwnedTarget(), false, HOST_EFFECT_OUTCOME.pageMutation);
    },
    'page/click': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/click: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/click', 'resource', () =>
        entry.authority.clickOwnedTarget(), false, HOST_EFFECT_OUTCOME.pageMutation);
    },
    'page/login': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/login: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/login', 'resource', () =>
        entry.authority.performConfirmedOwnedLogin(), false, HOST_EFFECT_OUTCOME.pageMutation);
    },
    'page/run-program': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(
        grantFor(msg, sender, boundGrant), msg, ['args'], [], ['pageProgramSemanticToken'],
      );
      if (!entry || typeof msg.pageProgramSemanticToken !== 'string'
          || msg.pageProgramSemanticToken.length < 8
          || msg.pageProgramSemanticToken.length > 128) {
        return { ok: false, error: 'page/run-program: authority mismatch', outcomeKnown: true };
      }
      return runDomainEffect(entry, 'page/run-program', 'resource', () =>
        entry.authority.runOwnedPageProgram(), false, HOST_EFFECT_OUTCOME.programRun);
    },
    'page/capture-foreground': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/capture-foreground: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/capture-foreground', 'read', () =>
        entry.authority.captureForegroundPixels());
    },
    'page/capture-owned': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await pageEntry(grantFor(msg, sender, boundGrant), msg, ['args']);
      if (!entry) return { ok: false, error: 'page/capture-owned: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'page/capture-owned', 'read', () =>
        entry.authority.captureOwnedTabPixels());
    },
    'resource/confirm-web-write': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await resourceEntry(
        grantFor(msg, sender, boundGrant), msg, ['url', 'method', 'headers', 'body'],
      );
      if (!entry) return { ok: false, error: 'resource/confirm-web-write: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/confirm-web-write', 'control', () =>
        entry.authority.confirmWebWrite({
          url: msg.url, method: msg.method, headers: msg.headers, body: msg.body,
        }), true, HOST_EFFECT_OUTCOME.confirmation);
    },
    'resource/request-web-text': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await resourceEntry(
        grantFor(msg, sender, boundGrant), msg, ['url', 'method', 'headers', 'body'],
      );
      if (!entry) return { ok: false, error: 'resource/request-web-text: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/request-web-text', 'resource', () =>
        entry.authority.requestWebText({
          url: msg.url, method: msg.method, headers: msg.headers, body: msg.body,
        }), false, HOST_EFFECT_OUTCOME.webRequest);
    },
    'resource/extract-markdown': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await resourceEntry(
        grantFor(msg, sender, boundGrant), msg, ['html', 'url'],
      );
      if (!entry) return { ok: false, error: 'resource/extract-markdown: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/extract-markdown', 'read', () =>
        entry.authority.extractReadableMarkdown(msg.html, msg.url));
    },
    'resource/extract-document': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await resourceEntry(
        grantFor(msg, sender, boundGrant), msg, ['url', 'format', 'engine'],
      );
      if (!entry) return { ok: false, error: 'resource/extract-document: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/extract-document', 'read', () =>
        entry.authority.extractDocument({
          url: msg.url, format: msg.format, engine: msg.engine,
        }));
    },
    'resource/spill-result': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await resourceEntry(grantFor(msg, sender, boundGrant), msg, [
        'url', 'format', 'text', 'producer', 'fenced', 'originLabel',
      ]);
      if (!entry) return { ok: false, error: 'resource/spill-result: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/spill-result', 'control', () =>
        entry.authority.spillResult({
          url: msg.url, format: msg.format, text: msg.text,
          producer: msg.producer, fenced: msg.fenced, originLabel: msg.originLabel,
        }), false, HOST_EFFECT_OUTCOME.spill);
    },
    'resource/read-result': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await resourceEntry(grantFor(msg, sender, boundGrant), msg, ['key']);
      if (!entry) return { ok: false, error: 'resource/read-result: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'resource/read-result', 'read', () =>
        entry.authority.readResult(msg.key));
    },
    'site-client/read': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await siteClientEntry(grantFor(msg, sender, boundGrant), msg, ['origin']);
      if (!entry) return { ok: false, error: 'site-client/read: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'site-client/read', 'read', () =>
        entry.authority.readStoredClient(msg.origin));
    },
    'site-client/run': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await siteClientEntry(
        grantFor(msg, sender, boundGrant), msg, ['origin', 'code', 'timeoutMs'],
      );
      if (!entry) return { ok: false, error: 'site-client/run: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'site-client/run', 'resource', () =>
        entry.authority.runStoredClient(msg.origin, msg.code, msg.timeoutMs), false, HOST_EFFECT_OUTCOME.siteClientRun);
    },
    'site-client/commit': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await siteClientEntry(
        grantFor(msg, sender, boundGrant), msg, ['origin'],
        ['summary', 'endpoints', 'auth', 'deriver', 'body'],
      );
      if (!entry) return { ok: false, error: 'site-client/commit: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'site-client/commit', 'commit', () =>
        entry.authority.commitConfirmedClient(msg.origin), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'site-client/capture-start': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await siteClientEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'site-client/capture-start: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'site-client/capture-start', 'resource', () =>
        entry.authority.startOwnedCapture(), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'site-client/capture-stop': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await siteClientEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'site-client/capture-stop: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'site-client/capture-stop', 'resource', () =>
        entry.authority.stopOwnedCapture(), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/create-webvm': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await executionEntry(grantFor(msg, sender, boundGrant), msg, ['plan']);
      if (!entry) return { ok: false, error: 'execution/create-webvm: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/create-webvm', 'commit', () =>
        entry.authority.createWebVm(msg.plan), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/create-notebook': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await executionEntry(grantFor(msg, sender, boundGrant), msg, ['plan']);
      if (!entry) return { ok: false, error: 'execution/create-notebook: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/create-notebook', 'commit', () =>
        entry.authority.createNotebook(msg.plan), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/create-pod': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await executionEntry(grantFor(msg, sender, boundGrant), msg, ['plan']);
      if (!entry) return { ok: false, error: 'execution/create-pod: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/create-pod', 'commit', () =>
        entry.authority.createPod(msg.plan), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/create-app': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await executionEntry(grantFor(msg, sender, boundGrant), msg, ['plan']);
      if (!entry) return { ok: false, error: 'execution/create-app: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/create-app', 'commit', () =>
        entry.authority.createApp(msg.plan), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'execution/run-script': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await executionEntry(grantFor(msg, sender, boundGrant), msg, [
        'code', 'actors', 'provider', 'workspace', 'timeoutMs',
      ]);
      if (!entry) return { ok: false, error: 'execution/run-script: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/run-script', 'resource', () =>
        entry.authority.runHeadlessScript({
          code: msg.code, actors: msg.actors, provider: msg.provider,
          workspace: msg.workspace, timeoutMs: msg.timeoutMs,
        }), false, HOST_EFFECT_OUTCOME.scriptRun);
    },
    'execution/spill-script': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await executionEntry(
        grantFor(msg, sender, boundGrant), msg, ['text', 'fenced', 'originLabel'],
      );
      if (!entry) return { ok: false, error: 'execution/spill-script: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'execution/spill-script', 'control', () =>
        entry.authority.spillScriptValue({
          text: msg.text, fenced: msg.fenced, originLabel: msg.originLabel,
        }), false, HOST_EFFECT_OUTCOME.spill);
    },
    'editing/read-target': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await editingEntry(
        grantFor(msg, sender, boundGrant), msg, ['kind', 'targetId', 'path'],
      );
      if (!entry) return { ok: false, error: 'editing/read-target: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'editing/read-target', 'read', () =>
        entry.authority.readEditTarget({
          kind: msg.kind, targetId: msg.targetId, path: msg.path,
        }));
    },
    'editing/write-target': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await editingEntry(grantFor(msg, sender, boundGrant), msg, [
        'kind', 'targetId', 'path', 'content',
      ]);
      if (!entry) return { ok: false, error: 'editing/write-target: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'editing/write-target', 'commit', () =>
        entry.authority.writeEditTarget({
          kind: msg.kind, targetId: msg.targetId, path: msg.path, content: msg.content,
        }), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'introspection/actor-roster': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await introspectionEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'introspection/actor-roster: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/actor-roster', 'read', () =>
        entry.authority.readActorRoster());
    },
    'introspection/provider-posture': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await introspectionEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'introspection/provider-posture: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/provider-posture', 'read', () =>
        entry.authority.readProviderPosture());
    },
    'introspection/storage-snapshot': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await introspectionEntry(grantFor(msg, sender, boundGrant), msg, ['prefix']);
      if (!entry) return { ok: false, error: 'introspection/storage-snapshot: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/storage-snapshot', 'read', () =>
        entry.authority.readStorageSnapshot(msg.prefix));
    },
    'introspection/automatable-tabs': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await introspectionEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'introspection/automatable-tabs: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/automatable-tabs', 'read', () =>
        entry.authority.readAutomatableTabs());
    },
    'introspection/denylist-patterns': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await introspectionEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'introspection/denylist-patterns: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/denylist-patterns', 'read', () =>
        entry.authority.readDenylistPatterns());
    },
    'introspection/audit-entries': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await introspectionEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'introspection/audit-entries: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/audit-entries', 'read', () =>
        entry.authority.readAuditEntries());
    },
    'introspection/installed-skill': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await introspectionEntry(grantFor(msg, sender, boundGrant), msg, ['name']);
      if (!entry) return { ok: false, error: 'introspection/installed-skill: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'introspection/installed-skill', 'read', () =>
        entry.authority.readInstalledSkill(msg.name));
    },
    'schedule/read-routines': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await scheduleEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'schedule/read-routines: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'schedule/read-routines', 'read', () =>
        entry.authority.readRoutines());
    },
    'schedule/arm-confirmed-routine': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await scheduleEntry(
        grantFor(msg, sender, boundGrant), msg,
        ['prompt', 'every', 'dailyAt', 'mode'],
      );
      if (!entry) return { ok: false, error: 'schedule/arm-confirmed-routine: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'schedule/arm-confirmed-routine', 'commit', () =>
        entry.authority.armConfirmedRoutine({
          prompt: msg.prompt, every: msg.every, dailyAt: msg.dailyAt, mode: msg.mode,
        }), false, HOST_EFFECT_OUTCOME.okResult);
    },
    'schedule/cancel-routine': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await scheduleEntry(grantFor(msg, sender, boundGrant), msg, ['id']);
      if (!entry) return { ok: false, error: 'schedule/cancel-routine: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'schedule/cancel-routine', 'commit', () =>
        entry.authority.cancelRoutine(msg.id), false, HOST_EFFECT_OUTCOME.scheduleCancel);
    },
    'dweb/discover-apps': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await dwebEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'dweb/discover-apps: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/discover-apps', 'read', () =>
        entry.authority.discoverApps());
    },
    'dweb/publish-confirmed-app': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await dwebEntry(grantFor(msg, sender, boundGrant), msg, ['appId']);
      if (!entry) return { ok: false, error: 'dweb/publish-confirmed-app: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/publish-confirmed-app', 'commit', () =>
        entry.authority.publishConfirmedApp(msg.appId), false, HOST_EFFECT_OUTCOME.dwebPublish);
    },
    'dweb/install-confirmed-app': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await dwebEntry(grantFor(msg, sender, boundGrant), msg, ['uri', 'name']);
      if (!entry) return { ok: false, error: 'dweb/install-confirmed-app: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/install-confirmed-app', 'commit', () =>
        entry.authority.installConfirmedApp(msg.uri, msg.name), false, HOST_EFFECT_OUTCOME.dwebInstall);
    },
    'dweb/read-peers': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await dwebEntry(grantFor(msg, sender, boundGrant), msg, []);
      if (!entry) return { ok: false, error: 'dweb/read-peers: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/read-peers', 'read', () =>
        entry.authority.readPeers());
    },
    'dweb/set-peer-blocked': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await dwebEntry(
        grantFor(msg, sender, boundGrant), msg, ['did', 'block', 'reason'],
      );
      if (!entry) return { ok: false, error: 'dweb/set-peer-blocked: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/set-peer-blocked', 'commit', () =>
        entry.authority.setPeerBlocked(msg.did, msg.block, msg.reason), false, HOST_EFFECT_OUTCOME.dwebPolicyMutation);
    },
    'dweb/set-discovery-enabled': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await dwebEntry(grantFor(msg, sender, boundGrant), msg, ['enabled']);
      if (!entry) return { ok: false, error: 'dweb/set-discovery-enabled: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/set-discovery-enabled', 'commit', () =>
        entry.authority.setDiscoveryEnabled(msg.enabled), false, HOST_EFFECT_OUTCOME.dwebPolicyMutation);
    },
    'dweb/run-mesh-program': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined, /** @type {any} */ boundGrant = null) => {
      const entry = await dwebEntry(
        grantFor(msg, sender, boundGrant), msg, ['code', 'timeoutMs'],
      );
      if (!entry) return { ok: false, error: 'dweb/run-mesh-program: authority mismatch', outcomeKnown: true };
      return runDomainEffect(entry, 'dweb/run-mesh-program', 'resource', () =>
        entry.authority.runMeshProgram(msg.code, msg.timeoutMs), false,
        HOST_EFFECT_OUTCOME.meshProgramRun);
    },
    'actor/call-complete': async (
      /** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined,
      /** @type {any} */ boundGrant = null,
    ) => {
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant || !exactKeys(msg, ['callId', 'turnGeneration', 'result'])
          || typeof msg.callId !== 'string' || !msg.callId
          || msg.turnGeneration !== grant.turnGeneration
          || !grant.semanticCallState.has(msg.callId)
          || grant.closingCalls.has(msg.callId) || grant.finalizing === true
          || grant.completedCalls.has(msg.callId)) {
        return { ok: false, error: 'actor/call-complete: authority mismatch', outcomeKnown: true };
      }
      grant.closingCalls.add(msg.callId);
      await Promise.allSettled([...(grant.pendingClaimsByCall.get(msg.callId) ?? [])]);
      await Promise.allSettled([...(grant.dispatchesByCall.get(msg.callId) ?? [])]);
      const claimed = grant.claimedEffectsByCall.get(msg.callId) ?? new Map();
      for (const [effectId, operation] of claimed) {
        if (grant.effectReceipts.has(effectId)) continue;
        grant.effectReceipts.set(effectId, Object.freeze({
          callId: msg.callId, effectId, operation,
          outcome: 'unknown', outcomeKnown: false, performed: false, retryable: false,
          code: 'authority_receipt_missing',
          error: 'An accepted authority claim ended without a host outcome receipt.',
        }));
      }
      grant.completedCalls.add(msg.callId);
      // why: domain binders may retain multi-megabyte snapshots while a call is
      // open. Completion has drained every accepted claim/dispatch; receipts
      // and the completed-call tombstone are sufficient for custody and replay.
      grant.semanticCallState.delete(msg.callId);
      if (!runIsLive(grant)) return {
        ok: false, error: 'actor/call-complete: authority retired',
        outcomeKnown: false, retryable: false,
      };
      const resultBytes = structuredClonePayloadBytes(msg.result, {
        maxDepth: 32, maxNodes: 250_000,
      });
      // why: the isolated heap is not trusted to choose what the SW retains or
      // appends to a session. Preserve already-recorded host receipts, but
      // replace an unsafe semantic payload with one bounded terminal failure.
      const semanticResult = Number.isFinite(resultBytes)
        && resultBytes <= ACTOR_SEMANTIC_TOOL_RESULT_CAP
        ? msg.result : {
          ok: false,
          code: 'actor_semantic_result_invalid',
          error: 'actor semantic result exceeds its fixed structured-clone limit',
          outcomeKnown: true,
          retryable: false,
        };
      const result = stampActorCallResult(grant, msg.callId, semanticResult);
      return {
        ok: true, result,
        performed: result.authorityPerformed === true,
        outcomeKnown: result.outcomeKnown !== false,
      };
    },
    /**
     * @param {{ relayToken?: string, event?: object }} [msg]
     * @param {unknown} [sender] - must be the offscreen document (see grantFor).
     */
    'actor/loop-event': (msg = {}, sender = undefined, boundGrant = null) => {
      // Lowest-authority of the three (it only feeds the actor card + cost meter),
      // but bound the same way: an unauthorized sender could otherwise inject
      // fabricated progress/cost events into another run's UI.
      const grant = grantFor(msg, sender, boundGrant);
      if (!grant) return { ok: false, error: 'actor/loop-event: unauthorized relay' };
      if (grant.relaySignal.aborted) return { ok: false, error: 'aborted' };
      const eventBytes = structuredClonePayloadBytes(msg.event, {
        maxDepth: 16, maxNodes: 4_096,
      });
      if (!Number.isFinite(eventBytes) || eventBytes > ACTOR_LOOP_EVENT_BYTES) return {
        ok: false,
        code: 'actor_loop_event_invalid',
        error: 'actor loop event exceeds its structured-clone boundary',
        outcomeKnown: true,
      };
      if (grant.loopEvents >= loopEventLimit) return { ok: true, coalesced: true };
      grant.loopEvents += 1;
      try { if (msg.event) runOnEvent.get(grant.runId)?.(msg.event); } catch { /* never break the relay */ }
      return { ok: true };
    },
  });

  return { run, routes };
};
