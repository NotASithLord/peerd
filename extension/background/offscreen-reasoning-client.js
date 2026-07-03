// @ts-check
// background/offscreen-reasoning-client.js — SW-side client for offscreen
// reasoning subagents (heap-split phase 1), the reasoning sibling of
// offscreen-js-client.
//
// Three halves:
//   • run(job, {signal, onEvent}) — ensure the offscreen doc, dispatch
//     'reasoning/run', and return the child's result. signal → abort: aborts the
//     in-flight (key-bearing) provider call AND terminates the worker, so Stop /
//     cancel / the wall-clock timeout actually stop the child (and its billing).
//     onEvent receives the child's forwarded loop events (card + cost meter).
//   • routes['reasoning/model-call'] — the offscreen→SW leg: run the REAL
//     callModel WITH the SW's key (getSecret) AND the SW's egress (safeFetch,
//     which the provider adapter requires to make the request). The key + egress
//     never cross to the worker. Its AbortController is registered under runId so
//     run()'s signal can cancel it mid-stream.
//   • routes['reasoning/loop-event'] — fire-and-forget: hand a forwarded loop
//     event to that run's onEvent.
//
// Pure shell — every IO injected — so the run/relay flow is unit-testable.

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen
 * @param {(msg: object) => Promise<any>} deps.sendMessage   runtime.sendMessage → offscreen
 * @param {(args: object) => AsyncIterable<any>} deps.callModel   the provider registry callModel
 * @param {(name: string) => Promise<string | null>} deps.getSecret
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} deps.safeFetch
 * @param {() => number} [deps.now]
 */
export const makeOffscreenReasoningClient = ({ ensureOffscreen, sendMessage, callModel, getSecret, safeFetch, now = Date.now }) => {
  let seq = 0;
  // runId → the AbortControllers of its in-flight model calls (so a Stop can
  // cancel the streaming provider request, not just terminate the worker).
  /** @type {Map<string, Set<AbortController>>} */
  const inflight = new Map();
  // runId → the caller's onEvent (loop events forwarded from the worker).
  /** @type {Map<string, (ev: object) => void>} */
  const runOnEvent = new Map();

  /**
   * @param {{ sessionId: string, task: string, systemPrompt: string, provider: string, model: string, depth?: number, maxSteps: number, maxOutputTokens?: number, reasoning?: object, contextWindow?: number, budgetMs?: number }} job
   * @param {{ signal?: AbortSignal, onEvent?: (ev: object) => void }} [opts]
   * @returns {Promise<{ ok: boolean, started?: boolean, finalText?: string, usage?: object, stopReason?: string, toolCalls?: number, error?: string, aborted?: boolean }>}
   */
  const run = async (job, { signal, onEvent } = {}) => {
    await ensureOffscreen();
    const runId = `rw-${now().toString(36)}-${++seq}`;
    if (onEvent) runOnEvent.set(runId, onEvent);
    // Stop / cancel / the SW-side timeout fire this signal → abort the in-flight
    // provider call(s) for this run AND tell the offscreen host to terminate the
    // worker. Both: aborting the call stops billing immediately; terminating the
    // worker stops it looping.
    const abortRun = () => {
      for (const ac of inflight.get(runId) ?? []) { try { ac.abort(); } catch { /* already */ } }
      sendMessage({ type: 'reasoning/abort', runId }).catch(() => {});
    };
    if (signal) {
      if (signal.aborted) abortRun();
      else signal.addEventListener('abort', abortRun, { once: true });
    }
    try {
      return await sendMessage({ type: 'reasoning/run', job: { ...job, runId } });
    } finally {
      runOnEvent.delete(runId);
      inflight.delete(runId);
    }
  };

  // Registered into the SW dispatcher. Offscreen (a first-party sender) is the
  // only caller.
  const routes = {
    /** @param {{ runId?: string, args?: object }} [msg] */
    'reasoning/model-call': async ({ runId, args } = {}) => {
      const ac = new AbortController();
      const key = runId ?? '';
      const set = inflight.get(key) ?? new Set();
      set.add(ac); inflight.set(key, set);
      /** @type {any[]} */
      const events = [];
      try {
        // getSecret (the key) AND safeFetch (the egress the adapter needs) are
        // added HERE — the worker never had either. The controller is abortable
        // by run()'s signal above (Stop cancels the stream mid-flight).
        for await (const ev of callModel({ ...(args ?? {}), getSecret, safeFetch, signal: ac.signal })) events.push(ev);
        return { ok: true, events };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      } finally {
        set.delete(ac); if (set.size === 0) inflight.delete(key);
      }
    },
    /** @param {{ runId?: string, event?: object }} [msg] */
    'reasoning/loop-event': ({ runId, event } = {}) => {
      try { if (event) runOnEvent.get(runId ?? '')?.(event); } catch { /* onEvent must never break the relay */ }
      return { ok: true };
    },
  };

  return { run, routes };
};
