# Browser security hand test

This guide covers the visible browser security boundary. The threat model and
automated suites contain the full contract.

Run these checks with a disposable profile and accounts you control. Do not use
production credentials or third-party data.

## Setup

1. Run the current development or preview package.
2. Unlock the vault and configure a test model.
3. Keep Settings and Activity available so you can inspect learned sites and
   audit events.
4. Use the same browser package for the full pass. Repeat browser-specific
   checks on Firefox.

## Origin ownership

| Check | Expected result |
|---|---|
| Ask the roaming web actor to read an ordinary public page. | It may open and read the page. |
| Ask it to drive a tab on a site peerd knows is tied to your account. | It stops and points to the site-bound actor. |
| Redirect a roaming actor from an ordinary site to an account site. | The landed origin is checked and the actor stops. |
| Ask a bound actor to leave its origin. | It stops. |
| Move an actor-owned tab to another origin by hand, then continue the task. | The actor rechecks the live tab before acting. |
| Fetch public content from an account site without a tab session. | The request remains sessionless. It may return public content. |

Address a tab by numeric id after moving it to a private, metadata, or
denylisted page. Actor resolution must refuse it. Numeric addressing applies
the same live target policy as every browser tool.

## Learned sites

| Check | Expected result |
|---|---|
| Have an actor inspect a sign-in page with a password field. | The origin appears in Settings under learned sites. |
| Approve an authenticated write on a new origin. | The origin is learned. |
| Forget one learned origin in Settings. | Only that learned record is removed. Curated and credential-bound rules still apply. |

## Page content and writes

| Check | Expected result |
|---|---|
| Read a page containing zero-width text, bidi controls, Unicode tag characters, or HTML comments. | Hidden control text does not reach the model. Ordinary Persian, Urdu, and Indic text remains readable. |
| Write to user-generated content, such as an issue or shared document. | Each authenticated write asks for confirmation even when ordinary write confirmations are disabled. |
| Read the same user-generated page or navigate away. | The extra write confirmation does not apply. |

## Egress

| Check | Expected result |
|---|---|
| Navigate or fetch a cross-origin URL with a long encoded blob in the host, credentials, or path. | Supported paths refuse the request and record the denial. |
| Use a fetch, document-reading, or browser tool on localhost, a private network address, or cloud metadata. | The operation is refused. Driven tabs also carry a tab-scoped network rule that blocks redirects and tab-associated requests before they reach the target. |
| From a service worker controlled by an actor-owned public page, fetch a private target. | The request does not reach the target. The no-tab rule is limited to private targets and public domains visited by the driven tab. Chrome and Firefox prove reachability before custody, blocking during custody, another origin remaining reachable, and reachability after custody closes. |
| From that service worker, open a WebSocket to a private target. | Firefox blocks it. Chrome DNR does not intercept worker-created WebSockets. The Chrome test proves the bypass remains visible, including against an unscoped diagnostic rule, so it cannot be mistaken for covered behavior. |
| Follow a redirect from an allowed request or navigation to a blocked destination. | The destination is refused. Browser automation stops and the tab is reset when the browser can verify the reset. |
| From an actor-owned test page, open a child that navigates, fetches, or opens a WebSocket toward a private or denylisted target. | The protected request does not reach the target. Firefox synchronously stops the exact child's request until its tab-scoped rules are installed. A subrequest observed by that temporary stop produces a URL-free tool and Activity receipt. If DNR wins first, the block is silent. |
| From the same test page, open a child toward a public target. | Only that child receives the driven-tab network floor, then the public navigation continues. |
| Open a child from an ordinary user tab while no actor owns it. | peerd does not blank, close, focus, or guard the child. |

The exfiltration heuristic is intentionally narrow. Query strings and URL
fragments have legitimate uses and are not a complete data-loss prevention
boundary. See the residual risks in the threat model.

Private-network classification is lexical. It covers direct hostnames and IP
spellings but does not resolve DNS. DNS rebinding remains outside this client-side
check.

Child handling is exact-tab scoped. Firefox uses a synchronous request stop for
a browser-identified child of a live driven source while its durable rule is
installed, then releases that temporary stop. If source custody restores before
the denylist, that exact child waits for policy hydration instead of treating an
empty list as permission. On a cold service-worker start, peerd acts early only
when the exact source has restored custody and its complete browser rule set
survives.
Otherwise it waits for the ownership registries. This avoids changing user
popups, but it cannot guarantee that a first child request is stopped if the
browser discarded the session rules during the restart.

The no-tab service-worker rule is domain-scoped because the browser does not
attribute these requests to a source tab. DNR domain matching ignores scheme and
port and can include subdomains. A user-owned tab on the same matching domain can
therefore lose private-network worker access while peerd drives that domain.
Verify that peerd does not prompt, unregister the worker, or affect domains
outside that DNR match.
Visited domains survive extension service-worker restarts and remain covered
until the owning tab's custody closes.
Also keep Chrome worker WebSockets, Chrome's immediate inherited-child request
race when native local-network checks are disabled, the page-initiated
cross-origin redirect race, and DNS rebinding listed as residual boundaries.

## Login

| Check | Expected result |
|---|---|
| Ask the web actor to start a supported sign-in flow. | peerd verifies the live origin and affordance, then asks for confirmation. |
| Present an ambiguous or unsupported login control. | peerd hands the step back to the user. |
| Complete a passkey, SSO, or password step. | The user and browser handle the factor. The actor does not read or store it. |
| Confirm verified SSO, then visit the exact verified identity provider. | The one-shot grant is consumed. The actor waits without tool or credential authority until the tab returns to exact home. |
| Confirm passkey or unverified SSO, then visit an identity provider. | No provider grant exists. The actor stops at the identity provider. |
| During SSO, visit a wrong provider or third origin, replay authorization, restore legacy state, or let authorization expire. | The actor stops and the state grants no authority. |

## Contributor Metrics

Run these checks only in preview or dev. Store and web packages must not expose the
surface.

| Check | Expected result |
|---|---|
| Open Contributor Metrics on a fresh profile. | It is disabled, has no pending payload, and states that peerd works fully without it. |
| Enable it from Settings, complete a web-actor task, then reopen Settings. | The exact canonical payload bytes are shown locally. They contain only the disclosed aggregate fields. |
| Inspect browser network activity while enabling, recording, previewing, and voting. | No Contributor Metrics request, endpoint, alarm, or upload exists. |
| Use the worked or didn’t-work control on a final answer. | The control is a named binary group, creates no chat message, and contributes only while consent is current. |
| Disable and clear, then reopen Settings. | Consent, pending rows, local dedupe tokens, and feedback are gone. |
| Force an enable or disable storage timeout, make the opposite choice, then release the old write and restart the background. | The later acknowledged choice remains authoritative; stale writes and cleanup stay inert. |
| Attempt consent or feedback from an engine tab or other extension surface. | The background refuses the sender before any contribution mutation. |

## Recovery and Stop

| Check | Expected result |
|---|---|
| Stop during a browser action or delegated turn. | Delayed work does not execute after Stop. |
| Close or navigate the owned tab during a wait. | The pending action fails instead of moving to the new page. |
| Restart the service worker during a task. | Recovery reports what resumed, stopped, or may need verification. It does not silently repeat an uncertain write. |
| Remove several running engine host tabs while the service worker is unavailable, then restart it. | Each loss is audited. The owning chat receives one passive, session-scoped report that names the resources, says what was stored, and says which runtime state was lost. Other chats receive nothing. |

## Firefox

Firefox hosts the actor runner from its extension background page instead of an
offscreen document. Verify an `actor_ran_isolated` audit entry records the
background-page worker host, a dedicated worker, a successful realm proof, and
no extension APIs in the worker. Break the worker import in a test package and
verify actor work is marked Not run, no target action runs, and Retry is shown.
Reload the background and verify the failure remains stored until a manual probe
succeeds. Close every extension UI during a delayed actor turn and verify an
acknowledged product `storage.session` heartbeat runs after the normal
event-page idle window while the isolated turn is still active. The test must
not create a separate storage listener or extension view that could keep the
page alive. Physically
close the extension UI and keep a plain page focused through the parent
continuation. The heartbeat, actor request, and final result must keep one
background boot identity, and the
actor request must complete exactly once. Force a failure after a successful actor tool call and
verify the parent model and UI report Outcome unknown, pause actor work, and do
not retry automatically. Simulate a second background loss during recovery and verify no
queued, started, or legacy request is executed from storage. Keep the recovery
record until its Not run or Outcome unknown warning is accepted by the session.
The packaged Firefox CI lane also proves browser-tool fallbacks and the
tab-scoped private-network rules. It uses the pinned current release. ESR is
not a separate support lane.

## Evidence

For every refusal, inspect Activity and the relevant session. Trusted terminal
messages should name only the origin needed for recovery and must not include
page-authored instructions.
