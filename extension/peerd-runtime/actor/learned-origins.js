// @ts-check
// peerd-runtime/actor — the origins peerd LEARNED the user has an account on.
// (issue #251, the half that grows with use.)
//
// The two seeds next door (a curated UGC zone, a stored vault credential) will
// never be a complete list of where someone is signed in, and a classifier that
// fails open is only as good as its inputs. This is the input that improves on
// its own, from data ordinary use already produces.
//
// THE TWO SIGNALS, and why these and not the obvious one:
//
//   password-field   A password input was on a page the actor walked. Nothing
//                    else on the web says "this site has accounts" as plainly,
//                    and the DOM walk already visits every element — so this
//                    costs one boolean, not a new observation.
//   confirmed-write  The user approved a `web:write` to this origin. They
//                    affirmed acting there under their own name; we are only
//                    remembering that they did.
//
// The obvious signal — "does this origin have cookies" — needs the `cookies`
// permission, which is a broad ask on a store-reviewed extension and the same
// reasoning that kept `webNavigation` out. Both signals here are byproducts of
// data we already hold.
//
// WHAT LEARNING CAN AND CANNOT DO HERE. No AUTOMATIC path in this file makes an
// origin ordinary again, and that asymmetry is deliberate: a false positive
// costs a handoff, a false negative costs a roaming actor loose on a site the
// user is logged into. That is why the cap refuses to learn rather than evicting
// (see `note`), and why nothing decays.
//
// `forget`/`clear` are the ONE exception, and only because the caller is the
// user, not a heuristic. The whole store is a guess AT a fact the user knows for
// certain — whether they have an account somewhere — so a person saying "not
// this one" is better evidence than the password field we inferred it from, and
// refusing to accept it does not make anyone safer: it just leaves a wrong guess
// permanent and invisible. What must never call these is anything acting on
// page-derived input; the SW exposes them on the settings routes only, which the
// agent and its actors cannot reach.
//
// PURE-ISH: an in-memory Map is the read path (the classifier's check is
// synchronous), durable storage is injected and write-only-behind. Nothing here
// imports IO.

/** @typedef {import('./origin-sensitivity.js').SensitivityReason} SensitivityReason */

/** The reasons this store may record. Mirrors LEARNED_REASONS next door. */
const ALLOWED = new Set(['password-field', 'confirmed-write']);

/**
 * How many origins we are willing to remember.
 *
 * why a cap at all: this grows from browsing, so it grows without bound over a
 * long-lived profile, and it lives in memory on a service worker that is
 * supposed to stay small. why it is generous: evicting an entry silently
 * DOWNGRADES an origin to ordinary, which is the one direction this file is
 * otherwise incapable of moving in — so the cap must be high enough that
 * reaching it is a genuine outlier rather than a Tuesday.
 */
export const MAX_LEARNED = 500;

/**
 * @param {object} deps
 * @param {() => Promise<Record<string, string> | null | undefined>} deps.load
 * @param {(all: Record<string, string>) => Promise<void>} deps.save
 * @param {(origin: string, reason: SensitivityReason) => void} [deps.onLearn]
 *   fired the first time an origin is learned — the SW turns this into an audit
 *   entry, so a user can see WHY a site started being treated as theirs.
 * @param {(origins: string[]) => void} [deps.onForget]
 *   fired when the USER un-learns origins. Audited for the same reason as
 *   onLearn, and louder: this one removes a protection.
 * @param {(message: string, error: unknown) => void} [deps.onError]
 */
export const makeLearnedOrigins = ({ load, save, onLearn, onForget, onError }) => {
  /** @type {Map<string, SensitivityReason>} */
  const learned = new Map();
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  let ready = false;
  let loadFailed = false;
  /** Did a signal land while the boot read was still in flight? */
  let pendingDuringHydrate = false;
  /**
   * Origins the USER un-learned before the boot read landed.
   *
   * why tombstones: `hydrate` MERGES (it must — see there), so without this a
   * forget that raced the boot read would be silently undone by the very next
   * line of storage, and the user would watch a row they deleted come back.
   * Consulted only while !ready, then dropped.
   * @type {Set<string>}
   */
  const tombstones = new Set();
  /** Same race, for `clear`: the boot read must bring back NOTHING, not just the rows we had seen. */
  let clearedDuringHydrate = false;

  const report = (/** @type {string} */ m, /** @type {unknown} */ e) => {
    if (onError) onError(m, e);
    else console.warn('[learned-origins]', m, e);
  };

  /**
   * Load the durable set once. Called at boot; a failure leaves the set EMPTY,
   * which means "nothing learned yet" — the fail-open direction the classifier
   * already documents, and the only honest answer when we cannot read our notes.
   */
  /** The single in-flight boot read, so concurrent callers share it. @type {Promise<void> | null} */
  let hydrating = null;
  const runHydrate = async () => {
    let all = null;
    try {
      all = await load();
    } catch (e) {
      loadFailed = true;
      report('load failed — starting with nothing learned', e);
    }
    // MERGE, never replace, and mark ready only after. A signal can land while
    // this read is in flight — the boot read is async and the very first page
    // walk is not — and an earlier draft let that happen in the worst possible
    // way: `note()` would fire, save a snapshot of a nearly-empty Map, and the
    // durable set the read was about to deliver would be gone. Setting only the
    // keys we do not already hold keeps the live observation (which is fresher)
    // and restores everything else.
    // `clearedDuringHydrate` / `tombstones`: a user un-learn that raced this read
    // wins over what the read brings back. Anything else would resurrect a row
    // the user just deleted.
    for (const [origin, reason] of Object.entries(clearedDuringHydrate ? {} : (all ?? {}))) {
      if (ALLOWED.has(reason) && !learned.has(origin) && !tombstones.has(origin)) {
        learned.set(origin, /** @type {SensitivityReason} */ (reason));
      }
    }
    ready = true;
    tombstones.clear();
    clearedDuringHydrate = false;
    // If anything was noted DURING the load, its snapshot was written without
    // the restored entries. Re-save once so the durable copy matches the merged
    // set rather than the racing writer's partial view.
    if (pendingDuringHydrate) {
      pendingDuringHydrate = false;
      const snapshot = Object.fromEntries(learned);
      chain = chain
        .then(() => save(snapshot))
        .catch((e) => report('post-hydrate save failed', e));
    }
  };

  /**
   * Idempotent AND awaitable. The SW kicks this at boot without awaiting (the
   * classifier's read path is synchronous and fails open, so learning must not
   * wait on IO) — but a caller that needs the REAL set, rather than "whatever has
   * loaded so far", has to be able to wait for it. The settings routes do: on a
   * cold service worker the boot read has not resolved when the first message
   * arrives, and an un-awaited `clear()` there reported success while forgetting
   * nothing, because the map it measured was empty. Memoized rather than
   * re-entrant so a second caller joins the in-flight read instead of starting a
   * competing one.
   * @returns {Promise<void>}
   */
  const hydrate = () => {
    if (ready) return Promise.resolve();
    if (!hydrating) hydrating = runHydrate();
    return hydrating;
  };

  /**
   * Write the current set through, behind the same serialized chain every
   * mutation shares. A snapshot is taken SYNCHRONOUSLY (before the await) so two
   * mutations in the same tick cannot save each other's half-state.
   * @param {string[]} [removed] origins this write un-learned, for the tombstones
   *   + the audit hook. Empty for `note`.
   */
  const persist = (removed = []) => {
    if (!ready) {
      pendingDuringHydrate = true;
      for (const origin of removed) tombstones.add(origin);
    }
    const snapshot = Object.fromEntries(learned);
    chain = chain
      .then(() => save(snapshot))
      .catch((e) => report('save failed — this change is heap-only until the next write', e));
  };

  /**
   * Record a signal. Idempotent, and FIRST WRITER WINS.
   *
   * why the first reason sticks rather than the newest: the reason is shown to
   * the user to explain why a site is treated as theirs, and the first
   * observation is the one that actually changed the classification. Overwriting
   * it with whatever happened most recently would make the explanation drift
   * away from the decision it explains.
   *
   * @param {string | null | undefined} origin  MUST be canonical (URL.origin) —
   *   the caller normalizes, because the classifier looks up by the same
   *   normalizer and a mismatch here is a silent miss rather than an error.
   * @param {SensitivityReason} reason
   * @returns {boolean} whether this call learned something new
   */
  const note = (origin, reason) => {
    if (!origin || typeof origin !== 'string') return false;
    if (!ALLOWED.has(reason)) return false;
    if (learned.has(origin)) return false;
    // At the cap we STOP LEARNING rather than evict. Evicting would silently
    // downgrade an origin this file had already decided was the user's — the one
    // move it must never make. Refusing to learn keeps the failure on the
    // fail-open side the classifier already accounts for, and it is visible in
    // the log rather than invisible in a Map.
    if (learned.size >= MAX_LEARNED) {
      report(`at the ${MAX_LEARNED}-origin cap — not learning ${origin}`, null);
      return false;
    }
    learned.set(origin, reason);
    try { onLearn?.(origin, reason); } catch { /* best-effort */ }
    persist();
    return true;
  };

  /**
   * The SYNCHRONOUS read the classifier takes as `deps.learned`. Returns the
   * live Map — the classifier only ever reads it, and copying on every DOM tool
   * call would cost more than the whole check.
   * @returns {ReadonlyMap<string, SensitivityReason>}
   */
  const snapshot = () => learned;

  /**
   * A serializable copy, sorted by origin — what the settings list renders.
   * why a copy and not `snapshot()`: this one crosses a message boundary, and
   * handing the live Map to a caller that might hold it would let a UI bug
   * mutate the classifier's own state.
   * @returns {Array<{ origin: string, reason: SensitivityReason }>}
   */
  const entries = () => [...learned.entries()]
    .map(([origin, reason]) => ({ origin, reason }))
    .sort((a, b) => a.origin.localeCompare(b.origin));

  /**
   * USER-INITIATED un-learn of one origin. See the header for why this exists
   * when eviction deliberately does not.
   * @param {string | null | undefined} origin canonical (URL.origin), as `note`
   * @returns {boolean} whether anything was forgotten
   */
  const forget = (origin) => {
    if (!origin || typeof origin !== 'string') return false;
    if (!learned.delete(origin)) return false;
    try { onForget?.([origin]); } catch { /* best-effort */ }
    persist([origin]);
    return true;
  };

  /**
   * USER-INITIATED un-learn of everything. why offer it at all: the list is
   * unreadable in bulk once it is long, and "start over" is the only honest
   * remedy for a profile whose marks the user no longer trusts. Re-learning
   * begins immediately from ordinary use, so this loses no capability.
   * @returns {number} how many origins were forgotten
   */
  const clear = () => {
    // BEFORE the empty check, not after. Pre-hydrate the map can be empty while
    // storage holds rows, so an early return here would leave nothing suppressed
    // and the boot read would restore everything the user just cleared. Callers
    // that need an accurate COUNT await hydrate() first (the settings routes do);
    // this branch is the belt to that braces, and it still empties storage.
    if (!ready) {
      clearedDuringHydrate = true;
      if (learned.size === 0) { persist([]); return 0; }
    }
    if (learned.size === 0) return 0;
    const forgotten = [...learned.keys()];
    learned.clear();
    try { onForget?.(forgotten); } catch { /* best-effort */ }
    persist(forgotten);
    return forgotten.length;
  };

  /** Test/settings seam. */
  const size = () => learned.size;
  const settled = () => chain.then(() => undefined, () => undefined);
  // Authority-minting callers need to distinguish an authoritative empty set
  // from a storage failure. Ordinary roaming classification keeps its
  // documented fail-open behavior and does not consult this status.
  const hydrationStatus = () => Object.freeze({ ready, ok: ready && !loadFailed });

  return Object.freeze({ hydrate, hydrationStatus, note, snapshot, entries, forget, clear, size, settled });
};
