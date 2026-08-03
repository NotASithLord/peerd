# Design 7 — iteration-loop polish: four small fixes with outsized ergonomics

Independent one-PR-each fixes, ordered by value. None changes architecture;
all four sharpen the edit→run→read→fix loop the code superpower lives on.

## 7.1 Split stderr in `vm_boot`

**Today**: the PTY merges streams; `stderr` in the result is hardcoded `''`
(`engine-tabs/vm-tab/vm-tab.js` `runViaShell`) while the tool renders an
`[STDERR]` section that is therefore always empty — actively misleading for
an agent debugging a failing command.

**Fix**, in the wrapped-command template (`runViaShell`): redirect fd 2 to a
temp file inside the VM, then emit it between two more markers after the
exit-code marker:

```
{ <cmd>; } 2>"$__peerd_err"; ec=$?
printf '\n%s:%s\n' '<marker>' "$ec"
printf '%s\n' '<marker>-err'; cat "$__peerd_err"; printf '\n%s\n' '<marker>-end'
```

`$__peerd_err` is minted per-call under `/tmp` and removed after cat. The
marker scanner (`emitStripped`) grows the second section; the result's
`stderr` becomes real. Terminal display is unchanged (the PTY still shows
both streams live — the redirect applies to the wrapped run's capture,
which xterm never depended on). Edge case to test: commands that spawn
backgrounded children keeping fd 2 open — `cat` of the file after the
foreground exit reads what was flushed, which is the honest best effort.

Interactive/TTY-detecting programs will see fd 2 as a file for the wrapped
command; acceptable for an agent-driven shell, and `2>&1` inside the user's
own `cmd` still works (their redirect wins on the inner scope).

## 7.2 Wire or delete the dead VM streaming plumbing

**Today**: `activeRunToolUseId` / `activeRunSessionId` are set per run and
never read — plumbing for streaming chunks to chat that was never finished.

**Call**: do NOT stream into the model turn (a tool result is atomic; the
model can't consume mid-call). Two honest options:

- **(a) delete** the two fields and the comment — the visible xterm tab
  already IS the live view; or
- **(b) UI tail**: broadcast a throttled `vm/output-chunk` port event
  (mirroring the `page/op` broadcast shape in the SW) so the side panel's
  activity line can show the last output line under the running tool call —
  "what is it doing in there" without a tab switch.

Proposed: (b) — it matches the shipped "show which tab peerd is driving"
direction (PR #259) and the plumbing is half-built; but (a) is a fine
outcome if (b)'s throttling/redaction questions (VM output is
untrusted-adjacent bytes rendered in the panel — render as text, never
markdown/html) feel heavier than the value. Decide in the PR, don't leave
the dead fields a third option.

## 7.3 Headless `peerd.distributed.*` must fail fast

**Today**: the tab host handles `distributed-request`; the headless runner
has no handler, so a `script` run touching `peerd.distributed.whoami()`
hangs to its bridge timeout — a silent multi-second stall for a one-word
answer.

**Fix**: in `offscreen/job-runner.js`, either add a refusal responder for
`distributed-request` ("distributed is not available in headless runs — use
a Notebook"), or (better, matching the double-wall convention) pass a
`distributed:false` marker in the worker params so the in-realm surface
throws synchronously, AND add the host refusal as the backstop. Both walls,
per the shared invariants; ~15 lines total.

(If the dweb actor's lanes later want headless `distributed` reads, that is
a deliberate caps flag at that point — today nothing legitimate hits this
path headless.)

## 7.4 `script` joins `SHELL_TOOLS`

**Today**: `permissions/policy.js` classifies `vm_boot`, `js_notebook`,
`page_exec`, `page_eval` as SHELL ("code execution"), but `script` — code
execution WITH egress and delegation on the main agent — classifies as a
workspace write via its `notebook` primitive. The most powerful code lane
has the softest confirm class; that's an inconsistency waiting to be quoted
back at us in a store review.

**Fix**: add `'script'` to `SHELL_TOOLS` with the same one-line why-comment
style the set already uses. Check the e2e states and default policy matrix
for confirm-flow fallout (a Plan-mode block is already correct; the change
is the Act-mode classification). `page_code` stays out: its every effect
crosses the gated DOM tools it maps onto, which carry their own classes —
classifying the wrapper as shell would double-prompt.

Also fold in (same PR, same file region): `site_client_run` stays
`sideEffect:'read'` deliberately — document the why at the SHELL_TOOLS set
("runs code, but capability-stripped to an origin-pinned fetch whose writes
confirm at the route") so the next reader doesn't "fix" it.

## Touch points / tests

| Fix | Files | Tests |
|---|---|---|
| 7.1 | `engine-tabs/vm-tab/vm-tab.js` (template + scanner) | in-browser: marker parse with stderr section, empty-stderr case, `2>&1` user override; e2e smoke unaffected |
| 7.2 | `vm-tab.js`, SW broadcast, side panel activity component (if (b)) | (b): in-browser component test + verify-loop screenshot state |
| 7.3 | `offscreen/job-runner.js`, `worker-source.js` (params marker) | in-browser: headless `whoami()` rejects immediately |
| 7.4 | `peerd-runtime/permissions/policy.js` | Bun: classification table test update |
