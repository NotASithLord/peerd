// @ts-check
// Tool → retry class. The lifecycle contract's §16.1 obligation — "every
// side-effecting tool has a retry classification" — realized as ONE pure
// function over a tool DESCRIPTOR.
//
// why a descriptor and not the tool objects themselves: importing
// BUILTIN_TOOLS here would drag every def's chrome.* / engine-client import
// graph into a module that must stay pure, IO-free and browser-free
// (functional core, imperative shell). The classifier reads only
// { name, sideEffect, primitive, retryClass } — the shape every tool already
// declares in /shared/tool-types.js — so the dispatcher can classify a
// controller tool and a Bun test can classify the entire live inventory
// without a browser.
//
// The decision order, and why it is that order:
//   1. an explicit, VALID `tool.retryClass`. A def may state its own class.
//      An INVALID one is IGNORED and falls through to derivation — silently
//      accepting garbage that looked authoritative is the worst outcome
//      available here, because it would license a replay nobody sanctioned.
//   2. `destructive` → Class E, unconditionally. The one declaration no name
//      override may soften: an irreversible delete is never auto-repeated.
//   3. the by-NAME override table below — the knowledge the (sideEffect,
//      primitive) pair structurally cannot carry: a `read` that costs a
//      network round trip, a "workspace write" whose payload is arbitrary
//      code, a call that BOOTS something outliving it.
//   4. the declared taxonomy, failing CLOSED. Anything the rules do not
//      positively recognize as safe is Class E — the same posture
//      normalizeRetryClass takes for a missing class, for the same reason:
//      guessing "safe to retry" is the unsafe-replay failure the contract
//      forbids.

import { RETRY_CLASSES, isRetryClass } from './retry-class.js';

/** @typedef {import('./retry-class.js').RetryClass} RetryClass */

/**
 * The classifier's whole input surface — a structural subset of
 * /shared/tool-types.js `Tool`, plus the optional self-declaration.
 *
 * @typedef {Object} ToolDescriptor
 * @property {string} [name]
 * @property {string} [sideEffect]   'read' | 'write' | 'mutate_external' | 'destructive'
 * @property {string} [primitive]    tab | web | webvm | notebook | app | engine | dweb | …
 * @property {unknown} [retryClass]  an explicit declaration; validated, never trusted
 */

// Primitives whose WRITES land in the agent's own sandbox (WebVM disk,
// Notebook OPFS, App bodies, the cross-kind engine create) or the dweb node's
// own local state — not on the user's live web session.
//
// why the set is duplicated instead of imported: this is the same taxonomy
// permissions/policy.js draws for WORKSPACE_PRIMITIVES (that one is
// module-private there), and the two answer different questions from it —
// policy asks "must the user confirm", this asks "is a repeat harmless". They
// are deliberately read twice from one shared vocabulary; if the list moves,
// both sites move together.
const WORKSPACE_PRIMITIVES = Object.freeze(
  new Set(['webvm', 'notebook', 'pod', 'app', 'engine', 'dweb']),
);

/**
 * The explicit by-name inventory. Everything here is a case the declared
 * (sideEffect, primitive) pair gets WRONG — kept in one frozen table so the
 * exceptions are countable and reviewable rather than scattered through
 * branches.
 *
 * @type {Readonly<Record<string, RetryClass>>}
 */
export const RETRY_CLASS_OVERRIDES = Object.freeze(
  /** @type {Record<string, RetryClass>} */ ({
    // --- Class B · repeatable reads that COST something outside peerd -------
    // why: a `read` that crosses the network still has no observable effect on
    // the far side, so repeating it is safe — but a repeat spends bandwidth, a
    // rate-limit budget, and possibly a credential that has since expired.
    // That is exactly what Class B's "new attempt + fresh credentials (+
    // budget)" preconditions exist for. A LOCAL read (inspect, a page already
    // in the tab, a cache, a stored record) has none of that cost and stays A.
    fetch_url: 'B',
    read_doc: 'B',
    // why: site_client_run reads at the tool boundary but EXECUTES the stored
    // client, whose every op is an origin-pinned fetch — requests on the wire,
    // carried by the user's live session.
    site_client_run: 'B',
    // why: dweb_discover queries peers and the DHT over the mesh. Nothing is
    // published, but the round trip is remote work on other people's nodes.
    dweb_discover: 'B',

    // --- Class D · conditionally idempotent external mutations --------------
    // why: dweb_share publishes a CONTENT-ADDRESSED signed bundle, so
    // republishing the same app converges on the same hash/URI instead of
    // duplicating it — the repeat is safe ONCE the external state is checked
    // (did the announce/DHT store actually land?). "Verify, then reuse the
    // original key" is Class D precisely; it is not the blind-safe Class C.
    dweb_share: 'D',

    // --- Class E · declared writes that are NOT idempotent ------------------
    // why: js_notebook and script sit on workspace primitives, so the taxonomy
    // below would call them local Class C writes — but their payload is
    // ARBITRARY CODE (permissions/policy.js draws the same line with
    // SHELL_TOOLS). A half-run eval may already have written files or made a
    // request, and `script` additionally holds egress and delegation. Silently
    // re-running one is the textbook unsafe replay.
    js_notebook: 'E',
    pod_exec: 'E',
    script: 'E',
    // app_code can compose several game actions in one run. A timeout may have
    // applied an earlier action, so replaying the body is never automatically safe.
    app_code: 'E',
    // A single custom App action may mutate an arbitrary game state and has no
    // host idempotency key. Lost acknowledgement is therefore outcome-unknown.
    app_act: 'E',
    // why: a2a_run's `dweb` primitive reads as workspace-local, but the mesh
    // bridge SENDS signed messages to other agents — the effect lands in a
    // peer's inbox, on another machine, and a duplicate cannot be recalled.
    a2a_run: 'E',

    // --- Class F · long-lived resources: recreate, never continue -----------
    // why: each of these BOOTS or CREATES something that outlives the call — a
    // sandbox, a Linux VM, a child agent session. After an interruption the
    // handle is dangling and its grants are stale, so the contract's answer is
    // to recreate from durable records with grants re-derived. Auto-retrying
    // them as ordinary writes would instead mint a SECOND orphan.
    sandbox_create: 'F',
    vm_boot: 'F',
    actor_create: 'F',
  }),
);

/**
 * Classify a tool for recovery. Pure: same descriptor in, same class out; no
 * IO, no clock, no registry lookup.
 *
 * @param {ToolDescriptor | null | undefined} tool
 * @returns {RetryClass}
 */
export const retryClassForTool = (tool) => {
  // 1. A def's own declaration wins — but only when it is a real class.
  // An invalid one falls through to derivation rather than being coerced,
  // so a typo degrades to the honest taxonomy instead of to a lie.
  const declared = tool?.retryClass;
  if (isRetryClass(declared)) return declared;

  const sideEffect = tool?.sideEffect;

  // 2. Irreversible by declaration. No name override, no primitive, and no
  // convenience softens a delete: unproven completion must land in
  // outcome_unknown, never in an automatic second attempt.
  if (sideEffect === 'destructive') return RETRY_CLASSES.SIDE_EFFECT;

  // 3. The explicit inventory — what the declaration cannot express.
  const name = tool?.name;
  if (typeof name === 'string' && Object.hasOwn(RETRY_CLASS_OVERRIDES, name)) {
    return RETRY_CLASS_OVERRIDES[name];
  }

  // 4. Derivation from the declared taxonomy.

  // A read the table did not name touches nothing outside peerd: an
  // introspection call, a page already loaded in a tab it owns, a cache, a
  // stored record. Duplicates are invisible.
  if (sideEffect === 'read') return RETRY_CLASSES.PURE_READ;

  if (sideEffect === 'write') {
    // A write to the agent's OWN sandbox is deterministic and re-appliable:
    // same path, same bytes, same resulting state, so a retry under the
    // ORIGINAL idempotency key converges (Class C). A write to a `tab` is
    // not — a click on a live page is a click, twice clicked is twice, and
    // the page has moved on underneath the selector. Every other primitive
    // (web / spawned / memory / schedule / time) is unproven in either
    // direction, so it fails closed alongside `tab`.
    return WORKSPACE_PRIMITIVES.has(tool?.primitive ?? '')
      ? RETRY_CLASSES.IDEMPOTENT_WRITE
      : RETRY_CLASSES.SIDE_EFFECT;
  }

  // `mutate_external` (form submits, downloads, cross-origin writes, tab
  // opens, installs) and anything unrecognized land here. Class E is the
  // floor of the whole function: an unclassified action is a non-idempotent
  // side effect until someone proves otherwise, in this table, by name.
  return RETRY_CLASSES.SIDE_EFFECT;
};
