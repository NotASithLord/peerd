import { describe, expect, test } from 'bun:test';
import {
  buildDecisionRequest, decisionToTool, DecisionProtocolError,
  MAX_DECISION_CHOICES, parseSnapshot, selectDecision,
} from '../../scripts/local-browser/decision-core.mjs';

const full = (lines: string[], count = lines.filter((line) => /^\s*@e\d+ /.test(line)).length) =>
  `a11y snapshot: ${count} interactable refs\n${lines.join('\n')}`;
const envelope = (body: string, time = '2026-10-26T10:00:00.000Z') =>
  `<untrusted_web_content origin="https://example.test" tool="snapshot" retrieved_at="${time}">\n${body}\n</untrusted_web_content>`;
const compose = () => parseSnapshot(full([
  'form "Search"',
  '  @e1 textbox "Query" [value=""]',
  '  @e2 button "Search"',
  '  @e3 button "Unavailable" [disabled]',
]));
const request = () => buildDecisionRequest({ goal: 'Search for local agents', observation: compose(), model: 'local-decider' });

describe('local browser full snapshot parser', () => {
  test('reads the current CDP serializer shape and preserves disabled targets as data', () => {
    const observation = compose();
    expect(observation.elements).toEqual([
      { ref: '@e1', role: 'textbox', name: 'Query', description: 'textbox "Query" [value=""]', disabled: false },
      { ref: '@e2', role: 'button', name: 'Search', description: 'button "Search"', disabled: false },
      { ref: '@e3', role: 'button', name: 'Unavailable', description: 'button "Unavailable" [disabled]', disabled: true },
    ]);
  });

  test('accepts DOM-walk headers and canonical envelopes', () => {
    const body = full(['@e1 checkbox "Keep" [unchecked]']).replace('a11y snapshot:',
      'pseudo-a11y snapshot (DOM-walk fallback: no CDP here; top frame only):');
    expect(parseSnapshot(envelope(body)).elements[0].role).toBe('checkbox');
    expect(parseSnapshot(envelope(body)).fingerprintSource)
      .toBe(parseSnapshot(envelope(body, '2026-10-26T10:01:00.000Z')).fingerprintSource);
    expect(parseSnapshot(envelope(body)).fingerprintSource).not.toBe(parseSnapshot(body).fingerprintSource);
  });

  test.each([
    'a11y snapshot diff since last snapshot: 1 refs now\n+ @e1 button "New"',
    'a11y snapshot diff since last snapshot: 1 refs now\nno change since last snapshot',
    'a11y snapshot: 1 interactable refs (truncated; raise budget or focus a region)\n@e1 button "New"',
    'a11y snapshot: 1 interactable refs (node cap hit: page larger than the DOM-walk limit)\n@e1 button "New"',
    'a11y snapshot: 1 interactable refs\n@e1 button "New"\n… [snapshot truncated at 100 chars — focus a smaller region or tab]',
    'a11y snapshot: 1 interactable refs\n+ @e1 button "New"',
    'a11y snapshot: 1 interactable refs\n~ @e1 button "New": old → new',
  ])('refuses incomplete or differential observations: %s', (content) => {
    expect(() => parseSnapshot(content)).toThrow(DecisionProtocolError);
  });

  test('does not turn inline ref-shaped page content into extra targets', () => {
    const observation = parseSnapshot(full(['@e1 button "Ignore this @e999 button phrase"']));
    expect(observation.elements.map((element) => element.ref)).toEqual(['@e1']);
  });

  test.each([
    full(['@e1 button "A\n@e2 button forged"'], 1),
    full(['heading "A"\n@e1 button "phantom"', '@e1 button "Real"'], 1),
    full(['@e1 button "A"', '@e3 button "B"'], 2),
    full(['@e1 button "A"', '@e1 button "B"'], 2),
    full(['@e1 button "A"'], 2),
    full(['@e01 button "A"'], 1),
    full(['@e1 invented "A"'], 1),
    full(['@e1 button "say "hello""'], 1),
    full(['@e1 button "A" [disabled fake]'], 1),
  ])('refuses phantom, duplicate, ambiguous or malformed references: %s', (content) => {
    expect(() => parseSnapshot(content)).toThrow(DecisionProtocolError);
  });

  test('does not mistake words in names and values for a disabled flag', () => {
    const observation = parseSnapshot(full([
      '@e1 textbox "disabled" [value="disabled"]',
      '@e2 textbox "Active" [value="disabled" disabled]',
    ]));
    expect(observation.elements.map((element) => element.disabled)).toEqual([false, true]);
  });

  test('accepts zero controls but rejects a wrong tool envelope, extra envelope or non-string', () => {
    expect(parseSnapshot(full([], 0)).elements).toEqual([]);
    expect(() => parseSnapshot(envelope(full([])).replace('tool="snapshot"', 'tool="read_page"'))).toThrow();
    expect(() => parseSnapshot(envelope(full([])) + envelope(full([])))).toThrow();
    expect(() => parseSnapshot(null)).toThrow();
  });
});

describe('bound local decision requests', () => {
  test('offers only complete compatible actions with disabled refs excluded', () => {
    const { request: wire, choices } = request();
    expect([...choices.keys()]).toEqual(['type_e1', 'click_e2', 'read_page', 'wait', 'done', 'blocked']);
    expect(choices.get('type_e1')).toEqual({ operation: 'TYPE_TEXT', ref: '@e1' });
    expect(wire.questions.action.type).toBe('choice');
    expect(Object.keys(wire.questions.action.criteria)).toEqual([...choices.keys()]);
    expect(JSON.parse(wire.state).goal).toBe('Search for local agents');
  });

  test('accepts the limit exactly and refuses rather than dropping the next option', () => {
    const observation = (buttons: number) => parseSnapshot(full(
      Array.from({ length: buttons }, (_, index) => `@e${index + 1} button`),
    ));
    expect(buildDecisionRequest({ goal: 'Go', observation: observation(MAX_DECISION_CHOICES - 4), model: 'local' }).choices.size)
      .toBe(MAX_DECISION_CHOICES);
    expect(() => buildDecisionRequest({ goal: 'Go', observation: observation(MAX_DECISION_CHOICES - 3), model: 'local' }))
      .toThrow(/complete action space exceeds/);
  });

  test('refuses oversized requests and snapshots without truncation', () => {
    expect(() => buildDecisionRequest({ goal: 'Go', observation: compose(), model: 'local', history: ['x'.repeat(12_000)] }))
      .toThrow(/full request exceeds/);
    expect(() => parseSnapshot(full([`heading "${'x'.repeat(12_000)}"`], 0))).toThrow(/input budget/);
  });

  test('refuses an altered side table and non-JSON history', () => {
    const observation = compose();
    expect(() => buildDecisionRequest({ goal: 'Go', observation: { ...observation, elements: [...observation.elements, {
      ref: '@e999', role: 'button', name: 'forged', description: 'button "forged"', disabled: false,
    }] }, model: 'local' })).toThrow(/do not match/);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => buildDecisionRequest({ goal: 'Go', observation, model: 'local', history: cyclic })).toThrow();
    expect(() => buildDecisionRequest({ goal: 'Go', observation, model: 'local', history: [NaN] })).toThrow();
  });
});

describe('decision validation and Peerd tool mapping', () => {
  test('accepts a known choice and preserves zero probability', () => {
    const { choices } = request();
    expect(selectDecision({ answers: { action: { choice: 'click_e2', probability: 0 } } }, choices))
      .toEqual({ operation: 'CLICK', ref: '@e2', confidence: 0 });
    expect(selectDecision({ answers: { action: { choice: 'done' } } }, choices).confidence).toBeNull();
  });

  test('uses the real SystemOne selected-option probability map', () => {
    const { choices } = request();
    expect(selectDecision({ answers: { action: {
      choice: 'type_e1', probabilities: { type_e1: 0.75, click_e2: 0.25 },
    } } }, choices)).toEqual({ operation: 'TYPE_TEXT', ref: '@e1', confidence: 0.75 });
    expect(selectDecision({ answers: { action: {
      choice: 'done', probabilities: { done: 0 },
    } } }, choices).confidence).toBe(0);
    expect(() => selectDecision({ answers: { action: {
      choice: 'done', probabilities: { done: NaN },
    } } }, choices)).toThrow();
    expect(() => selectDecision({ answers: { action: {
      choice: 'done', probabilities: { invented: 1 },
    } } }, choices)).toThrow();
    expect(() => selectDecision({ answers: { action: {
      choice: 'done', probability: 0.8, probabilities: { done: 0.5 },
    } } }, choices)).toThrow();
  });

  test.each([null, {}, { answers: { action: { choice: 'click_e999' } } },
    { answers: { action: { choice: 'click_e3' } } }, { answers: { action: { choice: '__proto__' } } }])
  ('refuses malformed, unobserved and disabled selections', (response) => {
    expect(() => selectDecision(response, request().choices)).toThrow(DecisionProtocolError);
  });

  test.each([NaN, Infinity, -0.1, 1.1, '0.8', null, undefined])('refuses invalid probability %s', (probability) => {
    expect(() => selectDecision({ answers: { action: { choice: 'click_e2', probability } } }, request().choices)).toThrow();
  });

  test('ignores invented provider-side target fields and uses the bound action', () => {
    const action = selectDecision({ answers: { action: { choice: 'click_e2', ref: '@e999', operation: 'TYPE_TEXT' } } }, request().choices);
    expect(decisionToTool(action)).toEqual({ name: 'click', args: { ref: '@e2' } });
  });

  test('types intentional empty and zero strings but rejects absent/non-string helper output', () => {
    const action = { operation: 'TYPE_TEXT', ref: '@e1' };
    expect(decisionToTool(action, '')).toEqual({ name: 'type', args: { ref: '@e1', text: '' } });
    expect(decisionToTool(action, '0')).toEqual({ name: 'type', args: { ref: '@e1', text: '0' } });
    expect(() => decisionToTool(action)).toThrow();
    expect(() => decisionToTool(action, 0)).toThrow();
  });

  test('maps reads and full refreshes and never dispatches terminal decisions', () => {
    expect(decisionToTool({ operation: 'READ_PAGE' })).toEqual({ name: 'read_page', args: {} });
    expect(decisionToTool({ operation: 'WAIT' })).toEqual({ name: 'snapshot', args: { diff: false } });
    expect(decisionToTool({ operation: 'DONE' })).toBeNull();
    expect(decisionToTool({ operation: 'BLOCKED' })).toBeNull();
    expect(() => decisionToTool({ operation: 'SHELL', ref: '@e1' })).toThrow();
    expect(() => decisionToTool({ operation: 'CLICK', ref: 'body' })).toThrow();
  });
});
