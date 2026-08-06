// @ts-check
// offscreen/job-runner.js — runs a HEADLESS JS job in a sealed Worker.
//
// The headless sibling of the Notebook tab's runEval (DECISIONS #25, "runJob"):
// the SAME sealed worker (worker-source.js — realm seal first, peerd.* surface,
// the fetch/opfs/actor bridges), but hosted in the offscreen document with NO
// UI, an EPHEMERAL OPFS scratch that is nuked when the job ends, and output
// ACCUMULATED into the return value. Egress + actor relay through the SAME
// audited SW routes the tab uses (sw/web-fetch, actor/spawn), so
// denylist + SSRF + audit are enforced centrally regardless of host.
//
// SECURITY — defense-in-depth is WEAKER here than the tab, by one layer, and
// that is deliberate + bounded:
//   • The Notebook tab page has TWO fences: the realm seal AND a page CSP of
//     `connect-src 'none'`. The offscreen document's CSP allows `https:` (it
//     MUST, to download the Moonshine voice model), and a blob worker inherits
//     its owner document's CSP — so a headless worker has NO `connect-src 'none'`
//     backstop. It relies on the realm seal ALONE.
//   • That is acceptable because runJob runs the agent's OWN semi-trusted code,
//     and the seal is the PRIMARY fence: it deletes fetch/XHR/WS/etc. and pins a
//     postMessage-bridged fetch (the seal tests prove it can't be unseated from
//     inside the realm). The CSP only ever mattered as a seal-ESCAPE backstop.
//   • Do NOT run UNTRUSTED code here — that needs a real origin boundary (the
//     opaque-origin iframe / "App without UI", DESIGN.md §8.5), not a Worker.
//   • Hardening path if the backstop is wanted: spawn the worker from a
//     same-origin iframe carrying its own `connect-src 'none'` meta-CSP.

import { opfsHelpers, buildModule, makeFetchRemote, TOOLBOX_SPECIFIER_PREFIX } from '/peerd-engine/index.js';
import { buildWorkerSource, mapWorkerError, NOTEBOOK_BUILTINS, DEFAULT_WORKER_CAPS } from '/engine-tabs/notebook-tab/worker-source.js';
import { ACTORS_BRIDGE_GUARD_MS, ACTORS_RUN_MAX_OPS, buildCodeClientSource, canonicalCodeTraceLabel, CODE_RUN_MAX_TRACE_OPS, MAX_FILE_CONTENT_CHARS } from '/peerd-runtime/index.js';
import { applyFetchExtract } from '/shared/fetch-extract.js';

// The workspace's total-size SOFT budget: over it the run still executes but
// writes are refused (the tool result carries a delete-files nudge). Soft +
// cheap by design — one list() on mount, no bookkeeping store; OPFS's
// origin-global quota is the hard backstop regardless. 200 MB is the design's
// proposed order of magnitude (docs/design/js-superpower/01-script-workspace.md).
const WORKSPACE_BUDGET_BYTES = 200 * 1024 * 1024;

let jobSeq = 0;

// Live jobs by the SW-minted runId, so a Stop can TERMINATE the worker instead
// of letting an abandoned script run to its wall-clock. Every session-owned
// `script` invocation carries one; other headless lanes may omit it.
/** @type {Map<string, { kill: () => void, owner?: string }>} */
const liveJobs = new Map();
// An abort that arrives BEFORE the job registers (Stop racing job startup —
// buildWorkerSource awaits resolver IO before liveJobs.set) would otherwise be
// lost and the worker would run to its full wall-clock. Tombstone the runId;
// registration checks it and kills immediately.
/** @type {Map<string, { owner?: string, expiresAt: number }>} */
const abortedEarly = new Map();
// why bounded + expiring: abort IDs can arrive after a job already settled (or
// from a stale SW). They are useful only for the short startup race; retaining
// arbitrary IDs for the offscreen document's whole life is an unbounded leak.
const EARLY_ABORT_MAX = 64;
const EARLY_ABORT_TTL_MS = 60_000;

const pruneEarlyAborts = (now = Date.now()) => {
  for (const [id, entry] of abortedEarly) {
    if (entry.expiresAt > now) break;   // insertion order is expiry order
    abortedEarly.delete(id);
  }
  while (abortedEarly.size > EARLY_ABORT_MAX) {
    const oldest = abortedEarly.keys().next().value;
    if (typeof oldest !== 'string') break;
    abortedEarly.delete(oldest);
  }
};

/** @param {string} runId @param {string} [owner] */
const rememberEarlyAbort = (runId, owner) => {
  const now = Date.now();
  pruneEarlyAborts(now);
  // Refresh a duplicate at the back of the FIFO so its expiry stays ordered.
  abortedEarly.delete(runId);
  abortedEarly.set(runId, { ...(owner ? { owner } : {}), expiresAt: now + EARLY_ABORT_TTL_MS });
  pruneEarlyAborts(now);
};

/** @param {string} runId @param {string} [owner] */
const consumeEarlyAbort = (runId, owner) => {
  pruneEarlyAborts();
  const entry = abortedEarly.get(runId);
  if (!entry || (entry.owner && entry.owner !== owner)) return false;
  abortedEarly.delete(runId);
  return true;
};

/**
 * Terminate a live job by runId (Stop plumbing). Owner-bound when the caller
 * supplies one: runIds are not secrets, so a first-party page must not be able
 * to kill another session's run by guessing (defense-in-depth — no such
 * sender exists today). No-op when already done.
 * @param {string} runId @param {string} [owner]
 */
export const abortJob = (runId, owner) => {
  const entry = liveJobs.get(runId);
  if (!entry) { rememberEarlyAbort(runId, owner); return; }
  if (owner && entry.owner && owner !== entry.owner) return;
  entry.kill();
};

// Any job that can wait on an outward capability relay gets its own sub-cap
// under MAX_CONCURRENT_JOBS. This includes page/a2a/site clients as well as
// actors/provider: a slow external system must never occupy every worker slot
// and starve the sealed worker's quick-compute lane.
const MAX_RELAYING_JOBS = 2;
let activeRelayingJobs = 0;
const RELAYING_MESSAGE_TYPES = Object.freeze(new Set([
  'sw/web-fetch', 'actor/spawn', 'actors/call', 'page/call',
  'a2a/call', 'site-fetch/call', 'script/model-call',
]));

// Cap concurrent headless workers so a loop (or many parallel script calls /
// actors) can't fork-bomb the offscreen renderer. Each job is its own thread
// + ephemeral OPFS; a handful at once is plenty. (The capability surface's own
// rule: engine.spawn* → resource exhaustion → hard caps.)
const MAX_CONCURRENT_JOBS = 4;
let activeJobs = 0;

/**
 * Run one headless job. Resolves with the same shape js_notebook returns. Rejects
 * (as a result, not a throw) when too many jobs are already in flight.
 *
 * @param {{ code: string, timeoutMs?: number, startedAt?: number, deadlineAt?: number, a2a?: boolean, actors?: boolean, siteFetch?: string, toolbox?: boolean, caps?: { page?: boolean, egress?: boolean, subagent?: boolean, opfs?: boolean, provider?: boolean }, ownerSessionId?: string, ownerToolUseId?: string, runId?: string, workspaceSessionId?: string, workspaceBudgetBytes?: number }} job
 *   caps: capability profile (default DEFAULT_WORKER_CAPS — the historical
 *   script surface; the distributed cap is not a caller knob here — headless
 *   forces it off unconditionally); caps.page needs ownerSessionId — the actor
 *   session this job runs FOR, set by the SW (trusted), the worker can never
 *   supply it.
 *   toolbox: this job may resolve peerd:toolbox/<name> modules (the script
 *   lane's trusted job param; refused for a2a/site-client runs regardless).
 *   workspaceSessionId: mount the durable per-session workspace (trusted,
 *   SW-set) instead of the ephemeral scratch. workspaceBudgetBytes is a
 *   DIRECT-CALLER seam (tests) — offscreen.js never forwards it from a
 *   message, so the production budget cannot be picked over the wire.
 * @param {{ sendToSW: (type: string, payload: object) => Promise<any>, abortRun?: (runId: string, ownerSessionId?: string) => Promise<unknown>, extractMarkdown?: import('/shared/fetch-extract.js').ExtractMarkdownFn, opfsForRoot?: typeof opfsHelpers }} deps
 * @returns {Promise<{ value: unknown, consoleOutput: {level:string,text:string}[], durationMs: number, error: string|null, usedEgress?: boolean, usedActors?: boolean, usedWorkspace?: boolean, workspaceOverBudget?: boolean, actorsTrace?: Array<object>, codeTrace?: Array<object>, usedProvider?: boolean, providerCalls?: number, providerTokens?: number }>}
 */
export const runJob = async (job, deps) => {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return { value: undefined, consoleOutput: [], durationMs: 0, error: `headless job rejected: ${MAX_CONCURRENT_JOBS} jobs already running` };
  }
  // Dedicated client profiles are known to relay before their worker starts,
  // so reserve their sub-cap eagerly. A normal script *may* be pure compute or
  // may later call egress/spawn; reserving every default-capability script here
  // would consume the two compute-reserved slots before it executes. Those
  // acquire lazily at their first outward relay through guardedSendToSW below.
  const isEagerRelayingRun = job.actors === true || job.a2a === true || !!job.siteFetch
    || job.caps?.page === true || job.caps?.provider === true;
  let holdsRelayLease = false;
  const relayRefusal = `headless job rejected: ${MAX_RELAYING_JOBS} capability-relaying runs already in flight — await their results before fanning out further`;
  const acquireRelayLease = () => {
    if (holdsRelayLease) return true;
    if (activeRelayingJobs >= MAX_RELAYING_JOBS) return false;
    activeRelayingJobs++;
    holdsRelayLease = true;
    return true;
  };
  if (isEagerRelayingRun && !acquireRelayLease()) {
    return { value: undefined, consoleOutput: [], durationMs: 0, error: relayRefusal };
  }
  activeJobs++;
  const guardedSendToSW = (/** @type {string} */ type, /** @type {object} */ payload) => {
    if (RELAYING_MESSAGE_TYPES.has(type) && !acquireRelayLease()) {
      return Promise.resolve({ ok: false, error: relayRefusal });
    }
    return deps.sendToSW(type, payload);
  };
  try { return await _runJob(job, { ...deps, sendToSW: guardedSendToSW }); }
  finally {
    // Retire the SW-side run BEFORE releasing this relay lease. A Worker can
    // time out/crash/return while a fire-and-forget bridge call is still parked
    // on user confirmation; aborting its run signal first dismisses that card
    // and prevents stale work from outliving the capacity that admitted it.
    if (typeof job.runId === 'string' && job.runId && deps.abortRun) {
      try { await deps.abortRun(job.runId, job.ownerSessionId); } catch { /* SW gone = no live relay */ }
    }
    activeJobs--;
    if (holdsRelayLease) activeRelayingJobs--;
  }
};

/**
 * @param {{ code: string, timeoutMs?: number, startedAt?: number, deadlineAt?: number, a2a?: boolean, actors?: boolean, siteFetch?: string, toolbox?: boolean, caps?: { page?: boolean, egress?: boolean, subagent?: boolean, opfs?: boolean, provider?: boolean }, ownerSessionId?: string, ownerToolUseId?: string, runId?: string, workspaceSessionId?: string, workspaceBudgetBytes?: number }} job
 *   a2a: expose the `mesh` client (agent-to-agent); actors: expose the `actors`
 *   delegation client (the orchestrator's script surface); caps: capability
 *   profile (default DEFAULT_WORKER_CAPS; caps.page is the web actor's
 *   page-bridge lane, PR #119). ownerSessionId / ownerToolUseId / runId /
 *   workspaceSessionId are attached to every relay (and pick the OPFS root)
 *   from TRUSTED job params, never from the worker message (the worker can't
 *   spoof who it acts as, nor name its own root).
 * @param {{ sendToSW: (type: string, payload: object) => Promise<any>, extractMarkdown?: import('/shared/fetch-extract.js').ExtractMarkdownFn, opfsForRoot?: typeof opfsHelpers }} deps
 *   sendToSW relays a worker bridge message to the SW route of that name;
 *   extractMarkdown is the LOCAL web-extract entry (same offscreen document),
 *   injected so the in-browser tests can stub it without the vendored parsers.
 */
const _runJob = async ({ code, timeoutMs = 30000, startedAt, deadlineAt, a2a = false, actors = false, siteFetch = '', toolbox = false, caps, ownerSessionId, ownerToolUseId, runId, workspaceSessionId, workspaceBudgetBytes = WORKSPACE_BUDGET_BYTES }, { sendToSW, extractMarkdown, opfsForRoot = opfsHelpers }) => {
  // One ABSOLUTE deadline spans resolution + execution. Phase-local timers
  // derive only the remaining budget; no phase may mint a fresh timeout and
  // quietly make the advertised wall-clock additive.
  const receivedAt = Date.now();
  const runStartedAt = typeof startedAt === 'number' && Number.isFinite(startedAt)
    ? Math.min(startedAt, receivedAt) : receivedAt;
  const nominalDeadline = runStartedAt + timeoutMs;
  const absoluteDeadline = typeof deadlineAt === 'number' && Number.isFinite(deadlineAt)
    ? Math.min(deadlineAt, nominalDeadline) : nominalDeadline;
  const remainingMs = () => Math.max(0, absoluteDeadline - Date.now());
  const deadlineError = () => {
    const error = new Error(`job timed out after ${timeoutMs}ms`);
    error.name = 'JobDeadlineError';
    return error;
  };
  /** @template T @param {Promise<T>} promise */
  const beforeDeadline = (promise) => new Promise((resolve, reject) => {
    const budgetMs = remainingMs();
    if (budgetMs <= 0) { reject(deadlineError()); return; }
    let settled = false;
    /** @param {(value: any) => void} fn @param {any} value */
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, deadlineError()), Math.ceil(budgetMs));
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
  // The job's capability profile — enforced HERE (the host refuses the bridge
  // message) as well as in the generated worker surface (worker-source.js), so
  // a realm-seal escape alone cannot re-open a disabled lane.
  // DESIGN-19: a site-client run forces EVERY standard cap off — its ONLY outward
  // edge is the pinned site.fetch (the site-fetch-request relay below). Even if the
  // caller passed a wider profile, siteFetch closes it, the a2a-run posture applied
  // to the site lane.
  // distributed is ALWAYS off headless (caller caps can't re-open it): this host
  // has no 'distributed-request' handler — the tab does — so without the in-realm
  // throw a peerd.distributed.* touch would hang to the job wall-clock for a
  // one-word answer (design 7.3). If a headless lane ever legitimately needs
  // base-network reads, that is a deliberate caps flag + host relay at that point.
  const profile = siteFetch
    ? { page: false, egress: false, subagent: false, opfs: false, provider: false, distributed: false }
    : { ...DEFAULT_WORKER_CAPS, ...(caps ?? {}), distributed: false };
  const jobId = `job-${Date.now().toString(36)}-${++jobSeq}`;
  // design js-superpower/06 — the toolbox resolution LANE GATE, enforced at
  // this host: only a job whose TRUSTED params carry the flag (the script tool
  // sets it) resolves peerd:toolbox modules, and never an a2a/site-client run —
  // their profiles promise "this code + the pinned capability and nothing
  // else", and a stored module would be a side-channel into that promise. The
  // gate is dep INJECTION (the resolver refuses when the dep is absent), so
  // there is no request for a sealed worker to forge.
  // why !caps?.page too: a page_code run (PR #119) is a pinned "this code + the
  // page bridge and nothing else" lane — same promise a2a/site-client make — so
  // it is refused by an EXPLICIT denial, mirroring the a2a/siteFetch exclusion,
  // not merely by the toolbox flag being unset.
  const toolboxOn = toolbox === true && !a2a && !siteFetch && !caps?.page;
  // The OPFS root: per-job EPHEMERAL scratch by default (peerd.self.* +
  // relative imports work within the run, then it's nuked) — or, for a
  // workspace run, the DURABLE per-session subtree, which survives the run
  // (the nukes below are all skipped). The worker API is unchanged either way;
  // only where the root points differs, and only the SW ever picks it.
  const usedWorkspace = typeof workspaceSessionId === 'string' && workspaceSessionId.length > 0;
  const opfs = opfsForRoot(usedWorkspace ? ['peerd-workspace', workspaceSessionId] : ['peerd-jobs', jobId]);
  // Worker termination does not cancel async work already running in THIS host
  // document. Every OPFS operation therefore shares a host-owned signal and is
  // tracked until settlement. Stop/timeout/done aborts the signal first; the
  // finalizer waits for those operations before deleting ephemeral scratch, so
  // a late writable/delete can neither mutate a durable workspace post-Stop nor
  // race the scratch nuke and recreate residue after the run returned.
  const hostOpsAbort = new AbortController();
  /** @type {Set<Promise<unknown>>} */
  const pendingHostOperations = new Set();
  /** @template T @param {Promise<T>} operation @returns {Promise<T>} */
  const trackHostOperation = (operation) => {
    const tracked = Promise.resolve(operation);
    pendingHostOperations.add(tracked);
    tracked.finally(() => pendingHostOperations.delete(tracked)).catch(() => {});
    return tracked;
  };
  const abortHostOperations = () => {
    if (!hostOpsAbort.signal.aborted) hostOpsAbort.abort();
  };
  const settleHostOperations = async () => {
    // A tracked compose-module may start tracked reads while settling. Drain to
    // a fixed point rather than snapshotting once.
    while (pendingHostOperations.size > 0) {
      await Promise.allSettled([...pendingHostOperations]);
    }
  };
  // Cleanup is hygiene, but ordering is correctness: pending host mutations
  // must settle before an ephemeral root is removed. The deletion itself keeps
  // the historical small grace budget and remains best-effort.
  const cleanupScratch = async () => {
    abortHostOperations();
    await settleHostOperations();
    if (usedWorkspace) return;
    const cleanup = opfs.nuke().catch(() => {});
    const budgetMs = remainingMs();
    if (budgetMs <= 0) { void cleanup; return; }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      };
      const timer = setTimeout(finish, Math.min(250, Math.ceil(budgetMs)));
      cleanup.then(finish, finish);
    });
  };
  // Workspace size budget (soft): computed ONCE on mount. Over it, writes are
  // refused for this whole run — cheap and stateless; the next run after a
  // cleanup passes again.
  let workspaceOverBudget = false;
  if (usedWorkspace) {
    try {
      const files = await beforeDeadline(trackHostOperation(opfs.list({ signal: hostOpsAbort.signal })));
      workspaceOverBudget = files.reduce((/** @type {number} */ sum, /** @type {{ size: number }} */ f) => sum + f.size, 0) > workspaceBudgetBytes;
    } catch (error) {
      if (/** @type {{ name?: string }} */ (error)?.name === 'JobDeadlineError') {
        await cleanupScratch();
        return { value: undefined, consoleOutput: [], durationMs: timeoutMs, error: `job timed out after ${timeoutMs}ms`, usedWorkspace, workspaceOverBudget, codeTrace: [] };
      }
      // An unreadable/empty workspace does not block the run.
    }
  }
  // Did this run reach the web? The fetch bridge below and the resolver's
  // fetchRemote (remote module source) are the ONLY egress lanes a sealed
  // worker's run has; both set this one authoritative flag. script fences the
  // run's output for the model when it's set (fetched bytes are untrusted).
  let usedEgress = false;
  // Any page bridge can return attacker-authored DOM/pixels. Stamp provenance
  // at the host boundary; user code cannot launder it away by transforming the
  // value before return.
  let usedPage = false;
  /** @type {Array<{ data: string, mediaType: string }>} */
  let pageImages = [];
  // A uniform, privacy-minimal trace for EVERY code-client bridge. It records
  // no arguments or results — only which bridge/method ran, whether it settled,
  // and its duration. The existing actor-specific trace remains for model-facing
  // delegation detail and backwards compatibility.
  /** @type {Array<{ seq: number, bridge: string, method: string, outcome: 'pending'|'ok'|'error', ok: boolean, settled: boolean, ms: number }>} */
  const codeTrace = [];
  let codeSeq = 0;
  /** @param {string} bridge @param {unknown} method */
  const beginCodeOp = (bridge, method) => {
    const canonical = canonicalCodeTraceLabel(bridge, method);
    const entry = {
      seq: ++codeSeq,
      bridge: canonical.bridge,
      method: canonical.method,
      outcome: /** @type {'pending'|'ok'|'error'} */ ('pending'),
      ok: false,
      settled: false,
      ms: 0,
    };
    if (codeTrace.length >= CODE_RUN_MAX_TRACE_OPS) codeTrace.shift();
    codeTrace.push(entry);
    const traceStartedAt = performance.now();
    return (/** @type {boolean} */ ok) => {
      entry.ok = ok;
      entry.outcome = ok ? 'ok' : 'error';
      entry.settled = true;
      entry.ms = Math.round(performance.now() - traceStartedAt);
    };
  };
  /**
   * @template T
   * @param {string} bridge @param {unknown} method @param {() => Promise<T>} operation
   * @param {(value: T) => boolean} [succeeded]
   */
  const runCodeOp = async (bridge, method, operation, succeeded = (value) => /** @type {any} */ (value)?.ok !== false) => {
    const settle = beginCodeOp(bridge, method);
    try {
      const value = await operation();
      settle(succeeded(value));
      return value;
    } catch (error) {
      settle(false);
      throw error;
    }
  };
  /** @param {string} bridge @param {unknown} method */
  const recordRefusedCodeOp = (bridge, method) => beginCodeOp(bridge, method)(false);
  // Remote module source rides the audited fetchRemote (shared decode in
  // module-resolver.js makeFetchRemote — see its header for the full story).
  const remoteModuleFetch = makeFetchRemote((req) =>
    runCodeOp('fetch', 'GET', () => sendToSW('sw/web-fetch', {
      ...req, runId, ownerSessionId, deadlineAt: absoluteDeadline,
    }), (response) => response?.ok === true));
  const resolverDeps = {
    /** @param {string} path */
    readFile: (path) => trackHostOperation(opfs.read(path, { signal: hostOpsAbort.signal })),
    /** @param {string} src */
    makeBlobUrl: (src) => URL.createObjectURL(new Blob([src], { type: 'application/javascript' })),
    log: () => {},
    builtins: NOTEBOOK_BUILTINS,
    // Remote (https:) imports ride the run's EGRESS capability: an a2a or
    // no-egress lane (page_code, site-client) gets NO fetchRemote, so the
    // resolver refuses the import with the why ("no network"). This wall is
    // load-bearing at RUNTIME too: the worker reaches the resolver via the
    // compose-module relay below (a worker-supplied path may be an https
    // URL), so it's the resolver's fetchRemote-absence check — plus
    // profile.opfs gating that relay — that keeps a no-egress realm from
    // pulling code bytes, not any absence of a runtime surface.
    ...((!a2a && profile.egress) ? {
      /** @param {string} url */
      fetchRemote: (url) => {
        usedEgress = true;   // module bytes are untrusted web bytes → fence the output
        return remoteModuleFetch(url);
      },
    } : {}),
    ...(toolboxOn ? {
      /** @param {string} name */
      readToolboxModule: async (name) => {
        const resp = await runCodeOp('toolbox', 'read', () => sendToSW('toolbox/read', { name }), (response) => response?.ok === true);
        if (!resp?.ok) throw new Error(resp?.error ?? 'toolbox read failed');
        return String(resp.body);
      },
    } : {}),
  };

  // The deadline + Stop now cover RESOLUTION too: a remote import graph hits
  // the network, so a tarpit CDN must not hang the job (pre-remote-imports
  // the build was local OPFS reads and starting the clock after it was
  // harmless). A build-phase Stop/timeout settles the job promptly; the
  // in-flight relay fetch is abandoned, not cancelled.
  /** @type {Awaited<ReturnType<typeof buildWorkerSource>>} */
  let built;
  try {
    built = await /** @type {Promise<Awaited<ReturnType<typeof buildWorkerSource>>>} */ (new Promise((resolve, reject) => {
      const budgetMs = remainingMs();
      if (budgetMs <= 0) { reject(deadlineError()); return; }
      /** @param {unknown} err */
      const killWith = (err) => {
        clearTimeout(buildTimer);
        abortHostOperations();
        reject(err);
      };
      const buildTimer = setTimeout(() => killWith(deadlineError()), Math.ceil(budgetMs));
      if (runId) {
        liveJobs.set(runId, { kill: () => killWith(new Error('job aborted (Stop)')), owner: ownerSessionId });
        // Stop already arrived before we registered — honor it now.
        if (consumeEarlyAbort(runId, ownerSessionId)) { killWith(new Error('job aborted (Stop)')); return; }
      }
      buildWorkerSource(code, {
        entryPath: 'job.js', notebookId: jobId, resolverDeps, a2a, actors,
        actorsGuardMs: ACTORS_BRIDGE_GUARD_MS, caps: profile, siteFetch,
        // Generated from the same declarative manifest that drives prompt lore
        // and host validation. Outer termination still owns the absolute wall;
        // these guards only make an unanswered bridge fail no later than it.
        clientSources: {
          ...(actors ? { actors: buildCodeClientSource('actors', { timeoutMs: ACTORS_BRIDGE_GUARD_MS }) } : {}),
          // Page calls share the OUTER run deadline. A shorter bridge-local
          // timeout would reject user code while a confirmation-gated SW
          // dispatch remained alive and could mutate later.
          ...(profile.page ? { page: buildCodeClientSource('page', { timeoutMs: Math.ceil(remainingMs()) }) } : {}),
          ...(a2a ? { mesh: buildCodeClientSource('mesh', { timeoutMs: Math.ceil(remainingMs()) }) } : {}),
          ...(profile.provider ? { provider: buildCodeClientSource('provider') } : {}),
          ...(siteFetch ? { site: buildCodeClientSource('site', { siteOrigin: siteFetch, timeoutMs: Math.ceil(remainingMs()) }) } : {}),
        },
      })
        .then((v) => { clearTimeout(buildTimer); resolve(v); }, killWith);
    }));
  } catch (e) {
    if (runId) liveJobs.delete(runId);
    await cleanupScratch();
    // usedEgress still rides out: a partially-fetched remote graph that then
    // failed (denylist, pin mismatch) DID touch the web.
    const deadlineHit = /** @type {{ name?: string }} */ (e)?.name === 'JobDeadlineError';
    return { value: undefined, consoleOutput: [], durationMs: deadlineHit ? timeoutMs : 0, error: `import resolution failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`, usedEgress, usedWorkspace, workspaceOverBudget, codeTrace };
  }
  // Drop the build-phase Stop handle: its kill can only settle the (already
  // settled) build promise. The run phase re-registers with a worker kill
  // below; an abort landing in this gap tombstones and is honored there.
  if (runId) liveJobs.delete(runId);
  const { source, cache, bodyLine } = built;
  const revokeCache = () => { for (const entry of cache.values()) if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl); };
  // Resolution consumed the same budget execution uses. If it settled on the
  // edge, do not spawn a worker merely to terminate it on a zero-delay timer.
  if (remainingMs() <= 0) {
    revokeCache();
    await cleanupScratch();
    return { value: undefined, consoleOutput: [], durationMs: timeoutMs, error: `job timed out after ${timeoutMs}ms`, usedEgress, usedWorkspace, workspaceOverBudget, codeTrace };
  }
  // The DELEGATIONS trace — one entry per actors op this run made. This is the
  // observability spine of the script surface: the orchestrator reads it back
  // (which op, to whom, outcome, how long) even when the script itself failed
  // mid-way, and the ops keep flowing into it right up to a termination.
  /** @type {Array<{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string, settled?: boolean, actorFailed?: boolean }>} */
  const actorsTrace = [];
  let actorsSeq = 0;
  let usedActors = false;
  // The sub-model meter (design 5): host-counted, so the [MODEL CALLS n |
  // tokens t] line the orchestrator reads is never the realm's own claim.
  // Calls count every relayed attempt (an attempt is potential spend); tokens
  // sum whatever usage the SW route reports back, ok or errored — the
  // authoritative money record is the SW-side cost fold either way.
  let usedProvider = false;
  let providerCalls = 0;
  let providerTokens = 0;
  // design 06 rot bookkeeping: when the run settles, report which toolbox
  // modules it imported and whether it succeeded (runCount/failCount on the
  // meta — the treat-as-cache signal toolbox_list surfaces). Fire-and-forget;
  // bookkeeping must never fail a run. A Stop is deliberately NOT recorded —
  // an aborted run says nothing about the module.
  const recordToolboxUse = (/** @type {boolean} */ ok) => {
    if (!toolboxOn) return;
    const names = [...cache.keys()]
      .filter((k) => k.startsWith(TOOLBOX_SPECIFIER_PREFIX))
      .map((k) => k.slice(TOOLBOX_SPECIFIER_PREFIX.length));
    if (names.length) Promise.resolve(sendToSW('toolbox/record', { names, ok })).catch(() => {});
  };

  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  let worker;
  try { worker = new Worker(blobUrl, { type: 'module' }); }
  catch (e) {
    URL.revokeObjectURL(blobUrl);
    revokeCache();
    await cleanupScratch();
    return { value: undefined, consoleOutput: [], durationMs: 0, error: `worker spawn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`, usedWorkspace, workspaceOverBudget, codeTrace };
  }

  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        abortHostOperations();
        try { worker.terminate(); } catch {}
        recordToolboxUse(false);
        resolve({ value: undefined, consoleOutput: [], durationMs: timeoutMs, error: `job timed out after ${timeoutMs}ms`, usedEgress, usedActors, usedPage, images: pageImages, usedWorkspace, workspaceOverBudget, actorsTrace, codeTrace, usedProvider, providerCalls, providerTokens });
      }, Math.ceil(remainingMs()));
      // Stop plumbing: a runId-carrying job can be terminated from the SW
      // (script tool abort). The trace survives — partial work stays visible.
      if (runId) {
        const kill = () => {
          clearTimeout(timer);
          abortHostOperations();
          try { worker.terminate(); } catch {}
          resolve({ value: undefined, consoleOutput: [], durationMs: 0, error: 'job aborted (Stop)', usedEgress, usedActors, usedPage, images: pageImages, usedWorkspace, workspaceOverBudget, actorsTrace, codeTrace, usedProvider, providerCalls, providerTokens });
        };
        liveJobs.set(runId, { kill, owner: ownerSessionId });
        // Stop already arrived while we were still building — honor it now.
        if (consumeEarlyAbort(runId, ownerSessionId)) kill();
      }

      worker.addEventListener('message', async (ev) => {
        // why any: worker postMessage payload, discriminated by m.type below.
        /** @type {any} */
        const m = ev.data;
        if (!m || typeof m !== 'object') return;
        // Headless: no UI. console accumulates in the worker and rides 'done';
        // display() has no surface here (the agent should RETURN its result).
        if (m.type === 'log' || m.type === 'display') return;

        if (m.type === 'actor-request') {
          // An a2a run is the dweb actor's MESH-ONLY surface. Its tool allow-set
          // grants no delegation (no actor_create), so the worker's
          // peerd.runtime.runAgent must not re-grant it — refuse at the host, the
          // authoritative choke point (the worker surface can't be trusted). The
          // caps profile (PR #119: the page_code worker) is the second no-spawn
          // lane, enforced the same way.
          if (a2a || !profile.subagent) {
            recordRefusedCodeOp('actor', 'spawn');
            worker.postMessage({ type: 'actor-response', rid: m.rid, error: a2a ? 'actor spawn is disabled for a2a runs (the dweb actor does not delegate)' : 'actor spawn capability is disabled for this job' });
            return;
          }
          const a = m.args ?? {};
          try {
            const resp = await runCodeOp('actor', 'spawn', () => sendToSW('actor/spawn', {
              task: a.task, tools: a.tools, maxSteps: a.maxSteps, maxDepth: a.maxDepth, allowRecursion: a.allowRecursion,
            }), (response) => response?.ok === true);
            if (!resp?.ok) worker.postMessage({ type: 'actor-response', rid: m.rid, error: resp?.error ?? 'actor failed' });
            else worker.postMessage({ type: 'actor-response', rid: m.rid, result: resp.result });
          } catch (e) {
            worker.postMessage({ type: 'actor-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'actors-request') {
          // Relay a delegation call to the SW actors/call route. The owner ids
          // ride from TRUSTED job params; the SW re-gates every op (sender gate,
          // rate caps, oneShot sandbox-only) — the worker's word buys nothing.
          if (!actors || typeof ownerSessionId !== 'string' || !ownerSessionId) {
            recordRefusedCodeOp('actors', m.method);
            worker.postMessage({ type: 'actors-response', rid: m.rid, error: 'actors capability is disabled for this run' });
            return;
          }
          usedActors = true;   // actor replies are untrusted content → fence the run's output
          const seq = ++actorsSeq;
          if (seq > ACTORS_RUN_MAX_OPS) {
            recordRefusedCodeOp('actors', m.method);
            worker.postMessage({
              type: 'actors-response', rid: m.rid,
              error: 'actors: this script run reached its delegation-operation limit',
            });
            return;
          }
          // Compatibility trace fields retain their historical names while the
          // canonical Elixir-shaped client now emits address/message.
          const actorAddress = m?.args?.address ?? m?.args?.to;
          const goalRaw = m?.args?.message ?? m?.args?.goal;
          /** @type {{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string, settled?: boolean, actorFailed?: boolean }} */
          const entry = {
            seq,
            method: canonicalCodeTraceLabel('actors', m.method).method,
            ...(typeof actorAddress === 'string' ? { to: actorAddress } : {}),
            ...(typeof goalRaw === 'string' ? { goal: goalRaw.slice(0, 200) } : {}),
            // settled:false until the relay answers — a run that dies first
            // reports this op as IN FLIGHT, never as an instant failure.
            ok: false, ms: 0, settled: false,
          };
          if (actorsTrace.length >= CODE_RUN_MAX_TRACE_OPS) actorsTrace.shift();
          actorsTrace.push(entry);
          const t0 = performance.now();
          try {
            const resp = await runCodeOp(
              'actors', m.method,
              () => sendToSW('actors/call', { method: m.method, args: m.args, ownerSessionId, ownerToolUseId, runId, seq }),
              (response) => response?.ok === true && response?.value?.failed !== true,
            );
            entry.ms = Math.round(performance.now() - t0);
            entry.settled = true;
            if (resp?.ok) {
              entry.ok = true;
              // Transport ok ≠ delegation ok: an ask whose actor turn FAILED
              // returns { failed:true } — record it so the trace can't render
              // a failed delegation as a clean 'ok' (the model-facing record
              // must agree with the user-facing live feed).
              if (resp.value && resp.value.failed === true) entry.actorFailed = true;
              worker.postMessage({ type: 'actors-response', rid: m.rid, result: resp.value });
            } else {
              entry.error = resp?.error ?? 'actors call failed';
              worker.postMessage({ type: 'actors-response', rid: m.rid, error: entry.error });
            }
          } catch (e) {
            entry.ms = Math.round(performance.now() - t0);
            entry.settled = true;
            entry.error = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
            worker.postMessage({ type: 'actors-response', rid: m.rid, error: entry.error });
          }
          return;
        }
        if (m.type === 'provider-request') {
          // Design 5: the sub-model lane. Refuse unless the HOST-supplied job
          // params carry the cap, a trusted owner, AND a live runId — the
          // worker's own words buy nothing (the SW script/model-call route
          // re-verifies the owner/run and enforces the per-run quota
          // regardless; this wall just makes a seal escape buy nothing new).
          if (!profile.provider || typeof ownerSessionId !== 'string' || !ownerSessionId || typeof runId !== 'string' || !runId) {
            recordRefusedCodeOp('provider', 'call');
            worker.postMessage({ type: 'provider-response', rid: m.rid, error: 'provider capability is disabled for this job' });
            return;
          }
          usedProvider = true;   // money may move → the result line must show it
          try {
            const resp = await runCodeOp(
              'provider', 'call',
              () => sendToSW('script/model-call', { ownerSessionId, runId, args: m.args }),
              (response) => response?.ok === true,
            );
            const usage = resp?.ok ? resp.value?.usage : resp?.usage;
            // The DISPLAY meter counts only calls that actually returned usage —
            // i.e. SPENT. An SW-side refusal (quota/foreign-run/bad-args) or an
            // abort that billed nothing carries no usage, so it never inflates
            // the [MODEL CALLS] line. (The SW-side per-run quota counter is a
            // SEPARATE meter, deliberately count-on-ATTEMPT — do not conflate.)
            if (usage) {
              providerCalls += 1;
              providerTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
            }
            if (resp?.ok) worker.postMessage({ type: 'provider-response', rid: m.rid, result: resp.value });
            else worker.postMessage({ type: 'provider-response', rid: m.rid, error: resp?.error ?? 'provider call failed' });
          } catch (e) {
            worker.postMessage({ type: 'provider-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'a2a-request') {
          // Relay the mesh call to the SW a2a/call route. Refuse if the cap is
          // off or no trusted owner — the OWNER is attached from the job params
          // (ownerSessionId), NEVER from the worker message (which is untrusted).
          if (!a2a || typeof ownerSessionId !== 'string' || !ownerSessionId || typeof runId !== 'string' || !runId) {
            recordRefusedCodeOp('a2a', m.method);
            worker.postMessage({ type: 'a2a-response', rid: m.rid, error: 'mesh capability is disabled for this run' });
            return;
          }
          try {
            const resp = await runCodeOp(
              'a2a', m.method,
              () => sendToSW('a2a/call', { method: m.method, args: m.args, ownerSessionId, runId }),
              (response) => response?.ok === true,
            );
            if (resp?.ok) worker.postMessage({ type: 'a2a-response', rid: m.rid, result: resp.value });
            else worker.postMessage({ type: 'a2a-response', rid: m.rid, error: resp?.error ?? 'mesh call failed' });
          } catch (e) {
            worker.postMessage({ type: 'a2a-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'fetch-request') {
          // Same envoy posture: the dweb actor has no egress (no fetch_url in its
          // allow-set). The a2a worker still carries the seal's bridged fetch +
          // peerd.egress.fetch, so the host is where we deny it — the mesh is the
          // ONLY outward edge an a2a run gets. The caps profile (PR #119: the
          // page_code worker) is the second no-egress lane, same choke point.
          if (a2a || !profile.egress) {
            recordRefusedCodeOp('fetch', m.method ?? 'GET');
            worker.postMessage({ type: 'fetch-response', rid: m.rid, ok: false, status: 0, bodyB64: null, error: a2a ? 'egress is disabled for a2a runs (the dweb actor talks only to the mesh)' : 'egress capability is disabled for this job' });
            return;
          }
          usedEgress = true;   // the run touched the web → its output carries untrusted bytes
          try {
            const resp = await runCodeOp('fetch', m.method ?? 'GET', async () => {
              const raw = await sendToSW('sw/web-fetch', {
                url: m.url, method: m.method, headers: m.headers, body: m.body,
                runId, ownerSessionId, deadlineAt: absoluteDeadline,
              });
              // Design 2a extract step (see shared/fetch-extract.js), applied HERE
              // against the local pipeline — same document, no SW round-trip.
              return await applyFetchExtract(raw, { extract: m.extract, url: m.url, extractMarkdown });
            }, (response) => response?.ok === true);
            worker.postMessage({
              type: 'fetch-response', rid: m.rid,
              ok: resp?.ok ?? false, status: resp?.status ?? 0,
              statusText: resp?.statusText ?? '', headers: resp?.headers ?? null,
              bodyB64: resp?.bodyB64 ?? null, error: resp?.error ?? null,
              ...(typeof resp?.extracted === 'boolean' ? { extracted: resp.extracted } : {}),
            });
          } catch (e) {
            worker.postMessage({ type: 'fetch-response', rid: m.rid, ok: false, status: 0, bodyB64: null, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'site-fetch-request') {
          // DESIGN-19: the site-client run's ONLY outward edge. Refuse unless this
          // is a site-client run (siteFetch set) with a trusted owner — the OWNER +
          // the PINNED ORIGIN ride from the runJob params (SW-set, trusted), NEVER
          // from the worker message. The SW route resolves the worker's pathOrUrl
          // against the pinned origin (cross-origin refused) and runs it through the
          // actor's session-scoped, denylisted, audited webFetch — this relay adds
          // no authority and cannot pick the host.
          if (!siteFetch || typeof ownerSessionId !== 'string' || !ownerSessionId || typeof runId !== 'string' || !runId) {
            recordRefusedCodeOp('site-fetch', m.method ?? 'GET');
            worker.postMessage({ type: 'site-fetch-response', rid: m.rid, ok: false, error: 'site fetch is disabled for this run' });
            return;
          }
          usedEgress = true;   // the run reached the web (its pinned origin) → untrusted bytes
          try {
            const resp = await runCodeOp('site-fetch', m.method ?? 'GET', () => sendToSW('site-fetch/call', {
              ownerSessionId, runId, siteOrigin: siteFetch,
              pathOrUrl: m.pathOrUrl, method: m.method, headers: m.headers, body: m.body,
            }), (response) => response?.ok === true);
            // The bridge resolves on m.result and rejects on m.error — so the
            // response object rides under `result`, and an SW-side refusal (ok:false)
            // surfaces as a thrown Error inside the run.
            if (resp?.ok) worker.postMessage({ type: 'site-fetch-response', rid: m.rid, result: resp.value });
            else worker.postMessage({ type: 'site-fetch-response', rid: m.rid, error: resp?.error ?? 'site fetch failed' });
          } catch (e) {
            worker.postMessage({ type: 'site-fetch-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'page-request') {
          // PR #119: the code-REPL actor's page bridge. The OWNER identity rides
          // from the runJob params (the SW set it — trusted), NEVER from the
          // worker message: a hostile realm cannot name another session. The SW
          // route re-derives the owned tab from its own bindings and dispatches
          // through the full gate stack, so this relay adds no authority.
          if (!profile.page || typeof ownerSessionId !== 'string' || !ownerSessionId || typeof runId !== 'string' || !runId) {
            recordRefusedCodeOp('page', m.method);
            worker.postMessage({ type: 'page-response', rid: m.rid, error: 'page capability is disabled for this job' });
            return;
          }
          usedPage = true;
          try {
            const resp = await runCodeOp(
              'page', m.method,
              () => sendToSW('page/call', { method: m.method, args: m.args, ownerSessionId, runId }),
              (response) => response?.ok === true,
            );
            if (resp?.ok) {
              // `view` pixels are host-authored tool-result blocks, never realm
              // output. Keep only the newest capture so a loop cannot amass
              // dozens of multi-megabyte screenshots in one result.
              if (Array.isArray(resp.images) && resp.images.length) pageImages = resp.images.slice(-1);
              worker.postMessage({ type: 'page-response', rid: m.rid, result: resp.value });
            }
            else worker.postMessage({ type: 'page-response', rid: m.rid, error: resp?.error ?? 'page call failed' });
          } catch (e) {
            worker.postMessage({ type: 'page-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'distributed-request') {
          // Backstop wall (the in-realm surface already throws — profile above):
          // a seal-escaped realm still gets a fast refusal, never a silent hang.
          recordRefusedCodeOp('distributed', m.method ?? m.op ?? 'info');
          worker.postMessage({ type: 'distributed-response', rid: m.rid, error: 'distributed is not available in headless runs - use a Notebook' });
          return;
        }
        if (m.type === 'opfs-request') {
          if (!profile.opfs) {
            recordRefusedCodeOp('opfs', m.op);
            worker.postMessage({ type: 'opfs-response', rid: m.rid, error: 'opfs capability is disabled for this job' });
            return;
          }
          try {
            const result = await trackHostOperation(runCodeOp('opfs', m.op, async () => {
              let value;
              if (m.op === 'read') value = await opfs.read(m.args.path, { signal: hostOpsAbort.signal });
              else if (m.op === 'write') {
                // Workspace write hygiene, enforced at the RELAY (the host choke
                // point — an in-realm check alone could be unseated): the same
                // per-file ceiling js_write_file applies tool-side, so worker
                // writes can't dodge it; plus the mount-time budget refusal.
                if (usedWorkspace) {
                  if (workspaceOverBudget) throw new Error('workspace over budget — writes are refused this run; peerd.self.deleteFile files first to get back under it');
                  // chars for strings, bytes for binary payloads — same ceiling
                  // either way. Shape-ALLOWLISTED, fail closed: opfs.write feeds
                  // FileSystemWritableFileStream.write, which also accepts a
                  // WriteParams object ({ type:'write', data }) — an unmeasured
                  // shape would size to 0 and dodge the cap, so anything but the
                  // four measurable shapes is refused outright.
                  const content = m.args.content;
                  const size = typeof content === 'string' ? content.length
                    : content instanceof Blob ? content.size
                    : content instanceof ArrayBuffer || ArrayBuffer.isView(content) ? content.byteLength
                    : -1;
                  if (size < 0) throw new Error('unsupported write payload — pass a string, ArrayBuffer, TypedArray, or Blob');
                  if (size > MAX_FILE_CONTENT_CHARS) throw new Error(`write too large: ${size} > ${MAX_FILE_CONTENT_CHARS} chars`);
                }
                await opfs.write(m.args.path, m.args.content, { signal: hostOpsAbort.signal }); value = null;
              }
              // delete stays legal even when the workspace is over budget — it is
              // the ONE in-band way back under it (the over-budget nudge names it).
              else if (m.op === 'delete') { await opfs.delete(m.args.path, { signal: hostOpsAbort.signal }); value = null; }
              else if (m.op === 'list') value = await opfs.list({ signal: hostOpsAbort.signal });
              else if (m.op === 'compose-module') value = (await buildModule(m.args.path, resolverDeps, cache)).source;
              else throw new Error(`unknown opfs op: ${m.op}`);
              return value;
            }));
            worker.postMessage({ type: 'opfs-response', rid: m.rid, result });
          } catch (e) {
            worker.postMessage({ type: 'opfs-response', rid: m.rid, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) });
          }
          return;
        }
        if (m.type === 'done') {
          clearTimeout(timer);
          // A script may start an OPFS promise and return without awaiting it.
          // Its Worker is done, so that host operation no longer has an owner.
          abortHostOperations();
          try { worker.terminate(); } catch {}
          // Map blob-URL stack frames back to job.js:<line> — the model reads
          // this error; a user-code line number is actionable, a blob one isn't.
          const error = m.error ? mapWorkerError(m.error, blobUrl, bodyLine, 'job.js') : null;
          recordToolboxUse(!error);
          resolve({ value: m.value, consoleOutput: m.consoleOutput, durationMs: Math.min(timeoutMs, Math.max(0, Date.now() - runStartedAt)), error, usedEgress, usedActors, usedPage, images: pageImages, usedWorkspace, workspaceOverBudget, actorsTrace, codeTrace, usedProvider, providerCalls, providerTokens });
        }
      });

      worker.addEventListener('error', (e) => {
        clearTimeout(timer);
        abortHostOperations();
        try { worker.terminate(); } catch {}
        const detail = mapWorkerError(
          e.error?.stack || e.error?.message || e.message || 'worker crashed (no detail)',
          blobUrl, bodyLine, 'job.js');
        recordToolboxUse(false);
        resolve({ value: undefined, consoleOutput: [], durationMs: 0, error: `worker error: ${detail}`, usedEgress, usedActors, usedPage, images: pageImages, usedWorkspace, workspaceOverBudget, actorsTrace, codeTrace, usedProvider, providerCalls, providerTokens });
      });
    });
  } finally {
    if (runId) liveJobs.delete(runId);
    URL.revokeObjectURL(blobUrl);
    revokeCache();
    // The workspace PERSISTS — that is its whole point. Only the per-job
    // ephemeral scratch is nuked; the workspace subtree is torn down with its
    // session (the SW session-lifecycle hook), never per run.
    await cleanupScratch();
  }
};
