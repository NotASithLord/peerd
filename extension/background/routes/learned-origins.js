// @ts-check
// background/routes/learned-origins.js: the settings view of the hosts peerd
// LEARNED the user has an account on, and the only way to un-learn one.
//
// why these routes exist: the learned set silently decides which sites a roaming
// helper is refused on, and until now it had no reader and no eraser — a wrong
// guess (a signup modal's password field, a shared machine) was permanent and
// invisible for the life of the profile. That is the one failure mode the store's
// deliberate never-forget asymmetry does NOT excuse, because the user knows the
// fact the store is guessing at.
//
// Reachable from the SETTINGS surface only. The tool dispatcher has no path to
// routes, so neither the agent nor a page-fed actor can call these — which is
// what makes accepting a removal safe at all (see learned-origins.js's header).
// Imports nothing; the store + audit ride deps like every other route module.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeLearnedOriginRoutes = (deps) => {
  // No auditLog here on purpose: the STORE's onForget hook owns the audit, one
  // entry per origin, mirroring onLearn. Appending here too would double-record
  // every removal and leave a bulk clear counted twice.
  const { learnedOrigins, normalizeApiOrigin } = deps;

  const snapshot = () => ({ ok: true, origins: learnedOrigins.entries() });

  // EVERY handler waits for the durable set before touching it.
  //
  // why (this was a real bug): the SW kicks learnedOrigins.hydrate() at boot
  // WITHOUT awaiting, and a settings message is exactly what wakes a cold worker
  // — Chrome delivers it right after top-level evaluation, before an async
  // storage read can resolve. Pre-hydrate the map is empty, so `list` rendered
  // "Nothing learned yet." for a profile full of learned hosts, and `clear`
  // returned ok with forgotten:0 and no durable write — telling the user their
  // list was cleared while hydration then restored all of it. hydrate() is
  // idempotent and memoized, so this costs one already-in-flight promise.
  const ready = () => learnedOrigins.hydrate();

  return {
    'learned/list': async () => { await ready(); return snapshot(); },

    // Un-learn ONE host. Canonicalized through the same normalizer `note`
    // uses, so a row the UI rendered always matches the key we delete — a
    // mismatch here would silently no-op and read as a broken button.
    'learned/forget': async ({ host, origin }) => {
      // `origin` remains accepted for an already-open Settings page from the
      // previous extension version. Both spellings collapse to the same host.
      const canonical = normalizeApiOrigin(host ?? origin);
      if (!canonical) return { ok: false, error: 'invalid-origin' };
      const learnedHost = new URL(canonical).hostname;
      await ready();
      const forgotten = learnedOrigins.forget(learnedHost);
      if (!forgotten) return { ok: false, error: 'not-learned' };
      // Await the durable write before replying: the caller re-renders from this
      // reply, so returning early would show a row gone that a mid-flight SW
      // eviction could still bring back.
      await learnedOrigins.settled();
      return snapshot();
    },

    // Un-learn EVERYTHING. Returns the count so the UI can say what it did
    // rather than just showing an empty list, which reads the same as "nothing
    // was ever learned".
    'learned/clear': async () => {
      await ready();
      const count = learnedOrigins.clear();
      await learnedOrigins.settled();
      return { ...snapshot(), forgotten: count };
    },
  };
};
