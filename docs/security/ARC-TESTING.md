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

Known limitation: the raw numeric-tab actor path can bind after a redirect
without applying the normal sensitivity classification. Issue #263 tracks this
authority bypass. Do not treat the checks above as coverage for that path.

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
| Use a direct fetch or document-reading tool on localhost, a private network address, or cloud metadata. | The request is refused before network access. Browser navigation is a separate path and does not currently carry this private-network guard. |
| Follow a redirect from an allowed request to a blocked destination. | The redirect is refused. |

The exfiltration heuristic is intentionally narrow. Query strings and URL
fragments have legitimate uses and are not a complete data-loss prevention
boundary. See the residual risks in the threat model.

## Login

| Check | Expected result |
|---|---|
| Ask the web actor to start a supported sign-in flow. | peerd verifies the live origin and affordance, then asks for confirmation. |
| Present an ambiguous or unsupported login control. | peerd hands the step back to the user. |
| Complete a passkey, SSO, or password step. | The user and browser handle the factor. The actor does not read or store it. |

## Recovery and Stop

| Check | Expected result |
|---|---|
| Stop during a browser action or delegated turn. | Delayed work does not execute after Stop. |
| Close or navigate the owned tab during a wait. | The pending action fails instead of moving to the new page. |
| Restart the service worker during a task. | Recovery reports what resumed, stopped, or may need verification. It does not silently repeat an uncertain write. |

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

## Evidence

For every refusal, inspect Activity and the relevant session. Trusted terminal
messages should name only the origin needed for recovery and must not include
page-authored instructions.
