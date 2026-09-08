// @ts-check
// renderSystemPromptFromAssets placeholder substitution.

import { describe, it, expect } from '../../framework.js';
import { renderSystemPromptFromAssets } from '/peerd-runtime/loop/system-prompt.js';

const TEMPLATE = [
  'BASE-PROMPT',
  '{{MEMORY_BLOCK}}',
  '{{TEMPORAL_BLOCK}}',
  '---',
  '{{WEB_TAB_POLICY}}',
].join('\n');

describe('renderSystemPromptFromAssets', () => {
  // design 01: the volatile temporal/date bytes moved OUT of the cached system
  // block into a per-turn <context> message; renderSystemPrompt still substitutes
  // {{TEMPORAL_BLOCK}} for an ACTOR turn (which re-renders per turn), so a passed
  // block still embeds. The main path passes '' → the placeholder collapses.
  it('embeds the temporal block when provided (actor path)', async () => {
    const out = renderSystemPromptFromAssets({
      temporalBlock: '<time>2026-06-05T14:00:00Z · t+47s</time>',
    }, { template: TEMPLATE });
    expect(out.includes('t+47s')).toBe(true);
  });

  it('embeds the always-loaded memory block when provided (V1.5)', async () => {
    const out = renderSystemPromptFromAssets({
      memoryBlock: '<memory>\n## Memory: user (global)\nremember this\n</memory>',
    }, { template: TEMPLATE });
    expect(out.includes('remember this')).toBe(true);
    expect(out.includes('<memory>')).toBe(true);
  });

  it('collapses the memory block to empty when omitted', async () => {
    const out = renderSystemPromptFromAssets({}, { template: TEMPLATE });
    expect(out.includes('{{MEMORY_BLOCK}}')).toBe(false);
    expect(out.includes('<memory>')).toBe(false);
  });

  it('always emits the tab focus policy (tabs open in the background)', async () => {
    const out = renderSystemPromptFromAssets({}, { template: TEMPLATE });
    // DESIGN-12: tabs open in the BACKGROUND with a "go there" card — they never
    // steal focus (the old "take focus by default" / "active:false" wording was
    // stale; open_tab has no active arg and always opens quietly).
    expect(out.includes('stays in the BACKGROUND')).toBe(true);
    expect(out.includes('go there')).toBe(true);
    expect(out.includes('never yank them across')).toBe(true);
  });

  describe('customSystemPrompt (/system session instructions)', () => {
    it('APPENDS a <session_instructions> block after the intact base prompt', async () => {
      const out = renderSystemPromptFromAssets(
        { customSystemPrompt: 'answer like a pirate' }, { template: TEMPLATE },
      );
      // Augments — the full base renders first, the block is appended.
      expect(out.includes('BASE-PROMPT')).toBe(true);
      expect(out.includes('<session_instructions>')).toBe(true);
      expect(out.includes('answer like a pirate')).toBe(true);
      expect(out.indexOf('---') < out.indexOf('<session_instructions>')).toBe(true);
      // The framing pins the block BELOW the base's authority.
      expect(out.includes('never override')).toBe(true);
    });

    it('collapses to nothing when omitted or whitespace-only', async () => {
      expect(renderSystemPromptFromAssets({}, { template: TEMPLATE })
        .includes('session_instructions')).toBe(false);
      expect(renderSystemPromptFromAssets(
        { customSystemPrompt: '  \n' }, { template: TEMPLATE },
      ).includes('session_instructions')).toBe(false);
    });
  });
});
