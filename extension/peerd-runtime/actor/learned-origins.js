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
// WHAT LEARNING CAN AND CANNOT DO HERE. It can only ever mark an origin as MORE
// protected. There is no path in this file that makes an origin ordinary, and
// that asymmetry is deliberate: a false positive costs a handoff, a false
// negative costs a roaming actor loose on a site the user is logged into. The
// same asymmetry is why nothing here forgets — see `note` for the one real cost
// of that, stated rather than buried.
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
 * @param {(message: string, error: unknown) => void} [deps.onError]
 */
export const makeLearnedOrigins = ({ load, save, onLearn, onError }) => {
  /** @type {Map<string, SensitivityReason>} */
  const learned = new Map();
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  let ready = false;
  /** Did a signal land while the boot read was still in flight? */
  let pendingDuringHydrate = false;

  const report = (/** @type {string} */ m, /** @type {unknown} */ e) => {
    if (onError) onError(m, e);
    else console.warn('[learned-origins]', m, e);
  };

  /**
   * Load the durable set once. Called at boot; a failure leaves the set EMPTY,
   * which means "nothing learned yet" — the fail-open direction the classifier
   * already documents, and the only honest answer when we cannot read our notes.
   */
  const hydrate = async () => {
    if (ready) return;
    let all = null;
    try {
      all = await load();
    } catch (e) {
      report('load failed — starting with nothing learned', e);
    }
    // MERGE, never replace, and mark ready only after. A signal can land while
    // this read is in flight — the boot read is async and the very first page
    // walk is not — and an earlier draft let that happen in the worst possible
    // way: `note()` would fire, save a snapshot of a nearly-empty Map, and the
    // durable set the read was about to deliver would be gone. Setting only the
    // keys we do not already hold keeps the live observation (which is fresher)
    // and restores everything else.
    for (const [origin, reason] of Object.entries(all ?? {})) {
      if (ALLOWED.has(reason) && !learned.has(origin)) {
        learned.set(origin, /** @type {SensitivityReason} */ (reason));
      }
    }
    ready = true;
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
    if (!ready) pendingDuringHydrate = true;
    try { onLearn?.(origin, reason); } catch { /* best-effort */ }
    const snapshot = Object.fromEntries(learned);
    chain = chain
      .then(() => save(snapshot))
      .catch((e) => report('save failed — this origin is heap-only until the next write', e));
    return true;
  };

  /**
   * The SYNCHRONOUS read the classifier takes as `deps.learned`. Returns the
   * live Map — the classifier only ever reads it, and copying on every DOM tool
   * call would cost more than the whole check.
   * @returns {ReadonlyMap<string, SensitivityReason>}
   */
  const snapshot = () => learned;

  /** Test/settings seam. */
  const size = () => learned.size;
  const settled = () => chain.then(() => undefined, () => undefined);

  return Object.freeze({ hydrate, note, snapshot, size, settled });
};
