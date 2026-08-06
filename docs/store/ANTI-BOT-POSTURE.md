# Site automation limits

peerd does not try to hide automation or bypass site protections. It does not
use fingerprint spoofing, proxy rotation, challenge solvers, or synthetic
identity tricks.

## Current behavior

- The store package uses the scripting-based browser path.
- Preview Chrome packages may use the debugger-based path when advanced
  automation is enabled.
- Sensitive sites remain blocked by the denylist.
- peerd does not solve visible challenges. Automatic challenge detection and
  handoff are not implemented, so the user must take over manually.
- Site terms and user intent still limit whether a task should run.

## Adaptive pacing

Issue #234 records the chosen design for per-origin action pacing. The unwired
reducer and its tests do not affect a shipped package. No shipped package
currently learns or enforces pacing rules.

The usable feature still needs trusted signal detection, service-worker
persistence, one serialized lane per origin, complete write-path coverage,
Stop and liveness checks, terminal handoff behavior, user settings, and browser
tests.

Other open product work includes visible challenge detection and user handoff,
assist-only behavior on guarded sites, preference for official APIs, and clear
per-site automation posture. None of those are shipped.

The issue is the live design record. The code and packaging tests are the source
of truth for shipped behavior.
