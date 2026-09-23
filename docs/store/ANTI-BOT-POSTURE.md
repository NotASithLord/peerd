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

Per-origin action pacing is enforced. Issue #234 is the design record.

When a site answers an error status that states a wait, or refuses a request as
too frequent, peerd records the pause against that exact canonical origin and
honors it before acting there again. The recorded deadline is absolute, so it
survives a browser restart. peerd also learns a slower steady cadence for browser
write actions on that site. A wait longer than peerd will hold inside a turn ends
the turn instead, with a fixed message naming the site.

The rule is control-plane state. Only the egress choke point, holding a real HTTP
response, can create or raise one. Page text, tool results, and model
instructions cannot create, raise, lower, or clear one. A rule fades on its own
after the site stops refusing, and a person can forget one from Settings ->
Paced sites.

What peerd can honestly learn from is narrower than it may sound, and the limit
is a browser one: only requests peerd itself makes through its own network path
expose a status code and a Retry-After header. A page navigation does not, so a
challenge page that peerd only navigates to is not a pacing signal on any
package. Requests a page makes for itself, including anything an action causes,
are the page's own and are never metered.

Other open product work includes visible challenge detection and user handoff,
assist-only behavior on guarded sites, preference for official APIs, and clear
per-site automation posture. None of those are shipped.

The issue is the live design record. The code and packaging tests are the source
of truth for shipped behavior.
