// @ts-check
// background/offscreen-reasoning-client.js — SW-side client for offscreen
// reasoning subagents (heap-split phase 1), the reasoning sibling of
// offscreen-js-client.
//
// Two halves:
//   • run(job) — ensure the offscreen doc, dispatch 'reasoning/run', and return
//     the child's result. Wired signal → 'reasoning/abort' so Stop / cancel /
//     the wall-clock timeout terminate the worker.
//   • routes['reasoning/model-call'] — the offscreen→SW leg: the worker's loop
//     asks for a model call; THIS runs the real callModel WITH the SW's key
//     (getSecret) and hands back the accumulated events. The key never crosses
//     to the worker — the whole point of the split. Accumulate-then-return (not
//     token streaming) is correct for the loop and keeps the relay a plain
//     request/reply, exactly like job-runner's fetch bridge; live streaming is a
//     phase-2 refinement.
//
// Pure shell — every IO (ensureOffscreen, sendMessage, callModel, getSecret) is
// injected, so the run/relay flow is unit-testable without a browser.

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen
 * @param {(msg: object) => Promise<any>} deps.sendMessage   runtime.sendMessage → offscreen
 * @param {(args: object) => AsyncIterable<any>} deps.callModel   the provider registry callModel
 * @param {(name: string) => Promise<string | null>} deps.getSecret
 * @param {() => number} [deps.now]
 */
export const makeOffscreenReasoningClient = ({ ensureOffscreen, sendMessage, callModel, getSecret, now = Date.now }) => {
  let seq = 0;

  /**
   * @param {{ sessionId: string, task: string, systemPrompt: string, provider: string, model: string, depth?: number, maxSteps: number, maxOutputTokens?: number, reasoning?: object, contextWindow?: number, budgetMs?: number }} job
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ ok: boolean, finalText?: string, usage?: object, stopReason?: string, toolCalls?: number, error?: string, aborted?: boolean }>}
   */
  const run = async (job, { signal } = {}) => {
    await ensureOffscreen();
    const runId = `rw-${now().toString(36)}-${++seq}`;
    // Stop / cancel / the SW-side timeout fire this signal → tell the offscreen
    // host to terminate THIS worker (best-effort; the host's own budget timer is
    // the backstop if the message is lost).
    if (signal) {
      const sendAbort = () => { sendMessage({ type: 'reasoning/abort', runId }).catch(() => {}); };
      if (signal.aborted) sendAbort();
      else signal.addEventListener('abort', sendAbort, { once: true });
    }
    return sendMessage({ type: 'reasoning/run', job: { ...job, runId } });
  };

  // Registered into the SW dispatcher. Offscreen (a first-party sender) is the
  // only caller; a reasoning child's model args carry no secret (getSecret is
  // added HERE), so nothing sensitive was ever in the worker's request.
  const routes = {
    /** @param {{ args?: object }} [msg] */
    'reasoning/model-call': async ({ args } = {}) => {
      const ac = new AbortController();
      /** @type {any[]} */
      const events = [];
      try {
        for await (const ev of callModel({ ...(args ?? {}), getSecret, signal: ac.signal })) events.push(ev);
        return { ok: true, events };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
  };

  return { run, routes };
};
