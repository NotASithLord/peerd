// planTrim's DYNAMIC (token-budget) trigger — layered over the original
// message-count backstop. The byte-level message-count + boundary-snap
// behavior is pinned in trim.test.ts / trim-rolling.test.ts; this suite
// covers the token trigger and its interaction with the keep floor.

import { describe, test, expect } from 'bun:test';
import { planTrim } from '../../../extension/peerd-runtime/loop/trim.js';

const big = (i: number, chars = 400) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: 'x'.repeat(chars),
  id: `m${i}`,
  when: i,
});
const convo = (n: number, chars = 400): any[] => Array.from({ length: n }, (_, i) => big(i, chars));

describe('planTrim — message-count parity (window absent)', () => {
  test('no contextWindow + under soft cap → no trim', () => {
    const plan = planTrim(convo(12));
    expect(plan.didTrim).toBe(false);
    expect(plan.messages.length).toBe(12);
  });

  test('no contextWindow + over soft cap → message-count trim (legacy)', () => {
    const plan = planTrim(convo(80, 5));
    expect(plan.didTrim).toBe(true);
    expect(plan.messages.length).toBe(21); // 1 summary + keepRecent(20)
    expect(plan.messages[0].synthetic).toBe(true);
  });
});

describe('planTrim — a KNOWN window makes tokens authoritative (count cap demoted)', () => {
  test('long-but-LIGHT history on a big window is NOT trimmed by the count cap', () => {
    // 80 tiny turns (~5 chars each ≈ a few hundred tokens total) — over the
    // 60 message cap, but nowhere near a 1M window. The old count trigger
    // would have trimmed to 21; now it must stay whole.
    const msgs = convo(80, 5);
    expect(planTrim(msgs).didTrim).toBe(true);                      // window unknown → legacy count trim
    const plan = planTrim(msgs, { contextWindow: 1_000_000 });     // window known → token-authoritative
    expect(plan.didTrim).toBe(false);
    expect(plan.messages.length).toBe(80);
  });

  test('the SAME history still trims once it is genuinely token-heavy for the window', () => {
    const msgs = convo(80, 5);
    // a tiny window the same little history DOES overflow → token trigger fires
    const plan = planTrim(msgs, { contextWindow: 200 });
    expect(plan.didTrim).toBe(true);
  });

  test('an explicit softCap is ignored when a window is known', () => {
    const msgs = convo(40, 5); // over softCap 10, but light for the window
    expect(planTrim(msgs, { softCap: 10 }).didTrim).toBe(true);                       // no window → softCap applies
    expect(planTrim(msgs, { softCap: 10, contextWindow: 1_000_000 }).didTrim).toBe(false); // window wins
  });
});

describe('planTrim — dynamic token trigger', () => {
  test('trims a SHORT (under message-cap) history when it is token-heavy', () => {
    const msgs = convo(12, 400); // 12 msgs, well under softCap 60
    expect(planTrim(msgs).didTrim).toBe(false);          // no window → no trim
    const plan = planTrim(msgs, { contextWindow: 1000 }); // ~1250 est > 0.75×1000
    expect(plan.didTrim).toBe(true);
    expect(plan.messages[0].synthetic).toBe(true);
    expect(plan.messages.length).toBeLessThan(msgs.length);
    expect(plan.messages[plan.messages.length - 1].id).toBe('m11'); // newest kept
  });

  test('cuts down toward the target fraction (deep cut, not a nibble)', () => {
    const msgs = convo(40, 400);
    const plan = planTrim(msgs, { contextWindow: 2000, triggerFraction: 0.75, targetFraction: 0.5 });
    expect(plan.didTrim).toBe(true);
    expect(plan.messages.length).toBeLessThan(15);
  });

  test('respects the keep floor even when every turn is huge', () => {
    const msgs = convo(20, 4000);
    const plan = planTrim(msgs, { contextWindow: 50 });
    expect(plan.didTrim).toBe(true);
    const keptReal = plan.messages.filter((m: any) => !m.synthetic);
    expect(keptReal.length).toBeGreaterThanOrEqual(4);
  });

  test('does not trim when the estimate is under the trigger', () => {
    const plan = planTrim(convo(6, 40), { contextWindow: 200_000 });
    expect(plan.didTrim).toBe(false);
  });

  test('counts the system prompt toward the estimate', () => {
    const msgs = convo(12, 100); // ~350 est tokens of messages, room above the floor
    expect(planTrim(msgs, { contextWindow: 2000 }).didTrim).toBe(false); // 350 < 0.75×2000
    // A large system prompt (~1500 tokens) pushes the same history over.
    const plan = planTrim(msgs, { contextWindow: 2000, system: 's'.repeat(6000) });
    expect(plan.didTrim).toBe(true);
  });

  test('honors an injected estimator', () => {
    const plan = planTrim(convo(6, 10), { contextWindow: 1000, estimateTokens: () => 10_000 });
    expect(plan.didTrim).toBe(true);
  });

  test('the token-drop decrement uses the INJECTED estimator, not the char/4 default', () => {
    // Custom additive estimator: 1000 "tokens" per message (ignores system),
    // wildly different from char/4 on these tiny 5-char bodies.
    const estimateTokens = (msgs: readonly any[]) => (Array.isArray(msgs) ? msgs.length * 1000 : 0);
    const msgs = convo(20, 5); // total = 20_000 by the injected scale
    // window 10_000 → trigger 7_500 (fires), target 5_500. Correct: drop until
    // (20-D)*1000 ≤ 5_500 → D=15 → keep 5. If the decrement still used char/4
    // (~6/msg) it would barely move and over-drop to the MIN_KEEP floor (4).
    const plan = planTrim(msgs, { contextWindow: 10_000, estimateTokens });
    expect(plan.didTrim).toBe(true);
    const keptReal = plan.messages.filter((m: any) => !m.synthetic).length;
    expect(keptReal).toBe(5); // the bug would yield 4
  });

  test('the deeper of the two triggers wins (token cut beats message keepRecent)', () => {
    const plan = planTrim(convo(80, 400), { contextWindow: 2000 });
    expect(plan.didTrim).toBe(true);
    expect(plan.messages.length).toBeLessThan(21); // deeper than keepRecent(20)+summary
  });

  test('rolling state still produced under the token trigger', () => {
    const msgs = convo(12, 400);
    const plan = planTrim(msgs, { contextWindow: 1000 });
    expect(plan.summaryState).not.toBe(null);
    expect(plan.summaryState!.covered).toBe(plan.newlyDropped.length);
    expect(plan.newlyDropped.length).toBeGreaterThan(0);
  });
});
