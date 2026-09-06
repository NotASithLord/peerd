// @ts-check
// eval/om2w-recorder — records an Online-Mind2Web trajectory for ONE task run:
// the ordered page actions (Grammar A strings + SUCCESS/FAILED from the real
// tool results) and an after-action screenshot per step.
//
// Flow: the eval runner feeds it turn/tool-use (name+input, keyed by toolUseId)
// and turn/tool-result (ok/error per toolUseId). A tool call only becomes a
// STEP when (a) it maps to a page action (om2w-actions.js — reads/delegation/
// compute don't) and (b) its result arrives — at which point the page state is
// post-action, so THAT is when the screenshot is taken (matching the reference
// submissions' after-action semantics; step 0 is the harness's own initial
// navigation, captured in begin()). A serial queue keeps captures ordered even
// when results interleave. At maxSteps (the paper's 25-step convention) it
// calls stop() — the run-rule enforcement, not a suggestion.
//
// IO is INJECTED (capture/tabInfo/stop) so ordering + capping are bun-testable;
// the runner wires the real chrome.tabs capture.

import { pageActionFor, pageActionForOp, formatAction, initialNavigation } from './om2w-actions.js';

/**
 * @param {Object} deps
 * @param {() => Promise<string>} deps.capture   screenshot the agent's current tab → dataURL
 * @param {() => Promise<string | null>} deps.tabInfo  the agent tab's current URL
 * @param {() => void} deps.stop                 halt the agent (25-step cap)
 * @param {number} [deps.maxSteps]
 */
export const makeOm2wRecorder = ({ capture, tabInfo, stop, maxSteps = 25 }) => {
  /** @type {Map<string, { name: string, input: Record<string, any> }>} */
  let pending = new Map();
  /** @type {Array<{ action: string, url: string | null, status: 'SUCCESS' | 'FAILED' | null }>} */
  let actions = [];
  /** @type {string[]} */
  let shots = [];
  let stopped = false;
  let active = false;
  /** @type {Promise<void>} */
  let queue = Promise.resolve();

  // Serialize async work so steps land in result-arrival order.
  /** @param {() => Promise<void>} job */
  const enqueue = (job) => { queue = queue.then(job).catch(() => {}); return queue; };

  // Capture, but NEVER let a screenshot failure drop the action — a missing
  // action breaks the whole trajectory (steps must be contiguous), whereas a
  // missing/blank screenshot is a soft loss. On failure push a sentinel; the
  // exporter writes a 1x1 placeholder so step N still has a file.
  const captureOrBlank = async () => { try { return await capture(); } catch { return ''; } };

  return {
    /** Reset + record step 0 (the harness's initial navigation). @param {string | null} startUrl */
    begin(startUrl) {
      pending = new Map(); actions = []; shots = []; stopped = false; active = true;
      queue = Promise.resolve();
      if (!startUrl) return Promise.resolve();
      return enqueue(async () => {
        shots.push(await captureOrBlank());
        actions.push({ action: initialNavigation(startUrl), url: startUrl, status: null });
      });
    },

    /** @param {{ toolUseId?: string, name?: string, input?: Record<string, any> }} msg */
    onToolUse(msg) {
      if (!active || !msg?.toolUseId || typeof msg.name !== 'string') return;
      pending.set(msg.toolUseId, { name: msg.name, input: msg.input ?? {} });
    },

    /** @param {{ toolUseId?: string, result?: { ok?: boolean } }} msg */
    onToolResult(msg) {
      if (!active || !msg?.toolUseId) return;
      const call = pending.get(msg.toolUseId);
      if (!call) return;
      pending.delete(msg.toolUseId);
      const mapped = pageActionFor(call.name, call.input);
      if (!mapped || stopped) return;
      const status = msg.result?.ok === true ? 'SUCCESS' : (msg.result?.ok === false ? 'FAILED' : null);
      enqueue(async () => {
        if (stopped) return;
        shots.push(await captureOrBlank());
        actions.push({ action: formatAction(mapped, status), url: await tabInfo().catch(() => null), status });
        // The 25-step convention is enforced, not advisory: past the cap the
        // trajectory would not be comparable, so halt the agent.
        if (actions.length >= maxSteps && !stopped) { stopped = true; stop(); }
      });
    },

    /**
     * A settled page.* op from the CODE surface, reported as a 'page/op'
     * event. The op arrives WITH its outcome, so
     * it becomes a step immediately (the page state is already post-action);
     * no pending map. Same cap enforcement as the tool path, so the two arms
     * run the same 25-step budget.
     * @param {{ method?: string, args?: Record<string, any>, ok?: boolean }} msg
     */
    onPageOp(msg) {
      if (!active || typeof msg?.method !== 'string') return;
      const mapped = pageActionForOp(msg.method, msg.args ?? {});
      if (!mapped || stopped) return;
      const status = msg.ok === true ? 'SUCCESS' : (msg.ok === false ? 'FAILED' : null);
      enqueue(async () => {
        if (stopped) return;
        shots.push(await captureOrBlank());
        actions.push({ action: formatAction(mapped, status), url: await tabInfo().catch(() => null), status });
        if (actions.length >= maxSteps && !stopped) { stopped = true; stop(); }
      });
    },

    /**
     * A settled ACTOR tool execution (the exact authority relay's 'actor/op'
     * broadcast — the OFFSCREEN actor heap's analog of turn/tool-use +
     * turn/tool-result, which only in-SW turns emit). Single-phase like
     * onPageOp; the TOOL mapper decides page action vs read/compute.
     * @param {{ name?: string, args?: Record<string, any>, ok?: boolean }} msg
     */
    onActorOp(msg) {
      if (!active || typeof msg?.name !== 'string') return;
      const mapped = pageActionFor(msg.name, msg.args ?? {});
      if (!mapped || stopped) return;
      const status = msg.ok === true ? 'SUCCESS' : (msg.ok === false ? 'FAILED' : null);
      enqueue(async () => {
        if (stopped) return;
        shots.push(await captureOrBlank());
        actions.push({ action: formatAction(mapped, status), url: await tabInfo().catch(() => null), status });
        if (actions.length >= maxSteps && !stopped) { stopped = true; stop(); }
      });
    },

    /** Final capture (the TASK_COMPLETE step's screenshot) + drain the queue. */
    async finish() {
      await enqueue(async () => { shots.push(await captureOrBlank()); });
      active = false;
      // shots.length === actions.length + 1 (one per action + the final state).
      return { actions, shots, capped: stopped };
    },
  };
};
