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

The store package keeps remote skill installation disabled. Local skill text is
supported. The live feature gate and service-worker checks are the authority.

### Remote JavaScript imports

The current Script and Notebook resolver can fetch HTTPS JavaScript and execute
it in a sealed worker. The store package does not disable that path. Store
submission is blocked until packaging removes or disables remote imports, or a
documented Chrome Web Store decision accepts and accurately discloses the
isolated-worker behavior.

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
- resolve the remote JavaScript import blocker and verify the uploaded artifact
- review `PERMISSION-JUSTIFICATIONS.md`, `PRIVACY.md`, and `REVIEWER-NOTES.md`
- replace any submission placeholders, including the reviewer demo URL
- verify the public privacy policy URL in the store dashboards
