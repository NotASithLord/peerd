// @ts-check
// Ralph backpressure gates — the pluggable quality bar each iteration
// must clear BEFORE its work is committed.
//
// This is peerd's KEY DIFFERENTIATOR over terminal Ralph. Terminal Ralph
// gates an iteration on lint/test/build. peerd ALSO gates on LIVE browser
// signals — DOM inspection, a console-clean check, network calls — run
// IN-PROCESS through peerd's own tab/WebVM tools, NOT an external browser
// MCP (NO MCP is a hard constraint).
//
// A "gate" is just `{ name, kind, run(ctx) -> {pass, detail} }`. The
// runner executes them in order and SHORT-CIRCUITS on the first failure
// (fail fast — no point running the browser gate if lint is already red).
// Gates are PURE plumbing over injected IO: a WebVM shell runner
// (`vmExec`) and a browser inspector (`inspect`). Both are DI seams so
// the loop is testable with mocked gates.
//
// kind ∈ 'webvm' | 'browser' — purely informational, lets the UI badge
// which gates are terminal-style vs browser-native.

/**
 * @typedef {Object} GateResult
 * @property {boolean} pass
 * @property {string} name
 * @property {'webvm'|'browser'} kind
 * @property {string} [detail]   human-readable failure reason / output tail
 * @property {number} durationMs
 */

/**
 * @typedef {Object} Gate
 * @property {string} name
 * @property {'webvm'|'browser'} kind
 * @property {(ctx: GateContext) => Promise<{pass:boolean, detail?:string}>} run
 */

/**
 * @typedef {Object} GateContext  IO injected into every gate
 * @property {(cmd: string) => Promise<{ exitCode:number, stdout:string, stderr:string }>} [vmExec]
 *   Run a shell command in the WebVM (the build/test/lint shell). The
 *   ADAPTER for feature 02/WebVM. Optional so browser-only plans work.
 * @property {(req: { tabId?: number }) => Promise<{ consoleErrors: string[], dom: string, url?: string }>} [inspect]
 *   Browser-native inspection: read the page's console error buffer + a
 *   DOM snapshot. ADAPTER over peerd's read_page / inspect_* tools. The
 *   loop binds this to the live agent tab.
 * @property {() => number} [now]
 *   Injected clock for gate-duration timing (the loop passes `now`); falls
 *   back to Date.now when absent.
 */

// ── WebVM (terminal-style) gate factories ────────────────────────────

/**
 * A shell-command gate: passes iff the command exits 0. Used for
 * lint / typecheck / test / build. The command runs in the WebVM via
 * the injected `vmExec`.
 *
 * @param {{ name:string, cmd:string }} spec
 * @returns {Gate}
 */
const shellGate = ({ name, cmd }) => ({
  name,
  kind: 'webvm',
  run: async ({ vmExec }) => {
    if (typeof vmExec !== 'function') {
      // why: a WebVM gate with no shell wired is a CONFIG error, not a
      // silent pass — failing closed keeps the bar honest.
      return { pass: false, detail: `gate "${name}" needs a WebVM shell but none was provided` };
    }
    const { exitCode, stdout, stderr } = await vmExec(cmd);
    if (exitCode === 0) return { pass: true };
    const tail = (stderr || stdout || '').split('\n').slice(-12).join('\n');
    return { pass: false, detail: `\`${cmd}\` exited ${exitCode}\n${tail}` };
  },
});

export const lintGate = (cmd = 'npm run lint') => shellGate({ name: 'lint', cmd });
const typecheckGate = (cmd = 'npm run typecheck') => shellGate({ name: 'typecheck', cmd });
export const testGate = (cmd = 'npm test') => shellGate({ name: 'test', cmd });
export const buildGate = (cmd = 'npm run build') => shellGate({ name: 'build', cmd });

// ── Browser-native gate factories (THE differentiator) ───────────────

/**
 * Console-clean gate: passes iff the live page logged no console errors
 * during the iteration. This is the canonical browser-native gate — it
 * catches runtime breakage a terminal build never sees (uncaught
 * exceptions, failed fetches, React error boundaries firing).
 *
 * @returns {Gate}
 */
export const consoleCleanGate = () => ({
  name: 'console-clean',
  kind: 'browser',
  run: async ({ inspect }) => {
    if (typeof inspect !== 'function') {
      return { pass: false, detail: 'console-clean gate needs a browser inspector but none was provided' };
    }
    const { consoleErrors = [] } = await inspect({});
    if (consoleErrors.length === 0) return { pass: true };
    return {
      pass: false,
      detail: `${consoleErrors.length} console error(s):\n${consoleErrors.slice(0, 5).join('\n')}`,
    };
  },
});

/**
 * DOM-contains gate: passes iff the live DOM snapshot contains an
 * expected substring (e.g. a node/text the task was supposed to add).
 * A cheap visual-acceptance check without screenshots.
 *
 * @param {string} expected
 * @returns {Gate}
 */
export const domContainsGate = (expected) => ({
  name: `dom-contains:${expected.slice(0, 24)}`,
  kind: 'browser',
  run: async ({ inspect }) => {
    if (typeof inspect !== 'function') {
      return { pass: false, detail: 'dom-contains gate needs a browser inspector but none was provided' };
    }
    const { dom = '' } = await inspect({});
    if (dom.includes(expected)) return { pass: true };
    return { pass: false, detail: `expected DOM to contain "${expected}" but it did not` };
  },
});

// ── The runner ───────────────────────────────────────────────────────

/**
 * Build a gate runner from an ordered gate list. The returned `run(ctx)`
 * executes gates in order, short-circuiting on the first failure, and
 * returns `{ pass, results }`. `pass` is true iff EVERY gate passed (an
 * empty gate list passes vacuously — useful for planning mode, which has
 * nothing to verify).
 *
 * This is the `gates.run() -> pass/fail` interface the loop depends on
 * (the ADAPTER seam for feature 10 hooks: a hook system can supply
 * additional gates by appending to this list).
 *
 * @param {ReadonlyArray<Gate>} gates
 */
export const createGateRunner = (gates = []) => {
  /**
   * @param {GateContext} ctx
   * @returns {Promise<{ pass: boolean, results: GateResult[] }>}
   */
  const run = async (ctx) => {
    /** @type {GateResult[]} */
    const results = [];
    for (const gate of gates) {
      const start = ctx.now?.() ?? Date.now();
      let outcome;
      try {
        outcome = await gate.run(ctx);
      } catch (e) {
        // A gate that THROWS is a failure, not a crash of the loop.
        outcome = { pass: false, detail: `gate threw: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
      }
      const durationMs = (ctx.now?.() ?? Date.now()) - start;
      results.push({ name: gate.name, kind: gate.kind, pass: !!outcome.pass, detail: outcome.detail, durationMs });
      if (!outcome.pass) return { pass: false, results }; // fail fast
    }
    return { pass: true, results };
  };
  return Object.freeze({ run, gates });
};
