// @ts-check
// Pod admission policy for one admitted semantic tool call.
//
// why one implementation: the controller bridge and the actor relay each
// carried this policy inline, line for line, so a fix to one could silently
// miss the other. That is where the Pod's remote-Git consent lives:
// resolve the target Pod → read its remote → ask the user once → execute with
// a grant that is consumed by that one job. Both hosts now call these pure
// decisions and keep only what is genuinely theirs: the claim/receipt
// envelope, their refusal text, their run signal and liveness check.
//
// Shape (functional core, imperative shell):
//   decidePodOperation(operation, input) → { refusal } | a plan (never throws
//   on relayed input: unparsable command text is an 'invalid-command' refusal)
//   plan.admit()          state that must change at admission, before any effect
//   plan.effect(deps)     the effect to run, or null when the host lacks it
//   plan.settle(value)    state that changes only after the effect succeeded
// A plan never performs I/O itself; the host runs plan.effect inside its own
// effect envelope so cancellation, receipts and audit are unchanged.
//
// The actor instance pin lives here too. It reads ctx.actorType, so it binds a
// Pod actor to its own Pod and is inert on the controller path, whose context
// carries no actor type.

import { parsePodShell, podGitRemoteIntents } from '/peerd-engine/authority.js';
import { sameCanonicalStructuredClone } from '/shared/canonical-clone-digest.js';

/** The Pod operations both hosts route here. */
export const POD_OPERATIONS = Object.freeze([
  'resolve', 'read-remote', 'confirm-git', 'exec', 'status', 'cancel', 'read-file', 'write-file',
]);

/** Answers to the Git consent prompt that grant this one job its remote. */
const APPROVALS = Object.freeze([true, 'yes_once', 'yes_session']);

/** Default and ceiling for a Pod command's timeout, recomputed from the admitted args. */
export const podExpectedTimeout = (/** @type {unknown} */ timeoutMs) =>
  Math.min(300_000, Math.max(1, Number(timeoutMs) || 30_000));

/** @typedef {'mismatch'|'invalid-command'|'invalid-remote'} PodRefusal */

/**
 * @typedef {Object} PodEffectDeps
 * @property {AbortSignal|undefined} signal   the host's run signal for this call
 */

/**
 * @typedef {Object} PodPlan
 * @property {() => void} admit
 * @property {(deps: PodEffectDeps) => (() => Promise<unknown>|unknown) | null} effect
 *   The effect to run, or null when the host context lacks the capability.
 * @property {'unavailable'|'decline'} whenUnavailable
 *   'unavailable': refuse with the host's pod_unavailable error.
 *   'decline': answer a known `false` (no confirmation surface means no consent).
 * @property {(value: unknown, isLive: () => boolean) => void} settle
 * @property {'podExecution'|'podCancel'|'podMutation'|'confirmation'|null} outcome
 *   The host effect-outcome classifier this effect needs, if any.
 */

/** @type {() => void} */
const nothing = () => {};

/**
 * @param {string} operation one of POD_OPERATIONS
 * @param {{
 *   message: Record<string, any>,
 *   args: Record<string, any>|undefined,
 *   domainState: Record<string, any>,
 *   ctx: any,
 * }} input  message: the relayed operation values; args: the admitted semantic
 *   call's args; domainState: per-call state shared across this call's steps;
 *   ctx: the host's SW-owned tool context.
 * @returns {{ refusal: PodRefusal } | PodPlan}
 */
export const decidePodOperation = (operation, { message, args, domainState, ctx }) => {
  const boundPodId = ctx?.actorType === 'pod' ? ctx.actorInstanceId : null;
  const sessionId = ctx?.session?.sessionId;
  const client = ctx?.podClient;
  /** @type {{ refusal: PodRefusal }} */
  const mismatch = { refusal: 'mismatch' };
  /** @param {Partial<PodPlan>} overrides @returns {PodPlan} */
  const plan = (overrides) => ({
    admit: nothing, settle: nothing, whenUnavailable: 'unavailable', outcome: null,
    effect: () => null, ...overrides,
  });

  switch (operation) {
    case 'resolve': {
      // A bound actor may omit podId (meaning its own Pod) or name its own Pod;
      // an unbound caller must name exactly the admitted Pod (or none).
      const admitted = boundPodId
        ? message.podId === undefined || message.podId === boundPodId
        : message.podId === args?.podId;
      if (!admitted) return mismatch;
      return plan({
        effect: () => typeof client?.resolveId === 'function'
          ? () => client.resolveId({ sessionId, podId: boundPodId ?? message.podId })
          : null,
        settle: (value) => {
          if (typeof value !== 'string') return;
          domainState.podId = value;
          if (typeof message.command === 'string') domainState.command = message.command;
        },
      });
    }

    case 'read-remote': {
      let intent;
      try { intent = podGitRemoteIntents(domainState.command ?? '')[0]; }
      catch { return { refusal: 'invalid-command' }; }
      if (typeof message.podId !== 'string' || message.podId !== domainState.podId
          || !intent || intent.url) return mismatch;
      // why null rather than unavailable: with no repository surface there is
      // simply no recorded remote, and the confirm step then refuses.
      const readRemote = ctx?.repositories?.getRemote;
      return plan({
        effect: () => () => typeof readRemote === 'function'
          ? readRemote({ kind: 'pod', id: message.podId }) : null,
        settle: (value) => { if (value !== undefined) domainState.remote = value; },
      });
    }

    case 'confirm-git': {
      let intents;
      try { intents = podGitRemoteIntents(domainState.command ?? ''); }
      catch { return { refusal: 'invalid-command' }; }
      const intent = intents.length === 1 ? intents[0] : null;
      const target = intent?.url ?? domainState.remote?.url;
      if (typeof domainState.podId !== 'string' || !intent || message.op !== intent.op
          || typeof target !== 'string') return mismatch;
      let origin;
      try { origin = new URL(target).origin; }
      catch { return { refusal: 'invalid-remote' }; }
      const confirm = ctx?.confirm;
      return plan({
        whenUnavailable: 'decline',
        outcome: 'confirmation',
        effect: ({ signal }) => typeof confirm === 'function'
          ? () => confirm({
            tool: 'pod_exec', kind: `git_${intent.op}`,
            sideEffect: intent.op === 'push' ? 'mutate_external' : 'write',
            origins: [origin],
            summary: intent.op === 'push'
              ? `Allow this one Pod job to push code and commit history to ${target}?`
              : `Allow this one Pod job to ${intent.op} ${target} through peerd's audited Git transport?`,
          }, signal)
          : null,
        // why liveness at settle: a consent that arrives after Stop must not
        // leave a grant behind for a later step of a dead run.
        settle: (value, isLive) => {
          if (isLive() && APPROVALS.includes(/** @type {any} */ (value))) {
            domainState.remoteGitGrant = { op: intent.op, url: target };
          }
        },
      });
    }

    case 'exec': {
      let program;
      let intents;
      try {
        program = parsePodShell(args?.command ?? '');
        intents = podGitRemoteIntents(args?.command ?? '');
      } catch { return { refusal: 'invalid-command' }; }
      // The relayed timeout and background flag must equal what the claimed
      // call's own command implies. why the resolve-time command too: the Git
      // consent was asked for the command this call resolved with. Executing a
      // different command under that consent would let "fetch from X" approve
      // whatever the same call runs next.
      const expectedTimeout = podExpectedTimeout(args?.timeoutMs);
      const expectedBackground = args?.background === true || program.background;
      const expectedGrant = intents.length === 1 ? domainState.remoteGitGrant ?? null : null;
      if (intents.length > 1 || typeof domainState.podId !== 'string'
          || typeof domainState.command === 'string' && message.command !== domainState.command
          || message.command !== args?.command || message.podId !== domainState.podId
          || message.timeoutMs !== expectedTimeout || message.background !== expectedBackground
          || !sameCanonicalStructuredClone(message.remoteGitGrant, expectedGrant)) return mismatch;
      return plan({
        outcome: 'podExecution',
        // why consume at admission: a consent covers exactly one job. Clearing
        // it before the effect means a retry, a second exec in the same call,
        // or an unavailable client can never reuse it.
        admit: () => { if (expectedGrant) domainState.remoteGitGrant = null; },
        effect: ({ signal }) => typeof client?.exec === 'function'
          ? () => client.exec(message.command, {
            podId: message.podId,
            timeoutMs: expectedTimeout,
            background: expectedBackground,
            remoteGitGrant: expectedGrant,
            // why: a background job outlives this call by design; Stop cancels
            // only foreground work.
            signal: expectedBackground ? undefined : signal,
          })
          : null,
      });
    }

    case 'status': {
      if (message.podId !== args?.podId || message.jobId !== args?.jobId
          || message.stream !== args?.stream || message.offset !== args?.offset
          || message.limit !== args?.limit
          || boundPodId && message.podId !== boundPodId) return mismatch;
      return plan({
        effect: () => typeof client?.status === 'function'
          ? () => client.status({
            sessionId, podId: message.podId, jobId: message.jobId, stream: message.stream,
            offset: message.offset, limit: message.limit,
          })
          : null,
      });
    }

    case 'cancel': {
      if (typeof message.jobId !== 'string' || message.jobId !== args?.jobId
          || message.podId !== args?.podId || boundPodId && message.podId !== boundPodId) {
        return mismatch;
      }
      return plan({
        outcome: 'podCancel',
        effect: () => typeof client?.cancel === 'function'
          ? () => client.cancel(message.jobId, { sessionId, podId: message.podId })
          : null,
      });
    }

    case 'read-file': {
      if (typeof message.path !== 'string' || message.path !== args?.path
          || message.podId !== args?.podId || boundPodId && message.podId !== boundPodId) {
        return mismatch;
      }
      return plan({
        effect: () => typeof client?.readFile === 'function'
          ? () => client.readFile(message.path, { sessionId, podId: message.podId })
          : null,
      });
    }

    case 'write-file': {
      if (typeof message.path !== 'string' || typeof message.content !== 'string'
          || message.path !== args?.path || message.content !== args?.content
          || message.podId !== args?.podId || boundPodId && message.podId !== boundPodId) {
        return mismatch;
      }
      return plan({
        outcome: 'podMutation',
        effect: () => typeof client?.writeFile === 'function'
          ? () => client.writeFile(message.path, message.content, {
            sessionId, podId: message.podId,
          })
          : null,
      });
    }

    default:
      return mismatch;
  }
};
