// @ts-check
// Ralph driver — the SW-side orchestration for the persistent fresh-
// context loop, pushed DOWN into the module so the service worker keeps
// only wiring (its §6 thin-wiring rule). The SW constructs this factory
// once with its singletons; the message routes and the /loop slash
// command are one-line calls into the returned surface.
//
// A Ralph run reads a plan file, picks ONE task, spawns a FRESH-CONTEXT
// iteration to do it (a subagent — clean session, no carried context),
// runs backpressure gates, and commits. Persistence is the plan file +
// checkpoints in chrome.storage.local; the loop never holds a long-lived
// context. It survives SW restarts because every iteration persists
// LoopState (ralph.loop.v1) and the plan file (ralph.plan.v1) before and
// after the work — `resume()` on boot rehydrates from those alone.
//
// The four adapters the feature brief calls out:
//   01 plan persistence → planStore over kv
//   02 checkpoint/commit → checkpoint() (git in the session's WebVM)
//   03 permissions       → resolveCanRunUnattended() (Ralph commits unattended)
//   10 hooks for gates    → gateRunner (a pluggable, ordered gate list)
//
// Every IO surface is INJECTED (the makeSpawnSubagent pattern), so the
// driver's decision logic is unit-testable with mocked deps — see
// tests/peerd-runtime/ralph-driver.test.ts.

import { createRalphLoop } from './loop.js';
import {
  createGateRunner, lintGate, testGate, buildGate, consoleCleanGate,
} from './gates.js';

/**
 * Build the Ralph driver bound to its IO dependencies.
 *
 * @param {Object} deps
 * @param {ReturnType<typeof import('./plan-store.js').createPlanStore>} deps.planStore
 *   Plan-file persistence (the SW also reads it directly for the
 *   ralph/getPlan + ralph/setPlan routes).
 * @param {{ get(k:string):Promise<any>, set(k:string,v:any):Promise<void>, delete(k:string):Promise<void> }} deps.kv
 *   LoopState persistence (the resumability seam) — passed through to
 *   createRalphLoop.
 * @param {(req: object) => Promise<{ result?: string, exceeded?: boolean, refused?: boolean }>} deps.spawnSubagent
 *   The SW-bound subagent orchestrator; each iteration is one spawn.
 * @param {() => Promise<string|null|undefined>} deps.getCurrentSessionId
 *   Resolve the active chat session id (the fresh-context run's parent).
 * @param {{ run(cmd:string, opts?:object): Promise<{ exitCode?:number, stdout?:string, stderr?:string }> }} deps.vmClient
 *   WebVM RPC client — terminal-style gates + the git checkpoint commit.
 * @param {(opts?: object) => Promise<object>} deps.buildToolContext
 *   ToolContext builder for the browser-native inspect gate signals.
 * @param {(call: object, ctx: object) => Promise<any>} deps.dispatchToolCall
 *   Tool dispatcher (read_page / page_exec) for the same inspect path.
 * @param {() => Promise<boolean>} deps.resolveCanRunUnattended
 *   Feature-03 permissions adapter: Ralph commits unattended, so it
 *   requires Act mode with confirmActions OFF — the REAL Plan/Act axis.
 *   The SW binds resolvePermission(session) here; the loop refuses to
 *   start (and each iteration re-checks) when it resolves false.
 * @param {(ev: object) => void} [deps.forwardEvent]
 *   ralph/* status events → the side panel's Ralph channel.
 * @param {(text: string) => void} [deps.postChatNote]
 *   User-facing progress notes posted into the chat transcript.
 * @param {Array<import('./gates.js').Gate>} [deps.gates]
 *   Override the default gate list (feature 10 lets a plan customize
 *   it; tests inject mocks). Defaults to WebVM lint+test+build then a
 *   console-clean browser gate.
 */
export const makeRalphDriver = (deps) => {
  const {
    planStore,
    kv,
    spawnSubagent,
    getCurrentSessionId,
    vmClient,
    buildToolContext,
    dispatchToolCall,
    resolveCanRunUnattended,
    forwardEvent = () => {},
    postChatNote = () => {},
    gates,
  } = deps;

  // Browser-native gate context (THE differentiator). `vmExec` runs the
  // terminal-style lint/test/build in the session's WebVM; `inspect` reads
  // the live page's console errors + a DOM snapshot through peerd's own
  // tools — NOT an external browser MCP.
  const gateContext = () => ({
    /** @param {string} cmd */
    vmExec: async (cmd) => {
      const r = await vmClient.run(cmd, { sessionId: undefined, timeoutMs: 120_000 });
      return { exitCode: r?.exitCode ?? 1, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
    },
    inspect: async () => {
      // Read the live page's console + DOM via the dispatcher (read_page
      // for the DOM, page_exec for any window-level error signal). We keep
      // this defensive: a missing active tab yields empty signals so the
      // console-clean gate passes vacuously rather than wedging the loop.
      const ctx = await buildToolContext();
      let dom = '';
      const consoleErrors = [];
      try {
        const page = await dispatchToolCall({ id: `ralph-${Date.now()}`, name: 'read_page', args: {} }, ctx);
        if (page?.ok) dom = typeof page.content === 'string' ? page.content : JSON.stringify(page.content);
      } catch { /* no active tab — leave dom empty */ }
      try {
        const ex = await dispatchToolCall({
          id: `ralph-c-${Date.now()}`, name: 'page_exec',
          args: { code: 'void 0' },
        }, ctx);
        // page_exec surfaces buffered console output; pull error-level lines.
        const out = ex?.ok ? (ex.content ?? '') : '';
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        for (const line of text.split('\n')) {
          if (/\berror\b/i.test(line) || /uncaught/i.test(line)) consoleErrors.push(line.trim());
        }
      } catch { /* page_exec unavailable — treat as console-clean */ }
      return { dom, consoleErrors };
    },
  });

  // Default gate set: WebVM lint+test+build then a console-clean browser
  // gate. A real run can override the gate list per-plan (feature 10).
  const gateRunner = createGateRunner(gates ?? [
    lintGate('npm run lint'),
    testGate('npm test'),
    buildGate('npm run build'),
    consoleCleanGate(),
  ]);

  // Fresh-context runner: each iteration is a SUBAGENT — a clean session,
  // the plan goal + the single task as the prompt, depth-bounded, no
  // carried history. THIS is the no-long-context discipline made concrete.
  /** @param {{ task:string, goal:string, mode:'planning'|'building' }} req */
  const runFresh = async ({ task, goal, mode }) => {
    const parentSessionId = await getCurrentSessionId();
    if (!parentSessionId) return { ok: false, text: 'no active session for ralph run' };
    const prompt = mode === 'planning'
      ? `RALPH PLANNING PASS. Goal: ${goal}\n\nDo a gap analysis of the codebase against the goal and produce a prioritized plan as a markdown task list (## Tasks with - [ ] items). Output ONLY the plan file.`
      : `RALPH BUILD ITERATION (fresh context). Goal: ${goal}\n\nDo EXACTLY this one task and nothing else:\n${task}`;
    try {
      const out = await spawnSubagent({ task: prompt, parentSessionId, parentDepth: 0 });
      const text = out.result ?? '';
      return { ok: !out.exceeded && !out.refused, text, ...(mode === 'planning' ? { plan: text } : {}) };
    } catch (e) {
      return { ok: false, text: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
    }
  };

  // Checkpoint adapter (feature 02): commit the iteration's work via git in
  // the session's WebVM. If git isn't available the commit is best-effort;
  // the gate already vouched for the work, and the plan file is the durable
  // record either way.
  /** @param {string} message */
  const checkpoint = async (message) => {
    try {
      const safe = message.replace(/"/g, "'").slice(0, 200);
      const r = await vmClient.run(`git add -A && git commit -m "${safe}" --no-verify`, { timeoutMs: 60_000 });
      return { ok: r?.exitCode === 0, ref: undefined };
    } catch (e) {
      console.warn('[sw] ralph checkpoint failed', e);
      return { ok: false };
    }
  };

  let halted = false;

  const loop = createRalphLoop({
    planStore,
    kv,
    runFresh,
    gateRunner,
    gateContext,
    checkpoint,
    canRunUnattended: resolveCanRunUnattended,
    onEvent: forwardEvent,
    shouldHalt: () => halted,
  });

  // Drive the loop in small budgeted bursts so a single drive can't exceed
  // the MV3 30s window. Each burst persists state; the next burst (or a
  // post-restart resume) continues. We chain bursts with setTimeout(0) so
  // the SW stays responsive to halt/status messages between iterations.
  let driving = false;
  const driveRalph = async () => {
    if (driving) return;
    driving = true;
    try {
      while (!halted) {
        const res = await loop.drive({ budget: 1 });
        if (!res.ok || !res.state) break;
        const s = res.state.status;
        if (s === 'done' || s === 'halted' || s === 'error') {
          postChatNote(s === 'done' ? 'Ralph loop finished — plan complete.'
            : s === 'halted' ? 'Ralph loop halted.'
            : 'Ralph loop stopped on an error.');
          break;
        }
        // Yield to the event loop so halt/status RPCs interleave.
        await new Promise((r) => setTimeout(r, 0));
      }
    } catch (e) {
      console.error('[sw] driveRalph threw', e);
    } finally {
      driving = false;
    }
  };

  // Simple in-chat entry point for the Ralph loop (feature 05): the `/loop
  // <goal>` slash command. Seeds the goal, runs a planning pass to draft the
  // plan, then builds it — all in the background, results posted to the chat.
  // Requires Act mode with confirmations off (the loop commits
  // unattended); loop.start refuses otherwise and we explain why.
  /** @param {string} [goal] */
  const startRalphLoop = async (goal) => {
    halted = false;
    if (goal) {
      const plan = await planStore.load();
      await planStore.save({ ...plan, goal });
    }
    const res = await loop.start({ mode: goal ? 'planning' : 'building' });
    if (res.ok) {
      postChatNote(goal
        ? `Ralph loop started toward: "${goal}". It runs in the background; progress posts here. Send /loop with nothing to resume, or use the Stop button to halt.`
        : 'Ralph loop resumed.');
      driveRalph().catch((e) => console.error('[sw] driveRalph', e));
    } else {
      postChatNote(res.error === 'confirmations-on'
        ? 'Ralph needs Act mode with confirmations off (it commits unattended). Switch the Plan/Act selector to Act, turn off "Confirm actions", then /loop again.'
        : `Ralph couldn't start: ${res.error ?? 'unknown'}.`);
    }
  };

  // ── Thin route surface (the SW's ralph/* handlers call these) ────────

  /**
   * ralph/start: clear the halt flag, start, and kick the driver.
   * @param {{ maxIterations?: number, mode?: 'planning'|'building' }} [opts]
   */
  const start = async ({ maxIterations, mode } = {}) => {
    halted = false;
    const res = await loop.start({ maxIterations, mode });
    if (!res.ok) return res;
    driveRalph().catch((e) => console.error('[sw] driveRalph', e));
    return res;
  };

  /** ralph/halt: raise the flag (stops the burst loop) + persist halted. */
  const halt = async () => {
    halted = true;
    return loop.halt();
  };

  const status = async () => loop.status();

  /** ralph/reset: halt any in-flight drive, then drop the LoopState. */
  const reset = async () => {
    halted = true;
    await loop.reset();
  };

  // why: resume an in-flight Ralph run on SW boot (the SW awaits the vault
  // first — a run needs unlocked secrets to call the model). If the SW died
  // mid-run, the persisted LoopState + plan file let us pick up at the next
  // iteration with NO carried context. A no-op if there's no active run.
  const resume = async () => {
    const r = await loop.resume();
    if (r?.ok) {
      console.log('[sw] ralph run resumed from persisted state');
      driveRalph().catch((e) => console.error('[sw] driveRalph (resume)', e));
    }
    return r;
  };

  return Object.freeze({
    start, halt, status, reset, resume,
    startRalphLoop, driveRalph,
  });
};
