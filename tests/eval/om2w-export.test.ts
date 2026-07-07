// Online-Mind2Web export — the pure halves of the adapter: tool-call → Grammar A
// action strings (extension/eval/om2w-actions.js) and the schema-v2 result.json
// builder/validator (scripts/cdp/om2w/result-builder.mjs). Shapes are pinned to
// the benchmark's reference submission (data/example/example_v2) so a drift in
// our exporter fails HERE, not as a judge-side rejection after a paid run.

import { describe, test, expect } from 'bun:test';
import { pageActionFor, pageActionForOp, formatAction, initialNavigation, taskComplete } from '../../extension/eval/om2w-actions.js';
import { buildResult, validateResult, shotName } from '../../scripts/cdp/om2w/result-builder.mjs';

describe('om2w-actions — peerd tool calls to Grammar A', () => {
  test('page actions map; reads/orchestration/compute do NOT', () => {
    expect(pageActionFor('navigate', { url: 'https://x.com' })?.verb).toBe('NAVIGATE');
    expect(pageActionFor('click', { selector: '#buy' })?.verb).toBe('CLICK');
    expect(pageActionFor('type', { selector: '#q', text: 'shoes' })?.verb).toBe('TYPE');
    expect(pageActionFor('page_keys', { keys: 'Enter' })?.verb).toBe('PRESS_KEY');
    expect(pageActionFor('open_tab', { url: 'https://x.com' })?.verb).toBe('NAVIGATE');
    // NOT page actions: perception, delegation, HTTP fetch, compute, code arm.
    for (const n of ['snapshot', 'read_page', 'read_state', 'query_dom', 'watch_changes',
      'message_actor', 'actor_list', 'fetch_url', 'js_run', 'page_code', 'read_pdf', 'view', 'remember']) {
      expect(pageActionFor(n, {})).toBeNull();
    }
  });

  test('formatAction matches the reference style, with and without status', () => {
    expect(formatAction({ verb: 'NAVIGATE', target: 'page', description: 'navigate to https://x.com' }))
      .toBe('page -> NAVIGATE -> navigate to https://x.com');
    expect(formatAction({ verb: 'CLICK', target: '[#buy]', description: 'click [#buy]' }, 'SUCCESS'))
      .toBe('CLICK [#buy] -> click [#buy] | SUCCESS');
    expect(formatAction({ verb: 'TYPE', target: '[#q]', description: 'type "shoes"' }, 'FAILED'))
      .toBe('TYPE [#q] -> type "shoes" | FAILED');
    expect(initialNavigation('https://x.com')).toBe('page -> NAVIGATE -> Initial navigation to https://x.com');
    expect(taskComplete('Done.')).toBe('TASK_COMPLETE -> ANSWER: Done.');
  });

  test('page/op mapping (the CODE surface): goto/click/fill map, snapshot/content do NOT', () => {
    expect(pageActionForOp('goto', { url: 'https://x.com' })?.verb).toBe('NAVIGATE');
    expect(pageActionForOp('click', { selector: '#buy' })?.verb).toBe('CLICK');
    expect(pageActionForOp('fill', { selector: '#q', text: 'shoes' })?.verb).toBe('TYPE');
    // A page.* op formats IDENTICALLY to its discrete-tool twin — the judge
    // sees one Grammar A vocabulary across both arms.
    expect(formatAction(pageActionForOp('click', { selector: '#buy' })!, 'SUCCESS'))
      .toBe(formatAction(pageActionFor('click', { selector: '#buy' })!, 'SUCCESS'));
    for (const m of ['snapshot', 'content', 'unknown']) {
      expect(pageActionForOp(m, {})).toBeNull();
    }
  });

  test('long typed text is clipped so result.json stays readable', () => {
    const a = pageActionFor('type', { selector: '#q', text: 'x'.repeat(300) })!;
    expect(a.description.length).toBeLessThan(120);
  });
});

describe('result-builder — schema-v2 result.json', () => {
  const TASK = { task_id: 'abc123', task_description: 'Find the price.', reference_length: 7 };
  const ACTIONS = [
    { action: initialNavigation('https://shop.example'), url: 'https://shop.example', status: null },
    { action: formatAction({ verb: 'CLICK', target: '[#p]', description: 'click [#p]' }, 'SUCCESS'), url: 'https://shop.example/p', status: 'SUCCESS' as const },
  ];

  test('builds a VALID result: steps indexed, screenshots zero-padded, final TASK_COMPLETE matches the answer', () => {
    const r = buildResult(TASK, ACTIONS, 'The price is $8.50.');
    expect(validateResult(r)).toEqual([]);
    expect(r.schema_version).toBe('online-mind2web-v2');
    expect(r.action_history.map((s: any) => s.step)).toEqual([0, 1, 2]);
    expect(r.action_history[0].screenshot).toBe('0000.jpg');
    expect(r.action_history[2].action).toBe('TASK_COMPLETE -> ANSWER: The price is $8.50.');
    expect(r.agent_final_answer).toBe('The price is $8.50.');
    // thought key present (null ok) on every step — additionalProperties-safe shape.
    for (const s of r.action_history) expect('thought' in s).toBe(true);
  });

  test('a null/empty final answer still yields a valid TASK_COMPLETE step', () => {
    const r = buildResult(TASK, ACTIONS, null);
    expect(r.agent_final_answer).toBeNull();
    expect(r.action_history.at(-1)!.action).toMatch(/^TASK_COMPLETE -> ANSWER: /);
    expect(validateResult(r)).toEqual([]);
  });

  test('the validator catches the traps: bad id, index drift, suffix/status disagreement, wrong final step', () => {
    const good = buildResult(TASK, ACTIONS, 'ok');
    expect(validateResult({ ...good, task_id: 'tasks/abc' })).toContainEqual(expect.stringContaining('task_id'));
    const drift = structuredClone(good); drift.action_history[1].step = 5;
    expect(validateResult(drift).join(' ')).toContain('must equal its index');
    const disagree = structuredClone(good); disagree.action_history[1].action_status = 'FAILED';
    expect(validateResult(disagree).join(' ')).toContain('disagrees');
    const noFinal = structuredClone(good); noFinal.action_history.pop();
    expect(validateResult(noFinal).join(' ')).toContain('TASK_COMPLETE');
  });

  test('shotName zero-pads to sort lexicographically', () => {
    expect(shotName(0)).toBe('0000.jpg');
    expect(shotName(13, 'png')).toBe('0013.png');
  });
});
