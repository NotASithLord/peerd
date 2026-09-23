// @ts-check
// background/routes/paced-origins.js: the settings view of the sites peerd is
// pacing itself on, and the only way to forget one.
//
// why these routes exist: a pacing rule silently makes peerd slower on a site,
// and a rule learned from a one-off outage would otherwise sit there taxing
// every future turn with no reader and no eraser. Time decay eventually clears
// it, but "eventually" is not an answer for someone watching a turn crawl.
//
// Reachable from the SETTINGS surface only. The tool dispatcher has no path to
// routes, so neither the agent nor a page-fed actor can call these - which is
// the whole reason accepting a removal is safe. Forgetting a rule makes peerd
// act FASTER on a site that already asked it to slow down, so it is exactly the
// lever an injected page would want, and exactly the one a person is entitled
// to. Who is asking is the only thing that separates them.
//
// Imports nothing; the store rides deps like every other route module.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makePacedOriginRoutes = (deps) => {
  // No auditLog here on purpose: the STORE's onAudit hook owns the entries, so
  // appending here too would double-record every removal and count a bulk
  // forget twice.
  const { originPacing, normalizeApiOrigin } = deps;

  // EVERY handler waits for the durable set first. A settings message is what
  // wakes a cold worker, and a pre-hydrate read would report an empty list for a
  // profile that has rules - then a "forget all" would return ok having written
  // nothing, while hydration restored every rule a moment later.
  const ready = () => originPacing.hydrate();

  const snapshot = async () => ({
    ok: true,
    origins: await originPacing.list(),
    // The list is only trustworthy once the durable read succeeded. Saying so
    // lets the page explain a fail-closed turn instead of showing an empty list
    // that reads as "nothing is being paced".
    state: originPacing.hydrationStatus(),
  });

  return {
    'paced/list': async () => { await ready(); return snapshot(); },

    // Forget ONE origin. Canonicalized through the same normalizer the store
    // keys on, so a row the UI rendered always matches the key deleted - a
    // mismatch would silently no-op and read as a broken button.
    'paced/forget': async ({ origin }) => {
      const canonical = normalizeApiOrigin(origin);
      if (!canonical) return { ok: false, error: 'invalid-origin' };
      await ready();
      const result = await originPacing.forget(canonical);
      if (!result.forgot) return { ok: false, error: 'not-paced' };
      return snapshot();
    },

    // Forget EVERYTHING. Also the recovery path for an unreadable record:
    // writing a fresh empty state is what lets browser writes stop failing
    // closed, so the count can legitimately be 0 and still have done something.
    'paced/clear': async () => {
      await ready();
      const result = await originPacing.forgetAll();
      return { ...(await snapshot()), forgotten: result.forgot };
    },
  };
};
