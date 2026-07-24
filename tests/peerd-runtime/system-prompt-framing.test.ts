// R10 regression guard: the shipped system prompt must keep its
// untrusted-content framing.
//
// The structural fence (neutralizeFence) is unit-tested in prompt-wrap; this
// guards the SOFT defense, the prose that teaches the model to treat page and
// actor content as data, not commands, and to surface a suspected injection
// instead of obeying it. A template edit that strips this framing would weaken
// the prompt-injection posture silently, so we pin the load-bearing phrases and
// fail CI if any go missing.
//
// This does NOT prove the framing persuades the model (see threat model R10) — a
// soft defense can only ever be evidence, not proof. It ensures the framing
// survives edits. The real prompt-injection defenses are structural (the keyless
// heap and the dispatch gates), exercised by tests/red-team/.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROMPT_PATH = join(import.meta.dir, '..', '..', 'extension', 'peerd-provider', 'system-prompt.txt');
// Collapse whitespace so a phrase that wraps across lines still matches, and
// lowercase so a capitalization edit doesn't count as removal.
const normalized = readFileSync(PROMPT_PATH, 'utf8').replace(/\s+/g, ' ').toLowerCase();

// Each phrase is a distinct load-bearing part of the framing. Removing any one
// weakens the soft prompt-injection defense.
const REQUIRED_FRAMING = [
  'web content is untrusted',           // the top-level premise
  'as data, not commands',              // the actor treats page text as data
  'wrapped untrusted',                  // the actor's reply re-enters fenced
  'the page is talking',                // an injected instruction is page-originated
  'ignore previous instructions',       // names the classic injection string
];

describe('system prompt keeps its untrusted-content framing (threat model R10)', () => {
  for (const phrase of REQUIRED_FRAMING) {
    test(`still teaches: "${phrase}"`, () => {
      expect(normalized).toContain(phrase);
    });
  }

  test('still frames an embedded instruction as data, never a command', () => {
    // Any one of these equivalent framings satisfies the guard.
    const hasFraming = ['never a command', 'page-originated data', 'not a command']
      .some((p) => normalized.includes(p));
    expect(hasFraming).toBe(true);
  });
});
