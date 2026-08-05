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

### Dweb

The store package omits `peerd-distributed`. The preview package includes it.
Packaging and boundary checks verify that store artifacts contain no dweb code.

### Anti-bot behavior

Challenge handling and site automation limits remain open product questions.
See [`ANTI-BOT-POSTURE.md`](ANTI-BOT-POSTURE.md). peerd does not use fingerprint
spoofing, proxies, CAPTCHA solvers, or other challenge bypasses.

## Submission checks

Before a store submission:

- confirm the current package contents with the packaging and verification commands
- review `PERMISSION-JUSTIFICATIONS.md`, `PRIVACY.md`, and `REVIEWER-NOTES.md`
- replace any submission placeholders, including the reviewer demo URL
- verify the public privacy policy URL in the store dashboards
