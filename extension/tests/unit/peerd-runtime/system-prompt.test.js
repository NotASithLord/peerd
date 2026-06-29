// @ts-check
// renderSystemPrompt — placeholder substitution.

import { describe, it, expect } from '../../framework.js';
import { renderSystemPrompt, _setTemplateForTests } from '/peerd-runtime/index.js';

const TEMPLATE = [
  'date: {{DATE}}',
  '{{MEMORY_BLOCK}}',
  '{{TEMPORAL_BLOCK}}',
  '---',
  '{{WEB_TAB_POLICY}}',
].join('\n');

describe('renderSystemPrompt', () => {
  it('substitutes the date', async () => {
    _setTemplateForTests(TEMPLATE);
    const out = await renderSystemPrompt({
      date: new Date('2026-06-05T00:00:00Z'),
    });
    expect(out.includes('date: 2026-06-05')).toBe(true);
  });

  it('embeds the temporal block when provided', async () => {
    _setTemplateForTests(TEMPLATE);
    const out = await renderSystemPrompt({
      temporalBlock: '<time>2026-06-05T14:00:00Z · t+47s</time>',
    });
    expect(out.includes('t+47s')).toBe(true);
  });

  it('embeds the always-loaded memory block when provided (V1.5)', async () => {
    _setTemplateForTests(TEMPLATE);
    const out = await renderSystemPrompt({
      memoryBlock: '<memory>\n## Memory: user (global)\nremember this\n</memory>',
    });
    expect(out.includes('remember this')).toBe(true);
    expect(out.includes('<memory>')).toBe(true);
  });

  it('collapses the memory block to empty when omitted', async () => {
    _setTemplateForTests(TEMPLATE);
    const out = await renderSystemPrompt({});
    expect(out.includes('{{MEMORY_BLOCK}}')).toBe(false);
    expect(out.includes('<memory>')).toBe(false);
  });

  it('always emits the tab focus policy (tabs open in the background)', async () => {
    _setTemplateForTests(TEMPLATE);
    const out = await renderSystemPrompt({});
    // DESIGN-12: tabs open in the BACKGROUND with a "go there" card — they never
    // steal focus (the old "take focus by default" / "active:false" wording was
    // stale; open_tab has no active arg and always opens quietly).
    expect(out.includes('stays in the BACKGROUND')).toBe(true);
    expect(out.includes('go there')).toBe(true);
    expect(out.includes('never yank them across')).toBe(true);
  });

  describe('customSystemPrompt (/system session instructions)', () => {
    it('APPENDS a <session_instructions> block after the intact base prompt', async () => {
      _setTemplateForTests(TEMPLATE);
      const out = await renderSystemPrompt({ customSystemPrompt: 'answer like a pirate' });
      // Augments — the full base renders first, the block is appended.
      expect(out.includes('date:')).toBe(true);
      expect(out.includes('<session_instructions>')).toBe(true);
      expect(out.includes('answer like a pirate')).toBe(true);
      expect(out.indexOf('---') < out.indexOf('<session_instructions>')).toBe(true);
      // The framing pins the block BELOW the base's authority.
      expect(out.includes('never override')).toBe(true);
    });

    it('collapses to nothing when omitted or whitespace-only', async () => {
      _setTemplateForTests(TEMPLATE);
      expect((await renderSystemPrompt({})).includes('session_instructions')).toBe(false);
      expect((await renderSystemPrompt({ customSystemPrompt: '  \n' })).includes('session_instructions')).toBe(false);
    });
  });
});
