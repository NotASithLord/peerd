# Ralph — dev notes (feature 05)

Integrator-facing notes. Design rationale lives in `docs/RALPH.md`.

## Entry points

| Where | What |
|-------|------|
| `extension/peerd-runtime/ralph/loop.js` | `createRalphLoop(deps)` — the controller. Pure core: `decideNext`, `initLoopState`. |
| `extension/peerd-runtime/ralph/plan-store.js` | plan-file format (pure `parsePlan`/`serializePlan` + reducers) and `createPlanStore({ kv })`. |
| `extension/peerd-runtime/ralph/gates.js` | gate factories + `createGateRunner(gates)` (`gates.run() → {pass,results}`). |
| `extension/peerd-runtime/ralph/index.js` | module surface; re-exported from `peerd-runtime/index.js`. |
| `extension/peerd-runtime/ralph/driver.js` | `makeRalphDriver(deps)` — driver, adapters, and `driveRalph` (the guarded drive loop + boot resume). |
| `extension/background/routes/ralph.js` | `makeRalphRoutes(deps)` — the SW message routes. |
| `extension/background/service-worker.js` | SW wiring only: binds the IO singletons into `makeRalphDriver`/`makeRalphRoutes`. |
| `extension/sidepanel/components/ralph-panel.js` (+ `ralph-format.js`) | start/stop/status UI — `RalphPanel`, rendered inline within `chat-view.js`. |

## Storage keys

| Key | Backend | Holds |
|-----|---------|-------|
| `ralph.plan.v1`  | `chrome.storage.local` (kv) | the plan file (markdown text). The durable memory. |
| `ralph.loop.v1`  | `chrome.storage.local` (kv) | `LoopState` (cursor, not context). Rehydrated on SW cold start. |

Both survive SW restarts (local storage, not session). `ralph/reset`
deletes `ralph.loop.v1`; the plan file persists until overwritten.

## The gate-runner interface

```js
const gateRunner = createGateRunner([
  lintGate('npm run lint'),       // kind: 'webvm'  — needs ctx.vmExec
  testGate('npm test'),
  buildGate('npm run build'),
  consoleCleanGate(),             // kind: 'browser' — needs ctx.inspect
  domContainsGate('Saved'),       // kind: 'browser'
]);
const { pass, results } = await gateRunner.run(ctx);
// ctx: { vmExec(cmd)->{exitCode,stdout,stderr}, inspect()->{consoleErrors,dom}, now? }
```

Runs in order, short-circuits on first failure. A throwing gate is a
failure (caught). Empty list ⇒ vacuous pass. To add a custom gate
(feature-10 hooks), append any `{ name, kind, run(ctx) }` object.

## The adapters (01 / 02 / 03 / 10)

`createRalphLoop` takes these injected deps — swap the SW wiring for the
real feature implementations as they land:

```js
createRalphLoop({
  planStore,                 // 01: createPlanStore({ kv })
  kv,                        //     LoopState persistence
  runFresh,                  //     fresh-context iteration (subagent)
  gateRunner,                // 10: pluggable gates
  gateContext,               //     () => { vmExec, inspect } per iteration
  checkpoint,                // 02: (msg) => { ok, ref }  — git commit in WebVM
  canRunUnattended,          // 03: () => bool — refuse start unless Act + confirmActions OFF
  onEvent, shouldHalt, now, maxAttempts,
});
```

- **01** — `planStore` is the only plan persistence; if feature 01 ships
  a richer store, adapt it to `{ load, save, loadText, saveText, clear }`.
- **02** — `checkpoint` is best-effort `git add -A && git commit` in the
  session's WebVM (`vmClient.run`). Swap for feature-02's checkpoint
  store by returning `{ ok, ref }`. Called ONLY after gates pass.
- **03** — `resolveCanRunUnattended` is the SW adapter: it returns true
  only when the session is in Act mode with confirmActions OFF.
- **10** — `ralphGateRunner` is a fixed default list. A hook system can
  build the list per-plan; just pass a different `createGateRunner([...])`.

## SW message routes

| Route | Effect |
|-------|--------|
| `ralph/start {maxIterations?, mode?}` | refuse unless `canRunUnattended`; `start()` then `driveRalph()` |
| `ralph/halt` | set halt flag + persist `halted` |
| `ralph/status` | `{ state, plan, summary }` |
| `ralph/getPlan` / `ralph/setPlan {text}` | read/write the plan file (planning surface) |
| `ralph/reset` | clear `LoopState` |

Loop events are pushed to the side panel on the port with
`channel: 'ralph'` (folded into `state.ralph` in `sidepanel.js`).

## SW-restart resumability — how it's wired

- `driveRalph` runs `ralph.drive({ budget: 1 })` in a guarded loop,
  yielding between iterations so a single awake-window stays under 30 s.
- On SW boot, after `vault.attemptResume()`, the SW calls
  `ralph.resume()` — a no-op unless a non-terminal `LoopState` exists.
  If a run was in flight it continues with NO carried context.
- The offscreen keepalive port (already wired) keeps the SW alive across
  a long run; if it dies anyway, boot-resume picks the run back up.

## V1.x gaps / follow-ups

- **`checkpoint` ↔ feature 02**: today it's a raw git commit; wire to the
  real checkpoint/undo store so `/undo` can revert a Ralph iteration.
- **`isFullAuto` ↔ feature 03**: replace the session-mode proxy with the
  real permissions tier; consider a dedicated `ralph` trust scope.
- **`inspect` adapter**: console-error extraction is a heuristic over
  `page_exec` output. Once a structured console-buffer tool exists
  (read_console), point `inspect` at it for precise error counts.
- **Visual-regression gate**: `domContainsGate` is the cheap stand-in;
  an optional screenshot-diff gate (`kind: 'browser'`) is a natural add.
- **Planning quality**: the planning pass trusts the subagent's returned
  markdown verbatim. A schema-validation gate on the produced plan would
  harden it.
- **Concurrency**: single-writer is enforced by `[~]` + `driving`.
  Multi-plan / parallel-lane runs are explicitly out of scope (would
  break the single-threaded-writes constraint).

## Tests

`tests/peerd-runtime/ralph.test.ts` (Bun) — standalone, no browser, all
IO mocked. Covers: 3-task plan to completion; failing gate blocks commit
+ retries then blocks; failing fresh run blocks commit; SW-restart
rehydration (drive 1 iter → new controller → resume → finish); crashed
`[~]` re-done with fresh context; clean exhaustion; halt; full-auto
refusal; plus pure-core round-trip / single-writer / reducer checks.

Run: `bun test ./tests/peerd-runtime/ralph.test.ts` (or `bun test ./tests`).
