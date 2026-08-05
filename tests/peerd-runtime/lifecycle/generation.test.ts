// SW generations + stale-authority refusal — guarantees 3 and 7: security
// authority is re-derived after restart, never resumed; a restart never
// extends a credential/approval/capability lifetime.

import { describe, test, expect } from 'bun:test';
import {
  mintGeneration, authorityValid, sweepStaleAuthority, acceptActorMessage,
} from '../../../extension/peerd-runtime/lifecycle/generation.js';

const gen1 = mintGeneration(null, { nonce: 'nonce-aaaa', now: 1000 });
const gen2 = mintGeneration(gen1, { nonce: 'nonce-bbbb', now: 2000 });

describe('minting', () => {
  test('seq is monotonic and the id embeds the nonce', () => {
    expect(gen1.seq).toBe(1);
    expect(gen2.seq).toBe(2);
    expect(gen1.id).toBe('gen-1-nonce-aaaa');
    expect(gen2.id).not.toBe(gen1.id);
  });

  test('a lost seq write cannot collide ids — the nonce disambiguates', () => {
    const replay = mintGeneration(null, { nonce: 'nonce-cccc', now: 3000 });
    expect(replay.seq).toBe(gen1.seq); // seq repeated (write was lost) …
    expect(replay.id).not.toBe(gen1.id); // … but the identity still differs
  });

  test('garbage previous records are tolerated; weak nonces are not', () => {
    expect(mintGeneration({ seq: Number.NaN, id: 'x', mintedAt: 0 },
      { nonce: 'nonce-dddd', now: 1 }).seq).toBe(1);
    expect(() => mintGeneration(null, { nonce: 'abc', now: 1 })).toThrow(TypeError);
  });
});

describe('authorityValid — fail closed', () => {
  const ctx = { generation: gen2, now: 5000 };

  test('current-generation, unexpired authority is valid', () => {
    expect(authorityValid({ generationId: gen2.id }, ctx).valid).toBe(true);
    expect(authorityValid({ generationId: gen2.id, expiresAt: 6000 }, ctx).valid).toBe(true);
  });

  test('prior-generation authority is refused wholesale', () => {
    const verdict = authorityValid({ generationId: gen1.id }, ctx);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('stale generation');
  });

  test('a restart cannot extend a lifetime: expiry is judged against the original window', () => {
    // Stamped by the CURRENT generation but past its window — still refused.
    const verdict = authorityValid({ generationId: gen2.id, expiresAt: 4000 }, ctx);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('expired');
  });

  test('missing/garbage stamps are refused', () => {
    expect(authorityValid(null, ctx).valid).toBe(false);
    expect(authorityValid({} as any, ctx).valid).toBe(false);
  });
});

describe('startup sweep', () => {
  test('partitions live from stale and names the reason', () => {
    const records = [
      { generationId: gen2.id, kind: 'tab-ownership' },
      { generationId: gen1.id, kind: 'actor-grant' },
      { generationId: gen2.id, expiresAt: 1, kind: 'approval-token' },
    ];
    const { live, stale } = sweepStaleAuthority(records, { generation: gen2, now: 5000 });
    expect(live.map((r) => r.kind)).toEqual(['tab-ownership']);
    expect(stale.map((s) => s.record.kind).sort()).toEqual(['actor-grant', 'approval-token']);
    for (const s of stale) expect(s.reason.length).toBeGreaterThan(0);
  });

  test('non-array input yields an empty sweep, not a crash', () => {
    const { live, stale } = sweepStaleAuthority(undefined as any, { generation: gen2, now: 0 });
    expect(live).toEqual([]);
    expect(stale).toEqual([]);
  });
});

describe('actor generations — old runs cannot speak into new ones', () => {
  test('messages from the current actor generation pass; prior ones are discarded', () => {
    expect(acceptActorMessage({ generation: 3 }, 3)).toBe(true);
    expect(acceptActorMessage({ generation: 2 }, 3)).toBe(false);
    expect(acceptActorMessage({}, 3)).toBe(false);
    expect(acceptActorMessage({ generation: '3' }, 3)).toBe(false);
  });
});
