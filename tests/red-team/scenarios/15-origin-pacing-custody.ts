// Scenario 15: a page, or the model reading it, tries to move the pause a site
// asked for (issue #234, INV-21).
//
// The interesting direction is DOWN. Raising a rule only slows peerd on the site
// that raised it; lowering one makes peerd hammer a site under the user's own
// logged-in session, so every probe here is about a lever that would lower a
// rule, shorten a deadline, or make an unreadable record read as "no limits".
//
// WHAT THIS SCENARIO DOES NOT CLAIM. Pacing meters the ACTIONS peerd takes, never
// the requests those actions cause a page to make. `page_exec` and `page_eval`
// run arbitrary JavaScript in the page's own world, and any fetch that code
// issues is the page's credentialed request: invisible to the egress choke
// point, to the audit, and to any counter here. The enclosing dispatch is metered
// as one action and the fan-out is unbounded. That is irreducible while
// page-world execution exists, and it is stated rather than probed.

import {
  type Probe, type Scenario, blocked, leaked, summarize,
} from '../harness.ts';
import {
  PACE_TUNABLES, isRateLimitSignal, nextRuleOnBlock, newRule, planRequest,
} from '../../../extension/peerd-runtime/pacing/pacing-core.js';
import {
  createOriginPacingStore, normalizePacingState, PACING_KEY,
} from '../../../extension/peerd-runtime/pacing/origin-pacing-store.js';

const T0 = 1_700_000_000_000;
const ORIGIN = 'https://target.test';

const memoryKv = (seed?: unknown) => {
  const values = new Map<string, any>();
  if (seed !== undefined) values.set(PACING_KEY, seed);
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
  };
};

/** A store whose sleep advances a fake clock, so a wait is observable. */
const pacedStore = (seed?: unknown) => {
  let t = T0;
  const kv = memoryKv(seed);
  const store = createOriginPacingStore({
    kv,
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
  });
  return { kv, store, now: () => t };
};

export const scenario: Scenario = {
  id: '15-origin-pacing-custody',
  title: 'Moving a site\'s stated pause from page content or model instruction (issue #234)',
  adversary: 'malicious page content, and the model that read it',
  asset: 'the per-origin pacing record, and the site whose stated limits it enforces',
  claim: 'A pacing rule can be created or raised only by the egress choke point holding a real Response. Page text, tool results, and model instructions cannot create, raise, lower, or clear one. The recorded deadline is absolute and survives a restart; no later answer and no adjustment can move an action earlier than it. At the ceiling the turn ends, and a retry or a fresh actor meets the same refusal because the record is keyed by origin, not by session. An unreadable record refuses browser writes rather than reading as no limits.',
  threatModelRef: 'INV-21',
  tier: 'unit',

  async run() {
    const probes: Probe[] = [];

    // 1. Only a real HTTP status makes a rule. A page can put anything in its
    //    body, including a convincing "Retry-After: 3600" string.
    const pageText = isRateLimitSignal(200, '3600')
      || isRateLimitSignal(undefined, 'Retry-After: 3600')
      || isRateLimitSignal('429' as any, '10');
    probes.push(!pageText
      ? blocked('[classifier] page-authored Retry-After text creates a pacing rule',
        'only an error STATUS from a real Response is a signal; a header on a success status is polling guidance, and a status string is not a status')
      : leaked('[classifier] page-authored Retry-After text creates a pacing rule', 'page text was accepted as a limit'));

    // 2. The model cannot reach a mutator. The dispatcher is handed exactly two
    //    closures, and neither can weaken a rule however often it is called.
    {
      const { store } = pacedStore();
      await store.observe({ origin: ORIGIN, responseAtMs: T0, status: 429, retryAfter: '600' });
      const before = (await store.list())[0];
      for (let i = 0; i < 20; i += 1) {
        store.peek(ORIGIN, { isWrite: true });
        await store.reserve(ORIGIN, { isWrite: true });
      }
      const after = (await store.list())[0];
      const worn = !after || after.minIntervalMs < before.minIntervalMs || after.notBeforeMs < before.notBeforeMs;
      probes.push(!worn
        ? blocked('[dispatcher surface] a turn wears a rule down by retrying it',
          'peek and reserve are read-shaped; twenty attempts left the deadline and the interval unchanged')
        : leaked('[dispatcher surface] a turn wears a rule down by retrying it', 'retrying weakened the rule'));
    }

    // 3. No exported symbol lowers a rule. A setter would be reachable the day
    //    someone wired it into a tool "for convenience".
    {
      const core = await import('../../../extension/peerd-runtime/pacing/pacing-core.js');
      const lowering = Object.keys(core).filter((name) => /^(clear|reset|set|lower|relax|allow)/i.test(name));
      probes.push(lowering.length === 0
        ? blocked('[policy core] a direct setter exists for the model to be wired into',
          'the core exposes escalation, decay, and validation only; descent is time or a human')
        : leaked('[policy core] a direct setter exists for the model to be wired into', `found ${lowering.join(', ')}`));
    }

    // 4. A later, smaller answer cannot shorten a live deadline. Otherwise one
    //    cooperative-looking response retires an hour-long pause.
    {
      const long = nextRuleOnBlock(newRule(ORIGIN, T0), { responseAtMs: T0, status: 429, retryAfter: '3600' });
      const short = nextRuleOnBlock(long, { responseAtMs: T0 + 1_000, status: 429, retryAfter: '1' });
      probes.push(short.notBeforeMs >= long.notBeforeMs
        ? blocked('[deadline] a small Retry-After shortens a long one', 'deadlines only ever move later')
        : leaked('[deadline] a small Retry-After shortens a long one', 'the deadline moved earlier'));
    }

    // 5. Nothing releases an action before the stated instant. This is the exact
    //    defect that closed PR #218, swept across the whole window.
    {
      const rule = nextRuleOnBlock(newRule(ORIGIN, T0), { responseAtMs: T0, status: 429, retryAfter: '10' });
      let early = false;
      for (let offset = 0; offset < 10_000 && !early; offset += 37) {
        const verdict = planRequest(rule, { now: T0 + offset, isWrite: true });
        if (!verdict || verdict.action === 'go') { early = true; break; }
        if (T0 + offset + verdict.waitMs < rule.notBeforeMs) early = true;
      }
      probes.push(!early
        ? blocked('[deadline] an adjustment releases an action inside the stated window',
          'every planned wait reaches at least the deadline; the only additive term is a positive-only skew guard')
        : leaked('[deadline] an adjustment releases an action inside the stated window', 'an action was released early'));
    }

    // 6. A read is not a hole in a stated pause. Reads escape the LEARNED
    //    interval by design; a deadline the server named binds both.
    {
      const rule = nextRuleOnBlock(newRule(ORIGIN, T0), { responseAtMs: T0, status: 429, retryAfter: '10' });
      const read = planRequest(rule, { now: T0 + 1_000, isWrite: false });
      probes.push(read?.action === 'wait'
        ? blocked('[deadline] a GET slips through a pause stated for the origin', 'the deadline gates every method')
        : leaked('[deadline] a GET slips through a pause stated for the origin', `read verdict=${read?.action}`));
    }

    // 7. The ceiling is a state, not a soft error: a restart, a new session, and
    //    a fresh actor all meet the same refusal, because the record is durable
    //    and keyed by origin rather than by session.
    {
      const { kv, store } = pacedStore();
      await store.observe({ origin: ORIGIN, responseAtMs: T0, status: 429, retryAfter: '3600' });
      const first = await store.reserve(ORIGIN, { isWrite: true });
      let t = T0;
      const revived = createOriginPacingStore({
        kv, now: () => t, sleep: async (ms: number) => { t += ms; },
      });
      await revived.hydrate();
      const second = await revived.reserve(ORIGIN, { isWrite: true });
      const held = first.outcome === 'handoff' && second.outcome === 'handoff';
      probes.push(held
        ? blocked('[ceiling] restarting the worker or delegating to a fresh actor clears the refusal',
          'the deadline is durable and keyed by origin; a new store on the same record refuses identically')
        : leaked('[ceiling] restarting the worker or delegating to a fresh actor clears the refusal',
          `first=${first.outcome} second=${second.outcome}`));
    }

    // 8. A tampered or unreadable record must not read as "no limits". Corrupt is
    //    the shape an attacker who can write storage would leave behind.
    {
      const { store } = pacedStore({ schema: 1, entries: { [ORIGIN]: { version: 1, origin: 'https://other.test' } } });
      await store.hydrate();
      const write = await store.reserve(ORIGIN, { isWrite: true });
      const peek = store.peek(ORIGIN, { isWrite: true });
      const refused = write.outcome === 'unavailable' && peek.outcome === 'unavailable';
      probes.push(refused
        ? blocked('[persistence] a tampered record reads as an origin with no limits',
          'a record filed under a foreign key makes the whole blob corrupt, and corrupt refuses browser writes')
        : leaked('[persistence] a tampered record reads as an origin with no limits', `write=${write.outcome}`));
    }

    // 9. A valid rule replayed under another origin's key would apply one site's
    //    pause to a different site, which is a denial lever against any origin.
    {
      const good = nextRuleOnBlock(newRule('https://a.test', T0), { responseAtMs: T0, status: 429 });
      const replayed = normalizePacingState({ schema: 1, entries: { 'https://b.test': good } });
      probes.push(replayed === null
        ? blocked('[persistence] a valid rule is replayed under a different origin key',
          'the key must equal the record\'s own origin; a mismatch invalidates the blob')
        : leaked('[persistence] a valid rule is replayed under a different origin key', 'the replay was adopted'));
    }

    // 10. A pre-hydrate read is the cold-worker shape of "no limits". A settings
    //     message is exactly what wakes a cold worker, so this is reachable.
    {
      const store = createOriginPacingStore({ kv: memoryKv(), now: () => T0 });
      const peek = store.peek(ORIGIN, { isWrite: true });
      const read = store.peek(ORIGIN, { isWrite: false });
      probes.push(peek.outcome === 'unavailable' && read.outcome === 'go'
        ? blocked('[persistence] a cold worker answers "no limits" before its record has loaded',
          'writes refuse until hydration proves the record; reads, which cannot act inside a pause, continue')
        : leaked('[persistence] a cold worker answers "no limits" before its record has loaded', `write=${peek.outcome}`));
    }

    // 11. The escalation ceiling bounds what one hostile answer can cost. A site
    //     answering `Retry-After: 31536000` must not park an origin for a year.
    {
      const absurd = nextRuleOnBlock(newRule(ORIGIN, T0), { responseAtMs: T0, status: 429, retryAfter: '31536000' });
      probes.push(absurd.notBeforeMs <= T0 + PACE_TUNABLES.maxDeadlineMs
        ? blocked('[escalation] one answer parks an origin indefinitely',
          'a stated deadline is clamped; the origin still reaches the visible ceiling handoff rather than an invisible year')
        : leaked('[escalation] one answer parks an origin indefinitely', `deadline=${absurd.notBeforeMs - T0}ms`));
    }

    return summarize(probes, [
      'the egress choke point is the only rule-creating observer, and only an error status counts',
      'the tool context gets two read-shaped closures; the policy core exports no setter',
      'deadlines are absolute, anchored to the response, and only ever move later',
      'no adjustment may release an action inside a stated window',
      'the ceiling ends the turn, and durable origin-keyed state makes a retry or a fresh actor meet it again',
      'corrupt, replayed, and not-yet-loaded records refuse browser writes instead of reading as no limits',
    ]);
  },
};
