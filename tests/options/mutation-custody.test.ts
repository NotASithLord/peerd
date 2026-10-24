import { describe, expect, test } from 'bun:test';
import { mutationFailureCopy, unknownMutationCopy } from '../../extension/options/mutation-custody.js';

const action = 'changing memory';
const fallback = 'The memory change could not be completed.';
const unlockGuidance = 'Vault is locked. Unlock it in the peerd panel, then try again.';
const siteMessage = 'Use the current vault unlock method.';
const cases: ReadonlyArray<{
  name: string; reply: unknown; messages?: Record<string, string>; expected: string;
}> = [
  { name: 'locked', reply: { error: 'locked' }, expected: unlockGuidance },
  { name: 'vault-locked', reply: { error: 'vault-locked' }, expected: unlockGuidance },
  { name: 'locked site override', reply: { error: 'locked' }, messages: { locked: siteMessage }, expected: siteMessage },
  { name: 'vault-locked site override', reply: { error: 'vault-locked' }, messages: { 'vault-locked': siteMessage }, expected: siteMessage },
  { name: 'unknown locked outcome', reply: { error: 'locked', outcomeKnown: false }, messages: { locked: siteMessage }, expected: unknownMutationCopy(action) },
  { name: 'unknown vault-locked outcome', reply: { error: 'vault-locked', outcomeKnown: false }, messages: { 'vault-locked': siteMessage }, expected: unknownMutationCopy(action) },
  { name: 'unknown thrown error', reply: Object.assign(new Error('vault-locked'), { outcomeKnown: false }), expected: unknownMutationCopy(action) },
  { name: 'unmapped code', reply: { error: 'refused' }, expected: fallback },
  { name: 'code with raw detail', reply: { error: 'vault-locked: raw transport detail' }, expected: fallback },
  { name: 'numeric error', reply: { error: 401 }, expected: fallback },
  { name: 'no reply', reply: undefined, expected: fallback },
  { name: 'message without string code', reply: new Error('vault-locked'), expected: fallback },
];

describe('Options mutation failure copy', () => {
  for (const row of cases) {
    test(row.name, () => {
      expect(mutationFailureCopy(row.reply, { action, fallback, messages: row.messages })).toBe(row.expected);
    });
  }
});
