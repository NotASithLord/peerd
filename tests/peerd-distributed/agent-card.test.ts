// The Agent Card — A2A's discovery pillar, rhymed onto the mesh (did address,
// no HTTP transport). Pure normalize/validate; pins the field vocabulary, the
// caps, and the untrusted-peer parse.

import { describe, test, expect } from 'bun:test';
import {
  normalizeCard, validateCard, parsePeerCard, CardRejectedError,
  MAX_SKILLS, MAX_CARD_BYTES,
} from '../../extension/peerd-distributed/agent-card.js';

const DID = 'did:key:z6MkexampleAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('normalizeCard — A2A-shaped, coerce-and-clamp', () => {
  test('keeps the A2A field vocabulary, defaults version + capabilities', () => {
    const c = normalizeCard({ name: 'Scheduler', description: 'books meetings', skills: [{ id: 's1', name: 'schedule', description: 'find a slot' }] });
    expect(c.name).toBe('Scheduler');
    expect(c.version).toBe('0.1.0');
    expect(c.skills).toEqual([{ id: 's1', name: 'schedule', description: 'find a slot' }]);
    expect(c.capabilities).toEqual({ ask: true, streaming: false });
  });

  test('stamps a did:key when present, drops a non-did (host stamps the real one)', () => {
    expect(normalizeCard({ name: 'A', did: DID }).did).toBe(DID);
    expect('did' in normalizeCard({ name: 'A', did: 'http://evil' })).toBe(false);
  });

  test('clamps skills to MAX_SKILLS and fills a missing skill id', () => {
    const many = Array.from({ length: MAX_SKILLS + 5 }, (_, i) => ({ name: `s${i}`, description: 'd' }));
    const c = normalizeCard({ name: 'A', skills: many });
    expect(c.skills.length).toBe(MAX_SKILLS);
    expect(c.skills[0].id).toBe('skill-0');   // synthesized
  });

  test('non-object input degrades to an empty (invalid) card, never throws', () => {
    expect(() => normalizeCard(null)).not.toThrow();
    expect(normalizeCard(null).name).toBe('');
  });
});

describe('validateCard — publishable gate', () => {
  test('a named card within the byte ceiling passes', () => {
    expect(validateCard({ name: 'Ada' }).ok).toBe(true);
  });
  test('a nameless card is rejected', () => {
    expect(() => validateCard({ description: 'no name' })).toThrow(CardRejectedError);
  });
  test('an over-ceiling card is rejected', () => {
    const huge = { name: 'A', skills: Array.from({ length: MAX_SKILLS }, (_, i) => ({ id: `id${i}`, name: 'n'.repeat(120), description: 'd'.repeat(120) })) };
    // force it over MAX_CARD_BYTES with a long description
    const over = { ...huge, description: 'x'.repeat(MAX_CARD_BYTES) };
    expect(() => validateCard(over)).toThrow(CardRejectedError);
  });
});

describe('parsePeerCard — untrusted inbound', () => {
  test('coerces a well-formed peer card, returns null on garbage', () => {
    expect(parsePeerCard({ name: 'Bob', skills: [{ name: 'x', description: 'y' }] })?.name).toBe('Bob');
    expect(parsePeerCard({ nope: 1 })).toBe(null);
    expect(parsePeerCard('not a card')).toBe(null);
  });
});

// Wiring drift guard (cynical re-swarm, medium): the caps were dead code once —
// agent-card.js was imported NOWHERE, so both the publish and fetch card paths
// ran uncapped. Pin that the validators are (a) re-exported from the module's
// public index and (b) actually CALLED on the card-set / card-get paths in the
// offscreen base host, so they can't silently go inert again.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
describe('agent-card caps are wired into the card paths (not dead code)', () => {
  test('peerd-distributed/index.js re-exports the validators', () => {
    const idx = readFileSync(join(import.meta.dir, '../../extension/peerd-distributed/index.js'), 'utf8');
    for (const name of ['normalizeCard', 'validateCard', 'parsePeerCard']) {
      expect(idx).toContain(name);
    }
  });
  test('dweb-base.js validates on card-set and clamps on card-get', () => {
    const src = readFileSync(join(import.meta.dir, '../../extension/offscreen/dweb-base.js'), 'utf8');
    // card-set must reject/strip via validateCard; card-get must clamp via parsePeerCard.
    expect(src).toContain('validateCard');
    expect(src).toContain('parsePeerCard');
  });
});
