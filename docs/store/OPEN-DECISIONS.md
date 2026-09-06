# Store decisions

This file records the current store posture. Packaging code and CI are the
authority for shipped behavior.

## Current decisions

### Advanced automation

The initial Chrome store package omits the `debugger` permission. Store Chrome
and Firefox use the scripting-based page path. Preview and development Chrome
builds may include the debugger-based path. The browser and channel transforms
live in `packaging/gen-manifest.ts` and are checked by the store posture tests.

Chrome does not allow `debugger` as an optional permission. Adding it to a
future store update requires a separate review decision.

### Remote skill installation

Remote skill installation is not a product surface. Local pasted skill text is
supported; there are no remote-install routes or URL controls.

### Remote JavaScript imports

Store and web builds refuse direct HTTP and HTTPS JavaScript imports without
requesting the module source. Preview keeps the audited import path. Tests and
both Store artifact checks verify the generated policy and resolver behavior.

This decision closes the direct URL import path only. The broader Store policy
for code that a run fetches as data, saves locally, or passes to a JavaScript or
WebAssembly execution API is tracked separately.

### Dweb

The store package omits `peerd-distributed`. The preview package includes it.
Packaging and boundary checks verify that store artifacts contain no dweb code.

### Anti-bot behavior

The non-evasion posture is fixed. peerd does not use fingerprint spoofing,
proxies, challenge solvers, or similar bypasses. Adaptive per-origin pacing is
designed in issue #234 but is not wired into the extension. Challenge handoff
and assist-only behavior still need implementation and field testing. See
[`ANTI-BOT-POSTURE.md`](ANTI-BOT-POSTURE.md).

## Submission checks

Before a store submission:

- confirm the current package contents with the packaging and verification commands
- resolve the open isolated execution policy for fetched data
- review `PERMISSION-JUSTIFICATIONS.md`, `PRIVACY.md`, and `REVIEWER-NOTES.md`
- replace any submission placeholders, including the reviewer demo URL
- verify the public privacy policy URL in the store dashboards
